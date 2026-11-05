// Run once (and whenever the knowledge base changes):  node scripts/build_index.js
// Reads knowledge_base/*.md, splits into chunks, embeds each chunk, writes netlify/functions/kb_index.json
const fs = require('fs'), path = require('path');
try { require('fs').readFileSync('.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }); } catch (_) {}
const { embed, chunkText, EMBED_MODEL, PROVIDER } = require('../netlify/lib/rag.js');

(async () => {
  if (!process.env.LLM_API_KEY) { console.error('Set LLM_API_KEY in .env first.'); process.exit(1); }
  const dir = path.join(__dirname, '..', 'knowledge_base');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const chunks = chunkText(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const [i, text] of chunks.entries()) {
      out.push({ source: f, n: i, text, vector: await embed(text, 'doc') });
      console.log('embedded', f, i + 1 + '/' + chunks.length);
      await new Promise((r) => setTimeout(r, 700)); // stay under free-tier rate limits
    }
  }
  fs.writeFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'kb_index.json'),
    JSON.stringify({ provider: PROVIDER, model: EMBED_MODEL, chunks: out }));
  console.log('Done:', out.length, 'chunks. Commit kb_index.json to GitHub.');
})().catch((e) => { console.error(e.message); process.exit(1); });
