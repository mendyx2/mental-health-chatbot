// Shared helpers: provider calls (Gemini or OpenAI), chunking, cosine similarity.
// Choose provider with env PROVIDER=gemini (default) or openai.
const PROVIDER = (process.env.PROVIDER || 'gemini').toLowerCase();
const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_BASE = process.env.OPENAI_BASE || 'https://api.openai.com/v1';
const EMBED_MODEL = process.env.EMBED_MODEL || (PROVIDER === 'openai' ? 'text-embedding-3-small' : 'gemini-embedding-001');
const CHAT_MODEL = process.env.CHAT_MODEL || (PROVIDER === 'openai' ? 'gpt-4o-mini' : 'gemini-2.5-flash');
const KEY = () => process.env.LLM_API_KEY;

async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${PROVIDER} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
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
  const d = await post(`${GEMINI_BASE}/models/${CHAT_MODEL}:generateContent`, { 'x-goog-api-key': KEY() }, {
    systemInstruction: { parts: [{ text: system }] }, contents,
    generationConfig: { temperature: 0.2, maxOutputTokens: 400 }
  });
  return (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
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
