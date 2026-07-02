// 定稿轨用：把上传的 webm(Opus)/mp4(AAC) 整段解码成 16k 单声道 PCM，
// 再按 Deepgram 词级时间戳拼出每个说话人的音频去算声纹。用打包的 ffmpeg 二进制，无系统依赖。
import { spawn } from 'node:child_process';

let ffmpegPath = null;
try { ffmpegPath = (await import('@ffmpeg-installer/ffmpeg')).default.path; } catch { ffmpegPath = null; }

/**
 * 解码任意容器 → 16k 单声道 Float32（int16 尺度，[-32768,32767]，供 fbank 直接用）。
 * 解码器不可用或 ffmpeg 非零退出时抛错，让调用方回退旧逻辑。
 * @returns {Promise<Float32Array>}
 */
export function decodeToPcm16k(buffer) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg 不可用'));
    const ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1']);
    const chunks = []; let err = '';
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg 解码失败(' + code + '): ' + err.slice(0, 200)));
      const buf = Buffer.concat(chunks);
      const n = buf.length >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2); // int16 尺度，不除 32768
      resolve(out);
    });
    ff.stdin.on('error', () => {}); // 忽略下游提前关闭导致的 EPIPE
    ff.stdin.end(buffer);
  });
}

/**
 * 按若干时间窗（秒）从 16k PCM 里拼出一段音频。
 * @param {Float32Array} pcm 16k 单声道
 * @param {Array<[number,number]>} windows [开始秒, 结束秒]
 * @param {number} sr 采样率
 * @returns {Float32Array}
 */
export function concatWindows(pcm, windows, sr = 16000) {
  let total = 0;
  const spans = [];
  for (const [s, e] of windows) {
    const a = Math.max(0, Math.floor(s * sr));
    const b = Math.min(pcm.length, Math.ceil(e * sr));
    if (b > a) { spans.push([a, b]); total += b - a; }
  }
  const out = new Float32Array(total);
  let pos = 0;
  for (const [a, b] of spans) { out.set(pcm.subarray(a, b), pos); pos += b - a; }
  return out;
}

export function decoderReady() { return !!ffmpegPath; }
