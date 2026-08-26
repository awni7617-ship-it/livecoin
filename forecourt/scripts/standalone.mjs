#!/usr/bin/env node
/**
 * Build the no-server version of the app.
 *
 *   npm run standalone
 *     -> dist/forecourt-standalone.html   a complete page: open it, host it anywhere
 *     -> dist/forecourt-artifact.html     the same page as a body fragment
 *
 * Same front end, same valuation model, same plate decoder as the deployed app.
 * The only swap is the backend: src/local-api.js answers the same routes out of
 * the browser's own storage, so everything stays on the device that opened it.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

/** Turn an ES module into plain top-level script code. */
const flatten = (source) => source
  .replace(/^import[^;]+;$/gm, '')
  .replace(/^export \{[^}]*\};?$/gm, '')
  .replace(/^export (default )?/gm, '');

const html = read('public', 'index.html');
const css = read('public', 'styles.css');

const script = [
  '/* ---- valuation model ---- */',
  flatten(read('src', 'valuation.js')),
  '/* ---- plate decoding ---- */',
  flatten(read('src', 'lookup.js')),
  '/* ---- local backend ---- */',
  flatten(read('src', 'local-api.js')),
  '/* ---- the app ---- */',
  flatten(read('public', 'app.js')),
  '/* ---- standalone extras ---- */',
  `
// The deployed app links CSV export at the Worker; here it is built in-page.
document.addEventListener('click', async (event) => {
  const link = event.target.closest('a[href="/api/export/stock.csv"]');
  if (!link) return;
  event.preventDefault();
  const csv = globalThis.FORECOURT_CSV();
  const filename = \`forecourt-stock-\${new Date().toISOString().slice(0, 10)}.csv\`;
  try {
    const downloads = globalThis.claude && await globalThis.claude.use('downloads');
    if (downloads) {
      await downloads.save({ filename, data: csv });
      return;
    }
  } catch { /* fall through to the browser's own download */ }
  try {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    await navigator.clipboard.writeText(csv);
    toast('Download blocked here — the CSV is on your clipboard instead');
  }
});

// Say so once if the browser refuses to keep anything.
let warnedEphemeral = false;
setInterval(() => {
  if (globalThis.FORECOURT_EPHEMERAL && !warnedEphemeral) {
    warnedEphemeral = true;
    toast('This browser is not saving data — it will be gone when you close the tab', 'bad');
  }
}, 4000);
`,
].join('\n\n');

// Strip the tags that pull in separate files; everything is inline now.
const body = html
  .replace(/<link rel="stylesheet"[^>]*>/, '')
  .replace(/<script src="\/app\.js"[^>]*><\/script>/, '');

const inner = body
  .replace(/^[\s\S]*?<body>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .trim();

const head = body.slice(body.indexOf('<head>') + 6, body.indexOf('</head>')).trim();

const styleTag = `<style>\n${css}\n</style>`;
const scriptTag = `<script type="module">\n${script}\n</script>`;

writeFileSync(
  join(dist, 'forecourt-standalone.html'),
  `<!doctype html>\n<html lang="en">\n<head>\n${head}\n${styleTag}\n</head>\n<body>\n${inner}\n${scriptTag}\n</body>\n</html>\n`,
);

// Artifact pages are published as a body fragment: no doctype, html, head or body.
writeFileSync(
  join(dist, 'forecourt-artifact.html'),
  `<title>Forecourt</title>\n${styleTag}\n${inner}\n${scriptTag}\n`,
);

for (const file of ['forecourt-standalone.html', 'forecourt-artifact.html']) {
  process.stdout.write(`  dist/${file}  ${(statSync(join(dist, file)).size / 1024).toFixed(0)} KB\n`);
}
process.stdout.write('\n');
