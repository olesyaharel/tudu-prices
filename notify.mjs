// After the nightly job: keeps one GitHub issue listing the branches without a location (they stay in the data, but the
// app can't place them). A comment is added only when the list changes, so the repo owner gets an email just then;
// when the list is empty the issue is closed. Run: GH_TOKEN=… node notify.mjs [--out=dir]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = path.resolve(process.argv.find(a => a.startsWith('--out='))?.split('=')[1] || HERE + 'out') + '/';
const TITLE = 'סניפים בלי מיקום';
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8' });

const missing = JSON.parse(fs.readFileSync(OUT + 'branches.json')).filter(b => !b.lat).sort((a, b) => a.k.localeCompare(b.k));
const cell = s => (s || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '—';
const row = b => `| ${cell(b.chainName)} | ${cell(b.name)} | ${cell(b.address)} | \`${b.k}\` |`;
const body = `הסניפים האלה נמצאים בנתונים, אבל אין לנו מיקום שלהם, ולכן הם לא יופיעו בהשוואה.
מי שיודע איפה סניף נמצא (עיר, או כתובת) – לספר ל־Claude, והוא יוסיף אותו ל־places.json.

| רשת | סניף | כתובת בקובץ | מזהה |
|---|---|---|---|
${missing.map(row).join('\n')}
`;

const [issue] = JSON.parse(gh('issue', 'list', '--state', 'open', '--search', `in:title "${TITLE}"`, '--json', 'number,body'));
const before = new Set(issue ? [...issue.body.matchAll(/`([^`]+)`/g)].map(m => m[1]) : []), now = new Set(missing.map(b => b.k));
const added = missing.filter(b => !before.has(b.k)), fixed = [...before].filter(k => !now.has(k));

if (!missing.length) { if (issue) { gh('issue', 'close', String(issue.number), '--comment', 'לכל הסניפים יש עכשיו מיקום 🎉'); console.log('closed'); } }
else if (!issue) { gh('issue', 'create', '--title', TITLE, '--body', body); console.log('opened with', missing.length); }
else if (added.length || fixed.length) {
  gh('issue', 'edit', String(issue.number), '--body', body);
  const note = [added.length && `**חדשים בלי מיקום (${added.length}):**\n${added.map(b => `- ${b.chainName} – ${b.name} (${b.address || '—'})`).join('\n')}`,
    fixed.length && `**קיבלו מיקום (${fixed.length}):** ${fixed.join(', ')}`].filter(Boolean).join('\n\n');
  gh('issue', 'comment', String(issue.number), '--body', note); console.log('updated:', added.length, 'new,', fixed.length, 'fixed');
} else console.log('no change,', missing.length, 'without a location');
