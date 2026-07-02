import express from 'express';
import multer from 'multer';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { analyze, extractTaskFields } from './llm.js';
import { KEYWORDS } from './keywords.js';
import { transcribeDiarized, mapTurnsBySpeaker, capSpeakers } from './deepgram.js';
import { openXfyunASR } from './xfyun.js';
import { openVolcASR } from './volc.js';
import { estimatePitch, genderOf } from './pitch.js';       // 声纹不可用时的回退（按男女声）
import { OnlineClusterer } from './cluster.js';
import { embedPcm, embedderReady, warmup } from './embedding.js';
import { correctTurns } from './correct.js';
import * as store from './store.js';

// 一句开头的标点（讯飞常把上句收尾标点甩到下句最前）——用于把它挪回上一条末尾
const LEAD_PUNCT = /^[\s，。！？、；：,.!?…·]+/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// 兼托上级工程目录：使 visit-assistant.html / asr-engine.js / recording/ 静态资源同源可访问，便于同源直连 WS
app.use(express.static(path.join(__dirname, '..', '..')));

// 1) 开始一次拜访（含录音授权）
app.post('/api/visit/start', (req, res) => {
  const { customer_name, store_type, bd_user, consent } = req.body || {};
  if (!consent) return res.status(400).json({ error: '需要先同意录音授权' });
  res.json(store.createVisit({ customer_name, store_type, bd_user, consent }));
});

// 2) 拜访结束：用【实时累计的分人转写】或整段录音 → 大模型纠错+映射角色+分析
app.post('/api/visit/:id/finish', upload.single('audio'), async (req, res) => {
  const visit = store.getVisit(req.params.id);
  if (!visit) return res.status(404).json({ error: '找不到该拜访记录' });

  try {
    let transcript;
    if (req.file) {
      // 整段上传模式：用 Deepgram 批量声纹分离
      const mime = req.file.mimetype || 'audio/webm';
      const ext = mime.includes('mp4') ? 'mp4' : mime.includes('mpeg') ? 'mp3' : 'webm';
      store.saveAudio(visit.id, req.file.buffer, ext);
      store.updateVisit(visit.id, { audio_file: `${visit.id}.${ext}`, status: 'transcribing', end_time: new Date().toISOString() });
      const dg = await transcribeDiarized(req.file.buffer, mime);
      transcript = dg.tagged;
    } else {
      // 实时流式模式：直接用录音过程中累计好的分人转写（已带 [说话人N] 标记）
      transcript = (visit.live_transcript || '').trim();
      store.updateVisit(visit.id, { status: 'summarizing', end_time: new Date().toISOString() });
      if (!transcript) return res.status(400).json({ error: '没有可分析的内容（既没有录音文件，也没有实时转写）' });
    }

    store.updateVisit(visit.id, { transcript, status: 'summarizing' });
    const result = await analyze(transcript);

    const done = store.updateVisit(visit.id, { ...result, status: 'done' });
    res.json(done);
  } catch (err) {
    store.updateVisit(visit.id, { status: 'error' });
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 纯声纹分离：整段录音 → Deepgram 批量分离 → 按音色映射角色(不依赖大模型)
app.post('/api/visit/:id/diarize', upload.single('audio'), async (req, res) => {
  const visit = store.getVisit(req.params.id);
  if (!visit) return res.status(404).json({ error: '找不到该拜访记录' });
  if (!req.file) return res.status(400).json({ error: '没有收到录音文件' });
  try {
    const mime = req.file.mimetype || 'audio/webm';
    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('mpeg') ? 'mp3' : 'webm';
    store.saveAudio(visit.id, req.file.buffer, ext);
    const dg = await transcribeDiarized(req.file.buffer, mime);
    const speakers = mapTurnsBySpeaker(capSpeakers(dg.turns, config.maxSpeakers)); // 封顶人数 → 说话人1/2…
    // LLM 校准(错别字/简体/标点) 与 任务字段抽取 并行跑，省一次等待
    const [dialogue, fields] = await Promise.all([
      correctTurns(speakers),
      extractTaskFields(dg.plain),                      // 根据纪要抽 海报/立牌/活动 + 品类/面积/桌位/联系人/电话
    ]);
    store.updateVisit(visit.id, { audio_file: `${visit.id}.${ext}`, dialogue, transcript: dg.plain, task_fields: fields, status: 'done', end_time: new Date().toISOString() });
    res.json({ dialogue, transcript: dg.plain, fields });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 录音中的"滚动声纹重算"：把【整段已录音频】批量声纹分离，返回准确的按音色分角色。
// 与 /diarize 的区别：不改状态、不落盘、不结束——前端每隔几秒调一次，把准确角色回填到实时界面。
app.post('/api/visit/:id/diarize-live', upload.single('audio'), async (req, res) => {
  const visit = store.getVisit(req.params.id);
  if (!visit) return res.status(404).json({ error: '找不到该拜访记录' });
  if (!req.file) return res.status(400).json({ error: '没有收到录音文件' });
  try {
    const dg = await transcribeDiarized(req.file.buffer, req.file.mimetype || 'audio/webm', true); // fast: turbo 模型
    const turns = mapTurnsBySpeaker(capSpeakers(dg.turns, config.maxSpeakers));   // 封顶人数 → 说话人1/2…
    // 实时这一拍【不做 LLM 校准】求快——Whisper 文字已较准，错别字/标点留到结束定稿(/diarize)统一洗
    store.updateVisit(visit.id, { live_dialogue: turns });
    res.json({ turns, transcript: dg.plain });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 关键词词库（前端实时高亮用）
app.get('/api/keywords', (_req, res) => res.json(KEYWORDS));

// 3) 编辑保存：BD 微调总结/Todo/话术后保存
app.patch('/api/visit/:id', (req, res) => {
  const v = store.getVisit(req.params.id);
  if (!v) return res.status(404).json({ error: '找不到该拜访记录' });
  const allow = ['customer_name', 'summary', 'todos', 'scripts'];
  const patch = {};
  for (const k of allow) if (k in (req.body || {})) patch[k] = req.body[k];
  patch.edited_at = new Date().toISOString();
  res.json(store.updateVisit(v.id, patch));
});

// 4) 查询单条 / 列表
app.get('/api/visit/:id', (req, res) => {
  const v = store.getVisit(req.params.id);
  v ? res.json(v) : res.status(404).json({ error: '找不到该拜访记录' });
});
app.get('/api/visits', (_req, res) => res.json(store.listVisits()));

// —— 实时转写：浏览器 PCM 流 → 本服务 → 讯飞听见（中转，密钥不暴露给前端）——
// 实时轨：讯飞流式出字（亚秒）。说话人用【声纹在线聚类】的 sticky 槽位分配——某句一旦定到
//   说话人N 就不再改，全程追加式、不回溯改写，保证已显示的内容稳定不闪不跳。
//   声纹模型缺失时自动回退按男女声分。定稿轨：结束时整段走 /diarize（Whisper 提准）覆盖。
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/live' });
warmup().catch(() => {});   // 进程启动即预热声纹模型（异步、失败静默），避免首句卡顿

wss.on('connection', (client, req) => {
  const visitId = new URL(req.url, 'http://x').searchParams.get('visitId');
  const visit = visitId && store.getVisit(visitId);
  if (!visit) { client.close(1008, '无效的拜访ID'); return; }
  const useVolc = config.asrProvider === 'volc';
  if (useVolc) {
    if (!config.volc.appKey || !config.volc.accessKey) {
      client.send(JSON.stringify({ type: 'error', error: '未配置火山凭证（VOLC_APP_KEY/VOLC_ACCESS_KEY）' }));
      client.close(); return;
    }
  } else if (!config.xfyun.appId) {
    client.send(JSON.stringify({ type: 'error', error: '未配置讯飞凭证（XFYUN_APPID/API_KEY/API_SECRET）' }));
    client.close(); return;
  }

  const buffered = [];        // 讯飞 started 前先缓存音频
  const turns = [];           // 稳定输出 [{ spk, speaker, text }]：追加式，仅最后一条会随说话增长
  // 分说话人：优先【声纹】——每句取其音频→CAM++ 声纹向量→在线粘性聚类到说话人槽位。
  // 声纹不可用(模型缺失)时回退【男女声】旧逻辑。两者都追加式、不回改，保证不闪不跳。
  const pcmChunks = [];       // 留存全部 PCM（16k/16bit），按 bg/ed(ms) 切片取声纹/基频
  let pcmBytes = 0;
  const pushPcm = (b) => { pcmChunks.push(b); pcmBytes += b.length; };
  const pcmSlice = (a, z) => {                 // 取字节区间 [a,z) 的 PCM
    a = Math.max(0, a); z = Math.min(pcmBytes, z); if (z <= a) return Buffer.alloc(0);
    const out = []; let pos = 0;
    for (const c of pcmChunks) {
      const s = pos, e = pos + c.length; pos = e;
      if (e <= a) continue; if (s >= z) break;
      out.push(c.subarray(Math.max(0, a - s), Math.min(c.length, z - s)));
    }
    return Buffer.concat(out);
  };
  const clusterer = new OnlineClusterer(config.speaker);   // 声纹在线聚类（默认路径）
  const genderSlot = {};      // 回退：'m'/'f' → 说话人槽位(0基)，仅当声纹不可用时启用
  let nextSlot = 0, lastSlot = 0;
  const assignByGender = (g) => {
    if (g === '?') return lastSlot;                          // 没基频(太短/静音) → 沿用上一个
    if (g in genderSlot) return genderSlot[g];
    if (nextSlot < Math.max(1, config.maxSpeakers)) { genderSlot[g] = nextSlot++; return genderSlot[g]; }
    return lastSlot;
  };
  // 火山自带说话人分离：把其说话人号(ev.role)按出现顺序稳定映射到 0基槽位 → 说话人N，不再算声纹
  const roleSlot = {};
  let roleNext = 0;
  const assignByRole = (role) => {
    const key = String(role == null ? 0 : role);
    if (key in roleSlot) return roleSlot[key];
    return (roleSlot[key] = roleNext++);
  };
  const send = (obj) => { if (client.readyState === client.OPEN) client.send(JSON.stringify(obj)); };

  // 定稿一句：算说话人槽位 → 追加/续写气泡 → 推送。声纹推理是异步的，用 segChain 串行保证
  //   逐句按序处理；turns[] 只增不改，已显示的气泡永不被回改（不闪不跳）。
  let segChain = Promise.resolve();
  const handleFinalSeg = async (ev) => {
    let spk;
    if (useVolc) {
      spk = assignByRole(ev.role);                          // 火山自带说话人号 → 稳定槽位（不算声纹）
    } else {
      const pcm = pcmSlice(ev.bg * 32, ev.ed * 32);         // 32 字节/ms @16k/16bit
      const durMs = ev.ed - ev.bg;
      if (embedderReady()) {
        let emb = null;
        if (pcm.length >= config.speaker.minEmbMs * 32) { try { emb = await embedPcm(pcm); } catch { emb = null; } }
        spk = clusterer.assign(emb, durMs);                 // emb=null/太短 → 沿用上一说话人
      } else {
        const g = genderOf(estimatePitch(pcm)); spk = assignByGender(g); lastSlot = spk; // 回退
      }
    }
    const last = turns[turns.length - 1];
    if (last && last.spk === spk) {
      last.text += ev.text;                                 // 同说话人 → 续写（标点自然落在中间）
    } else {
      // 新气泡：讯飞常把上一句的收尾标点甩到下一句最前面。把开头标点挪回上一条末尾，
      //   别挂在新气泡最前面（否则每个气泡都以 。/，/？ 开头，很难看）。
      let text = ev.text;
      const m = text.match(LEAD_PUNCT);
      if (m) {
        text = text.slice(m[0].length);
        const lead = m[0].replace(/\s+/g, '');
        if (last && lead && !/[，。！？、；：,.!?…]$/.test(last.text)) last.text += lead;
      }
      turns.push({ spk, speaker: '说话人' + (spk + 1), text });
    }
    store.updateVisit(visit.id, { live_dialogue: turns });
    send({ type: 'dialogue', turns, interim: '' });
  };

  const openASR = useVolc ? openVolcASR : openXfyunASR;
  const xf = openASR((ev) => {
    if (ev.type === 'started') {
      buffered.forEach((b) => xf.sendAudio(b)); buffered.length = 0;
    } else if (ev.type === 'seg') {
      if (ev.final) {
        segChain = segChain.then(() => handleFinalSeg(ev)).catch(() => {}); // 串行、按序、追加式
      } else {
        send({ type: 'dialogue', turns, interim: ev.text.replace(LEAD_PUNCT, '') }); // 中间结果：只动 interim（去掉开头标点）
      }
    } else if (ev.type === 'error') {
      send({ type: 'error', error: ev.error });
    }
  });

  client.on('message', (data, isBinary) => {
    if (isBinary) { pushPcm(Buffer.from(data)); xf.isStarted() ? xf.sendAudio(data) : buffered.push(data); }
    else if (data.toString() === 'stop') { xf.end(); }
  });
  client.on('close', () => { xf.end(); xf.close(); });
});

server.listen(config.port, () => {
  console.log(`\n  拜访助手已启动 → http://localhost:${config.port}\n`);
  if (!config.openrouter.apiKey) console.log('  ⚠️  尚未配置 OPENROUTER_API_KEY（大模型不可用）');
  if (!config.deepgram.apiKey) console.log('  ⚠️  尚未配置 DEEPGRAM_API_KEY（结束定稿分角色不可用）');
  if (config.asrProvider === 'volc') {
    console.log('  🎙️  实时转写引擎：火山语音识别大模型（bigmodel_async）');
    if (!config.volc.appKey || !config.volc.accessKey) console.log('  ⚠️  尚未配置 VOLC_APP_KEY/VOLC_ACCESS_KEY（实时流式转写不可用）');
  } else {
    console.log('  🎙️  实时转写引擎：讯飞听见');
    if (!config.xfyun.appId) console.log('  ⚠️  尚未配置 XFYUN_APPID/API_KEY/API_SECRET（实时流式转写不可用）');
  }
  console.log('');
});
