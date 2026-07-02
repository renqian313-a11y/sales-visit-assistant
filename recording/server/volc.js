// 火山引擎 语音识别大模型 实时流式转写（双向流式优化版 bigmodel_async）客户端
//   端点：wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
//   鉴权：WebSocket 握手 HTTP Header 传 X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id / X-Api-Request-Id
//   二进制协议：每帧 = header(4B) + [sequence(4B)] + payloadSize(4B, 大端) + payload(gzip)
//     · full client request：首帧发送 JSON 参数（含音频/请求配置）
//     · audio only request：后续帧发送 PCM 音频（16k/16bit/单声道）
//   返回：full server response，payload 为 gzip JSON，含 result.text / result.utterances[]
//     · utterances[].definite=true 表示该分句判停定稿；additions.speaker_id 为说话人号
//   说话人分离：enable_speaker_info + ssd_version=200（ASR2.0），说话人号直接填入 seg.role，
//     与 xfyun.js 契约完全一致，后端 index.js 与前端零改动。
import WebSocket from 'ws';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from './config.js';

const URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

// —— 协议常量 ——
const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001;                 // 4 字节
const MSG_FULL_CLIENT = 0b0001;             // full client request
const MSG_AUDIO_ONLY = 0b0010;              // audio only request
const MSG_FULL_SERVER = 0b1001;             // full server response
const MSG_ERROR = 0b1111;                   // 服务端错误
const FLAG_POS_SEQ = 0b0001;                // header 后 4B 为正 sequence
const FLAG_NEG_SEQ = 0b0011;                // header 后 4B 为负 sequence（最后一包）
const SER_JSON = 0b0001;
const SER_RAW = 0b0000;
const COMP_GZIP = 0b0001;
const COMP_NONE = 0b0000;

function header(msgType, flags, serial, comp) {
  const b = Buffer.alloc(4);
  b[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE;
  b[1] = (msgType << 4) | flags;
  b[2] = (serial << 4) | comp;
  b[3] = 0;
  return b;
}
function int32be(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n | 0, 0);
  return b;
}
// full client request：JSON 参数（gzip）
function buildFullClient(seq) {
  const payload = {
    user: { uid: 'visit-assistant' },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_nonstream: true,          // 二遍识别：实时快 + 分句重识别更准
      enable_itn: true,                // 数字规范化
      enable_punc: true,               // 标点
      enable_ddc: true,                // 语义顺滑
      show_utterances: true,           // 输出分句/definite
      enable_speaker_info: true,       // 说话人聚类分离
      ssd_version: '200',              // ASR2.0 SSD（配合说话人分离）
      result_type: 'full',             // 全量返回
      end_window_size: 800,            // 800ms 判停分句（实时性）
    },
  };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return Buffer.concat([header(MSG_FULL_CLIENT, FLAG_POS_SEQ, SER_JSON, COMP_GZIP), int32be(seq), int32be(gz.length), gz]);
}
// audio only request：PCM（gzip）
function buildAudio(seq, pcm, isLast) {
  const gz = zlib.gzipSync(pcm);
  const flags = isLast ? FLAG_NEG_SEQ : FLAG_POS_SEQ;
  const s = isLast ? -seq : seq;
  return Buffer.concat([header(MSG_AUDIO_ONLY, flags, SER_RAW, COMP_GZIP), int32be(s), int32be(gz.length), gz]);
}

// 解析服务端返回帧 → { code, seq, payload(object|string) }
function parseServer(buf) {
  if (!buf || buf.length < 4) return null;
  const headerSize = (buf[0] & 0x0f) * 4;
  const msgType = (buf[1] >> 4) & 0x0f;
  const flags = buf[1] & 0x0f;
  const comp = buf[2] & 0x0f;
  let pos = headerSize;
  let seq = 0;
  if (flags & 0b0001) { seq = buf.readInt32BE(pos); pos += 4; }        // 含 sequence
  else if (flags & 0b0010) { seq = buf.readInt32BE(pos); pos += 4; }   // 最后一包也带 4B
  if (pos + 4 > buf.length) return { msgType, seq, payload: null };
  const size = buf.readUInt32BE(pos); pos += 4;
  let raw = buf.subarray(pos, pos + size);
  if (comp === COMP_GZIP && raw.length) { try { raw = zlib.gunzipSync(raw); } catch { /* keep raw */ } }
  let payload = null;
  const txt = raw.toString('utf8');
  try { payload = JSON.parse(txt); } catch { payload = txt; }
  return { msgType, seq, payload };
}

// 从 result.utterances 里抽定稿/中间分句 → 逐条 {final, role, text, bg, ed}
function extractSegs(result) {
  const out = [];
  const utts = (result && result.utterances) || [];
  for (const u of utts) {
    const text = (u.text || '').trim();
    if (!text) continue;
    const spk = u.additions && (u.additions.speaker_id != null) ? Number(u.additions.speaker_id) : 0;
    out.push({
      final: u.definite === true,
      role: Number.isFinite(spk) ? spk : 0,
      text,
      bg: Number(u.start_time) || 0,
      ed: Number(u.end_time) || 0,
    });
  }
  return out;
}

/**
 * 打开一条到火山引擎的实时转写连接。事件契约与 xfyun.js 完全一致。
 * @param {(ev:{type:'started'|'seg'|'error'|'close', final?:boolean, role?:number, text?:string, bg?:number, ed?:number, error?:string})=>void} onEvent
 * @returns {{ isStarted:()=>boolean, sendAudio:(buf:Buffer)=>void, end:()=>void, close:()=>void }}
 */
export function openVolcASR(onEvent) {
  const appKey = config.volc.appKey;
  const accessKey = config.volc.accessKey;
  const resourceId = config.volc.resourceId;
  const ws = new WebSocket(URL, {
    headers: {
      'X-Api-App-Key': appKey,
      'X-Api-Access-Key': accessKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': crypto.randomUUID(),
      'X-Api-Connect-Id': crypto.randomUUID(),
    },
  });

  let started = false;
  let seq = 1;
  const emitted = new Set();   // 已作为 final 吐出的分句 key（bg-ed-len），避免重复

  ws.on('open', () => {
    try { ws.send(buildFullClient(seq++)); } catch (e) { onEvent({ type: 'error', error: String(e && e.message || e) }); }
  });
  ws.on('message', (raw) => {
    const msg = parseServer(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    if (!msg) return;
    if (msg.msgType === MSG_ERROR) {
      const err = (msg.payload && (msg.payload.error || msg.payload.message)) || (typeof msg.payload === 'string' ? msg.payload : '火山转写出错');
      return onEvent({ type: 'error', error: err });
    }
    if (msg.msgType !== MSG_FULL_SERVER) return;
    if (!started) { started = true; onEvent({ type: 'started' }); }
    const result = msg.payload && msg.payload.result;
    if (!result) return;
    for (const seg of extractSegs(result)) {
      if (seg.final) {
        const key = seg.bg + '-' + seg.ed + '-' + seg.text.length;
        if (emitted.has(key)) continue;   // 全量返回会重复带历史分句，去重只吐一次
        emitted.add(key);
        onEvent({ type: 'seg', final: true, role: seg.role, text: seg.text, bg: seg.bg, ed: seg.ed });
      } else {
        onEvent({ type: 'seg', final: false, role: seg.role, text: seg.text, bg: seg.bg, ed: seg.ed });
      }
    }
  });
  ws.on('error', (e) => onEvent({ type: 'error', error: String((e && e.message) || e) }));
  ws.on('close', () => onEvent({ type: 'close' }));

  return {
    isStarted: () => started,
    sendAudio: (buf) => { if (ws.readyState === WebSocket.OPEN) { try { ws.send(buildAudio(seq++, Buffer.isBuffer(buf) ? buf : Buffer.from(buf), false)); } catch { /* ignore */ } } },
    end: () => { try { if (ws.readyState === WebSocket.OPEN) ws.send(buildAudio(seq++, Buffer.alloc(0), true)); } catch { /* ignore */ } },
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}
