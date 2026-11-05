// Netlify serverless function: the whole RAG backend (retrieve from kb_index.json, then generate). The API key stays server-side.
// Also applies a deterministic crisis-keyword check BEFORE the model (safety net in addition to the model's own [URGENT] tagging).

// Strong signals: the user may be at risk themselves -> immediate emergency reply, model not called.
const CRISIS = [
  /\bsuicid/, /\bkill(ing)?\s+(my\s?self|myself)\b/, /\b(hurt|hurting|harm|harming|cut|cutting)\s+(my\s?self|myself)\b/,
  /\bself[\s-]?harm/, /\bend(ing)?\s+(it\s+all|my\s+(own\s+)?life|everything)\b/, /\btake\s+my\s+(own\s+)?life\b/,
  /\b(want|wanna|wish|wanting|going)\s+(to\s+)?(die|be\s+dead|disappear)\b/, /\bwant\s+to\s+kill\s+my/,
  /\bno\s+(reason|point)\s+(to|in)\s+(live|living|go\s+on|going\s+on|continue)\b/, /\b(reason|point)\s+(to\s+)?(keep|keeping)\s+(on\s+)?(live|living)\b/,
  /\b(don'?t|do\s+not|dont)\s+want\s+to\s+(live|be\s+here|exist|wake\s+up)\b/, /\bbetter\s+off\s+(dead|without\s+me)\b/,
  /\bcan'?t\s+(go|take\s+it)\s+(on|anymore)\b/, /\bcannot\s+go\s+on\b/, /\boverdos/, /\b(took|taken|swallowed)\s+(too\s+many|a\s+lot\s+of)\s+(pills|tablets|drugs)\b/,
  /\bplan\s+to\s+(kill|end)\b/, /\bwant\s+(it\s+all\s+)?to\s+stop\b.*\b(life|everything)\b/
];

// Softer signals (a third person in danger, abuse, wish to harm others): sent to the model, but if the model fails
// the user still gets emergency information.
const RISK = [
  /\b(wants?|wanted|threatens?|threatened|is\s+going)\s+to\s+(kill|end|hurt|harm)\s+(him|her|them)?(self|selves)\b/,
  /\bkill\s+(him|her|them)self\b/, /\bscared\s+for\s+my\s+(life|safety)\b/, /\b(beats?|beating|hits?|abus(e|es|ed|ing))\s+me\b/,
  /\b(want|going)\s+to\s+(hurt|kill|harm)\s+(someone|him|her|them|people)\b/, /\bhurt\s+someone\b/, /\bin\s+danger\b/
];

const EMERGENCY_REPLY =
  "I am really sorry you are going through this, and I am glad you told me. You deserve support right now. " +
  "Please call 112 or go to the nearest hospital emergency unit immediately, or reach a trusted person near you and stay with them. " +
  "You are not alone.";

const EMERGENCY_REPLY_THIRD =
  "This sounds serious, and I am glad you reached out. If anyone is in immediate danger, please call 112 or go to the nearest hospital emergency unit now, " +
  "and stay with the person if it is safe to do so. You do not have to handle this alone, so involve a trusted adult as well.";

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
  const crisisHit = CRISIS.some((re) => re.test(lower));
  const riskHit = !crisisHit && RISK.some((re) => re.test(lower));
  const started = Date.now();

  // Log WITHOUT message content or identifiers (privacy by design). Visible in Netlify function logs.
  const log = (extra) => console.log(JSON.stringify({ t: new Date().toISOString(), crisisHit, riskHit, ms: Date.now() - started, ...extra }));

  if (crisisHit) {
    log({ route: 'crisis-shortcut' });
    return { statusCode: 200, headers, body: JSON.stringify({ reply: EMERGENCY_REPLY, emergency: true }) };
  }

  try {
    const { embed, generate, cosine } = require('./rag.js');
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
    // Short, non-sensitive error code so problems can be diagnosed from the page (no message text, no key, no provider body)
    const m = /(?:gemini|openai) (\d{3})/.exec(err.message);
    const code = /Cannot find module/.test(err.message) ? 'missing-index-or-file'
      : m ? 'provider-' + m[1] : /Empty model reply/.test(err.message) ? 'empty-reply'
      : /LLM_API_KEY|fetch failed/.test(err.message) ? 'network-or-key' : 'error';
    log({ route: 'error', error: err.message.slice(0, 200), code });
    if (riskHit) {
      return { statusCode: 200, headers, body: JSON.stringify({ reply: EMERGENCY_REPLY_THIRD, emergency: true, code }) };
    }
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ reply: 'I am having trouble responding right now. If this is urgent, call 112 or go to the nearest hospital.', code })
    };
  }
};
