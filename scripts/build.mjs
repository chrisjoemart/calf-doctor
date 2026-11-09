// Builds:
//   docs/            -> the real app, served by GitHub Pages (Firebase, offline, installable)
//   dist/demo.html   -> one self-contained file running the on-device demo
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const css = readFileSync('src/app.css', 'utf8');

const page = ({ head = '', body }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#14532d">
<title>Calf Doctor</title>
${head}
</head>
<body>
<div id="app"></div>
<div id="toast" role="status" aria-live="polite"></div>
${body}
</body>
</html>
`;

// ---- real app ----
rmSync('docs', { recursive: true, force: true });
mkdirSync('docs', { recursive: true });
const app = await build({
  entryPoints: ['src/main-firebase.js'], bundle: true, minify: true, format: 'esm', target: ['es2020', 'safari15'],
  write: false, legalComments: 'none',
});
const js = app.outputFiles[0].text;
const hash = createHash('sha256').update(js + css).digest('hex').slice(0, 10);
writeFileSync('docs/app.js', js);
writeFileSync('docs/app.css', css);
cpSync('public', 'docs', { recursive: true });
writeFileSync('docs/.nojekyll', '');
writeFileSync('docs/index.html', page({
  head: `<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="icon" href="icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Calf Doctor">
<link rel="stylesheet" href="app.css?v=${hash}">`,
  body: `<script type="module" src="app.js?v=${hash}"></script>`,
}));
const shell = ['./', 'index.html', `app.js?v=${hash}`, `app.css?v=${hash}`, 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
writeFileSync('docs/sw.js', readFileSync('src/sw.js', 'utf8')
  .replace('__VERSION__', hash)
  .replace('__SHELL__', JSON.stringify(shell)));

// ---- demo (single file) ----
mkdirSync('dist', { recursive: true });
const demo = await build({
  entryPoints: ['src/main-demo.js'], bundle: true, minify: true, format: 'iife', target: ['es2020', 'safari15'],
  write: false, legalComments: 'none',
});
writeFileSync('dist/demo.html', page({
  head: `<style>${css}</style>`,
  body: `<script>${demo.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`,
}));

console.log(`built docs/ (v${hash}, app.js ${(js.length / 1024).toFixed(0)} KB) and dist/demo.html`);
