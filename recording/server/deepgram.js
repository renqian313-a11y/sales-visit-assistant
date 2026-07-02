// Deepgram：语音转写 + 声纹分角色（diarization）
// transcribeDiarized() —— 整段音频批量转写：结束定稿、以及录音中由 /diarize-live 滚动重算都用它。
import { config } from './config.js';
import { embedSamples, embedderReady } from './embedding.js';
import { decodeToPcm16k, concatWindows } from './decode.js';
import { agglomerate } from './cluster.js';

const BASE = 'api.deepgram.com';
// 公共转写参数：中文 + 标点 + 智能格式化；声纹分离仅在"批量/结束"时开（流式分离不稳定）
// 注意：不要加 keywords 词加权——Deepgram 的关键词加权对中文(zh)不支持，会直接返回 400。
function commonQuery({ diarize = false } = {}) {
  const q = new URLSearchParams({
    model: config.deepgram.model,
    language: 'zh',
    punctuate: 'true',
    smart_format: 'true',
  });
  if (diarize) q.set('diarize', 'true');
  return q;
}

// 把 Deepgram 的 words（含 speaker 序号）聚合成一轮一轮 [{ speaker, text }]。
// 只在【说话人切换】时另起一段——同一个人连续说话全程合并，不按停顿断句
// （按停顿断会把一个人正常说话的停顿拆成「这次」「呢」这种碎片）。
export function wordsToTurns(words) {
  const turns = [];
  for (const w of words || []) {
    const sp = w.speaker ?? 0;
    const t = w.punctuated_word || w.word || '';
    const last = turns[turns.length - 1];
    if (last && last.speaker === sp) last.text += t;
    else turns.push({ speaker: sp, text: t });
  }
  return turns.filter((t) => t.text.trim());
}

// 声纹兜底：当某一个音色占了绝大多数文字(≥ratio)时，认定其实只有一个人，
// 把零星被误判成「第二个人」的碎句并回主音色——避免一个人独白被拆成 说话人1/说话人2。
// 真正的两人对话里双方都会有相当篇幅，不会触发；随着录音变长会自动恢复成多角色。
export function collapseIfDominant(turns, ratio = 0.85) {
  const list = turns || [];
  if (list.length < 2) return list;
  const bySpk = {};
  let total = 0;
  for (const t of list) {
    const n = t.text.replace(/\s/g, '').length;
    bySpk[t.speaker] = (bySpk[t.speaker] || 0) + n;
    total += n;
  }
  if (!total) return list;
  let top = list[0].speaker, topN = -1;
  for (const k in bySpk) if (bySpk[k] > topN) { topN = bySpk[k]; top = k; }
  if (topN / total < ratio) return list;                 // 没有压倒性主音色 → 保持多角色
  return [{ speaker: top, text: list.map((t) => t.text).join('') }];  // 压倒性 → 全并成一个人
}

// 把说话人数封顶到 maxN：只保留说话时长(字数)最多的 maxN 个音色，其余并入"相邻"的保留音色。
// 用途：声纹盲分偶发把一个人拆成 3+ 个时，按"实际就两个人(BD+商家)"收敛，避免凭空冒出说话人3。
// 注意：真有 ≤maxN 个音色时此函数是 no-op，不影响正常两人对话。
export function capSpeakers(turns, maxN = 2) {
  const list = (turns || []).filter((t) => t.text && t.text.trim());
  if (list.length < 2) return list;
  const chars = {};
  for (const t of list) { const k = String(t.speaker ?? 0); chars[k] = (chars[k] || 0) + t.text.replace(/\s/g, '').length; }
  const ranked = Object.keys(chars).sort((a, b) => chars[b] - chars[a]);
  if (ranked.length <= maxN) return list;                // 音色数没超 → 原样
  const keep = new Set(ranked.slice(0, maxN));
  const out = [];
  let prevKept = ranked[0];                              // 开头就被淘汰则归到时长最大的音色
  for (const t of list) {
    let k = String(t.speaker ?? 0);
    if (!keep.has(k)) k = prevKept; else prevKept = k;   // 淘汰音色 → 并入前一段保留音色
    const last = out[out.length - 1];
    if (last && String(last.speaker) === k) last.text += t.text;  // 合并相邻同音色
    else out.push({ speaker: k, text: t.text });
  }
  return out;
}

// 声纹合并：Deepgram 声纹盲分常把同一个人拆成多个 speaker。这里对每个 Deepgram 说话人
// 用其全部词的音频算一个声纹向量，再凝聚合并"其实是同一个人"的 speaker（替代旧的按时长封顶）。
// 任一环节不可用/失败（模型缺失、解码失败、少于2人）→ 原样返回 words，零回归。
export async function mergeWords(words, audioBuffer, contentType, opts = {}) {
  if (!embedderReady() || !words || words.length < 2) return words;
  const bySpk = new Map();                       // spk(number) → [[开始秒,结束秒]...]
  for (const w of words) {
    if (w.start == null || w.end == null) continue;
    const sp = w.speaker ?? 0;
    if (!bySpk.has(sp)) bySpk.set(sp, []);
    bySpk.get(sp).push([w.start, w.end]);
  }
  if (bySpk.size < 2) return words;              // 只有一个说话人，无需合并
  let pcm;
  try { pcm = await decodeToPcm16k(audioBuffer, contentType); } catch { return words; }
  if (!pcm || !pcm.length) return words;
  const speakers = [];
  for (const [sp, wins] of bySpk) {
    const seg = concatWindows(pcm, wins, 16000);
    const durMs = wins.reduce((a, [s, e]) => a + (e - s) * 1000, 0);
    const emb = seg.length >= 8000 ? await embedSamples(seg) : null; // <0.5s 不出声纹
    speakers.push({ id: sp, emb, durMs });
  }
  const remap = agglomerate(speakers, {
    mergeSim: opts.mergeSim ?? 0.70,
    maxSpeakers: opts.maxSpeakers ?? 2,
    minClusterMs: opts.minClusterMs ?? 3000,
  });
  return words.map((w) => {
    const nid = remap.get(w.speaker ?? 0);
    return nid == null ? w : { ...w, speaker: nid };
  });
}

// 把分人轮次拼成带标记的文字稿，喂给大模型做纠错 + 角色映射
export function turnsToTaggedTranscript(turns) {
  return turns.map((t) => `[说话人${t.speaker}] ${t.text}`).join('\n');
}

// 按音色（声纹）给说话人编号：第一种音色→说话人1，第二种→说话人2…（按首次开口顺序）。
// 不做 BD/商家 角色猜测——只按音色区分。spk 为 0 基序号，给前端上色用。
// @returns {Array<{spk:number, speaker:string, text:string}>}
export function mapTurnsBySpeaker(turns) {
  const list = (turns || []).filter((t) => t.text && t.text.trim());
  const order = {};
  let n = 0;
  return list.map((t) => {
    const k = String(t.speaker ?? 0);
    if (!(k in order)) order[k] = n++;
    const spk = order[k];
    return { spk, speaker: '说话人' + (spk + 1), text: t.text };
  });
}

// 行业词偏置：喂给 Whisper 的 prompt，显著降低同音误识（货架↔话术、生菜↔什么、动销、客单价…）
const ASR_HINT = '以下是一段中文的销售拜访 / 门店经营对话，可能涉及：海报、立牌、展架、台卡、物料、铺设、张贴、活动报名、满减、促销、上线、流量扶持、返点、佣金、客流、客单价、营业额、动销、上架、铺货、对接、专员、老板、店长。';

// Deepgram：只取「说话人 + 词级时间戳」，文字交给 Whisper
async function deepgramWords(audioBuffer, contentType) {
  const url = `https://${BASE}/v1/listen?${commonQuery({ diarize: true }).toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${config.deepgram.apiKey}`, 'Content-Type': contentType },
    body: audioBuffer,
  });
  if (!res.ok) throw new Error(`Deepgram 转写失败 (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const alt = data?.results?.channels?.[0]?.alternatives?.[0] || {};
  return { words: alt.words || [], plain: alt.transcript || '' };
}

// Groq Whisper-large-v3：中文识别远好于 nova-2；verbose_json 拿到分句时间戳，用于对齐说话人
async function whisperTranscribe(audioBuffer, filename, model = config.groq.model) {
  if (!config.groq.apiKey) return null;
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', model);                        // 定稿用 large-v3，实时用 turbo
  form.append('language', 'zh');
  form.append('response_format', 'verbose_json');     // 带分句时间戳
  form.append('prompt', ASR_HINT);                    // 行业词偏置
  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${config.groq.apiKey}` }, body: form,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { text: (data.text || '').trim(), segments: data.segments || [] };
  } catch { return null; }
}

// 在时间区间 [s,e) 内，找与 Deepgram words 重叠最久的说话人（无对应词时返回 null）
function dominantSpeaker(words, s, e) {
  const dur = {};
  for (const w of words) {
    if (w.start == null || w.end == null || w.end <= s || w.start >= e) continue;
    const ov = Math.min(w.end, e) - Math.max(w.start, s);
    if (ov > 0) { const sp = w.speaker ?? 0; dur[sp] = (dur[sp] || 0) + ov; }
  }
  let bestSp = null, best = 0;
  for (const k in dur) if (dur[k] > best) { best = dur[k]; bestSp = Number(k); }
  return bestSp;
}

// 用 Whisper 的准确分句 + Deepgram 的说话人时间线，对齐成「带说话人的准确文字」
function alignWhisperToSpeakers(segments, words) {
  const turns = [];
  let lastSp = 0;
  for (const seg of segments) {
    const text = (seg.text || '').trim();
    if (!text) continue;
    let sp = dominantSpeaker(words, seg.start, seg.end);
    if (sp == null) sp = lastSp;          // 该句没有对应词 → 沿用上一个说话人
    lastSp = sp;
    const last = turns[turns.length - 1];
    if (last && last.speaker === sp) last.text += text;
    else turns.push({ speaker: sp, text });
  }
  return turns;
}

/**
 * 整段音频批量转写 + 声纹分离（Whisper 出准确文字，Deepgram 出说话人，按时间对齐）
 * @returns {Promise<{ words:array, turns:array, tagged:string, plain:string }>}
 */
export async function transcribeDiarized(audioBuffer, contentType = 'audio/webm', fast = false) {
  if (!config.deepgram.apiKey) throw new Error('未配置 DEEPGRAM_API_KEY，请在 .env 中填写');
  const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('mpeg') ? 'mp3' : contentType.includes('wav') ? 'wav' : 'webm';
  const whisperModel = fast ? config.groq.asrFastModel : config.groq.model;  // 实时用 turbo 求快，定稿用 large-v3 求准

  // 说话人(Deepgram) 与 准确文字(Whisper) 并行跑，省一半等待
  const [dg, wh] = await Promise.all([
    deepgramWords(audioBuffer, contentType),
    whisperTranscribe(audioBuffer, `audio.${ext}`, whisperModel),
  ]);

  // 定稿时用声纹合并 Deepgram 过分裂的说话人；实时滚动(fast)跳过（省算力，且结束会覆盖）。
  const words = fast ? dg.words : await mergeWords(dg.words, audioBuffer, contentType, config.speaker);

  let turns, plain;
  if (wh && wh.segments.length && words.length) {
    turns = collapseIfDominant(alignWhisperToSpeakers(wh.segments, words)); // 首选：准确文字 + 说话人
    plain = wh.text;
  } else if (wh && wh.text) {
    turns = [{ speaker: 0, text: wh.text }];          // 有准确文字但拿不到对齐信息 → 单说话人
    plain = wh.text;
  } else {
    turns = collapseIfDominant(wordsToTurns(words)); // Whisper 不可用 → 退回 Deepgram 文字
    plain = dg.plain;
  }
  return { words, turns, tagged: turnsToTaggedTranscript(turns), plain };
}
