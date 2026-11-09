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

// Rule-based symptom screen. Each group is one feature of a possible mental health problem. The screen looks at what the user
// has reported across the whole conversation (previous user messages plus the current one), not only the latest message.
const SYMPTOMS = {
  'low mood': /\b(depress(ed|ion)?|sad(ness)?|hopeless|empty|worthless|crying|cry a lot|low mood|no joy|lost interest|nothing (feels|is) (fun|enjoyable))\b/,
  'mood swings': /\b(moody|mood\s?swings?|mood changes?|ups? and downs?|irritable|easily angered|snap(s|ping)? at)\b/,
  'excessive laughing or elation': /\b(laugh(s|ing)?\s+(too\s+much|excessively|for\s+no\s+reason|without\s+reason|uncontrollably)|excessive(ly)?\s+laugh|giggl\w*\s+(for\s+no\s+reason|uncontrollably)|overly\s+(happy|excited)|too\s+(happy|excited)|euphori\w+)\b/,
  'abnormal behaviour': /\b(abnormal|strange|odd|unusual|bizarre)\s+(behaviou?r|actions?|display|acts?)\b|\b(talk(s|ing)?\s+to\s+(him|her|them|my)self|talks?\s+alone|acting\s+(strange|weird|differently)|behaves?\s+(strangely|oddly)|aggressive|restless)\b/,
  'sleep change': /\b(can'?t sleep|cannot sleep|not sleeping|no sleep|insomnia|sleeping too much|sleep(s)? all day|little sleep)\b/,
  'appetite or energy change': /\b(no appetite|lost my appetite|not eating|eating too much|always tired|no energy|exhausted|fatigue)\b/,
  'withdrawal': /\b(isolat\w+|withdraw\w*|avoid(ing)? (people|everyone|friends)|stay(ing)? alone|do(n'?t| not) want to see anyone|stopped going out)\b/,
  'anxiety or panic': /\b(anxious|anxiety|panic|worr(y|ied|ying)|nervous|racing heart|fear)\b/,
  'poor concentration': /\b(can'?t concentrate|cannot concentrate|poor concentration|forget(ful|ting)?|can'?t focus|cannot focus)\b/
};
// Features that point to a possible loss of touch with reality; treated as high risk on their own.
const SEVERE = /\b(hear(s|ing)?\s+voices|see(s|ing)?\s+things\s+(that|which)|hallucinat\w+|paranoi\w+|someone\s+is\s+(watching|following|after)\s+(me|him|her)|not\s+slept\s+(for\s+)?(days|\d+\s+days)|cannot\s+care\s+for\s+(him|her|my)self|stopped\s+(eating|washing|bathing))\b/;

// Threshold: 0 groups = none, 1 to 2 = low, 3 to 4 = moderate, 5 or more (or any severe feature) = high.
function screenSymptoms(texts) {
  const all = texts.join(' ').toLowerCase();
  const groups = Object.keys(SYMPTOMS).filter((g) => SYMPTOMS[g].test(all));
  const severe = SEVERE.test(all);
  const level = severe || groups.length >= 5 ? 'high' : groups.length >= 3 ? 'moderate' : groups.length >= 1 ? 'low' : 'none';
  return { groups, severe, level };
}

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

  let screenLevel = 'none';
  try {
    const { embed, generate, cosine } = require('./rag.js');
    const index = require('./kb_index.json');
    const system0 = require('./system_prompt.js');

    // 1. Context-aware retrieval: the search text is the current message plus the user's two previous messages, so a short
    //    follow-up such as "how long does it last?" is understood in the light of what was said before.
    const priorUser = history.filter((h) => h.role === 'user').slice(-2).map((h) => h.text);
    const searchText = [message, ...priorUser.reverse()].join(' ').slice(0, 900);
    const q = await embed(searchText, 'query');
    const top = index.chunks
      .map((c) => ({ c, s: cosine(q, c.vector) }))
      .sort((x, y) => y.s - x.s).slice(0, 4);
    const context = top.map((t) => t.c.text).join('\n\n---\n\n');

    // 2. Symptom screen over the whole conversation, then generate the reply from the context
    const screen = screenSymptoms([...history.filter((h) => h.role === 'user').map((h) => h.text), message]);
    screenLevel = screen.level;
    const note = screen.level === 'none'
      ? 'SCREENING NOTE: no clear symptoms have been reported yet. Ask a gentle question about how the person feels.'
      : 'SCREENING NOTE: the person has reported these features across the conversation: ' + screen.groups.join(', ') +
        (screen.severe ? ', and a feature that may suggest loss of touch with reality' : '') +
        '. Screening level: ' + screen.level.toUpperCase() + '.';
    const system = system0.replace('{context}', context).replace('{screening}', note);
    const reply = (await generate(system, history, message)).trim();
    if (!reply) throw new Error('Empty model reply');

    // The model tags urgent replies with [URGENT]
    const urgent = reply.startsWith('[URGENT]');
    log({ route: 'rag', urgent, level: screenLevel, top: top.map((t) => +t.s.toFixed(2)) });
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ reply: reply.replace(/^\[URGENT\]\s*/, ''), emergency: urgent || screenLevel === 'high', level: screenLevel })
    };
  } catch (err) {
    // Short, non-sensitive error code so problems can be diagnosed from the page (no message text, no key, no provider body)
    const m = /(?:gemini|openai) (\d{3})/.exec(err.message);
    const code = /Cannot find module/.test(err.message) ? 'missing-index-or-file'
      : m ? 'provider-' + m[1] : /Empty model reply/.test(err.message) ? 'empty-reply'
      : /LLM_API_KEY|fetch failed/.test(err.message) ? 'network-or-key' : 'error';
    const detail = String(err.message).replace(/key=[^&\s]+/g, 'key=***').slice(0, 120);
    log({ route: 'error', error: detail, code });
    if (riskHit) {
      return { statusCode: 200, headers, body: JSON.stringify({ reply: EMERGENCY_REPLY_THIRD, emergency: true, code, detail }) };
    }
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ reply: 'I am having trouble responding right now. If this is urgent, call 112 or go to the nearest hospital.', code, detail })
    };
  }
};
