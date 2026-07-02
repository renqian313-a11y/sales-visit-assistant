// 基频(F0)估计 + 男女声判别，用于"按男女音色分说话人"。
// 输入：16kHz / 16bit / 单声道 PCM Buffer（一句话对应的那段音频）。
// 男声基频偏低(约 85–180Hz)，女声偏高(约 165–255Hz)，用 ~165Hz 作分界。

const SR = 16000;
const BOUNDARY = Number(process.env.GENDER_PITCH_HZ || 165);

/**
 * 自相关法估计一段 PCM 的基频中位数(Hz)。静音/太短/无清晰基频时返回 0。
 */
export function estimatePitch(buf) {
  const N = buf.length >> 1;                 // 样本数(16bit)
  if (N < 1024) return 0;
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = buf.readInt16LE(i * 2) / 32768;

  const minLag = Math.floor(SR / 300);       // 上限 300Hz
  const maxLag = Math.floor(SR / 70);        // 下限 70Hz
  const win = 1024, hop = 512, f0s = [];
  for (let off = 0; off + win <= N; off += hop) {
    let e0 = 0;
    for (let i = 0; i < win; i++) e0 += x[off + i] * x[off + i];
    if (e0 / win < 1e-4) continue;           // 能量太低=静音，跳过
    let bestLag = 0, best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < win - lag; i++) s += x[off + i] * x[off + i + lag];
      if (s > best) { best = s; bestLag = lag; }
    }
    if (bestLag > 0 && best / e0 > 0.3) f0s.push(SR / bestLag);  // 归一化阈值，滤掉无基频帧
  }
  if (!f0s.length) return 0;
  f0s.sort((a, b) => a - b);
  return f0s[f0s.length >> 1];               // 中位数更抗噪
}

/** F0 → 'm'(男) / 'f'(女) / '?'(无法判断)。 */
export function genderOf(f0) {
  if (!f0) return '?';
  return f0 < BOUNDARY ? 'm' : 'f';
}
