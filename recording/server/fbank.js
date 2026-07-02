// Kaldi 兼容的 80 维 log-mel fbank 特征（纯 JS，无依赖），CAM++ 声纹模型的前处理。
// 必须逐字对齐模型训练时的 torchaudio.compliance.kaldi.fbank(POVEY 窗, dither=0)：
//   任一环节错（窗型/采样尺度/功率谱/N-1 窗长/逐句均值归一化）都会静默产出垃圾向量。
// 参考：3D-Speaker/CAM++ 用 POVEY 窗 + 逐句 mean-only CMN；输入 16k/16bit 单声道 int16。

const SR = 16000;
const FRAME_LEN = 400;     // 25ms @16k
const FRAME_SHIFT = 160;   // 10ms
const NUM_MEL = 80;
const LOW_HZ = 20;
const HIGH_HZ = 8000;      // Nyquist
const PREEMPH = 0.97;
const NFFT = 512;          // 大于等于 400 的 2 的幂（Kaldi round_to_power_of_two）
const MEL_FLOOR = 1e-10;   // log 前的能量下限

const melScale = (f) => 1127.0 * Math.log(1 + f / 700);

// —— 预计算：POVEY 窗（分母是 N-1=399，不是 400）——
const WINDOW = new Float32Array(FRAME_LEN);
for (let i = 0; i < FRAME_LEN; i++) {
  const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1));
  WINDOW[i] = Math.pow(hann, 0.85);
}

// —— 预计算：80 个三角 mel 滤波器（Kaldi 风格，在 mel 域做三角，不做面积归一化）——
// 每个滤波器存 {start, weights[]}，只覆盖非零的 fft bin，省乘法。
const NUM_FFT_BINS = NFFT / 2 + 1; // 257
const MEL_FILTERS = (() => {
  const melLow = melScale(LOW_HZ);
  const melHigh = melScale(HIGH_HZ);
  const delta = (melHigh - melLow) / (NUM_MEL + 1);
  const binHz = SR / NFFT; // 每个 fft bin 的频率宽度
  const filters = [];
  for (let m = 0; m < NUM_MEL; m++) {
    const leftMel = melLow + m * delta;
    const centerMel = melLow + (m + 1) * delta;
    const rightMel = melLow + (m + 2) * delta;
    let start = -1;
    const weights = [];
    for (let k = 0; k < NUM_FFT_BINS; k++) {
      const mel = melScale(k * binHz);
      if (mel <= leftMel || mel >= rightMel) { if (start >= 0) break; continue; }
      const w = mel <= centerMel
        ? (mel - leftMel) / (centerMel - leftMel)
        : (rightMel - mel) / (rightMel - centerMel);
      if (start < 0) start = k;
      weights.push(w);
    }
    filters.push({ start: start < 0 ? 0 : start, weights });
  }
  return filters;
})();

// —— 迭代基-2 复数 FFT（就地，长度 512）——
const BITREV = (() => {
  const rev = new Uint16Array(NFFT);
  const bits = Math.log2(NFFT);
  for (let i = 0; i < NFFT; i++) {
    let x = i, r = 0;
    for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  return rev;
})();
// 预计算旋转因子
const COS = new Float32Array(NFFT / 2);
const SIN = new Float32Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) { COS[i] = Math.cos((-2 * Math.PI * i) / NFFT); SIN[i] = Math.sin((-2 * Math.PI * i) / NFFT); }

function fftPower(re, im, outPower) {
  // 位反转置换
  for (let i = 0; i < NFFT; i++) {
    const j = BITREV[i];
    if (j > i) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= NFFT; len <<= 1) {
    const half = len >> 1;
    const step = NFFT / len;
    for (let i = 0; i < NFFT; i += len) {
      for (let j = 0, tw = 0; j < half; j++, tw += step) {
        const c = COS[tw], s = SIN[tw];
        const a = i + j, b = i + j + half;
        const rb = re[b] * c - im[b] * s;
        const ib = re[b] * s + im[b] * c;
        re[b] = re[a] - rb; im[b] = im[a] - ib;
        re[a] += rb; im[a] += ib;
      }
    }
  }
  for (let k = 0; k < NUM_FFT_BINS; k++) outPower[k] = re[k] * re[k] + im[k] * im[k]; // 功率谱 |X|^2
}

/**
 * 计算 [T,80] log-mel fbank（已做逐句 mean-only CMN），扁平成 Float32Array（长度 T*80，行主序）。
 * @param {Float32Array} samples 16k 单声道样本，int16 尺度（[-32768,32767]，不要除以 32768）
 * @returns {{ feats: Float32Array, frames: number }}
 */
export function computeFbank(samples) {
  const N = samples.length;
  if (N < FRAME_LEN) return { feats: new Float32Array(0), frames: 0 };
  const T = 1 + Math.floor((N - FRAME_LEN) / FRAME_SHIFT); // snip_edges=True
  const feats = new Float32Array(T * NUM_MEL);

  const frame = new Float32Array(FRAME_LEN);
  const re = new Float32Array(NFFT);
  const im = new Float32Array(NFFT);
  const power = new Float32Array(NUM_FFT_BINS);

  for (let f = 0; f < T; f++) {
    const off = f * FRAME_SHIFT;
    // (1) 取 400 样本
    for (let i = 0; i < FRAME_LEN; i++) frame[i] = samples[off + i];
    // (2) remove_dc_offset：减去本帧均值
    let mean = 0; for (let i = 0; i < FRAME_LEN; i++) mean += frame[i]; mean /= FRAME_LEN;
    for (let i = 0; i < FRAME_LEN; i++) frame[i] -= mean;
    // (3) pre-emphasis：y[n]=x[n]-0.97*x[n-1]，x[-1]=x[0]（从后往前）
    for (let i = FRAME_LEN - 1; i >= 1; i--) frame[i] -= PREEMPH * frame[i - 1];
    frame[0] -= PREEMPH * frame[0];
    // (4) 加窗，并写入 FFT 实部缓冲（补零到 512）
    for (let i = 0; i < FRAME_LEN; i++) { re[i] = frame[i] * WINDOW[i]; im[i] = 0; }
    for (let i = FRAME_LEN; i < NFFT; i++) { re[i] = 0; im[i] = 0; }
    // (5) FFT + 功率谱
    fftPower(re, im, power);
    // (6) mel 滤波 + log
    const base = f * NUM_MEL;
    for (let m = 0; m < NUM_MEL; m++) {
      const filt = MEL_FILTERS[m];
      let e = 0;
      for (let j = 0; j < filt.weights.length; j++) e += filt.weights[j] * power[filt.start + j];
      feats[base + m] = Math.log(e < MEL_FLOOR ? MEL_FLOOR : e);
    }
  }

  // 逐句 mean-only CMN：每个 mel 维减去其在时间轴上的均值（训练时用的归一化，必须做）
  for (let m = 0; m < NUM_MEL; m++) {
    let colMean = 0;
    for (let f = 0; f < T; f++) colMean += feats[f * NUM_MEL + m];
    colMean /= T;
    for (let f = 0; f < T; f++) feats[f * NUM_MEL + m] -= colMean;
  }

  return { feats, frames: T };
}

export const FBANK = { NUM_MEL, FRAME_LEN, FRAME_SHIFT, SR };
