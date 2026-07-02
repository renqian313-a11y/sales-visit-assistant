// 语音转写：调用 Groq 的 Whisper（OpenAI 兼容接口）
// 想换成火山引擎/讯飞，只需重写这一个函数，其余代码不用动。
import { config } from './config.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * @param {Buffer} audioBuffer 音频二进制
 * @param {string} filename    带扩展名的文件名（如 visit.webm / visit.mp4）
 * @returns {Promise<string>}  识别出的文字
 */
export async function transcribe(audioBuffer, filename) {
  if (!config.groq.apiKey) {
    throw new Error('未配置 GROQ_API_KEY，请在 .env 中填写');
  }

  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', config.groq.model);
  form.append('language', 'zh'); // 普通话
  form.append('response_format', 'json');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groq.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`语音转写失败 (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return (data.text || '').trim();
}
