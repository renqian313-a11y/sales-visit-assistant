# 录音 / 语音识别模块交接文档（RECORDING.md）

> 归属:本模块由【录音/识别负责人(同事)】维护。业务页面 `visit-assistant.html`
> 仅通过 `window.ASR` 工厂与回调契约对接,二者**解耦、可独立合并**。
> 替换识别模型时,**业务层零改动**——只需实现一个新引擎并切换 `RECORDER_CONFIG.engine`。

---

## 1. 文件结构与分工

| 文件 | 归属 | 职责 |
|---|---|---|
| `asr-engine.js` | 录音/识别负责人(同事) | 录音采集 + 语音识别引擎实现,吐出文本 |
| `visit-assistant.html` | 业务负责人 | 页面交互、抽取、表单、纪要;只消费引擎回调 |

合并方式:两个文件各自独立维护。HTML 通过
`<script src="asr-engine.js"></script>`(在内联业务脚本**之前**)引入,无需任何打包工具。

---

## 2. 引擎契约(ASREngine)

所有引擎实现**统一接口**,业务侧不感知具体引擎:

```js
engine.start()    // 开始录音 + 识别,返回 Promise
engine.stop()     // 停止并释放资源(麦克风轨道等)
engine.pause()    // 暂停(保持会话)
engine.resume()   // 继续
engine.destroy()  // 彻底销毁
engine.supported()// 返回当前环境是否支持该引擎(boolean)
engine.name       // 引擎标识:'browser' | 'mock' | 'whisper'
```

### 回调契约(创建引擎时由业务侧注入 `callbacks`)

引擎**只吐数据,绝不碰 DOM / 业务状态**:

```js
onInterim(text)          // 实时中间结果(灰字预览,可被后续覆盖)
onFinal(text)            // 一句话定稿  ←★ 业务核心入口(抽取/高亮/表单都吃这个)
onError(type, message)   // 统一错误
onStatus(state)          // 状态机
```

### 统一错误码(`onError` 的 type)

| type | 含义 | 业务侧典型提示 |
|---|---|---|
| `not-allowed` | 麦克风权限被拒绝 | 引导点击地址栏 🔒 → 麦克风 → 允许 |
| `no-device`   | 未检测到麦克风设备 | 提示连接设备后重试 |
| `network`     | 识别服务网络异常 | 部分地区需可访问云端识别服务 |
| `unsupported` | 当前浏览器/环境不支持 | 建议改用 Chrome / Edge |
| `insecure`    | 非安全上下文(非 https/localhost) | 浏览器禁止访问麦克风 |
| `unknown`     | 其他未知错误 | 透出原始错误名 |

### 状态机(`onStatus` 的 state)

`idle → requesting → recording → paused → stopped`

---

## 3. 当前占位实现(三个引擎)

### ① BrowserASREngine —— 默认真实占位(Web Speech API)
- 基于 `webkitSpeechRecognition`,Chrome 会把音频送 Google 云端识别,**零部署、即开即用**。
- 流程:先 `getUserMedia({audio:true})` 显式申请麦克风权限 → 再启动识别。
- `onend` 时若仍在录音且非手动停止 → **自动重启**(浏览器会周期性断开)。
- **不会**在权限错误时自动降级演示——只通过 `onError` 明确上报(这是上一版的关键修复)。

### ② MockASREngine —— 演示兜底(无麦/无网/预览环境)
- 不采集真实音频。读取 `config.script`(业务侧注入的 SCRIPT 时间轴),按秒吐 `onFinal`。
- ⚠️ 注意:当前业务页**演示模式并不走此引擎**,而是由业务侧 `runScript()` 时间轴直接驱动
  (因为演示脚本含 `summary/field/todo` 富内容,需要业务上下文)。MockASREngine 保留作为
  「纯文本演示引擎」的契约样例,方便同事理解 `onFinal` 数据流。

### ③ WhisperASREngine —— 同事接入区(TODO 桩)
- 当前为占位桩:`start()` 直接 `onError('unsupported', ...)` 并 reject,便于回退。

---

## 4. 推荐替换方案:开源 Whisper(Transformers.js)

纯浏览器本地推理,不依赖云、可定制、隐私友好。

| 选项 | 模型 | 体积 | 说明 |
|---|---|---|---|
| 轻量 | `onnx-community/whisper-base` | ~40–80MB | 速度快,中文一般 |
| 推荐 | `onnx-community/whisper-small` | ~240MB | 中文更准 |

**接入步骤(在 `WhisperASREngine` 内实现):**
1. `import { pipeline } from '@huggingface/transformers'`(CDN 或本地)。
2. `getUserMedia` 拿麦克风流 → `MediaRecorder` / `AudioWorklet` 按 `config.whisper.chunkSec` 分块。
3. `transcriber = await pipeline('automatic-speech-recognition', config.whisper.model, { device })`
   (`device: 'webgpu'`,失败回退 `'wasm'`)。
4. 每块音频送 `transcriber` → 部分结果 `cb.onInterim(...)`,整句 `cb.onFinal(...)`。
5. 错误统一走 `cb.onError(type, msg)`,状态走 `cb.onStatus(...)`。

**切换方式:** 实现完成后,把 `asr-engine.js` 顶部的
`RECORDER_CONFIG.engine` 由 `'browser'` 改为 `'whisper'` 即可。业务层零改动。

---

## 5. 业务层数据流(供同事理解对接点)

```
引擎(asr-engine.js)              业务(visit-assistant.html)
  onInterim(text) ───────────────▶ updateInterim(text)  // 灰字预览
  onFinal(text)   ───────────────▶ onFinalSpeech(text)
                                      ├─ guessSpeaker()   角色判定(BD/商家)
                                      ├─ highlight()      关键信息着色
                                      ├─ addLine()        落到转写流
                                      └─ runExtract()     正则抽取 → 填表单/纪要/待办
  onStatus(state) ───────────────▶ showMicTip(...)       状态提示
  onError(t,msg)  ───────────────▶ showMicTip('⚠️ '+msg) 错误提示(不降级)
```

业务侧创建引擎(`startASR()` 内):
```js
asrEngine = ASR.createEngine({ onInterim, onFinal, onStatus, onError },
                              { engine:'browser', lang:'zh-CN', script: SCRIPT });
asrEngine.start();
```

> **同事只需保证:实现的新引擎遵守 §2 契约,通过四个回调吐数据即可。**
> 业务侧的 `onFinalSpeech`/抽取/表单/纪要逻辑无需改动。
