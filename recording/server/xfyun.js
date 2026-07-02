// 讯飞听见 实时语音转写（流式）客户端
//   端点：wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1
//   鉴权：参数按名升序拼 baseString → HmacSHA1(baseString, accessKeySecret) → base64 → signature
//   音频：PCM 16k / 16bit / 单声道，二进制帧直送（建议 40ms / 1280B，但流式小帧也接受）
//   结束：发文本 {"end": true}
//   角色分离：role_type=2，返回 cn.st.rt[].ws[].cw[].rl（1/2/3=切到该说话人，0=沿用上一个）
import WebSocket from 'ws';
import crypto from 'node:crypto';
import { config } from './config.js';

const HOST = 'office-api-ast-dx.iflyaisol.com';
const PATH = '/ast/communicate/v1';

function signedUrl() {
  const { appId, accessKeyId, accessKeySecret, lang } = config.xfyun;
  const utc = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+0800'; // 北京时间
  const uuid = crypto.randomUUID().replace(/-/g, '');
  const params = {
    accessKeyId,
    appId,
    audio_encode: 'pcm_s16le',
    lang: lang || 'autodialect',
    role_type: '2',
    samplerate: '16000',
    utc,
    uuid,
  };
  const enc = (s) => encodeURIComponent(s);
  const parts = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`);
  const baseString = parts.join('&');
  const signature = crypto.createHmac('sha1', accessKeySecret).update(baseString).digest('base64');
  return `wss://${HOST}${PATH}?${baseString}&signature=${enc(signature)}`;
}

// 从一条讯飞结果里抽出 { final, role, text }（取不到返回 null）
function parseResult(msg) {
  const st = msg?.data?.cn?.st;
  if (!st) return null;
  const final = String(st.type) === '0'; // 0=确定结果，1=中间结果
  let text = '';
  let role = 0;
  for (const rt of st.rt || []) {
    for (const w of rt.ws || []) {
      for (const cw of w.cw || []) {
        text += cw.w || '';
        const rl = Number(cw.rl);
        if (rl > 0) role = rl; // 切换到该说话人
      }
    }
  }
  return { final, role, text: text.trim(), bg: Number(st.bg) || 0, ed: Number(st.ed) || 0 }; // bg/ed: 句子起止(ms)
}

/**
 * 打开一条到讯飞的实时转写连接。
 * @param {(ev:{type:'started'|'seg'|'error'|'close', final?:boolean, role?:number, text?:string, error?:string})=>void} onEvent
 * @returns {{ isStarted:()=>boolean, sendAudio:(buf:Buffer)=>void, end:()=>void, close:()=>void }}
 */
export function openXfyunASR(onEvent) {
  const ws = new WebSocket(signedUrl());
  let started = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const action = msg?.data?.action || msg?.action;
    if (action === 'started') { started = true; return onEvent({ type: 'started' }); }
    if (action === 'error' || msg?.msg_type === 'error') {
      return onEvent({ type: 'error', error: msg?.desc || msg?.data?.desc || '讯飞转写出错' });
    }
    const seg = parseResult(msg);
    if (seg && seg.text) onEvent({ type: 'seg', final: seg.final, role: seg.role, text: seg.text, bg: seg.bg, ed: seg.ed });
  });
  ws.on('error', (e) => onEvent({ type: 'error', error: String((e && e.message) || e) }));
  ws.on('close', () => onEvent({ type: 'close' }));

  return {
    isStarted: () => started,
    sendAudio: (buf) => { if (ws.readyState === WebSocket.OPEN) ws.send(buf); },
    end: () => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ end: true })); } catch { /* ignore */ } },
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}
