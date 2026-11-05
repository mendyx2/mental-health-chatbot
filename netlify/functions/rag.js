// Shared helpers: provider calls (Gemini or OpenAI), chunking, cosine similarity.
// Choose provider with env PROVIDER=gemini (default) or openai.
// PROVIDER should be "gemini" or "openai". If a model name was typed there by mistake (e.g. "gemini-3-flash"),
// it is treated as the Gemini chat model so the site still works.
const RAW = (process.env.PROVIDER || 'gemini').trim().toLowerCase();
const PROVIDER = /^(openai|gpt)/.test(RAW) ? 'openai' : 'gemini';
const RAW_IS_MODEL = RAW !== 'gemini' && RAW !== 'openai' && /\d/.test(RAW);
const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_BASE = process.env.OPENAI_BASE || 'https://api.openai.com/v1';
const EMBED_MODEL = process.env.EMBED_MODEL || (PROVIDER === 'openai' ? 'text-embedding-3-small' : 'gemini-embedding-001');
let CHAT_MODEL = process.env.CHAT_MODEL || (RAW_IS_MODEL && PROVIDER === 'gemini' ? RAW : (PROVIDER === 'openai' ? 'gpt-4o-mini' : ''));
const KEY = () => process.env.LLM_API_KEY;

async function post(url, headers, body, timeoutMs) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined });
  if (!res.ok) throw new Error(`${PROVIDER} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Gemini model names are retired often and busy models return 503. Build an ordered list of usable models
// (newest "flash" first, then "flash-lite") and try them in turn; the first that answers is remembered.
let MODEL_LIST = null;
async function geminiCandidates() {
  if (MODEL_LIST) return MODEL_LIST;
  let list = [];
  try {
    const res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': KEY() }, signal: AbortSignal.timeout(4000) });
    const d = await res.json();
    const ver = (n) => (n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1] * 1;
    const names = (d.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    const flash = names.filter((n) => /gemini-[\d.]+-flash$/.test(n)).sort((a, b) => ver(b) - ver(a));
    const lite = names.filter((n) => /gemini-[\d.]+-flash-lite$/.test(n)).sort((a, b) => ver(b) - ver(a));
    list = [...flash.slice(0, 2), ...lite.slice(0, 1), ...flash.slice(2, 3)];
  } catch (_) {}
  list.push('gemini-flash-latest');
  MODEL_LIST = list;
  return list;
}

async function embed(text, kind) { // kind: 'doc' | 'query'
  if (PROVIDER === 'openai') {
    const d = await post(`${OPENAI_BASE}/embeddings`, { Authorization: `Bearer ${KEY()}` }, { model: EMBED_MODEL, input: text });
    return d.data[0].embedding;
  }
  const d = await post(`${GEMINI_BASE}/models/${EMBED_MODEL}:embedContent`, { 'x-goog-api-key': KEY() }, {
    content: { parts: [{ text }] },
    taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT'
  });
  return d.embedding.values;
}

// history: [{role:'user'|'bot', text}]  (already trimmed); last item is NOT the current question
async function generate(system, history, question) {
  if (PROVIDER === 'openai') {
    const messages = [{ role: 'system', content: system },
      ...history.map((h) => ({ role: h.role === 'bot' ? 'assistant' : 'user', content: h.text })),
      { role: 'user', content: question }];
    const d = await post(`${OPENAI_BASE}/chat/completions`, { Authorization: `Bearer ${KEY()}` },
      { model: CHAT_MODEL, messages, temperature: 0.2, max_tokens: 400 });
    return d.choices[0].message.content;
  }
  const contents = [...history.map((h) => ({ role: h.role === 'bot' ? 'model' : 'user', parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: question }] }];
  const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.2, maxOutputTokens: 1500 } };
  const tryOrder = [...new Set([CHAT_MODEL, ...(CHAT_MODEL ? [] : await geminiCandidates())].filter(Boolean))];
  if (CHAT_MODEL) tryOrder.push(...(await geminiCandidates()).filter((m) => m !== CHAT_MODEL));
  let d, lastErr;
  for (const m of tryOrder.slice(0, 4)) {
    try {
      d = await post(`${GEMINI_BASE}/models/${m}:generateContent`, { 'x-goog-api-key': KEY() }, body, 7000);
      CHAT_MODEL = m; // remember the model that worked
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (!/ (404|429|500|503)|aborted|timeout/i.test(e.message)) throw e; // other errors (e.g. bad key) will not be fixed by another model
    }
  }
  if (lastErr) throw lastErr;
  // Skip any "thought" parts: thinking models can return their reasoning as separate parts.
  return (d.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
}

function chunkText(text, size = 800, overlap = 100) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = []; let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > size && cur) { chunks.push(cur); cur = cur.slice(-overlap) + '\n\n' + p; }
    else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

module.exports = { embed, generate, chunkText, cosine, PROVIDER, EMBED_MODEL, CHAT_MODEL };
