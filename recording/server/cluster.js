// 声纹聚类（纯向量运算，无 ONNX/音频依赖）。
//  - OnlineClusterer：实时轨用。同步 assign()，粘性追加——已分配的说话人绝不回改（不闪不跳）。
//  - agglomerate：定稿轨用。把 Deepgram 过分裂的说话人按声纹凝聚合并，替代旧的「按时长封顶」。

export function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

export function normalize(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

const usable = (e) => e && e.length && Number.isFinite(e[0]);

/**
 * 在线粘性聚类。每句一次 assign，返回说话人槽位(0基)。
 * 规则（防过分裂 + 不闪）：
 *  - 无声纹/太短 → 沿用上一个说话人（不污染质心）
 *  - 与最近质心相似度≥sim → 归入该人并 EMA 更新质心
 *  - 否则：只有当句子够长(≥newDurMs) 且 未达封顶 才开新说话人；否则强并入最近的人
 *  - 已返回过的槽位永不改写（调用方 turns[] 追加式）
 */
export class OnlineClusterer {
  constructor(opts = {}) {
    this.sim = opts.sim ?? 0.55;
    this.newDurMs = opts.newDurMs ?? 1500;
    this.minEmbMs = opts.minEmbMs ?? 700;
    this.maxSpeakers = Math.max(1, opts.maxSpeakers ?? 2);
    this.tau = 4000;
    this.slots = [];       // { ema:Float32Array, centroid:Float32Array, count }
    this.lastSlot = 0;
  }

  assign(emb, durMs) {
    // 1) 无声纹或太短 → 粘性沿用上一个说话人
    if (!usable(emb) || durMs < this.minEmbMs) return this.lastSlot;
    const e = normalize(emb);
    // 2) 第一句真声纹 → 说话人0
    if (!this.slots.length) return this._open(e);
    // 3) 找最近质心
    let best = 0, bestSim = -2;
    for (let i = 0; i < this.slots.length; i++) {
      const s = cosine(e, this.slots[i].centroid);
      if (s > bestSim) { bestSim = s; best = i; }
    }
    // 4) 归属：够像 / 太短不许开新 / 已封顶 → 并入最近；否则开新
    let slot;
    if (bestSim >= this.sim || durMs < this.newDurMs || this.slots.length >= this.maxSpeakers) {
      slot = best;
      if (bestSim >= this.sim - 0.10) this._update(this.slots[best], e, durMs); // 边界带不更新，避免污染
    } else {
      slot = this._open(e);
    }
    this.lastSlot = slot;
    return slot;
  }

  _open(e) {
    const s = { ema: Float32Array.from(e), centroid: e, count: 1 };
    this.slots.push(s);
    this.lastSlot = this.slots.length - 1;
    return this.lastSlot;
  }

  _update(s, e, durMs) {
    let a = durMs / (durMs + this.tau);
    a = Math.min(0.40, Math.max(0.05, a));
    a = Math.max(a, 1 / (s.count + 1));       // 前几句近似均值→快速锁定；后面慢 EMA→抗漂移
    for (let i = 0; i < e.length; i++) s.ema[i] = (1 - a) * s.ema[i] + a * e[i];
    s.centroid = normalize(s.ema);
    s.count++;
  }
}

/**
 * 定稿轨凝聚聚类：把 Deepgram 说话人按声纹合并。
 * @param {Array<{id:(string|number), emb:Float32Array|null, durMs:number}>} speakers
 * @param {{mergeSim:number, maxSpeakers:number, minClusterMs?:number}} opts
 * @returns {Map} oldId → newId(0基，按首次出现排序)
 */
export function agglomerate(speakers, opts) {
  const mergeDist = 1 - (opts.mergeSim ?? 0.70);      // 0.30
  const maxN = Math.max(1, opts.maxSpeakers ?? 2);
  const minClusterMs = opts.minClusterMs ?? 0;

  // 每个说话人一个初始簇；无声纹的簇不参与声纹合并（embs 为空）
  let clusters = speakers.map((s) => ({
    ids: [s.id], embs: usable(s.emb) ? [normalize(s.emb)] : [], durMs: s.durMs || 0,
  }));

  const avgDist = (A, B) => {
    if (!A.embs.length || !B.embs.length) return Infinity;
    let sum = 0, n = 0;
    for (const ea of A.embs) for (const eb of B.embs) { sum += 1 - cosine(ea, eb); n++; }
    return sum / n;
  };
  const mergePair = (i, j) => {
    clusters[i].ids.push(...clusters[j].ids);
    clusters[i].embs.push(...clusters[j].embs);
    clusters[i].durMs += clusters[j].durMs;
    clusters.splice(j, 1);
  };
  const closest = () => {
    let bi = -1, bj = -1, bd = Infinity;
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const d = avgDist(clusters[i], clusters[j]);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    return { bi, bj, bd };
  };

  // 1) 声纹合并：最近的一对距离 < 门槛就合并
  while (clusters.length > 1) {
    const { bi, bj, bd } = closest();
    if (bi < 0 || bd >= mergeDist) break;
    mergePair(bi, bj);
  }
  // 2) 封顶：仍超过 maxN → 继续并最近的一对（此时已超阈值，属强制合并）
  while (clusters.length > maxN) {
    const { bi, bj } = closest();
    if (bi < 0) break;
    mergePair(bi, bj);
  }
  // 3) 小簇消解：时长不足 minClusterMs 的簇并入最近的大簇（防过分裂碎片）
  if (minClusterMs > 0 && clusters.length > 1) {
    let changed = true;
    while (changed && clusters.length > 1) {
      changed = false;
      const smallIdx = clusters.findIndex((c) => c.durMs < minClusterMs);
      if (smallIdx < 0) break;
      // 找与它最近的另一簇
      let bj = -1, bd = Infinity;
      for (let j = 0; j < clusters.length; j++) {
        if (j === smallIdx) continue;
        const d = avgDist(clusters[smallIdx], clusters[j]);
        if (d < bd) { bd = d; bj = j; }
      }
      if (bj < 0) break;
      // 合并到较大的一方，保持索引稳定
      const [a, b] = smallIdx < bj ? [smallIdx, bj] : [bj, smallIdx];
      mergePair(a, b);
      changed = true;
    }
  }

  // 生成 oldId → newId（按 speakers 首次出现顺序编号）
  const remap = new Map();
  const order = [];
  for (const s of speakers) {
    const ci = clusters.findIndex((c) => c.ids.includes(s.id));
    if (!order.includes(ci)) order.push(ci);
  }
  for (const s of speakers) {
    const ci = clusters.findIndex((c) => c.ids.includes(s.id));
    remap.set(s.id, order.indexOf(ci));
  }
  return remap;
}
