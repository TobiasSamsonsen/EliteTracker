/* Sharing: a share button (the share icon) wherever a view can be shared, the
   browser's own share sheet where there is one, and a sheet of our own where
   there is not. A view the reader can share as a picture gets a renderer here
   that draws it on a canvas, in the format (wide, square, portrait, story)
   and the theme (dark, light) the reader picks in the sheet; the others share
   their link only (the address already carries what the reader built). Loaded
   before app.js; uses its helpers (el, t, pct, num, teamLogo, ...) only when
   called. */

/* The formats a picture can take: the size a link preview uses, and the
   three a phone's feeds and stories use. */
const SHARE_FORMATS = {
  wide: { w: 1200, h: 630 },
  square: { w: 1080, h: 1080 },
  portrait: { w: 1080, h: 1350 },
  story: { w: 1080, h: 1920 },
};
/* The site's two palettes (styles.css), fixed per picture: a shared picture
   looks the same whoever made it, in the theme its maker chose. */
const SHARE_DARK = {
  paper: '#080f1c', panel: '#111929', sunk: '#0c1423', ink: '#e8edf5', muted: '#98a3b7', faint: '#8490a5',
  rule: '#222e43', accent: '#1f5eff', accentInk: '#588cff', gold: '#facc15', good: '#1f5eff', goodInk: '#588cff',
  bad: '#d92b36', badInk: '#f4514f', draw: '#b5b5ac', slate: '#4b5568', cellInk: '#ffffff', cellInkInvert: '#0f1828',
  glow: 'rgba(31, 94, 255, 0.18)',
  seq: ['#081d58', '#22318d', '#225aa6', '#1d7aac', '#36abc3', '#80cdbb', '#caeab4'],
};
const SHARE_LIGHT = {
  paper: '#e8edf5', panel: '#ffffff', sunk: '#f3f5fa', ink: '#0f1828', muted: '#5a6375', faint: '#5f697c',
  rule: '#bfc6d3', accent: '#1f5eff', accentInk: '#184ddd', gold: '#f2c600', good: '#1f5eff', goodInk: '#184ddd',
  bad: '#d92b36', badInk: '#c4242f', draw: '#8c8c86', slate: '#a9b2c1', cellInk: '#0f1828', cellInkInvert: '#ffffff',
  glow: 'rgba(31, 94, 255, 0.12)',
  seq: ['#d0edb3', '#8bd1ba', '#3db2c4', '#1e8cbe', '#2265ac', '#253d98', '#12246b'],
};
// The palette and the size the picture being drawn uses (set by renderShare).
const SC = { ...SHARE_DARK, seq: [...SHARE_DARK.seq] };
let SW = 1200;
let SH = 630;
/* Tall formats are seen full-screen on a phone, so their type is larger. */
const shareTall = () => SH > SW * 0.8;
const shareU = () => (shareTall() ? 1.3 : 1);
const sharePad = () => (shareTall() ? 72 : 56);

/* The bands' colours as `bandColor` names them, for the canvas. */
const SHARE_BAND = {
  'var(--band-champion)': '#facc15',
  'var(--outcome-good)': '#1f5eff',
  'var(--edge-el)': '#f09c3a',
  'var(--edge-ecl)': '#4ade80',
  'var(--outcome-bad)': '#d92b36',
  'var(--band-relegation-playoff)': '#e3626a',
};
const shareBandColor = (band, count) => SHARE_BAND[bandColor(band, count)] || SC.faint;

/* The share icon: three circles joined by two lines, an angle. Its box is
   centred, but two of its three circles sit right of centre, so it looked
   shifted right in its round button: the drawing moves 1.25 units left
   (the viewBox), where its weight is centred. */
const SHARE_ICON = '<svg viewBox="1.25 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4"/><path d="m15.4 6.5-6.8 4"/></svg>';

/* Draws a picture in a format and a theme. Pictures are drawn one at a time
   (the size and palette are shared), so a second request waits its turn. */
let shareChain = Promise.resolve();
function renderShare(draw, { format = 'wide', theme = 'dark' } = {}) {
  const run = async () => {
    const size = SHARE_FORMATS[format] || SHARE_FORMATS.wide;
    SW = size.w;
    SH = size.h;
    Object.assign(SC, theme === 'light' ? SHARE_LIGHT : SHARE_DARK);
    SC.seq = [...(theme === 'light' ? SHARE_LIGHT : SHARE_DARK).seq];
    return draw();
  };
  const next = shareChain.then(run, run);
  shareChain = next.catch(() => {});
  return next;
}

/* ---------- the button and the sheet --------------------------------- */

/* A share button: the share icon, its name for screen readers and as a tip.
   `image` (optional) draws the view as a picture and resolves to a PNG blob;
   `title` names what is shared. Without a picture the browser's share sheet
   opens straight away (the link), and our own sheet where it has none; with
   one, our sheet opens first, with the picture, to choose between the two.
   `url` shares another address than the page's own (a mini-league's invite). */
function shareButton({ title, image = null, className = '', url = null, label = null } = {}) {
  const button = el('button', `share-btn ${className}`.trim());
  button.type = 'button';
  button.innerHTML = SHARE_ICON;
  button.title = label || t('share.button');
  button.setAttribute('aria-label', label || t('share.button'));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const what = { url: url || window.location.href, title: (typeof title === 'function' ? title() : title) || document.title };
    if (!image && navigator.share) {
      navigator.share({ title: what.title, url: what.url }).catch(() => {});
      return;
    }
    openShareSheet({ ...what, image }, button);
  });
  return button;
}

let shareClose = null;

const shareStored = (key, fallback, allowed) => {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch { return fallback; }
};
const shareStore = (key, value) => { try { localStorage.setItem(key, value); } catch { /* a convenience only */ } };

/* A row of choices (the site's segmented switch): `options` are [value,
   label] pairs; `onPick` gets the value. */
function shareChoice(label, options, current, onPick) {
  const row = el('div', 'share-sheet__choice');
  row.appendChild(el('span', 'share-sheet__choice-label', label));
  const group = el('div', 'switch');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const button = el('button', '', text);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(value === current));
    button.addEventListener('click', () => {
      for (const other of group.children) other.setAttribute('aria-pressed', String(other === button));
      onPick(value);
    });
    group.appendChild(button);
  }
  row.appendChild(group);
  return row;
}

/* Our own share sheet: the picture, with its format and theme to choose,
   Share (the browser's sheet, where it takes files) and Download; then the
   link with Copy and, where the browser has one, Share. */
function openShareSheet({ url, title, image }, opener) {
  shareClose?.();
  const root = el('div', 'share-sheet');
  const scrim = el('div', 'share-sheet__scrim');
  const panel = el('div', 'share-sheet__panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'share-sheet-title');
  const head = el('div', 'share-sheet__head');
  const heading = el('h2', 'share-sheet__title', t('share.title'));
  heading.id = 'share-sheet-title';
  const close = el('button', 'share-sheet__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', t('share.close'));
  head.append(heading, close);
  panel.appendChild(head);

  let file = null;
  const previews = [];
  if (image) {
    const siteTheme = document.documentElement.dataset.resolvedTheme === 'light' ? 'light' : 'dark';
    let format = shareStored('shareFormat', 'wide', Object.keys(SHARE_FORMATS));
    let theme = shareStored('shareTheme', siteTheme, ['dark', 'light']);
    const figure = el('figure', 'share-sheet__figure');
    const status = el('p', 'share-sheet__status', t('share.making'));
    figure.appendChild(status);
    const actions = el('div', 'share-sheet__actions');
    const shareImage = el('button', 'share-sheet__btn is-primary', t('share.image'));
    shareImage.type = 'button';
    const download = el('button', 'share-sheet__btn', t('share.download'));
    download.type = 'button';
    actions.append(shareImage, download);

    let token = 0;
    const draw = async () => {
      const mine = (token += 1);
      const size = SHARE_FORMATS[format];
      figure.style.setProperty('--ratio', `${size.w} / ${size.h}`);
      figure.style.setProperty('--wide', String(size.w / size.h));
      shareImage.disabled = download.disabled = true;
      figure.replaceChildren(status);
      status.textContent = t('share.making');
      file = null;
      try {
        const blob = await renderShare(image, { format, theme });
        if (mine !== token) return;
        if (!blob) throw new Error('no picture');
        file = new File([blob], `elitetracker-${format}-${new Date().toISOString().slice(0, 10)}.png`, { type: 'image/png' });
        const preview = el('img', 'share-sheet__preview');
        preview.alt = title;
        preview.src = URL.createObjectURL(blob);
        previews.push(preview.src);
        figure.replaceChildren(preview);
        const canShareFile = !!navigator.canShare?.({ files: [file] });
        shareImage.hidden = !canShareFile;
        shareImage.disabled = !canShareFile;
        download.disabled = false;
        download.classList.toggle('is-primary', !canShareFile);
      } catch (error) {
        if (mine !== token) return;
        console.error('[share] picture failed:', error);
        status.textContent = t('share.failed');
        shareImage.hidden = true;
      }
    };
    const choices = el('div', 'share-sheet__choices');
    choices.append(
      shareChoice(t('share.format'), Object.keys(SHARE_FORMATS).map((key) => [key, t(`share.fmt.${key}`)]), format, (value) => {
        format = value;
        shareStore('shareFormat', value);
        draw();
      }),
      shareChoice(t('share.theme'), [['dark', t('share.dark')], ['light', t('share.light')]], theme, (value) => {
        theme = value;
        shareStore('shareTheme', value);
        draw();
      }));
    panel.append(choices, figure, actions);
    draw();
    shareImage.addEventListener('click', () => {
      if (file) navigator.share({ files: [file], title, url }).catch(() => {});
    });
    download.addEventListener('click', () => {
      if (!file) return;
      const link = el('a');
      link.href = URL.createObjectURL(file);
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    });
  }

  const linkRow = el('div', 'share-sheet__link');
  const field = el('input', 'share-sheet__url');
  field.type = 'text';
  field.readOnly = true;
  field.value = url;
  field.setAttribute('aria-label', t('share.link'));
  field.addEventListener('focus', () => field.select());
  const copy = el('button', 'share-sheet__btn', t('share.copyLink'));
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      field.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
    }
    copy.textContent = t('share.copied');
    clearTimeout(copy.timer);
    copy.timer = setTimeout(() => { copy.textContent = t('share.copyLink'); }, 1600);
  });
  linkRow.append(field, copy);
  if (navigator.share) {
    const shareLink = el('button', 'share-sheet__btn', t('share.shareLink'));
    shareLink.type = 'button';
    shareLink.addEventListener('click', () => navigator.share({ title, url }).catch(() => {}));
    linkRow.append(shareLink);
  }
  panel.append(el('p', 'share-sheet__label', t('share.link')), linkRow);

  root.append(scrim, panel);
  document.body.appendChild(root);
  const release = trapFocus(panel);
  const onKey = (event) => { if (event.key === 'Escape') shareClose?.(); };
  document.addEventListener('keydown', onKey);
  shareClose = () => {
    release?.();
    document.removeEventListener('keydown', onKey);
    root.remove();
    for (const src of previews) URL.revokeObjectURL(src);
    shareClose = null;
    opener?.focus();
  };
  scrim.addEventListener('click', () => shareClose?.());
  close.addEventListener('click', () => shareClose?.());
}

/* ---------- drawing ----------------------------------------------------- */

const shareImages = new Map(); // src -> Promise<Image|null>
function shareImage(src) {
  if (!src) return Promise.resolve(null);
  if (!shareImages.has(src)) {
    shareImages.set(src, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    }));
  }
  return shareImages.get(src);
}

/* A club's crest for the canvas: the large one kept for pictures
   (logos/share, 256 pixels), else the site's own PNG (192). The pages show
   the small WebP; these load only when a picture is drawn. */
async function shareCrest(teamId) {
  if (!teamId) return null;
  return (await shareImage(`/logos/share/${teamId}.png`)) || shareImage(`/logos/${teamId}.png`);
}

/* A canvas for the format being drawn, at up to twice its size (sharp on a
   phone, the tallest kept under 2560 pixels), the site's fonts loaded first. */
async function shareCanvas() {
  try {
    await Promise.all(['800 48px Archivo', '700 20px Archivo', '600 16px Archivo'].map((font) => document.fonts.load(font)));
  } catch { /* the fallback face still draws */ }
  const scale = Math.min(2, 2560 / Math.max(SW, SH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(SW * scale);
  canvas.height = Math.round(SH * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';
  return { canvas, ctx };
}

/* Text on the canvas: the size, weight and colour, and the heroes' wide cut
   (`wide`) or the labels' spaced capitals (`label`). Text wider than
   `maxWidth` is cut short with an ellipsis, or with `fit` set in a smaller size
   (a name in a heading is shrunk, never cut). Returns its width. */
function paintText(ctx, text, x, y, { size = 20, weight = 600, color = SC.ink, align = 'left', wide = false, label = false, maxWidth, fit = false } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px Archivo, system-ui, sans-serif`;
  if ('fontStretch' in ctx) ctx.fontStretch = wide ? 'expanded' : 'normal';
  if ('letterSpacing' in ctx) ctx.letterSpacing = label ? `${(size * 0.14).toFixed(1)}px` : wide ? `${(-size * 0.03).toFixed(1)}px` : '0px';
  ctx.fillStyle = color;
  ctx.textAlign = align;
  const shown = label ? String(text).toUpperCase() : String(text);
  let measured = ctx.measureText(shown).width;
  let drawn = shown;
  if (fit && maxWidth && measured > maxWidth) {
    const smaller = size * (maxWidth / measured) * 0.98;
    ctx.font = `${weight} ${smaller}px Archivo, system-ui, sans-serif`;
    // Setting the font resets its stretch: the wide cut is set again.
    if ('fontStretch' in ctx) ctx.fontStretch = wide ? 'expanded' : 'normal';
    if ('letterSpacing' in ctx) ctx.letterSpacing = label ? `${(smaller * 0.14).toFixed(1)}px` : wide ? `${(-smaller * 0.03).toFixed(1)}px` : '0px';
    measured = ctx.measureText(shown).width;
  }
  if (maxWidth && measured > maxWidth) {
    while (drawn.length > 1 && ctx.measureText(`${drawn}…`).width > maxWidth) drawn = drawn.slice(0, -1);
    drawn = `${drawn}…`;
    measured = ctx.measureText(drawn).width;
  }
  ctx.fillText(drawn, x, y);
  ctx.restore();
  return measured;
}

/* The width text would take, without drawing it. */
function measureText(ctx, text, { size = 20, weight = 600, wide = false } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px Archivo, system-ui, sans-serif`;
  if ('fontStretch' in ctx) ctx.fontStretch = wide ? 'expanded' : 'normal';
  if ('letterSpacing' in ctx) ctx.letterSpacing = wide ? `${(-size * 0.03).toFixed(1)}px` : '0px';
  const width = ctx.measureText(String(text)).width;
  ctx.restore();
  return width;
}

/* The height of a capital in the share font, from the glyph's own bounds
   (Archivo's caps are about 0.69 of the size, the fallback's differ). */
function shareCapHeight(ctx, size, weight = 600, wide = false) {
  ctx.save();
  ctx.font = `${weight} ${size}px Archivo, system-ui, sans-serif`;
  if ('fontStretch' in ctx) ctx.fontStretch = wide ? 'expanded' : 'normal';
  const ascent = ctx.measureText('E').actualBoundingBoxAscent;
  ctx.restore();
  return ascent || size * 0.69;
}

function shareRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

async function shareDrawCrest(ctx, teamId, name, x, y, size) {
  const img = await shareCrest(teamId, name);
  if (!img) return;
  const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h);
}

/* The frame every picture shares: the page's ground, a label in the heroes'
   spaced capitals at the top, and at the foot the mark, the name and the
   address it came from. Returns the room left: x, y, w, h. */
function shareFrame(ctx, labelText) {
  const pad = sharePad();
  const u = shareU();
  ctx.fillStyle = SC.paper;
  ctx.fillRect(0, 0, SW, SH);
  // A faint glow from the top, as the page's masthead throws.
  const glow = ctx.createRadialGradient(SW / 2, -200, 50, SW / 2, -200, Math.max(SW, SH) * 0.6);
  glow.addColorStop(0, SC.glow);
  glow.addColorStop(1, 'rgba(31, 94, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SW, SH);
  paintText(ctx, labelText, pad, pad + 6 * u, { size: 16 * u, weight: 600, color: SC.muted, label: true, maxWidth: SW - pad * 2, fit: true });
  // The foot: the mark's nine cells, the name, the address. The cells are
  // centred on the name's capitals (its cap height, measured), not on a
  // fixed offset from the baseline, so they sit level at every size.
  const foot = SH - pad + 8;
  const nameBase = foot - 3;
  const nameSize = 20 * u;
  const cell = 7.5 * u;
  const gap = 2 * u;
  const markTop = nameBase - shareCapHeight(ctx, nameSize, 800, true) / 2 - (cell * 3 + gap * 2) / 2;
  [1, 0.35, 0.1, 0.35, 1, 0.35, 0.1, 0.35, 1].forEach((alpha, i) => {
    ctx.globalAlpha = alpha;
    shareRect(ctx, pad + (i % 3) * (cell + gap), markTop + Math.floor(i / 3) * (cell + gap), cell, cell, 1.5, i === 0 ? SC.accent : SC.ink);
  });
  ctx.globalAlpha = 1;
  paintText(ctx, 'ELITETRACKER', pad + 36 * u, nameBase, { size: nameSize, weight: 800, wide: true });
  paintText(ctx, window.location.host, SW - pad, foot - 3, { size: 18 * u, weight: 600, color: SC.faint, align: 'right' });
  const top = pad + 34 * u;
  const bottom = foot - 50 * u;
  return { x: pad, y: top, w: SW - pad * 2, h: bottom - top, top, bottom };
}

const shareBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

/* The season and the round a report has reached, for a picture's label. */
function shareSeasonLabel(report) {
  const round = overviewRound(report);
  const parts = [report.league.name, String(report.league.season)];
  if (report.model.matches_remaining === 0) parts.push(t('share.final'));
  else if (round) parts.push(t('overview.round', round));
  return parts.join(' · ');
}

/* A crest and a name on one line, the name after the crest (or before it,
   right-aligned). Returns the width taken. */
async function shareClubLine(ctx, row, x, y, { size, crest, align = 'left', maxWidth, weight = 700, color = SC.ink }) {
  const gap = crest * 0.3;
  if (align === 'right') {
    const width = paintText(ctx, row.team, x, y + size * 0.35, { size, weight, align: 'right', color, maxWidth: maxWidth && maxWidth - crest - gap });
    await shareDrawCrest(ctx, row.team_id, row.team, x - width - gap - crest, y - crest / 2, crest);
    return width + gap + crest;
  }
  await shareDrawCrest(ctx, row.team_id, row.team, x, y - crest / 2, crest);
  return crest + gap + paintText(ctx, row.team, x + crest + gap, y + size * 0.35, { size, weight, color, maxWidth: maxWidth && maxWidth - crest - gap });
}

/* ---------- the pictures ------------------------------------------------ */

/* A bar on its track, as long as `p` of the track. */
function shareBar(ctx, x, y, w, h, p, color) {
  shareRect(ctx, x, y, w, h, h / 2, SC.rule);
  if (p > 0) shareRect(ctx, x, y, Math.max(w * Math.min(p, 1), h), h, h / 2, color);
}

/* The club page's attack and defence bar: it grows from the division
   average (the centre line), blue when better, red when worse, scaled by the
   division's widest. `rel` is { v, widest }. */
function shareDiverging(ctx, x, y, w, h, rel) {
  shareRect(ctx, x, y, w, h, h / 2, SC.rule);
  const half = (Math.abs(rel.v) / rel.widest) * (w / 2);
  const mid = x + w / 2;
  if (half > 0.5) shareRect(ctx, rel.v >= 0 ? mid : mid - half, y, half, h, h / 2, rel.v >= 0 ? SC.good : SC.bad);
  ctx.fillStyle = SC.ink;
  ctx.fillRect(mid - 1.5, y - h * 0.55, 3, h * 2.1);
}

/* The table's trend arrow (`trendArrowSVG`): upright for a strong rise,
   level for steady, down for a strong fall, in the outcome colours. */
function shareArrow(ctx, direction, cx, cy, size) {
  const angle = { 'strong-rise': 0, rise: 45, steady: 90, fall: 135, 'strong-fall': 180 }[direction] ?? 90;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.scale(size / 24, size / 24);
  ctx.translate(-12, -12);
  ctx.strokeStyle = direction.includes('rise') ? SC.good : direction.includes('fall') ? SC.bad : SC.faint;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(12, 19);
  ctx.lineTo(12, 5);
  ctx.moveTo(5, 12);
  ctx.lineTo(12, 5);
  ctx.lineTo(19, 12);
  ctx.stroke();
  ctx.restore();
}

/* Text turned a quarter left, centred on (x, y). */
function shareRotated(ctx, text, x, y, opts) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 2);
  paintText(ctx, text, 0, 0, { ...opts, align: 'center' });
  ctx.restore();
}

/* The finish grid's rows: the clubs by likeliest finish. */
const shareGridRows = (report) => [...report.table].sort((a, b) => expectedFinish(a) - expectedFinish(b) || a.position - b.position);

/* The title race. Two contenders: their figures and the bar split between
   them (the favourite gold, the field slate), along the foot of a wide
   picture and up the right side of a tall one, each club level with its
   share. Three or more: a row each, its own bar as long as its chance. */
async function shareTitleRace(report) {
  const { ctx, canvas } = await shareCanvas();
  const room = shareFrame(ctx, `${t('hero.race.title')} · ${shareSeasonLabel(report)}`);
  const u = shareU();
  const tall = shareTall();
  const shown = overviewTitleRace(report).ranked.slice(0, OVERVIEW_TITLE_CLUBS);
  const n = shown.length;
  const tone = (i) => (i === 0 ? SC.gold : SC.slate);
  const figColor = (i) => (i === 0 ? SC.ink : SC.muted);

  if (n >= 3) {
    await shareRaceRows(ctx, room, shown.map(({ row, chance }, i) => ({ row, chance, text: pct(chance, 1), bar: tone(i), ink: figColor(i) })));
    return shareBlob(canvas);
  }

  const gap = 6;
  const rest = Math.max(0, 1 - shown.reduce((sum, { chance }) => sum + chance, 0));
  const parts = [...shown.map(({ chance }, i) => ({ p: Math.max(chance, 0.004), color: tone(i) })), ...(rest > 0.005 ? [{ p: rest, color: SC.rule }] : [])];
  const total = parts.reduce((sum, part) => sum + part.p, 0);

  if (!tall) {
    const barH = 22;
    const barY = room.y + room.h - barH;
    const size = 116;
    const figureY = room.y + (room.h - 40) / 2 + size * 0.2;
    for (const [i, { row, chance }] of shown.entries()) {
      const right = n === 2 && i === 1;
      const x = right ? room.x + room.w : room.x;
      paintText(ctx, pct(chance, 1), x, figureY, { size, weight: 800, wide: true, align: right ? 'right' : 'left', color: figColor(i) });
      await shareClubLine(ctx, row, x, figureY + 52, { size: 30, crest: 44, align: right ? 'right' : 'left', maxWidth: room.w / 2 });
    }
    const span = room.w - gap * (parts.length - 1);
    let x = room.x;
    for (const part of parts) {
      const w = (part.p / total) * span;
      shareRect(ctx, x, barY, Math.max(w, 3), barH, 6, part.color);
      x += w + gap;
    }
    return shareBlob(canvas);
  }

  // Tall: the bar up the right side, each club beside its share.
  const barW = 44 * u;
  const barX = room.x + room.w - barW;
  const span = room.h - gap * (parts.length - 1);
  const mids = [];
  let y = room.y;
  for (const part of parts) {
    const h = (part.p / total) * span;
    shareRect(ctx, barX, y, barW, Math.max(h, 3), 8 * u, part.color);
    mids.push(y + h / 2);
    y += h + gap;
  }
  const textW = barX - 60 * u - room.x;
  const size = Math.min(room.h * 0.19, 220);
  const crest = Math.max(40, size * 0.28);
  const blockH = size * 0.75 + size * 0.32 + crest / 2;
  const space = 50 * u;
  // Each block centred on its share, then pushed apart and kept in the room.
  const tops = mids.slice(0, n).map((m) => m - blockH / 2);
  for (let i = 0; i < n; i += 1) tops[i] = Math.max(tops[i], i ? tops[i - 1] + blockH + space : room.y);
  for (let i = n - 1; i >= 0; i -= 1) tops[i] = Math.min(tops[i], i === n - 1 ? room.y + room.h - blockH : tops[i + 1] - blockH - space);
  for (const [i, { row, chance }] of shown.entries()) {
    const base = tops[i] + size * 0.75;
    paintText(ctx, pct(chance, 1), room.x, base, { size, weight: 800, wide: true, color: figColor(i), maxWidth: textW, fit: true });
    await shareClubLine(ctx, row, room.x, base + size * 0.32, { size: Math.max(30, size * 0.2), crest, maxWidth: textW });
  }
  return shareBlob(canvas);
}

/* A race as rows, a club each: its figure (`text`, in `ink`) and its own bar
   (in `bar`) as long as its chance. Wide: the club, the bar and the figure
   on one line. Tall: the club, the figure under it, the bar under that. */
async function shareRaceRows(ctx, room, rows) {
  const u = shareU();
  const tall = shareTall();
  const n = rows.length;
  const rowH = Math.min(room.h / n, tall ? 320 * u : 150);
  const top = room.y + (room.h - rowH * n) / 2;
  const fig = tall ? Math.min(rowH * 0.36, 120 * u) : Math.min(rowH * 0.5, 60);
  const figW = Math.max(...rows.map((r) => measureText(ctx, r.text, { size: fig, weight: 800, wide: true }))) + 36;
  for (const [i, { row, chance, text, bar, ink }] of rows.entries()) {
    const y = top + rowH * i;
    if (tall) {
      const name = Math.min(36 * u, rowH * 0.12);
      const lineY = y + rowH * 0.14;
      await shareClubLine(ctx, row, room.x, lineY, { size: name, crest: name * 1.5, maxWidth: room.w });
      const base = lineY + name * 0.9 + fig * 0.8;
      paintText(ctx, text, room.x, base, { size: fig, weight: 800, wide: true, color: ink, maxWidth: room.w, fit: true });
      shareBar(ctx, room.x, base + rowH * 0.08, room.w, Math.max(14 * u, rowH * 0.06), chance, bar);
    } else {
      const mid = y + rowH / 2;
      const nameW = room.w * 0.32;
      await shareClubLine(ctx, row, room.x, mid, { size: Math.min(30, rowH * 0.28), crest: Math.min(48, rowH * 0.45), maxWidth: nameW - 20 });
      shareBar(ctx, room.x + nameW, mid - 11, room.w - nameW - figW, 22, chance, bar);
      paintText(ctx, text, room.x + room.w, mid + fig * 0.36, { size: fig, weight: 800, wide: true, align: 'right', color: ink });
    }
  }
}

/* One of a division's other races (the Champions League and Conference
   League places, promotion, relegation), as the overview's card has it: the
   title race's rows, the bars in the band's own colour, the figures of the
   clubs likelier in than out in ink and the rest muted. A club already up or
   down once the season is over is told in words. When the chances count a
   play-off, the picture says it is simulated. */
async function shareRace(report, { band, ranked }, finished) {
  const { ctx, canvas } = await shareCanvas();
  const room = shareFrame(ctx, `${bandName(band)} · ${shareSeasonLabel(report)}`);
  const u = shareU();
  const slug = report.league.slug;
  const color = shareBandColor(band, report.table.length);
  const shown = ranked.slice(0, finished ? OVERVIEW_DONE_CLUBS : OVERVIEW_RACE_CLUBS);
  if (shown.some(({ row }) => bandWithPlayoff(row, band, slug))) {
    paintText(ctx, t('share.playoffSimulated'), room.x, room.y + 18 * u, { size: 18 * u, weight: 600, color: SC.muted, maxWidth: room.w });
    room.y += 40 * u;
    room.h -= 40 * u;
  }
  await shareRaceRows(ctx, room, shown.map(({ row, chance }) => {
    const done = finished && chance >= 0.999;
    return {
      row,
      chance,
      text: done ? t(band.tone === 'relegation' ? 'overview.relegated' : 'overview.promoted') : pct(chance, chance < 0.1 ? 1 : 0),
      bar: color,
      ink: chance >= 0.5 ? SC.ink : SC.muted,
    };
  }));
  return shareBlob(canvas);
}

/* The finish grid. Wide and square: every club's chance of every place, the
   bands' colours over the columns, the cells in the grid's ramp (on a wide
   picture each cell at most half again as wide as it is tall, the whole
   centred). Portrait and story: the predicted table (shareFinishTable). */
async function shareFinishGrid(report) {
  if (SH > SW * 1.1) return shareFinishTable(report);
  const { ctx, canvas } = await shareCanvas();
  const room = shareFrame(ctx, `${t('grid.title')} · ${shareSeasonLabel(report)}`);
  const tall = shareTall();
  const rows = shareGridRows(report);
  const count = rows.length;
  const nameW = tall ? 300 : 270;
  const headH = 26;
  let cellW = (room.w - nameW) / count;
  const cellH = Math.min((room.h - headH) / count, cellW * (tall ? 1.6 : 1.15));
  if (!tall) cellW = Math.min(cellW, cellH * 1.5);
  const x0 = room.x + (tall ? 0 : (room.w - nameW - cellW * count) / 2);
  const gridX = x0 + nameW;
  const y0 = room.y + (tall ? (room.h - headH - cellH * count) / 2 : 0);
  const bands = report.league.bands;
  const numSize = Math.min(tall ? 18 : 15, cellH * 0.48, cellW * 0.36);
  for (let place = 1; place <= count; place += 1) {
    const x = gridX + (place - 1) * cellW;
    const band = bandFor(bands, place);
    if (band) shareRect(ctx, x + 2, y0 + 2, cellW - 4, 4, 2, shareBandColor(band, count));
    paintText(ctx, String(place), x + cellW / 2, y0 + headH - 4, { size: 13, weight: 600, color: SC.faint, align: 'center' });
  }
  for (const [r, row] of rows.entries()) {
    const y = y0 + headH + r * cellH;
    const crest = Math.min(tall ? 34 : 24, cellH - 4);
    const nameSize = Math.min(tall ? 26 : 19, cellH * (tall ? 0.6 : 0.66));
    await shareDrawCrest(ctx, row.team_id, row.team, x0, y + (cellH - crest) / 2, crest);
    paintText(ctx, row.team, x0 + crest + 10, y + cellH / 2 + nameSize * 0.35, { size: nameSize, weight: 600, maxWidth: nameW - crest - 20 });
    row.position_probabilities.forEach((p, i) => {
      const step = heatStep(p);
      const x = gridX + i * cellW;
      shareRect(ctx, x + 1.5, y + 1.5, cellW - 3, cellH - 3, 3, step <= 0 ? SC.sunk : SC.seq[Math.min(step, 7) - 1]);
      const text = pctShort(p);
      if (text) paintText(ctx, text, x + cellW / 2, y + cellH / 2 + numSize * 0.36, { size: numSize, weight: 700, color: step >= 5 ? SC.cellInkInvert : SC.cellInk, align: 'center' });
    });
  }
  return shareBlob(canvas);
}

/* The predicted table, the finish grid on a portrait or story picture: each
   club in the order the model expects, the table's band mark (a thin bar
   left of the place, none mid-table), a small chart of its chance of every
   place, its columns in the bands' colours (so a mid-table club's spread
   shows), and its likeliest place with that place's chance. */
async function shareFinishTable(report) {
  const { ctx, canvas } = await shareCanvas();
  const room = shareFrame(ctx, `${t('share.tableTitle')} · ${shareSeasonLabel(report)}`);
  const u = shareU();
  const rows = shareGridRows(report);
  const count = rows.length;
  const bands = report.league.bands;
  const headH = 40 * u;
  const rowH = (room.h - headH) / count;
  const size = Math.min(26 * u, rowH * 0.4);
  const markW = Math.max(4, size * 0.16);
  const numRight = room.x + markW + size * 0.45 + measureText(ctx, String(count), { size, weight: 800, wide: true });
  const nameX = numRight + size * 0.7;
  const textW = measureText(ctx, `${ordinal(count)} · 100 %`, { size: size * 0.8, weight: 700 });
  const histW = room.w * 0.27;
  const histX = room.x + room.w - textW - 28 * u - histW;
  const colW = histW / count;
  paintText(ctx, t('share.perPlace'), histX, room.y + 16 * u, { size: 12 * u, weight: 600, color: SC.faint, label: true, maxWidth: histW + 20 });
  paintText(ctx, t('share.likeliestShort'), room.x + room.w, room.y + 16 * u, { size: 12 * u, weight: 600, color: SC.faint, label: true, align: 'right' });
  for (const [i, row] of rows.entries()) {
    const cy = room.y + headH + i * rowH + rowH / 2;
    const band = bandFor(bands, i + 1);
    if (band) shareRect(ctx, room.x, cy - size * 0.58, markW, size * 1.15, 2, shareBandColor(band, count));
    paintText(ctx, String(i + 1), numRight, cy + size * 0.36, { size, weight: 800, wide: true, align: 'right', color: SC.muted });
    await shareClubLine(ctx, row, nameX, cy, { size, crest: size * 1.3, weight: 600, maxWidth: histX - 24 * u - nameX });
    // The columns as tall as the row's likeliest place allows (50 % at the
    // least), so a spread-out row still shows its shape.
    const probs = row.position_probabilities;
    const scale = Math.max(...probs, 0.5);
    const chartH = rowH * 0.62;
    const base = cy + chartH / 2;
    shareRect(ctx, histX, base, histW, Math.max(1.5, u * 1.5), 1, SC.rule);
    probs.forEach((p, j) => {
      if (p < 0.005) return;
      const h = Math.max(2, (p / scale) * chartH);
      const b = bandFor(bands, j + 1);
      shareRect(ctx, histX + j * colW + 1, base - h, colW - 2, h, Math.min(3, colW / 4), b ? shareBandColor(b, count) : SC.slate);
    });
    const likeliest = probs.reduce((best, p, j) => (p > probs[best] ? j : best), 0);
    paintText(ctx, `${ordinal(likeliest + 1)} · ${pct(probs[likeliest], 0)}`, room.x + room.w, cy + size * 0.3, { size: size * 0.8, weight: 700, color: SC.muted, align: 'right' });
  }
  return shareBlob(canvas);
}

/* A club's figures for its picture. */
function shareClubFigures(report, teamId, row) {
  const count = report.table.length;
  const live = report.model.matches_remaining > 0;
  const every = Object.values(state.reports || {}).flatMap((r) => r.table.map((x) => ({ id: String(x.team_id), rating: x.rating })));
  every.sort((a, b) => b.rating - a.rating);
  const rank = every.findIndex((x) => x.id === String(teamId)) + 1;
  const relative = (key, higher) => {
    const avg = report.table.reduce((sum, r) => sum + r[key], 0) / count;
    const f = (v) => (higher ? v / avg - 1 : 1 - v / avg);
    return { v: f(row[key]), widest: Math.max(...report.table.map((r) => Math.abs(f(r[key])))) || 1 };
  };
  const likeliest = row.position_probabilities.reduce((best, p, i) => (p > row.position_probabilities[best] ? i : best), 0);
  const left = Math.max(0, (count - 1) * 2 - row.played);
  return {
    count,
    trend: computeRatingTrend(row.team, report),
    rankText: rank ? t('team.rankOf', { rank: rankText(rank), total: every.length }) : '',
    place: live
      ? [t('share.likeliest'), rankText(likeliest + 1), pct(row.position_probabilities[likeliest], 0)]
      : [t('share.finished'), rankText(row.position), t('share.points', { n: num(row.points) })],
    points: live ? [t('team.xPts'), num(row.expected_points), `${t('share.pointsLabel')}: ${num(row.points)}`] : null,
    now: live ? [t('share.pointsLabel'), num(row.points), t(left === 1 ? 'share.matchLeft' : 'share.matchesLeft', { n: left })] : null,
    attack: relative('attack', true),
    defence: relative('defence', false),
    races: report.league.bands
      .filter((band) => band.tone !== 'playoff')
      .map((band) => ({ band, chance: bandChance(row, band, report.league.slug) }))
      .filter(({ chance }) => chance >= 0.005)
      .slice(0, 4),
  };
}

/* A figure: its label over it, the value (after the rating's trend arrow,
   when `arrow` names one), a line under it. */
function shareStat(ctx, x, y, w, [label, value, sub], { size, s = 1, arrow = null }) {
  paintText(ctx, label, x, y + 14 * s, { size: 14 * s, weight: 600, color: SC.faint, label: true, maxWidth: w - 10 });
  const base = y + 24 * s + size * 0.76;
  let vx = x;
  if (arrow) {
    shareArrow(ctx, arrow, x + size * 0.3, base - size * 0.36, size * 0.62);
    vx += size * 0.7;
  }
  paintText(ctx, value, vx, base, { size, weight: 800, wide: true, maxWidth: w - 10 - (vx - x), fit: true });
  if (sub) paintText(ctx, sub, x, base + 30 * s, { size: 17 * s, weight: 600, color: SC.muted, maxWidth: w - 10 });
}

/* Attack or defence: the label and the figure on a line, the club page's
   bar under them. Returns the height taken. */
function shareStrength(ctx, x, y, w, label, rel, { s = 1, size = 30 }) {
  const base = y + size * 0.75;
  paintText(ctx, label, x, base, { size: 15 * s, weight: 600, color: SC.faint, label: true });
  paintText(ctx, `${signed(rel.v * 100)}${percentSign()}`, x + w, base, { size, weight: 800, wide: true, align: 'right', color: rel.v >= 0 ? SC.goodInk : SC.badInk });
  shareDiverging(ctx, x, base + 16 * s, w, 12 * s, rel);
  return size * 0.75 + 28 * s;
}

/* A race the club is in: the band's name, the chance, a bar in the band's
   colour. Returns the height taken. */
function shareClubRace(ctx, x, y, w, { band, chance }, count, { s = 1 }) {
  const base = y + 24 * s;
  paintText(ctx, bandName(band), x, base, { size: 19 * s, weight: 600, color: SC.muted, maxWidth: w - 150 * s });
  paintText(ctx, pct(chance, chance < 0.1 ? 1 : 0), x + w, base + 2 * s, { size: 30 * s, weight: 800, wide: true, align: 'right' });
  shareBar(ctx, x, base + 16 * s, w, 10 * s, chance, shareBandColor(band, count));
  return 50 * s;
}

/* A club: its crest and name; its rating (after the trend arrow) and where
   that ranks among every club; its likeliest place (its place once the
   season is over) and points; its attack and defence as the club page's bars
   from the division average; the races it has a chance of. Wide: the rating
   at the head's right, the figures and bars on the left, the races on the
   right. Tall: the figures two by two, then the bars, then the races, the
   spare height shared between the parts. */
async function shareClub(report, teamId) {
  const row = report.table.find((r) => String(r.team_id) === String(teamId));
  if (!row) return null;
  const { ctx, canvas } = await shareCanvas();
  const room = shareFrame(ctx, shareSeasonLabel(report));
  const fig = shareClubFigures(report, teamId, row);
  const caption = t('share.averageLine');

  if (!shareTall()) {
    const crest = 84;
    await shareDrawCrest(ctx, row.team_id, row.team, room.x, room.y + 4, crest);
    const base = room.y + 4 + crest * 0.7;
    const ratingW = paintText(ctx, num(row.rating), room.x + room.w, base, { size: 58, weight: 800, wide: true, align: 'right' });
    const arrowW = fig.trend ? 52 : 0;
    if (fig.trend) shareArrow(ctx, fig.trend.direction, room.x + room.w - ratingW - 30, base - 21, 38);
    paintText(ctx, fig.rankText, room.x + room.w, base + 30, { size: 17, weight: 600, color: SC.muted, align: 'right' });
    paintText(ctx, row.team, room.x + crest + 22, base, { size: 56, weight: 800, wide: true, maxWidth: room.w - crest - 22 - Math.max(ratingW + arrowW, 200) - 40, fit: true });
    const y0 = room.y + crest + 50;
    const leftW = 500;
    [fig.place, fig.points].filter(Boolean).forEach((stat, i) => shareStat(ctx, room.x + i * (leftW / 2), y0, leftW / 2, stat, { size: 46 }));
    let y = y0 + 130;
    y += shareStrength(ctx, room.x, y, leftW - 20, t('share.attack'), fig.attack, { size: 28 }) + 26;
    y += shareStrength(ctx, room.x, y, leftW - 20, t('share.defence'), fig.defence, { size: 28 }) + 22;
    paintText(ctx, caption, room.x, y, { size: 14, weight: 600, color: SC.faint });
    const raceX = room.x + leftW + 70;
    let ry = y0 + 4;
    for (const race of fig.races) ry += shareClubRace(ctx, raceX, ry, room.x + room.w - raceX, race, fig.count, {}) + 34;
    return shareBlob(canvas);
  }

  // Tall: points now has a cell of its own, so expected points needs no line under it.
  const stats = [[t('share.rating'), num(row.rating), fig.rankText], fig.place, fig.points && [fig.points[0], fig.points[1], ''], fig.now].filter(Boolean);
  const statRows = Math.ceil(stats.length / 2);
  // The parts' heights at scale s; s shrinks when they would not fit.
  const parts = (s) => {
    const statSize = 66 * s;
    const statRow = 24 * s + statSize * 0.76 + 40 * s + 44 * s;
    const races = fig.races.length;
    return { s, crest: 116 * s, statSize, statRow, heights: [116 * s, statRow * statRows - 44 * s, (34 * s * 0.75 + 28 * s) * 2 + 74 * s, races ? races * 50 * s + (races - 1) * 44 * s : 0] };
  };
  const sum = (h) => h.reduce((a, b) => a + b, 0);
  const room0 = room.h - 150;
  let p = parts(Math.min(1.55, room.h / 835));
  if (sum(p.heights) > room0) p = parts(p.s * (room0 / sum(p.heights)));
  const { s } = p;
  const used = p.heights.filter(Boolean);
  const gap = Math.min(150 * s, (room.h - sum(used)) / used.length);
  let y = room.y;
  await shareDrawCrest(ctx, row.team_id, row.team, room.x, y, p.crest);
  paintText(ctx, row.team, room.x + p.crest + 28 * s, y + p.crest * 0.68, { size: 68 * s, weight: 800, wide: true, maxWidth: room.w - p.crest - 28 * s, fit: true });
  y += p.heights[0] + gap;
  const cw = room.w / 2;
  stats.forEach((stat, i) => shareStat(ctx, room.x + (i % 2) * cw, y + Math.floor(i / 2) * p.statRow, cw, stat, { size: p.statSize, s, arrow: i === 0 ? fig.trend?.direction : null }));
  y += p.heights[1] + gap;
  y += shareStrength(ctx, room.x, y, room.w, t('share.attack'), fig.attack, { s, size: 34 * s }) + 40 * s;
  y += shareStrength(ctx, room.x, y, room.w, t('share.defence'), fig.defence, { s, size: 34 * s }) + 34 * s;
  paintText(ctx, caption, room.x, y, { size: 16 * s, weight: 600, color: SC.faint });
  y += gap;
  for (const race of fig.races) y += shareClubRace(ctx, room.x, y, room.w, race, fig.count, { s }) + 44 * s;
  return shareBlob(canvas);
}

/* A side of a match: its tag (home blue, away red, as in the odds bar), the
   crest and the name; centred with the crest over the name when `stacked`.
   Returns the height taken. */
async function shareSide(ctx, side, x, y, { crest, size, tag, color, maxWidth, stacked = false }) {
  const tagSize = Math.max(13, size * 0.42);
  if (stacked) {
    await shareDrawCrest(ctx, side.id, side.name, x - crest / 2, y, crest);
    paintText(ctx, side.name, x, y + crest + size * 1.25, { size, weight: 800, wide: true, align: 'center', maxWidth, fit: true });
    paintText(ctx, tag, x, y + crest + size * 1.25 + tagSize * 2, { size: tagSize, weight: 700, color, align: 'center', label: true });
    return crest + size * 1.25 + tagSize * 2;
  }
  paintText(ctx, tag, x, y + tagSize, { size: tagSize, weight: 700, color, label: true });
  await shareClubLine(ctx, { team_id: side.id, team: side.name }, x, y + tagSize + 14 + crest / 2, { size, crest, weight: 800, maxWidth });
  return tagSize + 14 + crest;
}

/* The odds bar: home, draw, away, each as long as its chance with the chance
   in it, and under it whose each one is: the home club at the left in blue,
   the draw in the middle (where it fits), the away club at the right in red. */
function shareOdds(ctx, x, y, w, h, { home, away, odds }, { size, label }) {
  const segs = [[odds.home_win, SC.good, '#ffffff'], [odds.draw, SC.draw, '#0f1828'], [odds.away_win, SC.bad, '#ffffff']];
  const span = w - 8;
  let at = x;
  const mids = [];
  for (const [p, color, ink] of segs) {
    const sw = p * span;
    shareRect(ctx, at, y, Math.max(sw, 3), h, Math.min(8, h / 4), color);
    if (p >= 0.08) paintText(ctx, pct(p, 0), at + sw / 2, y + h / 2 + size * 0.36, { size, weight: 800, color: ink, align: 'center' });
    mids.push(at + sw / 2);
    at += sw + 4;
  }
  const ly = y + h + label * 1.5;
  const homeW = paintText(ctx, home.name, x, ly, { size: label, weight: 700, color: SC.goodInk, maxWidth: w * 0.4 });
  const awayW = paintText(ctx, away.name, x + w, ly, { size: label, weight: 700, color: SC.badInk, align: 'right', maxWidth: w * 0.4 });
  const draw = t('hero.match.draw');
  const drawW = measureText(ctx, draw, { size: label, weight: 600 });
  if (mids[1] - drawW / 2 > x + homeW + 12 && mids[1] + drawW / 2 < x + w - awayW - 12) paintText(ctx, draw, mids[1], ly, { size: label, weight: 600, color: SC.muted, align: 'center' });
}

/* The score grid: every score from 0-0 to 4-4 shaded by its chance, home
   goals down and away goals across, each axis named by its club in its
   side's colour. (gx, gy) is the grid's corner; the names and numbers sit in
   the `margin` above and left of it. */
function shareScoreGrid(ctx, gx, gy, side, { home, away, cells }, { u, margin }) {
  const k = 5;
  const at = new Map(cells.map((c) => [`${c.home_goals}-${c.away_goals}`, c.probability]));
  const maxP = Math.max(...cells.map((c) => c.probability), 0.01);
  const cell = side / k;
  const axis = Math.min(18 * u, cell * 0.24);
  const inCell = Math.min(22 * u, cell * 0.24);
  for (let i = 0; i < k; i += 1) {
    paintText(ctx, String(i), gx - margin * 0.3, gy + cell * i + cell / 2 + axis * 0.36, { size: axis, weight: 700, color: SC.faint, align: 'center' });
    paintText(ctx, String(i), gx + cell * i + cell / 2, gy - margin * 0.2, { size: axis, weight: 700, color: SC.faint, align: 'center' });
    for (let j = 0; j < k; j += 1) {
      const p = at.get(`${i}-${j}`) || 0;
      const step = Math.max(1, Math.min(7, Math.ceil((p / maxP) * 7)));
      shareRect(ctx, gx + cell * j + 2, gy + cell * i + 2, cell - 4, cell - 4, 6, SC.seq[step - 1]);
      paintText(ctx, pct(p, 0), gx + cell * j + cell / 2, gy + cell * i + cell / 2 + inCell * 0.36, { size: inCell, weight: 700, color: step >= 5 ? SC.cellInkInvert : SC.cellInk, align: 'center' });
    }
  }
  const nameSize = Math.min(20 * u, margin * 0.34);
  paintText(ctx, t('share.goals', { team: away.name }), gx + side / 2, gy - margin * 0.62, { size: nameSize, weight: 700, color: SC.badInk, align: 'center', maxWidth: side });
  shareRotated(ctx, t('share.goals', { team: home.name }), gx - margin * 0.74, gy + side / 2, { size: nameSize, weight: 700, color: SC.goodInk, maxWidth: side });
}

/* A match: the two sides, tagged home and away; the odds bar under them,
   named in the sides' colours; and the score grid. Wide: the sides and the
   odds on the left, the grid on the right. Tall: the sides across the top,
   the odds under them, the grid under that, kept to about four fifths of
   the width so the sides and the odds keep their weight. `home`/`away` carry
   id and name, `odds` home_win/draw/away_win, `cells` the scorelines from
   0-0 to 4-4 (topScorelines with 49). */
async function shareMatch({ label, home, away, odds, cells = [] }) {
  const { ctx, canvas } = await shareCanvas();
  const room = shareFrame(ctx, label);
  const u = shareU();
  const tags = [t('compare.home'), t('compare.away')];

  if (!shareTall()) {
    const margin = 62;
    const side = room.h - margin;
    const gx = room.x + room.w - side;
    shareScoreGrid(ctx, gx, room.y + margin, side, { home, away, cells }, { u, margin });
    const infoW = gx - margin - 50 - room.x;
    let y = room.y + (room.h - 316) / 2;
    y += await shareSide(ctx, home, room.x, y, { crest: 60, size: 32, tag: tags[0], color: SC.goodInk, maxWidth: infoW }) + 30;
    y += await shareSide(ctx, away, room.x, y, { crest: 60, size: 32, tag: tags[1], color: SC.badInk, maxWidth: infoW }) + 34;
    shareOdds(ctx, room.x, y, infoW, 46, { home, away, odds }, { size: 20, label: 17 });
    return shareBlob(canvas);
  }

  const s = Math.min(1.45, room.h / 835);
  const crest = 120 * s;
  const size = 40 * s;
  const sidesH = crest + size * 1.25 + Math.max(13, size * 0.42) * 2;
  const barH = 60 * s;
  const oddsH = barH + 22 * s * 1.5;
  const margin = 70 * s;
  const side = Math.min(room.w * 0.8 - margin, room.h - sidesH - oddsH - margin - 100 * s);
  const gap = Math.min(140 * s, (room.h - sidesH - oddsH - margin - side) / 3);
  let y = room.y + gap * 0.5;
  for (const [i, club] of [home, away].entries()) {
    await shareSide(ctx, club, room.x + room.w * (i ? 0.75 : 0.25), y, { crest, size, tag: tags[i], color: i ? SC.badInk : SC.goodInk, stacked: true, maxWidth: room.w / 2 - 30 });
  }
  y += sidesH + gap;
  shareOdds(ctx, room.x, y, room.w, barH, { home, away, odds }, { size: 26 * s, label: 22 * s });
  y += oddsH + gap;
  shareScoreGrid(ctx, room.x + (room.w - side + margin) / 2, y + margin, side, { home, away, cells }, { u: s, margin });
  return shareBlob(canvas);
}

/* A club's chance of one place. Where the browser's own season has the
   likeliest way it happens (`scenarioRequest`, as the popup shows it) and its
   matches fit the picture, that season in two lists: the club's run-in, each
   match's result from its side, and the rivals' results it rests on; side by
   side on a wide picture, one under the other on a tall one, where the rows
   grow with the room and the spare height goes between the parts. Otherwise
   the club's chance of every place as columns (shareFinishChart). */
async function shareFinish(report, teamId, position) {
  const club = report.table.findIndex((r) => String(r.team_id) === String(teamId));
  const row = report.table[club];
  if (!row) return null;
  let scenario = null;
  if (scenarioAvailable(report)) {
    try {
      const analysis = await scenarioRequest(report, club, position - 1, scenarioAvoidTie);
      if (analysis) {
        const prepared = whatIfPrepare(report);
        scenario = { prepared, analysis, own: scenarioByDate(prepared, analysis.own), deciders: scenarioDeciders(prepared, analysis) };
      }
    } catch { /* the chart stands in */ }
  }
  const { ctx, canvas } = await shareCanvas();
  const room = shareFrame(ctx, `${t('scenario.eyebrow')} · ${shareSeasonLabel(report)}`);
  const u = shareU();
  const tall = shareTall();
  const k = tall ? Math.min(1.35, Math.max(1, room.h / 1105)) : 1;
  const chance = row.position_probabilities[position - 1];
  // The head: the club, the place, the chance.
  const crest = tall ? 96 * k : 64;
  await shareDrawCrest(ctx, row.team_id, row.team, room.x, room.y + 6, crest);
  paintText(ctx, t('scenario.title', { team: row.team, place: ordinal(position) }), room.x + crest + 20, room.y + 6 + crest * 0.62, { size: tall ? 46 * k : 36, weight: 800, wide: true, maxWidth: room.w - crest - 20 - (tall ? 0 : 300), fit: true });
  const chanceSize = tall ? 120 * k : 64;
  if (tall) paintText(ctx, pct(chance, 1), room.x, room.y + crest + 40 * k + chanceSize * 0.85, { size: chanceSize, weight: 800, wide: true, color: SC.accentInk });
  else paintText(ctx, pct(chance, 1), room.x + room.w, room.y + 6 + crest * 0.75, { size: chanceSize, weight: 800, wide: true, align: 'right', color: SC.accentInk });
  const bodyY = room.y + crest + (tall ? 60 * k + chanceSize : 40);
  const bodyH = room.y + room.h - bodyY;

  const own = scenario?.own || [];
  const deciders = scenario?.deciders || [];
  const lines = tall ? own.length + Math.max(1, deciders.length) : Math.max(own.length, deciders.length);
  const headU = tall ? u * k : u;
  const chrome = tall ? 182 * headU : 80 * u;
  const rowH = lines ? Math.min(tall ? 120 * k : 46, (bodyH - chrome) / lines) : 0;
  const fits = scenario && own.length + deciders.length > 0 && rowH >= (tall ? 56 : 34);
  if (!fits) {
    shareFinishChart(ctx, room, row, position, bodyY, u);
    return shareBlob(canvas);
  }
  const { prepared, analysis } = scenario;
  const spare = Math.max(0, bodyH - chrome - lines * rowH);
  const gap = tall ? Math.min(160 * k, spare / 3) : Math.min(30, spare / 2);
  const colGap = 48;
  const colW = tall ? room.w : (room.w - colGap) / 2;
  const textSize = Math.min(tall ? 40 * k : 21, rowH * 0.45);
  const small = rowH * 0.62;
  const headSize = 14 * headU;
  const ownX = room.x;
  const rivalX = tall ? room.x : room.x + colW + colGap;
  let y = bodyY + 14 + gap;
  paintText(ctx, t('scenario.ownTitle', { owner: scenarioOwner(row.team) }), ownX, y, { size: headSize, weight: 600, color: SC.faint, label: true, maxWidth: colW });
  // The club's own matches: the opponent, home or away, the result from its side.
  const results = [0, 0, 0];
  let rowY = y + 26 * headU;
  for (const f of own) {
    const game = prepared.games[f];
    const home = game.home === club;
    const opponent = report.table[home ? game.away : game.home];
    const score = analysis.typical.scores[f];
    const mine = home ? score : [score[1], score[0]];
    const outcome = mine[0] > mine[1] ? 0 : mine[0] === mine[1] ? 1 : 2;
    results[outcome] += 1;
    const mid = rowY + rowH / 2;
    const nameW = await shareClubLine(ctx, opponent, ownX, mid, { size: textSize, crest: small, weight: 600, maxWidth: colW - textSize * 5 });
    paintText(ctx, t(home ? 'share.homeShort' : 'share.awayShort'), ownX + nameW + textSize * 0.4, mid + textSize * 0.35, { size: textSize * 0.75, weight: 600, color: SC.faint });
    const tone = outcome === 0 ? SC.goodInk : outcome === 2 ? SC.badInk : SC.muted;
    paintText(ctx, `${mine[0]}–${mine[1]}`, ownX + colW, mid + textSize * 0.4, { size: textSize * 1.15, weight: 800, wide: true, align: 'right', color: tone });
    rowY += rowH;
  }
  const total = analysis.typical.table.find((entry) => entry.club === club)?.points;
  paintText(ctx, t('share.ownSum', { w: results[0], d: results[1], l: results[2], total }), ownX, rowY + 26 * headU, { size: textSize * 0.72, weight: 600, color: SC.muted, maxWidth: colW });
  // The rivals' results it rests on.
  y = tall ? rowY + 90 * headU + gap : bodyY + 14 + gap;
  paintText(ctx, t('scenario.stepsTitle', { owner: scenarioOwner(row.team) }), rivalX, y, { size: headSize, weight: 600, color: SC.faint, label: true, maxWidth: colW });
  rowY = y + 26 * headU;
  if (!deciders.length) paintText(ctx, t('scenario.stepsNone', { team: row.team }), rivalX, rowY + rowH / 2 + textSize * 0.3, { size: textSize * 0.85, weight: 600, color: SC.muted, maxWidth: colW });
  for (const decider of deciders) {
    const game = prepared.games[decider.f];
    const score = analysis.typical.scores[decider.f];
    const mid = rowY + rowH / 2;
    const scoreW = measureText(ctx, '0–0', { size: textSize * 1.15, weight: 800, wide: true }) + textSize;
    const half = (colW - scoreW) / 2;
    await shareClubLine(ctx, report.table[game.home], rivalX, mid, { size: textSize * 0.9, crest: small * 0.85, weight: 600, maxWidth: half });
    paintText(ctx, `${score[0]}–${score[1]}`, rivalX + half + scoreW / 2, mid + textSize * 0.4, { size: textSize * 1.15, weight: 800, wide: true, align: 'center' });
    await shareClubLine(ctx, report.table[game.away], rivalX + colW, mid, { size: textSize * 0.9, crest: small * 0.85, weight: 600, align: 'right', maxWidth: half });
    rowY += rowH;
  }
  return shareBlob(canvas);
}

/* The chance of every place as columns, the place in question in the
   accent, with where the club stands now: the picture of one place when the
   likeliest season is not to be had or does not fit. */
function shareFinishChart(ctx, room, row, position, bodyY, u) {
  const count = row.position_probabilities.length;
  const left = (count - 1) * 2 - row.played;
  const facts = t('share.finishFacts', { place: ordinalShort(row.position), pts: num(row.points), left: num(Math.max(0, left)), xp: num(row.expected_points) });
  paintText(ctx, facts, room.x, bodyY + 10, { size: 18 * u, weight: 600, color: SC.muted, maxWidth: room.w });
  const cy = bodyY + 40 * u;
  const ch = room.y + room.h - cy - 30 * u;
  const probs = row.position_probabilities;
  const maxP = Math.max(...probs, 0.05);
  const colW = room.w / count;
  probs.forEach((p, i) => {
    const h = Math.max(2, (p / maxP) * ch);
    const x = room.x + i * colW;
    shareRect(ctx, x + 3, cy + ch - h, colW - 6, h, 5, i === position - 1 ? SC.accent : SC.slate);
    if (p >= 0.01 && h > 30 * u) paintText(ctx, pctShort(p), x + colW / 2, cy + ch - h - 8, { size: 14 * u, weight: 700, color: i === position - 1 ? SC.accentInk : SC.muted, align: 'center' });
    paintText(ctx, String(i + 1), x + colW / 2, cy + ch + 22 * u, { size: 14 * u, weight: 600, color: i === position - 1 ? SC.ink : SC.faint, align: 'center' });
  });
}
