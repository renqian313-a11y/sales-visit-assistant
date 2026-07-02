// 销售拜访关键词词库（MVP 先内置一套虚拟词，后续可改为按客户/行业配置）
// 命中后会在对话回放里高亮，并在顶部列出"本场命中关键词"。
// 每个词支持配同义/近音写法 aliases，命中任一都算命中该词。
export const KEYWORDS = [
  { word: '返点', cat: '价格', aliases: ['反点', '翻点', '返币', '翻币'] },
  { word: '箱价', cat: '价格', aliases: ['加币', '箱币'] },
  { word: '账期', cat: '价格', aliases: ['帐期'] },
  { word: '价格', cat: '价格', aliases: ['报价', '单价'] },
  { word: '促销', cat: '动销', aliases: ['搞活动', '做活动'] },
  { word: '动销', cat: '动销', aliases: ['盯动销', '盯购'] },
  { word: '试销', cat: '动销', aliases: ['试效', '时效'] },
  { word: '库存', cat: '动销', aliases: ['存货'] },
  { word: '陈列', cat: '动销', aliases: ['摆放', '上架位'] },
  { word: '竞品', cat: '风险', aliases: ['对手', '别家'] },
  { word: '比价', cat: '风险', aliases: ['比较价格'] },
  { word: '退货', cat: '风险', aliases: ['退换'] },
  { word: '送样', cat: '承诺', aliases: ['送货样', '寄样'] },
  { word: '下单', cat: '承诺', aliases: ['订货', '订购'] },
  { word: '续约', cat: '承诺', aliases: ['续签'] },
];

// 在一段文字里找出命中的关键词（去重，保留词库顺序）。
// 返回 [{ word, cat }]。
export function matchKeywords(text) {
  const s = String(text || '');
  const hit = [];
  for (const k of KEYWORDS) {
    const terms = [k.word, ...(k.aliases || [])];
    if (terms.some((t) => s.includes(t))) hit.push({ word: k.word, cat: k.cat });
  }
  return hit;
}

// 给前端用的扁平列表：所有词 + 别名，便于在对话里做高亮匹配。
export function allTerms() {
  return KEYWORDS.flatMap((k) => [k.word, ...(k.aliases || [])].map((t) => ({ term: t, word: k.word, cat: k.cat })));
}
