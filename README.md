# 拜访助手 Demo · 工程文件包

移动端「拜访助手」（Visit Assistant with AI）演示工程。业务页面为纯前端单文件，可浏览器直接打开；录音/识别能力由 `recording/` 下的实时流式后端提供。

## 目录结构

```
拜访助手-工程文件/
├── visit-assistant.html          # 业务主页面（交互 / 抽取 / 表单 / 纪要）— 业务负责人
├── asr-engine.js                 # ASR 统一引擎（window.ASR 工厂，含 wsstream 适配层）
├── README.md
├── RECORDING.md                  # 录音引擎契约 / 交接文档
├── .gitignore
└── recording/                    # ← 录音模块（同事负责，单独归档，便于替换 / 合并）
    ├── server/                   # Node 后端（Express + WebSocket + 讯飞流式 / Deepgram / LLM）
    ├── pcm-worklet.js            # 前端 16k PCM 采集 Worklet
    ├── package.json              # 后端依赖
    ├── .env.example              # 密钥模板（复制为 .env 填入）
    └── 技术方案_v1.0.md          # 录音方案说明
```

## 三种运行方式

### 1) 纯前端演示 / 本地 Whisper（零配置，无需后端）
直接用本地静态服务打开 `visit-assistant.html` 即可。真实模式默认走浏览器本地 Whisper 引擎；无麦克风/无网时可切「演示模式」。

### 2) 接入实时流式后端（录音真正可用）
让录音变得真正可用（实时出字 + 分角色 + AI 总结），需起 `recording/` 后端并配置密钥：

```
cd recording
cp .env.example .env      # 填入下方三类密钥
npm install
npm start                 # 启动在 http://localhost:4100
```

后端会把 `visit-assistant.html` 等前端文件一并托管在 `http://localhost:4100`。
然后在 `visit-assistant.html` 顶部把引擎开关改为 wsstream：

```js
const REAL_ASR_ENGINE = 'wsstream';   // 默认 'whisper'，改成 'wsstream' 接入后端实时转写
const WSSTREAM_BASE   = '';           // 同源留空；若前端另起端口，填 'http://localhost:4100'
```

浏览器打开 `http://localhost:4100/visit-assistant.html`，开始拜访即走实时流式转写。

### 所需密钥（需自行申请，填入 recording/.env）
| 密钥 | 用途 | 申请地址 |
|---|---|---|
| `XFYUN_APPID` / `XFYUN_API_KEY` / `XFYUN_API_SECRET` | 实时流式转写（录音中出字） | https://console.xfyun.cn |
| `DEEPGRAM_API_KEY` | 结束后声纹分离分角色 | https://deepgram.com |
| `OPENROUTER_API_KEY` | 结束后 AI 总结 / 待办 / 话术 | https://openrouter.ai |

> 密钥缺失时后端可正常启动并给出提示，对应能力自动禁用（不报错），便于先合码后配密钥。
> 声纹模型 `recording/models/campplus_zh.onnx` 缺失时自动回退按男女声分角色（见 `.env.example` 内下载说明）。

## 前后端解耦约定（合并要点）

- 业务层 `visit-assistant.html` 仅通过 `asr-engine.js` 的 `window.ASR.createEngine({onInterim,onFinal,onStatus,onError}, options)` 契约拿转写文本，**不关心底层是本地 Whisper 还是后端流式**。
- `recording/` 是录音模块的独立归档目录，同事替换识别模型只需保持后端 WS 消息契约（`{type:'dialogue', turns, interim}`）不变，或调整 `asr-engine.js` 中的 `wsstream` 适配层，业务 UI / 样式零改动。
- 切换引擎只改 `visit-assistant.html` 顶部的 `REAL_ASR_ENGINE` 常量。
