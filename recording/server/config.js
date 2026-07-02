// 读取 .env（无依赖的极简实现，避免再装一个包）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const config = {
  port: process.env.PORT || 4100,
  asrProvider: process.env.ASR_PROVIDER || 'volc',       // 实时流式转写引擎：volc(火山) | xfyun(讯飞)
  maxSpeakers: Number(process.env.MAX_SPEAKERS || 2),   // 说话人数封顶（拜访场景默认 BD+商家=2）
  // —— 声纹分说话人（CAM++ ONNX）——模型缺失/关闭时全部回退旧逻辑，零回归 ——
  speaker: {
    modelPath: process.env.SPEAKER_MODEL_PATH || path.join(__dirname, '..', 'models', 'campplus_zh.onnx'),
    sim: Number(process.env.SPEAKER_SIM || 0.55),            // 在线：与质心余弦相似度≥此值→同一人
    newDurMs: Number(process.env.SPEAKER_NEW_DUR_MS || 1500),// 在线：短于此的句子不许开新说话人（防过分裂）
    minEmbMs: Number(process.env.SPEAKER_MIN_EMB_MS || 700), // 短于此的音频不出声纹（沿用上一说话人）
    mergeSim: Number(process.env.SPEAKER_MERGE_SIM || 0.70), // 定稿：合并两个 Deepgram 说话人的相似度门槛
    minClusterMs: Number(process.env.SPEAKER_MIN_CLUSTER_MS || 3000), // 定稿：小于此时长的簇并入最近的人
    maxSpeakers: Number(process.env.MAX_SPEAKERS || 2),     // 复用同一封顶
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat',
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_ASR_MODEL || 'whisper-large-v3',
    asrFastModel: process.env.GROQ_ASR_FAST_MODEL || 'whisper-large-v3-turbo', // 实时预览用，快好几倍略糙
    chatModel: process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile',   // 文字校准用
  },
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY || '',
    model: process.env.DEEPGRAM_MODEL || 'nova-2',
  },
  // 火山引擎 语音识别大模型（双向流式优化版 bigmodel_async，自带说话人分离；ASR_PROVIDER=volc 时启用）
  volc: {
    appKey: process.env.VOLC_APP_KEY || '',
    accessKey: process.env.VOLC_ACCESS_KEY || '',
    secretKey: process.env.VOLC_SECRET_KEY || '',
    resourceId: process.env.VOLC_RESOURCE_ID || 'volc.bigasr.sauc.duration',
  },
  // 讯飞听见 实时语音转写（流式，做实时预览；定稿仍走 Whisper /diarize）
  xfyun: {
    appId: process.env.XFYUN_APPID || '',
    accessKeyId: process.env.XFYUN_API_KEY || '',       // 控制台的 APIKey
    accessKeySecret: process.env.XFYUN_API_SECRET || '', // 控制台的 APISecret
    lang: process.env.XFYUN_LANG || 'autodialect',       // cn 不支持，用 autodialect
  },
};
