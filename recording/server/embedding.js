// 声纹嵌入：int16 PCM → fbank → CAM++(ONNX) → L2 归一化的 192 维向量。
// 单例会话 + 串行推理（onnxruntime-node run 是异步的，串起来保证顺序、避免并发抢占）。
// 优雅降级：模型文件不存在或加载失败 → embedderReady()=false，上层全部回退旧逻辑。

import fs from 'node:fs';
import { config } from './config.js';
import { computeFbank, FBANK } from './fbank.js';

let ort = null;       // 懒加载 onnxruntime-node（没装也不至于整个服务起不来）
let session = null;
let ready = false;
let loadTried = false;
let chain = Promise.resolve(); // 串行推理队列

const modelPath = config.speaker.modelPath;

async function ensureLoaded() {
  if (loadTried) return ready;
  loadTried = true;
  try {
    if (!fs.existsSync(modelPath)) { console.warn('[embedding] 模型不存在，声纹分说话人已禁用：' + modelPath); return false; }
    ort = await import('onnxruntime-node');
    session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    ready = true;
    console.log('[embedding] CAM++ 声纹模型已加载：' + modelPath);
  } catch (e) {
    console.warn('[embedding] 声纹模型加载失败，回退旧逻辑：' + (e?.message || e));
    ready = false;
  }
  return ready;
}

/** 模型是否就绪（同步查询；首次需先 await warmup() 触发加载）。 */
export function embedderReady() { return ready; }

/** 进程启动时预热：加载模型 + 跑一次空推理做 JIT，避免首句卡顿。幂等、失败静默。 */
export async function warmup() {
  if (!(await ensureLoaded())) return false;
  try {
    const T = 200;
    const x = new ort.Tensor('float32', new Float32Array(T * FBANK.NUM_MEL), [1, T, FBANK.NUM_MEL]);
    await session.run({ x });
  } catch { /* 预热失败无所谓 */ }
  return ready;
}

function l2normalize(vec) {
  let n = 0; for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

/**
 * 由 16k 单声道、int16 尺度的 Float32 样本算 L2 归一化声纹向量。
 * @param {Float32Array} samples int16 尺度（[-32768,32767]），不是 [-1,1]
 * @returns {Promise<Float32Array|null>} 192 维；样本太短/未就绪返回 null
 */
export function embedSamples(samples) {
  if (!ready || !session) return Promise.resolve(null);
  const { feats, frames } = computeFbank(samples);
  if (!frames) return Promise.resolve(null);
  // 串到推理队列，保证一次只跑一个 run
  const run = chain.then(async () => {
    const x = new ort.Tensor('float32', feats, [1, frames, FBANK.NUM_MEL]);
    const out = await session.run({ x });
    const emb = out.embedding.data; // Float32Array(192)
    return l2normalize(emb);
  }).catch(() => null);
  chain = run.catch(() => {}); // 不让单次失败中断队列
  return run;
}

/** 由 int16 PCM Buffer（16k 单声道，LE）算声纹向量。 */
export function embedPcm(buf) {
  if (!buf || buf.length < 2) return Promise.resolve(null);
  const n = buf.length >> 1;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = buf.readInt16LE(i * 2); // int16 尺度，不除 32768
  return embedSamples(s);
}
