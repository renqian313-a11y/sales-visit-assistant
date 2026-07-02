/* ============================================================
 * ASR 统一引擎 (拜访助手 demo)
 * --------------------------------------------------------------
 * 暴露 window.ASR.createEngine(callbacks, options) 契约:
 *   callbacks: { onInterim, onFinal, onStatus, onError }
 *   options:   { engine: 'whisper'|'browser'|'mock'|'wsstream', lang, script,
 *                whisper: { model, chunkSec },
 *                wsstream: { base, workletUrl, customerName, storeType } }
 *
 * 三种引擎:
 *   whisper (默认, 真实可用) - 纯浏览器本地推理
 *       依赖: @xenova/transformers v2.17.2 (CDN 动态 import)
 *       模型: Xenova/whisper-base (首次约 80-150MB, IndexedDB 缓存,
 *             之后离线可用)。每 chunkSec 秒做一次 ASR 推理。
 *   browser - Web Speech API (依赖 Chrome/Edge 与云端服务,
 *             国内网络环境下不稳定)
 *   mock    - 演示脚本 (按时间轴回放, 不依赖麦克风)
 * ============================================================ */
(function (global) {
  'use strict';

  /* ============ 通用工具 ============ */
  function noop() {}
  function normCb(cb) {
    cb = cb || {};
    return {
      onInterim: cb.onInterim || noop,
      onFinal:   cb.onFinal   || noop,
      onStatus:  cb.onStatus  || noop,
      onError:   cb.onError   || noop
    };
  }

  /* ============ Whisper 引擎 (默认, 真实可用) ============ */
  function WhisperASREngine(callbacks, config) {
    var cb = normCb(callbacks);

    var stream = null, audioCtx = null, source = null, processor = null;
    var transcriber = null, transcribing = false;
    var pcmBuf = [];
    var paused = false, running = false, destroyed = false;

    var chunkSec  = (config && config.whisper && config.whisper.chunkSec) || 4;
    var lang      = (config && config.lang) || 'zh-CN';
    var whisperLang = (String(lang).toLowerCase().indexOf('zh') === 0) ? 'chinese' : 'english';
    var modelId   = (config && config.whisper && config.whisper.model) || 'Xenova/whisper-base';

    function supported() {
      return !!(global.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
          && (!!global.AudioContext || !!global.webkitAudioContext);
    }

    function loadModel() {
      cb.onInterim('（首次加载语音模型，约 30–90 秒，请稍候…）');
      return import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2').then(function (mod) {
        try {
          mod.env.allowLocalModels = false;
          mod.env.useBrowserCache  = true;
        } catch (_) {}
        return mod.pipeline('automatic-speech-recognition', modelId, { quantized: true });
      });
    }

    function openAudioPipe() {
      audioCtx  = new (global.AudioContext || global.webkitAudioContext)({ sampleRate: 16000 });
      source    = audioCtx.createMediaStreamSource(stream);
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = function (e) {
        if (paused || !running) return;
        var input = e.inputBuffer.getChannelData(0);
        var copy  = new Float32Array(input.length);
        copy.set(input);
        pcmBuf.push(copy);
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
    }

    function drainBuffer() {
      var total = 0, i, j;
      for (i = 0; i < pcmBuf.length; i++) total += pcmBuf[i].length;
      var out = new Float32Array(total);
      var off = 0;
      for (j = 0; j < pcmBuf.length; j++) { out.set(pcmBuf[j], off); off += pcmBuf[j].length; }
      pcmBuf = [];
      return out;
    }

    /* Whisper 在静音/无内容时会幻觉常见字幕水印, 这里过滤 */
    var HALLUCINATION_RE = /(amara\.org|字幕志愿者|by\s+\w+|请不吝点赞|订阅|转发|打赏|^[、。.!?\s]+$)/i;

    function loopInfer() {
      if (!running || destroyed) return;
      setTimeout(function () {
        if (!running || destroyed) return;
        if (paused || transcribing) { loopInfer(); return; }
        var samples = drainBuffer();
        if (samples.length < 16000 * 0.6) { loopInfer(); return; } // <0.6s 直接跳过
        transcribing = true;
        transcriber(samples, { language: whisperLang, task: 'transcribe' })
          .then(function (out) {
            transcribing = false;
            var text = '';
            if (out) {
              if (typeof out.text === 'string') text = out.text;
              else if (out[0] && typeof out[0].text === 'string') text = out[0].text;
            }
            text = (text || '').trim();
            if (text && !HALLUCINATION_RE.test(text)) cb.onFinal(text);
            loopInfer();
          })
          .catch(function (err) {
            transcribing = false;
            cb.onError('unknown', '推理失败：' + ((err && err.message) || '未知错误'));
            loopInfer();
          });
      }, chunkSec * 1000);
    }

    function start() {
      if (destroyed) return Promise.reject(new Error('destroyed'));
      paused = false;
      cb.onStatus('requesting');
      if (!supported()) {
        cb.onError('unsupported', '当前浏览器不支持麦克风采集（建议使用 Chrome 或 Edge）。');
        return Promise.reject(new Error('unsupported'));
      }
      if (!global.isSecureContext) {
        cb.onError('insecure', '当前非安全上下文，需通过 https 或 localhost 打开（浏览器禁止访问麦克风）。');
        return Promise.reject(new Error('insecure'));
      }
      return navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
      })
      .then(function (s) {
        stream = s;
        if (!transcriber) {
          return loadModel().then(function (t) { transcriber = t; });
        }
      })
      .then(function () {
        cb.onInterim('');
        openAudioPipe();
        running = true;
        cb.onStatus('recording');
        loopInfer();
      })
      .catch(function (err) {
        var name = (err && err.name) || '';
        var msg  = (err && err.message) || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          cb.onError('not-allowed', '麦克风权限被拒绝。请点击地址栏左侧的 🔒 - 麦克风 - 允许。');
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          cb.onError('no-device', '未检测到麦克风设备，请连接后重试。');
        } else if (/model|fetch|network|onnx|import/i.test(msg)) {
          cb.onError('network', '模型加载失败：' + msg + '（首次使用需联网下载，请检查网络后重试）');
        } else {
          cb.onError('unknown', '启动失败：' + (msg || name || '未知错误'));
        }
        throw err;
      });
    }

    function pause()  { paused = true;  cb.onStatus('paused'); }
    function resume() { paused = false; cb.onStatus('recording'); }

    function stop() {
      running = false;
      if (processor) { try { processor.disconnect(); } catch (_) {} processor.onaudioprocess = null; processor = null; }
      if (source)    { try { source.disconnect(); }    catch (_) {} source = null; }
      if (audioCtx)  { try { audioCtx.close(); }       catch (_) {} audioCtx = null; }
      if (stream)    { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      pcmBuf = [];
      cb.onStatus('stopped');
    }

    function destroy() { destroyed = true; stop(); transcriber = null; }

    return { name: 'whisper', supported: supported, start: start, pause: pause, resume: resume, stop: stop, destroy: destroy };
  }

  /* ============ 浏览器原生 (Web Speech API) 引擎 ============ */
  function BrowserASREngine(callbacks, config) {
    var cb = normCb(callbacks);
    var SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    var rec = null, running = false, paused = false, destroyed = false;
    var lang = (config && config.lang) || 'zh-CN';

    function supported() { return !!SR; }

    function start() {
      if (destroyed) return Promise.reject(new Error('destroyed'));
      cb.onStatus('requesting');
      if (!supported()) {
        cb.onError('unsupported', '当前浏览器不支持 Web Speech API（建议使用 Chrome 或 Edge）。');
        return Promise.reject(new Error('unsupported'));
      }
      try {
        rec = new SR();
        rec.lang = lang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.onstart = function () { running = true; cb.onStatus('recording'); };
        rec.onresult = function (e) {
          var interim = '';
          for (var i = e.resultIndex; i < e.results.length; i++) {
            var r = e.results[i];
            if (r.isFinal) cb.onFinal((r[0] && r[0].transcript || '').trim());
            else interim += (r[0] && r[0].transcript || '');
          }
          if (interim) cb.onInterim(interim.trim());
        };
        rec.onerror = function (e) {
          var t = e && e.error;
          if (t === 'not-allowed' || t === 'service-not-allowed') cb.onError('not-allowed', '麦克风权限被拒绝。');
          else if (t === 'no-speech') cb.onError('no-speech', '未检测到语音输入。');
          else if (t === 'audio-capture') cb.onError('no-device', '未检测到可用麦克风。');
          else if (t === 'network') cb.onError('network', '语音识别网络连接失败（Web Speech API 需要可访问 Google 服务）。');
          else cb.onError('unknown', '识别错误：' + (t || '未知'));
        };
        rec.onend = function () {
          if (running && !paused && !destroyed) { try { rec.start(); } catch (_) {} }
          else cb.onStatus('stopped');
        };
        rec.start();
        return Promise.resolve();
      } catch (err) {
        cb.onError('unknown', '启动失败：' + ((err && err.message) || '未知错误'));
        return Promise.reject(err);
      }
    }

    function pause()  { paused = true;  cb.onStatus('paused');    try { rec && rec.stop(); } catch (_) {} }
    function resume() { paused = false; cb.onStatus('recording'); try { rec && rec.start(); } catch (_) {} }
    function stop()   { running = false; try { rec && rec.stop(); } catch (_) {} }
    function destroy(){ destroyed = true; stop(); rec = null; }

    return { name: 'browser', supported: supported, start: start, pause: pause, resume: resume, stop: stop, destroy: destroy };
  }

  /* ============ Mock 演示引擎 ============ */
  function MockASREngine(callbacks, config) {
    var cb = normCb(callbacks);
    var script = (config && config.script) || [];
    var idx = 0, timer = null, paused = false, destroyed = false, running = false, t0 = 0;

    function tick() {
      if (!running || paused || destroyed) return;
      if (idx >= script.length) return;
      var step = script[idx];
      var dueIn = (step.t * 1000) - (Date.now() - t0);
      if (dueIn <= 0) {
        if (step.text) cb.onFinal(step.text);
        idx++;
        timer = setTimeout(tick, 0);
      } else {
        timer = setTimeout(tick, Math.max(50, dueIn));
      }
    }

    function start() {
      running = true; t0 = Date.now(); idx = 0;
      cb.onStatus('recording');
      tick();
      return Promise.resolve();
    }
    function pause()  { paused = true;  cb.onStatus('paused'); }
    function resume() { paused = false; cb.onStatus('recording'); tick(); }
    function stop()   { running = false; if (timer) clearTimeout(timer); timer = null; cb.onStatus('stopped'); }
    function destroy(){ destroyed = true; stop(); }

    return { name: 'mock', supported: function () { return true; }, start: start, pause: pause, resume: resume, stop: stop, destroy: destroy };
  }

  /* ============ WsStream 引擎 (对接同事的实时流式后端) ============
   * 采集麦克风 → AudioWorklet 降采样 16k PCM → WebSocket 推给
   * recording/ 后端(Node + 讯飞流式) → 收 {type:'dialogue', turns, interim}
   * 消息，转成业务侧统一契约的 onInterim(临时) / onFinal(定稿一句)。
   * 说话人分离信息(turns[i].speaker)保留在 finalMeta 供业务侧可选使用。
   * 后端地址由 config.wsstream.base 指定, 默认同源。
   */
  function WsStreamASREngine(callbacks, config) {
    var cb = normCb(callbacks);
    var opt = (config && config.wsstream) || {};
    var httpBase = opt.base || '';                         // '' = 同源
    var lang = (config && config.lang) || 'zh-CN';

    var stream = null, audioCtx = null, srcNode = null, workletNode = null;
    var ws = null, visitId = null;
    var paused = false, running = false, destroyed = false;
    var emittedCount = 0;                                  // 已作为 onFinal 吐出的 turns 条数

    function wsUrl() {
      var proto = (global.location && location.protocol === 'https:') ? 'wss' : 'ws';
      var host;
      if (httpBase) host = String(httpBase).replace(/^https?:\/\//, '').replace(/\/$/, '');
      else host = global.location ? location.host : 'localhost:4100';
      return proto + '://' + host + '/ws/live?visitId=' + encodeURIComponent(visitId);
    }
    function apiUrl(p) { return (httpBase ? httpBase.replace(/\/$/, '') : '') + p; }

    // 后端 turns[] 是分角色气泡数组: [{spk,speaker,text}]。最后一条会被同一说话人
    // 原地续写增长，因此从"上一次已吐出的最后一条"起重发，带 turn 索引供前端按索引 upsert，
    // 保证最后一条的后续增长也能刷新到界面(修复只落定第一条、后续卡在识别中的问题)。
    function pushTurns(turns) {
      if (!turns || !turns.length) return;
      var start = Math.max(0, emittedCount - 1);
      for (var i = start; i < turns.length; i++) {
        var t = turns[i];
        if (t && t.text) cb.onFinal(t.text, { speaker: t.speaker, index: i });
      }
      emittedCount = turns.length;
    }

    function startPcm() {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC || !('audioWorklet' in AC.prototype)) return Promise.reject(new Error('浏览器不支持 AudioWorklet 实时采集'));
      audioCtx = new AC();
      var ready = audioCtx.state === 'suspended' ? audioCtx.resume() : Promise.resolve();
      return ready
        .then(function () { return audioCtx.audioWorklet.addModule(opt.workletUrl || 'recording/pcm-worklet.js'); })
        .then(function () {
          srcNode = audioCtx.createMediaStreamSource(stream);
          workletNode = new AudioWorkletNode(audioCtx, 'pcm-worklet');
          workletNode.port.onmessage = function (e) {
            if (!paused && ws && ws.readyState === 1) ws.send(e.data);   // Int16 PCM
          };
          srcNode.connect(workletNode);
          var mute = audioCtx.createGain(); mute.gain.value = 0;
          workletNode.connect(mute); mute.connect(audioCtx.destination);
        });
    }

    function start() {
      running = true; emittedCount = 0;
      cb.onStatus('requesting');
      return navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function (s) {
          stream = s;
          return fetch(apiUrl('/api/visit/start'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer_name: (opt.customerName || '拜访商户'), store_type: (opt.storeType || '线下'), consent: true })
          });
        })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || '创建拜访失败'); return d; }); })
        .then(function (d) {
          visitId = d.id;
          return new Promise(function (resolve, reject) {
            ws = new WebSocket(wsUrl());
            ws.binaryType = 'arraybuffer';
            ws.onopen = function () { startPcm().then(function () { cb.onStatus('recording'); resolve(); }).catch(reject); };
            ws.onerror = function () { reject(new Error('实时转写连接失败')); };
            ws.onmessage = function (ev) {
              var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
              if (msg.type === 'dialogue') {
                if (typeof msg.interim === 'string') cb.onInterim(msg.interim);
                pushTurns(msg.turns);
              } else if (msg.type === 'error') {
                cb.onError('server', msg.error || '实时转写出错');
              }
            };
          });
        })
        .catch(function (err) {
          cleanup();
          var m = String(err && err.message || err);
          var type = /麦克风|permission|denied|getUserMedia/i.test(m) ? 'permission' : 'network';
          cb.onError(type, m);
          throw err;
        });
    }

    function cleanup() {
      try { if (workletNode) workletNode.disconnect(); } catch (e) {}
      try { if (srcNode) srcNode.disconnect(); } catch (e) {}
      try { if (audioCtx) audioCtx.close(); } catch (e) {}
      audioCtx = workletNode = srcNode = null;
      try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      stream = null;
    }

    function pause()  { paused = true;  cb.onStatus('paused'); }
    function resume() { paused = false; cb.onStatus('recording'); }
    function stop() {
      running = false;
      try { if (ws && ws.readyState === 1) { ws.send('stop'); ws.close(); } } catch (e) {}
      ws = null;
      cleanup();
      cb.onStatus('stopped');
    }
    function destroy() { destroyed = true; stop(); }

    return {
      name: 'wsstream',
      supported: function () { return !!(global.WebSocket && global.navigator && navigator.mediaDevices); },
      start: start, pause: pause, resume: resume, stop: stop, destroy: destroy,
      getVisitId: function () { return visitId; }
    };
  }

  /* ============ 工厂 ============ */
  function browserSupported()  { return !!(global.SpeechRecognition || global.webkitSpeechRecognition); }
  function whisperSupported()  {
    return !!(global.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
        && (!!global.AudioContext || !!global.webkitAudioContext);
  }

  function createEngine(callbacks, config) {
    config = config || {};
    var engine = config.engine;
    if (!engine) engine = whisperSupported() ? 'whisper' : (browserSupported() ? 'browser' : 'mock');
    if (engine === 'whisper') return WhisperASREngine(callbacks, config);
    if (engine === 'browser') return BrowserASREngine(callbacks, config);
    if (engine === 'wsstream') return WsStreamASREngine(callbacks, config);
    return MockASREngine(callbacks, config);
  }

  global.ASR = {
    createEngine: createEngine,
    browserSupported: browserSupported,
    whisperSupported: whisperSupported
  };
})(window);
