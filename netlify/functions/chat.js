// Netlify serverless function: the whole RAG backend (retrieve from kb_index.json, then generate). The API key stays server-side.
// Also applies a deterministic crisis-keyword check BEFORE the model (safety net in addition to Langflow's own routing).

const CRISIS = [
  'kill myself', 'end my life', 'want to die', 'suicide', 'suicidal', 'end it all',
  'hurt myself', 'harm myself', 'self harm', 'self-harm', 'no reason to live',
  "don't want to live", 'dont want to live', 'better off dead', 'overdose'
];

const EMERGENCY_REPLY =
  "I am really sorry you are going through this, and I am glad you told me. You deserve support right now. " +
  "Please call 112 or go to the nearest hospital emergency unit immediately, or reach a trusted person near you and stay with them. " +
  "You are not alone.";

const headers = { 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ reply: 'Method not allowed.' }) };
  }

  let message = '', sessionId = 'anon', history = [];
  try {
    const body = JSON.parse(event.body || '{}');
    message = String(body.message || '').slice(0, 1000);
    sessionId = String(body.sessionId || 'anon').slice(0, 64);
    history = (Array.isArray(body.history) ? body.history : []).slice(-6)
      .map((h) => ({ role: h.role === 'bot' ? 'bot' : 'user', text: String(h.text || '').slice(0, 1000) }));
  } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ reply: 'Bad request.' }) };
  }
  if (!message.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ reply: 'Please type a message.' }) };
  }

  const lower = message.toLowerCase();
  const crisisHit = CRISIS.some((k) => lower.includes(k));
  const started = Date.now();

  // Log WITHOUT message content or identifiers (privacy by design). Visible in Netlify function logs.
  const log = (extra) => console.log(JSON.stringify({ t: new Date().toISOString(), crisisHit, ms: Date.now() - started, ...extra }));

  if (crisisHit) {
    log({ route: 'crisis-shortcut' });
    return { statusCode: 200, headers, body: JSON.stringify({ reply: EMERGENCY_REPLY, emergency: true }) };
  }

  try {
    const { embed, generate, cosine } = require('../lib/rag.js');
    const index = require('./kb_index.json');
    const system0 = require('fs').readFileSync(require('path').join(__dirname, 'system_prompt.txt'), 'utf8');

    // 1. Retrieve the 4 most similar knowledge-base chunks
    const q = await embed(message, 'query');
    const top = index.chunks
      .map((c) => ({ c, s: cosine(q, c.vector) }))
      .sort((x, y) => y.s - x.s).slice(0, 4);
    const context = top.map((t) => t.c.text).join('\n\n---\n\n');

    // 2. Generate the reply from the context
    const system = system0.replace('{context}', context);
    const reply = (await generate(system, history, message)).trim();
    if (!reply) throw new Error('Empty model reply');

    // The model tags urgent replies with [URGENT]
    const urgent = reply.startsWith('[URGENT]');
    log({ route: 'rag', urgent, top: top.map((t) => +t.s.toFixed(2)) });
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ reply: reply.replace(/^\[URGENT\]\s*/, ''), emergency: urgent })
    };
  } catch (err) {
    log({ route: 'error', error: err.message });
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ reply: 'I am having trouble responding right now. If this is urgent, call 112 or go to the nearest hospital.' })
    };
  }
};
