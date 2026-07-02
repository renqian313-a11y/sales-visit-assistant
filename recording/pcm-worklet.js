// AudioWorklet：把麦克风 Float32 音频降采样到 16kHz、转 16-bit PCM(linear16)，
// 按 ~20ms 一帧 postMessage 回主线程，再经 WebSocket 推给后端做实时转写。
// 绕开 MediaRecorder 的容器打包延迟，实现逐字低延迟。
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = sampleRate;     // AudioWorkletGlobalScope 全局：输入采样率(常见 44100/48000)
    this.outRate = 16000;
    this.ratio = this.inRate / this.outRate;
    this._frac = 0;               // 跨 render-quantum 续接的重采样相位
    this._buf = [];               // 已降采样样本，凑够一帧再发
    this.frameSize = 320;         // 16000 * 0.02 = 320 样本/帧（20ms）
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;   // 没输入也要返回 true 保活
    const ch = input[0];                      // 单声道

    // 线性插值降采样到 16k，_frac 跨块续接，避免丢/重样本
    let pos = this._frac;
    while (pos < ch.length) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = ch[idx];
      const s1 = idx + 1 < ch.length ? ch[idx + 1] : s0;
      let s = s0 + (s1 - s0) * frac;
      s = Math.max(-1, Math.min(1, s));
      this._buf.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      pos += this.ratio;
    }
    this._frac = pos - ch.length;

    // 凑满整帧就发（Int16Array，transfer buffer 零拷贝）
    while (this._buf.length >= this.frameSize) {
      const slice = this._buf.splice(0, this.frameSize);
      const pcm = new Int16Array(slice);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-worklet', PCMWorklet);
