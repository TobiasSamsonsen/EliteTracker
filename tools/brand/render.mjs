// Render the PNG icons and the share image from the mark (public/icons/mark.svg)
// and the contours (public/contours.svg), with the Chrome already installed:
//
//   node tools/brand/render.mjs
//
// Writes public/icons/icon-192.png, icon-512.png, maskable-512.png and
// public/og.png. Set CHROME to the browser's path if it is not the Windows
// default. Dev only: nothing here runs on the site or in CI.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pub = (...p) => join(root, 'public', ...p);
const dataUrl = (file, type) => `data:${type};base64,${readFileSync(file).toString('base64')}`;
const chromePath = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const mark = readFileSync(pub('icons', 'mark.svg'), 'utf8');
// The mark's cells without its navy tile, for laying on a page of its own.
const cells = mark.replace(/<rect width="32" height="32"[^>]*\/>/, '');
const font = dataUrl(pub('fonts', 'archivo-latin.woff2'), 'font/woff2');
const contours = dataUrl(pub('contours.svg'), 'image/svg+xml');

const page = (width, height, body) => `<!doctype html><meta charset="utf-8">
<style>
  @font-face { font-family: Archivo; src: url(${font}) format('woff2'); font-weight: 400 800; font-stretch: 62% 125%; }
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
  svg { display: block; }
</style>${body}`;

const icon = (size, maskable) => page(size, size, maskable
  // Maskable: full bleed, the grid inside the safe circle (80 % of the side).
  ? `<div style="width:${size}px;height:${size}px;background:#080f1c;display:grid;place-items:center">
       <div style="width:${size * 0.85}px;height:${size * 0.85}px">${cells.replace('<svg ', '<svg width="100%" height="100%" ')}</div></div>`
  : mark.replace('<svg ', `<svg width="${size}" height="${size}" `));

const og = page(1200, 630, `
<div style="position:relative;width:1200px;height:630px;overflow:hidden;color:#e8edf5;font-family:Archivo;
  background:radial-gradient(1100px 520px at 50% -200px, rgb(31 94 255 / .3), transparent 70%), #080f1c">
  <img src="${contours}" style="position:absolute;inset:0;width:1200px;height:630px;filter:invert(1);opacity:.13;
    -webkit-mask:linear-gradient(to right, transparent 10%, #000 70%)">
  <div style="position:absolute;left:96px;top:118px;display:flex;align-items:center;gap:30px">
    <div style="width:104px;height:104px">${mark.replace('<svg ', '<svg width="104" height="104" ')}</div>
    <div style="font-weight:800;font-stretch:125%;font-size:76px;letter-spacing:.01em">ELITETRACKER</div>
  </div>
  <div style="position:absolute;left:96px;top:300px;max-width:880px;font-size:46px;font-weight:700;
    font-stretch:110%;line-height:1.12;letter-spacing:-.01em">Rating, odds og tabellprognose for Eliteserien og OBOS-ligaen</div>
  <div style="position:absolute;left:96px;bottom:72px;font-size:26px;font-weight:600;color:#98a3b7">elitetracker.no</div>
</div>`);

const shots = [
  { file: pub('icons', 'icon-192.png'), html: icon(192, false), w: 192, h: 192 },
  { file: pub('icons', 'icon-512.png'), html: icon(512, false), w: 512, h: 512 },
  { file: pub('icons', 'maskable-512.png'), html: icon(512, true), w: 512, h: 512 },
  { file: pub('og.png'), html: og, w: 1200, h: 630 },
];

const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'brand-'))}`,
  '--no-first-run', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); }
  catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });

const work = mkdtempSync(join(tmpdir(), 'brand-page-'));
await send('Page.enable');
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
for (const [n, shot] of shots.entries()) {
  const html = join(work, `${n}.html`);
  writeFileSync(html, shot.html);
  await send('Emulation.setDeviceMetricsOverride', { width: shot.w, height: shot.h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pathToFileURL(html).href });
  await sleep(800);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: shot.w, height: shot.h, scale: 1 } });
  writeFileSync(shot.file, Buffer.from(data, 'base64'));
  console.log(shot.file.slice(root.length + 1));
}
ws.close();
chrome.kill();
process.exit(0);
