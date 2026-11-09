// Exports the knowledge base as JSONL (one JSON record per passage). No API key needed.
// Run:  node scripts/export_jsonl.js   ->  knowledge_base/knowledge_base.jsonl
const fs = require('fs'), path = require('path');
const { chunkText } = require('../netlify/functions/rag.js');
const dir = path.join(__dirname, '..', 'knowledge_base');
const lines = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  const title = (raw.match(/^#\s+(.+)$/m) || [, f])[1].trim();
  chunkText(raw).forEach((text, i) => lines.push(JSON.stringify({ id: f.replace('.md', '') + '_' + i, source: f, title, text })));
}
fs.writeFileSync(path.join(dir, 'knowledge_base.jsonl'), lines.join('\n') + '\n');
console.log('Wrote', lines.length, 'records');
