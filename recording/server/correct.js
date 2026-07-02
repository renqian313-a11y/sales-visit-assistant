// 文字校准：用 Groq(LLM) 把语音转写的 turns 逐条洗干净
//  - 纠正同音/近音错别字（结合销售拜访 / 直播带货语境）
//  - 统一为简体中文
//  - 补全标点符号、去掉明显的口吃重复
// 不增删事实、不合并/拆分条目、不改变条数与顺序；失败时原样返回，保证流程不中断。
import { config } from './config.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

const SYS = `你是中文语音转写的"文字校准"助手。我会给你一段按说话人分好的对话，每条都来自语音识别，常见问题：同音/近音错别字、出现繁体字、缺标点、口语啰嗦或重复。
请你逐条校准，每条做到：
1) 纠正明显的同音/近音错别字（结合"销售拜访、直播带货、门店经营"的语境，例如：店→被误识成"电"、客流量→"口气血"、话术→"活活"、铺货/上架/场观/动销/返点/客单价 等行业词）；
2) 全部转成【简体中文】；
3) 补全标点符号（逗号、句号、问号等），让句子通顺；
4) 去掉明显的口吃和重复词。
严格要求：只做文字层面的校准，不要增删事实信息，不要合并或拆分条目，不要改变条目数量和顺序。
只输出 JSON，不要任何额外说明：{"texts":["第1条校准后文字","第2条校准后文字", ...]}，texts 数组长度必须与我给你的条数完全一致。`;

/**
 * 对分好角色的 turns 逐条做文字校准。
 * @param {Array<{role?:string, speaker?:string, text:string}>} turns
 * @returns {Promise<Array>} 同结构 turns，text 已校准（失败则原样返回）
 */
export async function correctTurns(turns) {
  const list = (turns || []).filter((t) => t && t.text && t.text.trim());
  if (!list.length) return list;
  if (!config.groq.apiKey) return list; // 没配 Groq key 就跳过校准（不报错）

  const numbered = list.map((t, i) => `${i + 1}. ${t.text}`).join('\n');
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groq.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.groq.chatModel,
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: `共 ${list.length} 条，请逐条校准：\n"""\n${numbered}\n"""` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0, // 稳定输出，避免每次校准结果抖动
      }),
    });
    if (!res.ok) return list;
    const data = await res.json();
    const texts = parseTexts(data.choices?.[0]?.message?.content || '');
    if (texts.length !== list.length) return list; // 条数对不上就放弃校准，保留原文
    return list.map((t, i) => ({ ...t, text: texts[i] && texts[i].trim() ? texts[i].trim() : t.text }));
  } catch {
    return list; // 任何异常都降级为原文，绝不打断转写流程
  }
}

function parseTexts(raw) {
  let o;
  try { o = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try { o = JSON.parse(m[0]); } catch { return []; }
  }
  return Array.isArray(o?.texts) ? o.texts.map((x) => String(x ?? '')) : [];
}
