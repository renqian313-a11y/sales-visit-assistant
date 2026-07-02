// 大模型：调用 OpenRouter，一次产出 分人对话 + 总结 + Todo + 话术（结构化 JSON）
// 想换模型只改 .env 里的 OPENROUTER_MODEL，代码不用动。
import { config } from './config.js';
import { matchKeywords, KEYWORDS } from './keywords.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM_PROMPT = `你是资深销售拜访助手。我会给你一段【由语音转写得到】的 BD/销售与客户拜访对话文字记录。

重要：这段文字来自语音识别，常有"同音错字"和口语断句错误。请你先结合销售拜访的常识，把明显的同音/近音错字纠正回正确含义，再做分析。常见纠正示例（不限于此）：
- "加币/箱币" → "箱价"；"翻币/返币" → "返点"；"算的/酸的" → "酸奶"
- "动销/订购稍后/盯购" → "盯动销/动销"；"试效/时效" → "试销"
- "网老板" → "王老板"；"淡淡的" → "带的/送的"
纠正时只依据上下文合理推断，不要凭空增删事实信息。

关于说话人：这段文字可能已经用 [说话人0]、[说话人1]… 这样的标记按声音分好了不同的人（来自声纹分离，准确）。请你【信任这些说话人边界，不要重新合并或拆分】，只做两件事：
1) 判断每个"说话人编号"对应的角色：我方销售标 "BD"，客户/店老板标 "客户"；多位客户方依次标 "客户A"、"客户B"；同一个编号在全程对应同一个角色，保持一致。
2) 把每一轮的文字做同音错字纠正，输出通顺内容。
如果原文没有 [说话人N] 标记，再由你结合语气、立场、上下文自行切分并标注角色。
保持原话顺序，不要合并不同人的话；每一轮 text 用纠错后的通顺文字。

请严格只输出 JSON（不要任何额外说明文字），结构如下：
{
  "corrected_transcript": "纠错后的通顺对话文字稿",
  "dialogue": [
    { "speaker": "BD 或 客户 或 客户A...", "text": "这一轮说的话（已纠错）" }
  ],
  "summary": {
    "customer_demands": ["客户诉求，逐条"],
    "key_info": ["关键信息，如报价/库存/竞品/决策人等"],
    "commitments": ["我方做出的承诺，如下周送样"],
    "risks": ["风险点，如客户在比价竞品X、预算不足"]
  },
  "todos": [
    { "content": "待办内容", "owner": "负责人，未提到填本次BD", "due": "截止日期或留空", "priority": "高|中|低" }
  ],
  "scripts": [
    { "scenario": "适用场景，如客户嫌贵", "suggested_line": "下次拜访建议话术原文", "rationale": "为什么这么说" }
  ]
}
要求：只依据原文，不编造；信息不足的字段用空数组；所有内容用简体中文。`;

/**
 * @param {string} transcript 拜访对话文字稿
 * @returns {Promise<{summary:object, todos:array, scripts:array}>}
 */
export async function analyze(transcript) {
  if (!config.openrouter.apiKey) {
    throw new Error('未配置 OPENROUTER_API_KEY，请在 .env 中填写');
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openrouter.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `拜访对话记录：\n"""\n${transcript}\n"""` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`大模型分析失败 (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  const result = safeParse(content);

  // 关键词命中：在纠错后的全文（退而求其次用对话拼接）里匹配词库
  const fullText = result.corrected_transcript
    || result.dialogue.map((d) => d.text).join('\n')
    || transcript;
  result.keywords_hit = matchKeywords(fullText);
  // 词库下发给前端，便于在对话里做高亮（含别名）
  result.keywords = KEYWORDS;
  return result;
}

// —— 任务跟进字段抽取：从对话里抽表单字段（枚举按钮 + 商家信息文本），只依据原文不编造 —— //
const FIELD_PROMPT = `你是销售拜访助手。根据下面这段【语音转写的】拜访对话，抽取"任务跟进"表单字段。
严格只依据原文，不编造；没提到或拿不准的字段就【不要出现在 JSON 里】。先在心里纠正明显同音错字再判断。
只输出 JSON（无任何多余文字），可用的键：
{
  "poster":  "可铺设|不可铺设|待确认",
  "standee": "可铺设|不可铺设|待确认",
  "activity":"已报名|暂不报名|考虑中",
  "cat":     "门店品类，如：川菜火锅",
  "area":    "营业面积，如：约 320㎡",
  "tables":  "桌位数，如：28 桌",
  "contact": "联系人，如：王经理",
  "phone":   "联系电话，保持原文（含脱敏星号）"
}
poster=门口活动海报能否张贴；standee=收银台立牌能否摆放；activity=平台活动报名情况。
枚举字段(poster/standee/activity)的值必须【严格等于】给定选项之一，否则不要输出该键。文本字段用简体中文、简短。`;

const SEG_ENUM = {
  poster: ['可铺设', '不可铺设', '待确认'],
  standee: ['可铺设', '不可铺设', '待确认'],
  activity: ['已报名', '暂不报名', '考虑中'],
};
const TEXT_KEYS = ['cat', 'area', 'tables', 'contact', 'phone'];

function normalizeFields(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of Object.keys(SEG_ENUM)) {          // 枚举字段：只接受合法选项，防 LLM 乱填
    const v = typeof o[k] === 'string' ? o[k].trim() : '';
    if (SEG_ENUM[k].includes(v)) out[k] = v;
  }
  for (const k of TEXT_KEYS) {
    const v = typeof o[k] === 'string' ? o[k].trim() : '';
    if (v) out[k] = v.slice(0, 40);
  }
  return out;
}

/**
 * 从拜访对话文字稿抽取任务跟进表单字段。失败/未配置/无依据 → 返回 {}（前端保持原样）。
 * @param {string} transcript
 * @returns {Promise<object>} 只含有依据的键，如 { poster:'可铺设', cat:'川菜火锅' }
 */
export async function extractTaskFields(transcript) {
  const clean = (transcript || '').trim();
  if (!clean || !config.groq.apiKey) return {};              // 用 Groq（与文字校准同一个有效 key）
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groq.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.groq.chatModel,
        messages: [
          { role: 'system', content: FIELD_PROMPT },
          { role: 'user', content: `拜访对话记录：\n"""\n${clean}\n"""` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    let o;
    try { o = JSON.parse(content); }
    catch { const m = content.match(/\{[\s\S]*\}/); o = m ? JSON.parse(m[0]) : {}; }
    return normalizeFields(o);
  } catch { return {}; }
}

// —— 实时分片分角色 —— //
const CHUNK_PROMPT = `你在为销售拜访录音做"实时转写分角色"。我会给你最新一小段语音转写文字（可能有同音错字，可顺手纠正明显错误，但不要增删事实）。
请把这小段按说话人切分：我方销售统一标 "BD"；客户/店老板标 "客户"，若明显有多位客户方依次标 "客户A"、"客户B"；实在无法判断标 "未知"。
我会告诉你"上一句的说话人"，请据此保持连贯（同一个人连续说话就合并到同一轮）。
只输出 JSON，不要任何额外文字：{"turns":[{"speaker":"...","text":"..."}]}`;

/**
 * 对一小段转写文字做快速分角色。失败时降级为单轮，保证实时流程不中断。
 * @param {string} text 这一小段转写文字
 * @param {string} prevSpeaker 上一轮说话人（上下文）
 * @returns {Promise<Array<{speaker:string,text:string}>>}
 */
export async function labelChunk(text, prevSpeaker = '') {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (!config.openrouter.apiKey) return [{ speaker: prevSpeaker || '未知', text: clean }];

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openrouter.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.openrouter.model,
        messages: [
          { role: 'system', content: CHUNK_PROMPT },
          { role: 'user', content: `上一句说话人：${prevSpeaker || '（无）'}\n新片段：\n"""\n${clean}\n"""` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    if (!res.ok) return [{ speaker: prevSpeaker || '未知', text: clean }];
    const data = await res.json();
    const turns = parseTurns(data.choices?.[0]?.message?.content || '{}');
    return turns.length ? turns : [{ speaker: prevSpeaker || '未知', text: clean }];
  } catch {
    return [{ speaker: prevSpeaker || '未知', text: clean }];
  }
}

function parseTurns(textRaw) {
  let o;
  try { o = JSON.parse(textRaw); } catch {
    const m = textRaw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try { o = JSON.parse(m[0]); } catch { return []; }
  }
  const arr = Array.isArray(o?.turns) ? o.turns : [];
  return arr
    .filter((d) => d && (d.text || d.speaker))
    .map((d) => ({ speaker: String(d.speaker || '未知').trim(), text: String(d.text || '').trim() }))
    .filter((d) => d.text);
}

function safeParse(text) {
  try {
    return normalize(JSON.parse(text));
  } catch {
    // 个别模型可能在 JSON 外包了文字，尝试抠出花括号部分
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return normalize(JSON.parse(m[0])); } catch { /* ignore */ }
    }
    return normalize({});
  }
}

function normalize(o) {
  return {
    corrected_transcript: o?.corrected_transcript || '',
    dialogue: Array.isArray(o?.dialogue)
      ? o.dialogue
          .filter((d) => d && (d.text || d.speaker))
          .map((d) => ({ speaker: String(d.speaker || '未知').trim(), text: String(d.text || '').trim() }))
      : [],
    summary: {
      customer_demands: o?.summary?.customer_demands || [],
      key_info: o?.summary?.key_info || [],
      commitments: o?.summary?.commitments || [],
      risks: o?.summary?.risks || [],
    },
    todos: Array.isArray(o?.todos) ? o.todos : [],
    scripts: Array.isArray(o?.scripts) ? o.scripts : [],
  };
}
