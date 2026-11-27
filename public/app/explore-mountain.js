/* ---------- explore: season mountain (viz=mountain) ------------------ */

/* The season mountain, ported from experiments/season_mountain: the finish
   grid is the floor, and every round stacks another layer of finishing-place
   chances on top until the stack narrows into the table. three.js is vendored
   under /vendor and only fetched the first time the mountain opens, so the
   rest of the site stays dependency-free. */
const MOUNTAIN_CUTOFFS = [0.001, 0.0025, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2];
const MOUNTAIN_LAYER = 0.3; // height of one round's layer, in grid cells
// Light left at a block corner with 0..3 of its three neighbours open:
// ambient occlusion, darkest in the folds of the stack.
const MOUNTAIN_AO = [0.55, 0.7, 0.85, 1];
const mountain = { root: null, scene: null, key: '', layers: null, teams: null, order: 'finish', cutoff: 2, cutTeam: '', cutPlace: 0, upto: 0, timer: null, raf: null };
let threeLoading = null;
let mountainToken = 0;

function loadThree() {
  threeLoading = threeLoading || ['/vendor/three/three.min.js', '/vendor/three/OrbitControls.js']
    .reduce((previous, src) => previous.then(() => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    })), Promise.resolve())
    .catch((error) => { threeLoading = null; throw error; });
  return threeLoading;
}

/* Layer k is the first matchday with k rounds' worth of matches played, so a
   postponed match counts where it was played: "~ round k", not round k. The
   pre-season layer is the season's pre-season view (the rewind slider's first
   stop), or the season shape's first snapshot where a build predates those,
   and a season still under way ends in a "now" layer. */
async function mountainLayers(report) {
  const season = report.league.season;
  const perRound = report.table.length / 2;
  const days = report.league.matchdays || [];
  const lastDate = days.length ? days[days.length - 1].date : null;
  const probs = (r) => new Map(r.table.map((row) => [row.team_id, row.position_probabilities]));
  const reportOn = (date) => fetchTimeline(season)
    .then((timeline) => timelineReports(timeline, date, new Map()) || fetchedReport(reportUrl(season, date)));
  const layers = [];
  const preseason = report.league.preseason;
  const history = report.history || {};
  const pre = preseason
    ? await reportOn(preseason).then((r) => ({ kind: 'pre', date: preseason, p: probs(r[report.league.slug]) }), () => null)
    : null;
  if (pre) layers.push(pre);
  else if (history.teams && history.latest_rounds && history.latest_rounds[0] == null) {
    layers.push({ kind: 'pre', date: history.dates[0], p: new Map(history.teams.map((h) => [h.team_id, h.positions[0]])) });
  }
  const rounds = [];
  for (let k = 1; k * perRound <= report.model.matches_played; k += 1) {
    const day = days.find((d) => d.matches_played >= k * perRound);
    if (day) rounds.push({ kind: 'round', k, date: day.date });
  }
  // The report already in hand stands in for its own date.
  const fetched = await Promise.all(rounds.map(({ date }) => (date === lastDate ? null : reportOn(date))));
  rounds.forEach((layer, i) => layers.push({ ...layer, p: probs(fetched[i] ? fetched[i][report.league.slug] : report) }));
  if (lastDate && (!layers.length || layers[layers.length - 1].date !== lastDate)) {
    layers.push({ kind: 'now', date: lastDate, p: probs(report) });
  }
  return layers;
}

function mountainLabel(layer) {
  if (layer.kind === 'pre') return t('mountain.preseason');
  if (layer.kind === 'now') return t('mountain.now');
  return t('mountain.round', { k: layer.k });
}

/* Rows keep one order all season: by the predicted finish now (the default,
   as on the finish grid), by the pre-season prediction, or by the table as it
   stands at the top of the stack. */
function mountainTeams(report, layers) {
  const first = layers[0].p;
  const expected = (id) => (first.get(id) || []).reduce((sum, p, i) => sum + (i + 1) * p, 0);
  const teams = report.table.map((row) => ({ id: row.team_id, name: row.team, now: row.position, expected: expectedFinish(row) }));
  [...teams].sort((a, b) => expected(a.id) - expected(b.id)).forEach((team, i) => { team.predicted = i + 1; });
  [...teams].sort((a, b) => a.expected - b.expected).forEach((team, i) => { team.finish = i + 1; });
  return teams;
}

/* The website's grid stops (HEAT_STOPS), blended smoothly: level 1..7 lands
   exactly on --seq-1..7 at each stop and moves on a log scale between them. */
function heatLevel(p) {
  if (p < HEAT_STOPS[0]) return p / HEAT_STOPS[0];
  for (let i = 1; i < HEAT_STOPS.length; i += 1) {
    if (p < HEAT_STOPS[i]) return i + Math.log(p / HEAT_STOPS[i - 1]) / Math.log(HEAT_STOPS[i] / HEAT_STOPS[i - 1]);
  }
  return HEAT_STOPS.length;
}

function mountainRoot() {
  if (mountain.root) return mountain.root;
  const root = el('div', 'mountain');
  // The stage fills the window; the division and season float along its
  // top, and everything else sits in a popup behind the settings button.
  root.innerHTML = `
    <div class="mountain__stage">
      <canvas></canvas>
      <p class="mountain__status"></p>
      <div class="mountain__top">
        <button type="button" class="mountain__chip mountain__back"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg><span data-i18n="explore.back"></span></button>
        <div class="mountain__where">
          <select class="mountain__select" id="mountain-league"></select>
          <select class="mountain__select" id="mountain-season"></select>
        </div>
        <button type="button" class="mountain__chip mountain__info"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.9" fill="currentColor" stroke="none"/></svg><span data-i18n="explore.facts"></span></button>
      </div>
      <div class="mountain__readout"><b></b><span></span></div>
      <span class="mountain__hint" data-i18n="mountain.hint"></span>
      <div class="mountain__transport">
        <button type="button" class="mountain__play" aria-pressed="false"><svg class="mountain__icon-play" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="M4.5 2.6v10.8L13.5 8z"/></svg><svg class="mountain__icon-pause" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="1"/></svg><span class="visually-hidden" data-i18n="mountain.play"></span></button>
        <input type="range" id="mountain-upto" min="0" step="1">
      </div>
      <button type="button" class="mountain__chip mountain__gear" popovertarget="mountain-settings" aria-expanded="false"><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5h8M3 10h2M9 10h8M3 15h10"/><circle cx="13" cy="5" r="2"/><circle cx="7" cy="10" r="2"/><circle cx="15" cy="15" r="2"/></svg></button>
    </div>
    <div class="mountain__controls" id="mountain-settings" popover>
      <div class="mountain__ctl mountain__ctl--order">
        <span class="mountain__label" data-i18n="mountain.order"></span>
        <div class="table-controls">
          <button type="button" class="table-control-btn" data-order="finish" data-i18n="mountain.byFinish"></button>
          <button type="button" class="table-control-btn" data-order="predicted" data-i18n="mountain.byPrediction"></button>
          <button type="button" class="table-control-btn" data-order="now" data-i18n="mountain.byTable"></button>
        </div>
      </div>
      <div class="mountain__ctl mountain__ctl--cutoff">
        <label class="mountain__label" for="mountain-cutoff"><span data-i18n="mountain.cutoff"></span> <output></output></label>
        <input type="range" id="mountain-cutoff" min="0" max="${MOUNTAIN_CUTOFFS.length - 1}" step="1" value="${mountain.cutoff}">
      </div>
      <div class="mountain__ctl mountain__ctl--cut">
        <span class="mountain__label" data-i18n="mountain.cut"></span>
        <div class="mountain__row">
          <select class="mountain__select" id="mountain-cut-team"></select>
          <select class="mountain__select" id="mountain-cut-place"></select>
        </div>
      </div>
      <div class="mountain__ctl mountain__ctl--reset">
        <span class="mountain__label" data-i18n="mountain.reset"></span>
        <div class="table-controls">
          <button type="button" class="table-control-btn" data-action="reset-view" data-i18n="mountain.resetView"></button>
        </div>
      </div>
    </div>
    <span class="mountain__probe" hidden></span>`;
  const redraw = () => drawMountain();
  root.querySelector('.mountain__back').addEventListener('click', () => goBackOr(() => openExplore(null)));
  root.querySelector('.mountain__info').addEventListener('click', () => {
    if (mountain.facts) openFacts(t('explore.mountain.title'), mountain.facts);
  });
  root.querySelector('#mountain-settings').addEventListener('toggle', (event) => {
    root.querySelector('.mountain__gear').setAttribute('aria-expanded', String(event.newState === 'open'));
    liftMountain();
  });
  for (const button of root.querySelectorAll('[data-order]')) {
    button.addEventListener('click', () => {
      mountain.order = button.dataset.order;
      redraw();
      if (mountain.cutTeam) frameMountain();
    });
  }
  root.querySelector('#mountain-upto').addEventListener('input', (event) => {
    mountainStop();
    mountain.upto = Number(event.target.value);
    redraw();
  });
  // Division and season go through the hero's own switches, so the rest of
  // the page follows as it would from there.
  root.querySelector('#mountain-league').addEventListener('change', (event) => {
    document.querySelector(`#hero-league-menu [data-league="${event.target.value}"]`)?.click();
  });
  root.querySelector('#mountain-season').addEventListener('change', (event) => {
    const season = Number(event.target.value);
    if (season !== state.season) loadSeason(season);
  });
  root.querySelector('#mountain-cut-team').addEventListener('change', (event) => {
    mountain.cutTeam = event.target.value;
    redraw();
    frameMountain();
  });
  root.querySelector('#mountain-cut-place').addEventListener('change', (event) => {
    mountain.cutPlace = Number(event.target.value);
    redraw();
    frameMountain();
  });
  root.querySelector('#mountain-cutoff').addEventListener('input', (event) => {
    mountain.cutoff = Number(event.target.value);
    redraw();
  });
  root.querySelector('[data-action="reset-view"]').addEventListener('click', () => {
    mountain.order = 'finish';
    mountain.cutoff = 2;
    mountain.cutTeam = '';
    mountain.cutPlace = 0;
    root.querySelector('#mountain-cutoff').value = String(mountain.cutoff);
    root.querySelector('#mountain-cut-team').value = '';
    root.querySelector('#mountain-cut-place').value = '0';
    drawMountain();
    frameMountain({ home: true });
  });
  // While a slider in the popup is held, the popup thins to that slider
  // alone, so the mountain it is changing shows through.
  const settings = root.querySelector('#mountain-settings');
  for (const range of settings.querySelectorAll('input[type="range"]')) {
    range.addEventListener('pointerdown', () => {
      range.closest('.mountain__ctl').classList.add('is-held');
      settings.classList.add('is-peeking');
    });
  }
  const release = () => {
    settings.classList.remove('is-peeking');
    for (const held of settings.querySelectorAll('.is-held')) held.classList.remove('is-held');
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  root.querySelector('.mountain__play').addEventListener('click', () => {
    if (mountain.timer || !mountain.layers) { mountainStop(); return; }
    const last = mountain.layers.length - 1;
    if (mountain.upto >= last) mountain.upto = 0;
    const play = root.querySelector('.mountain__play');
    play.setAttribute('aria-pressed', 'true');
    play.lastChild.dataset.i18n = 'mountain.pause';
    play.lastChild.textContent = t('mountain.pause');
    const step = () => {
      drawMountain();
      if (mountain.upto >= last) { mountainStop(); return; }
      mountain.upto += 1;
    };
    step();
    mountain.timer = setInterval(step, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 600 : 220);
  });
  window.addEventListener('resize', fitMountain);
  mountain.root = root;
  return root;
}

function mountainStop() {
  clearInterval(mountain.timer);
  mountain.timer = null;
  const play = mountain.root && mountain.root.querySelector('.mountain__play');
  if (play) {
    play.setAttribute('aria-pressed', 'false');
    play.lastChild.dataset.i18n = 'mountain.play';
    play.lastChild.textContent = t('mountain.play');
  }
}

function mountainScene(canvas) {
  const { THREE } = window;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 600);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Orbit around the mountain and zoom in/out only; no panning the view
  // around, on desktop or mobile alike.
  controls.enablePan = false;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.65);
  sun.position.set(-12, 30, 18);
  scene.add(sun);
  // The stack's surface, rebuilt by drawMountain; vertex colours carry the shading.
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  const labels = new THREE.Group();
  scene.add(mesh, labels);
  const s = { THREE, renderer, scene, camera, controls, mesh, labels, meta: [], faceBlock: [] };

  new ResizeObserver(() => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    liftMountain();
  }).observe(canvas);

  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hover = (event) => {
    const box = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObject(mesh)[0];
    // Two triangles per face, one block per face.
    const meta = hit && s.meta[s.faceBlock[Math.floor(hit.faceIndex / 2)]];
    if (!meta) { hideTooltip(); return; }
    const [layer, team, place, p] = meta;
    showTooltip(event, `<b>${esc(team.name)}</b><br>${mountainLabel(layer)} · ${formatDate(layer.date)}<br>`
      + `${t('mountain.tip', { place, p: pct(p) })}<br>${t('mountain.tipRank', { finish: team.finish, predicted: team.predicted, now: team.now })}`, canvas);
  };
  let downAt = null;
  canvas.addEventListener('pointerdown', (event) => { downAt = [event.clientX, event.clientY]; });
  canvas.addEventListener('pointermove', (event) => { if (event.buttons) hideTooltip(); else hover(event); });
  canvas.addEventListener('pointerup', (event) => {
    if (downAt && Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) < 5) hover(event);
  });
  canvas.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch') hideTooltip(); });
  return s;
}

/* A label that turns to face the camera, or with `flat` one printed on the
   floor: flat labels never swing into each other as the view turns. */
function textSprite(s, text, color, size, anchorX = 0.5, flat = false) {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const font = "600 64px Archivo, system-ui, sans-serif";
  g.font = font;
  canvas.width = Math.ceil(g.measureText(text).width) + 8;
  canvas.height = 84;
  g.font = font;
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 4, 44);
  const texture = new s.THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  if (flat) {
    const width = (size * canvas.width) / 84;
    const geometry = new s.THREE.PlaneGeometry(width, size);
    geometry.translate((0.5 - anchorX) * width, 0, 0);
    const label = new s.THREE.Mesh(geometry, new s.THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    label.rotation.x = -Math.PI / 2; // lying down, reading from the front edge
    return label;
  }
  const sprite = new s.THREE.Sprite(new s.THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set((size * canvas.width) / 84, size, 1);
  sprite.center.set(anchorX, 0.5);
  return sprite;
}

function drawMountain() {
  const s = mountain.scene;
  const report = state.reports && state.reports[state.league];
  if (!s || !mountain.layers || !report) return;
  const { THREE, mesh, labels } = s;
  const { layers, teams } = mountain;
  const root = mountain.root;
  const n = teams.length;
  const half = (n - 1) / 2;
  const H = MOUNTAIN_LAYER;
  const last = layers.length - 1;
  mountain.upto = Math.min(mountain.upto, last);
  const cutoff = MOUNTAIN_CUTOFFS[mountain.cutoff];
  // A finished season's predicted finish is its final table, so the table
  // order would only repeat it.
  const finished = report.model.matches_remaining === 0;
  root.querySelector('[data-order="now"]').hidden = finished;
  const finishButton = root.querySelector('[data-order="finish"]');
  finishButton.dataset.i18n = finished ? 'mountain.byFinal' : 'mountain.byFinish';
  finishButton.textContent = t(finishButton.dataset.i18n);
  if (finished && mountain.order === 'now') mountain.order = 'finish';
  const order = [...teams].sort((a, b) => a[mountain.order] - b[mountain.order]);
  mountain.rowOf = new Map(order.map((team, row) => [team.id, row]));

  // The cut pickers, refilled only when the clubs or the language change:
  // refilling an open select on every play step would close it.
  const teamPick = root.querySelector('#mountain-cut-team');
  const placePick = root.querySelector('#mountain-cut-place');
  if (teamPick.dataset.key !== mountain.key + currentLang) {
    teamPick.dataset.key = mountain.key + currentLang;
    teamPick.replaceChildren(new Option(t('mountain.allTeams'), ''),
      ...[...teams].sort((a, b) => a.name.localeCompare(b.name)).map((team) => new Option(team.name, team.id)));
    placePick.replaceChildren(new Option(t('mountain.allPlaces'), '0'),
      ...teams.map((_, i) => new Option(t('mountain.place', { n: i + 1 }), String(i + 1))));
    teamPick.setAttribute('aria-label', t('mountain.cutTeam'));
    placePick.setAttribute('aria-label', t('mountain.cutPlace'));
  }
  teamPick.value = mountain.cutTeam;
  placePick.value = String(mountain.cutPlace);

  // Theme colours, resolved from the stylesheet on every draw so a theme
  // switch repaints the stack too.
  const probe = root.querySelector('.mountain__probe');
  const css = (value) => { probe.style.color = value; return getComputedStyle(probe).color; };
  const ramp = ['var(--panel-sunk)', ...Array.from({ length: SEQ_STEPS }, (_, i) => `var(--seq-${i + 1})`)]
    .map((value) => new THREE.Color(css(value)));
  const ink = css('var(--ink)');
  const muted = css('var(--ink-muted)');
  s.scene.background = new THREE.Color(css('var(--panel)'));

  // Every block is a cell of one grid (place across, round up, club row
  // deep), so the stack is meshed as a voxel surface: only faces open to the
  // air, each corner darkened by the blocks around it, as voxel games do
  // ambient occlusion. Faces buried inside the stack are never drawn.
  // The pre-season layer is ground zero: flat tiles on the floor, with no
  // height, so round 1 is the first layer to stand on it.
  const ground = layers[0].kind === 'pre' ? 1 : 0;
  const shown = mountain.upto + 1 - ground; // standing layers drawn
  const cells = new Int32Array(n * n * Math.max(shown, 0)).fill(-1);
  const blockAt = ([x, y, z]) => (x < 0 || y < 0 || z < 0 || x >= n || z >= n || y >= shown ? -1 : cells[(y * n + z) * n + x]);
  const blocks = [];
  s.meta = [];
  for (let l = 0; l <= mountain.upto; l += 1) {
    const flat = l < ground;
    order.forEach((team, row) => {
      (layers[l].p.get(team.id) || []).forEach((p, place) => {
        if (p <= 0 || p < cutoff) return;
        // A vertical cut keeps one club's row or one place's column, where
        // they stand, so the faces it exposes are drawn and shaded too.
        if ((mountain.cutTeam && team.id !== mountain.cutTeam) || (mountain.cutPlace && place + 1 !== mountain.cutPlace)) return;
        const level = heatLevel(p);
        const lo = Math.min(SEQ_STEPS - 1, Math.floor(level));
        if (!flat) cells[((l - ground) * n + row) * n + place] = blocks.length;
        blocks.push([[place, l - ground, row], new THREE.Color().copy(ramp[lo]).lerp(ramp[lo + 1], Math.min(1, level - lo)), flat]);
        s.meta.push([layers[l], team, place + 1, p]);
      });
    });
  }
  const k = blocks.length;
  // The extent of what is standing (ground tiles included), for
  // frameMountain to aim a vertical cut at the middle of its wall.
  mountain.bounds = null;
  for (const [[x, y, z], , flat] of blocks) {
    const b = mountain.bounds || (mountain.bounds = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, top: 0 });
    b.x0 = Math.min(b.x0, x - half - 0.5);
    b.x1 = Math.max(b.x1, x - half + 0.5);
    b.z0 = Math.min(b.z0, z - half - 0.5);
    b.z1 = Math.max(b.z1, z - half + 0.5);
    if (!flat) b.top = Math.max(b.top, (y + 1) * H);
  }
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  s.faceBlock = [];
  const step = (cell, axis, by) => { const next = [...cell]; next[axis] += by; return next; };
  blocks.forEach(([cell, color, flat], b) => {
    if (flat) {
      // A ground tile: one face up, just above the floor; a round-1 block on
      // it covers it, so it shows where the mountain has not grown.
      const [x, , z] = cell;
      const base = positions.length / 3;
      for (const [cx, cz] of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
        positions.push(x + cx - half - 0.5, 0.004, z + cz - half - 0.5);
        normals.push(0, 1, 0);
        colors.push(color.r, color.g, color.b);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      s.faceBlock.push(b);
      return;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      for (const sign of [1, -1]) {
        const out = step(cell, axis, sign);
        if (blockAt(out) >= 0) continue;
        // u x v points along the face normal, so corners in this order wind
        // counter-clockwise seen from outside a positive face.
        const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
        const base = positions.length / 3;
        const ao = [];
        for (const [cu, cv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const corner = step(step(step(cell, axis, sign > 0 ? 1 : 0), u, cu), v, cv);
          positions.push(corner[0] - half - 0.5, corner[1] * H, corner[2] - half - 0.5);
          normals.push(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
          const side1 = step(out, u, cu ? 1 : -1);
          const side2 = step(out, v, cv ? 1 : -1);
          const [s1, s2, diagonal] = [blockAt(side1) >= 0, blockAt(side2) >= 0, blockAt(step(side1, v, cv ? 1 : -1)) >= 0];
          const open = s1 && s2 ? 0 : 3 - s1 - s2 - diagonal;
          ao.push(open);
          colors.push(color.r * MOUNTAIN_AO[open], color.g * MOUNTAIN_AO[open], color.b * MOUNTAIN_AO[open]);
        }
        // Split along the brighter diagonal, or the shading creases.
        let quad = ao[0] + ao[2] >= ao[1] + ao[3] ? [0, 1, 2, 0, 2, 3] : [1, 2, 3, 1, 3, 0];
        if (sign < 0) quad = quad.reverse();
        for (const i of quad) indices.push(base + i);
        s.faceBlock.push(b);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  mesh.geometry.dispose();
  mesh.geometry = geometry;

  // Scenery: band strips and place numbers along the back and front edges,
  // as on the grid, club names with their expected finish down both sides
  // and round marks up the right.
  for (const child of [...labels.children]) {
    if (child.material.map) child.material.map.dispose();
    child.material.dispose();
    if (!child.isSprite) child.geometry.dispose();
    labels.remove(child);
  }
  const bands = report.league.bands || [];
  for (let place = 1; place <= n; place += 1) {
    const band = bands.filter((b) => b.label !== 'Champions' && place >= b.first && place <= b.last).pop();
    const color = new THREE.Color(css(band ? bandColor(band, n) : 'var(--ink-muted)'));
    for (const z of [-half - 0.9, half + 0.9]) {
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 0.5),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: band ? 0.9 : 0.25 }),
      );
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(place - 1 - half, 0.01, z);
      labels.add(strip);
    }
    for (const z of [-half - 1.8, half + 1.8]) {
      const number = textSprite(s, String(place), ink, 0.6);
      number.position.set(place - 1 - half, 0, z);
      labels.add(number);
    }
  }
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(n + 0.6, n + 0.6),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(muted), transparent: true, opacity: 0.08 }),
  );
  plate.rotation.x = -Math.PI / 2;
  plate.position.y = -0.01;
  labels.add(plate);
  // The expected finish sits on the grid side of the name on both sides.
  order.forEach((team, row) => {
    for (const [text, x, anchor] of [[`${team.name}  ${team.finish}`, -half - 0.9, 1], [`${team.finish}  ${team.name}`, half + 0.9, 0]]) {
      const name = textSprite(s, text, ink, 0.65, anchor, true);
      name.position.set(x, 0.02, row - half);
      labels.add(name);
    }
  });
  const marks = [0, 5, 10, 15, 20, 25, 30].filter((l) => l <= mountain.upto);
  if (!marks.includes(mountain.upto)) marks.push(mountain.upto);
  // Round marks stand at the end of the back place numbers, above the club
  // names rather than over them, or at the front-right corner of what the
  // cut leaves, so a back row or a middle column keeps them beside its
  // blocks, not in front.
  const wall = (mountain.cutTeam || mountain.cutPlace) && mountain.bounds;
  const markX = (wall ? wall.x1 : half + 0.5) + 0.5;
  const markZ = wall ? wall.z1 : -half - 1.8;
  for (const l of marks) {
    const mark = textSprite(s, mountainLabel(layers[l]), l === mountain.upto ? ink : muted, 0.5, 0);
    mark.position.set(markX, l < ground ? 0.15 : (l - ground) * H + H / 2, markZ);
    labels.add(mark);
  }

  const top = layers[mountain.upto];
  mountain.facts = mountainFacts(layers[0], top, teams, finished && mountain.upto === last);
  root.querySelector('.mountain__readout b').textContent = mountainLabel(top);
  root.querySelector('.mountain__readout span').textContent = `${formatDate(top.date)} · ${t('mountain.blocks', { n: num(k) })}`;
  for (const button of root.querySelectorAll('[data-order]')) {
    button.setAttribute('aria-pressed', String(button.dataset.order === mountain.order));
  }
  const upto = root.querySelector('#mountain-upto');
  upto.max = last;
  upto.value = mountain.upto;
  upto.setAttribute('aria-valuetext', mountainLabel(top));
  root.querySelector('#mountain-cutoff').labels[0].querySelector('output').textContent = pct(cutoff, cutoff < 0.01 ? 2 : 1);
}

/* The whole division from the bottom layer to the top one built: how far the
   field has narrowed, the pre-season favourite then and now, who has moved
   most, and the surest single outcome. When the top layer is a finished
   season's final table those would only say "certain", so the figures turn
   into a scorecard for the pre-season prediction instead. The vertical cut
   does not apply. Returns the figures for exploreFacts. */
function mountainFacts(start, top, teams, final) {
  const chances = (layer, id) => layer.p.get(id) || [];
  const plausible = (layer) => teams.reduce((sum, team) => sum + chances(layer, team.id).filter((p) => p >= 0.05).length, 0) / teams.length;
  const expected = (layer, id) => chances(layer, id).reduce((sum, p, i) => sum + (i + 1) * p, 0);
  if (start === top) {
    return [{ value: num(plausible(top), 1), label: t('mountain.fact.places'), text: t('mountain.fact.placesText') }];
  }
  const favourite = [...teams].sort((a, b) => (chances(start, b.id)[0] || 0) - (chances(start, a.id)[0] || 0))[0];
  const favouriteThen = shareText(chances(start, favourite.id)[0] || 0);
  const favouriteLabel = t('mountain.fact.favourite', { team: favourite.name });

  if (final) {
    const placeOf = (id) => { const p = chances(top, id); return p.indexOf(Math.max(...p)) + 1; };
    const rows = teams.map((team) => {
      const place = placeOf(team.id);
      return { team, place, from: expected(start, team.id), then: chances(start, team.id)[place - 1] || 0 };
    });
    const hits = rows.filter((row) => Math.abs(row.place - row.from) <= 2).length;
    const moves = [...rows].sort((a, b) => (a.place - a.from) - (b.place - b.from));
    const surprise = [...rows].sort((a, b) => a.then - b.then)[0];
    const ended = (row) => t('mountain.fact.endedText', { from: num(row.from, 1), place: row.place });
    return [
      { value: t('mountain.fact.hitsValue', { hits, n: teams.length }), label: t('mountain.fact.hits'), text: t('mountain.fact.hitsText') },
      {
        value: `${favouriteThen} → ${placeOf(favourite.id)}.`,
        label: favouriteLabel,
        text: t('mountain.fact.favouriteFinalText'),
      },
      { value: moves[0].team.name, label: t('mountain.fact.climber'), text: ended(moves[0]) },
      { value: moves[moves.length - 1].team.name, label: t('mountain.fact.faller'), text: ended(moves[moves.length - 1]) },
      {
        value: surprise.team.name,
        label: t('mountain.fact.surprise'),
        text: t('mountain.fact.surpriseText', { place: surprise.place, pct: shareText(surprise.then) }),
      },
    ];
  }

  const moves = teams
    .map((team) => ({ team, from: expected(start, team.id), to: expected(top, team.id) }))
    .sort((a, b) => (a.to - a.from) - (b.to - b.from));
  const [climber, faller] = [moves[0], moves[moves.length - 1]];
  let surest = { p: 0 };
  for (const team of teams) {
    chances(top, team.id).forEach((p, i) => { if (p > surest.p) surest = { p, team, place: i + 1 }; });
  }
  const move = (m) => t('mountain.fact.moveText', { from: num(m.from, 1), to: num(m.to, 1) });
  return [
    { value: `${num(plausible(start), 1)} → ${num(plausible(top), 1)}`, label: t('mountain.fact.places'), text: t('mountain.fact.placesText') },
    {
      value: `${favouriteThen} → ${shareText(chances(top, favourite.id)[0] || 0)}`,
      label: favouriteLabel,
      text: t('mountain.fact.favouriteText'),
    },
    { value: climber.team.name, label: t('mountain.fact.climber'), text: move(climber) },
    { value: faller.team.name, label: t('mountain.fact.faller'), text: move(faller) },
    { value: shareText(surest.p), label: t('mountain.fact.surest'), text: t('mountain.fact.surestText', { team: surest.team.name, place: surest.place }) },
  ];
}

/* The key figures in a dialog, for where they are out of sight: below the
   fold on a wide screen, and left out of a phone's full-screen mountain. */
function openFacts(title, facts) {
  let dialog = $('#facts-dialog');
  if (!dialog) {
    dialog = el('dialog', 'facts-dialog');
    dialog.id = 'facts-dialog';
    dialog.setAttribute('aria-labelledby', 'facts-dialog-title');
    // A click on the backdrop lands on the dialog itself: close.
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    document.body.appendChild(dialog);
  }
  const head = el('div', 'facts-dialog__head');
  const heading = el('h2', '', title);
  heading.id = 'facts-dialog-title';
  const close = el('button', 'facts-dialog__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', t('explore.close'));
  close.addEventListener('click', () => dialog.close());
  head.append(heading, close);
  dialog.replaceChildren(head, exploreFacts(facts));
  dialog.showModal();
}

function mountainLoop() {
  const s = mountain.scene;
  if (!s || state.activeView !== 'explore' || state.exploreItem !== 'mountain' || !s.renderer.domElement.isConnected) {
    mountain.raf = null;
    mountainStop();
    // Left by the back button or a tab: the settings popup goes with it.
    mountain.root?.querySelector('.mountain__controls:popover-open')?.hidePopover();
    return;
  }
  const glide = mountain.glide;
  if (glide) {
    const k = Math.min(1, (performance.now() - glide.start) / 450);
    const eased = 1 - (1 - k) ** 3;
    s.controls.target.lerpVectors(glide.fromTarget, glide.toTarget, eased);
    s.camera.position.lerpVectors(glide.fromCamera, glide.toCamera, eased);
    if (k === 1) mountain.glide = null;
  }
  s.controls.update();
  s.renderer.render(s.scene, s.camera);
  mountain.raf = requestAnimationFrame(mountainLoop);
}

/* Aims the camera at what the vertical cut leaves standing: a club's row, a
   place's column, the one stack where both meet, or the whole mountain. The
   distance shrinks with the cut's size, so a lone stack fills the stage; the
   angle stays wherever the reader turned it, except on `home`, which is the
   opening view of a new league or season. */
function frameMountain({ home = false } = {}) {
  const s = mountain.scene;
  if (!s || !mountain.layers || !mountain.rowOf) return;
  const { THREE, camera, controls } = s;
  const n = mountain.teams.length;
  const half = (n - 1) / 2;
  // The pre-season layer lies flat, so it adds no height.
  const height = (mountain.layers.length - (mountain.layers[0].kind === 'pre' ? 1 : 0)) * MOUNTAIN_LAYER;
  // The opening view, framed for a wide stage; a tall, narrow one (a phone)
  // backs off so the whole stack and its labels stay in view.
  const canvas = s.renderer.domElement;
  const aspect = canvas.clientWidth / canvas.clientHeight || 1.5;
  // The back-off grows more slowly than the stage narrows (the power): a
  // phone's stack filled two thirds of its width, with room to spare.
  const opening = new THREE.Vector3(n * 1.45, height * 0.37 + n * 0.9, n * 2.05).multiplyScalar(Math.max(1, 1.6 / aspect) ** 0.8);
  // A vertical cut aims at the middle of the wall it leaves (its blocks'
  // extent, as drawn), sized to that wall; the whole mountain at the grid.
  const wall = (mountain.cutTeam || mountain.cutPlace) && mountain.bounds;
  const [across, deep, tall] = wall ? [wall.x1 - wall.x0, wall.z1 - wall.z0, wall.top] : [n, n, height];
  const size = (a, d, h) => Math.hypot(a, d, h);
  const scale = Math.max(0.45, size(across, deep, tall) / size(n, n, height));
  // The smaller the cut, the more of it is height, so the aim climbs from
  // the whole mountain's 38 % towards the middle of a lone stack.
  const target = new THREE.Vector3(
    wall ? (wall.x0 + wall.x1) / 2 : 0,
    tall * (0.5 - 0.12 * scale),
    wall ? (wall.z0 + wall.z1) / 2 : 0,
  );
  const direction = home ? opening.clone() : camera.position.clone().sub(controls.target);
  const position = target.clone().addScaledVector(direction.normalize(), opening.length() * scale);
  if (home || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    mountain.glide = null;
    controls.target.copy(target);
    camera.position.copy(position);
    controls.update();
    return;
  }
  mountain.glide = {
    fromTarget: controls.target.clone(), toTarget: target,
    fromCamera: camera.position.clone(), toCamera: position,
    start: performance.now(),
  };
}

/* With the settings card open on a phone it covers the lower half of the
   stage: the view shifts so the mountain stands in the room above it. */
function liftMountain() {
  const s = mountain.scene;
  if (!s) return;
  const { camera, renderer } = s;
  const width = renderer.domElement.clientWidth;
  const height = renderer.domElement.clientHeight;
  const card = mountain.root?.querySelector('.mountain__controls:popover-open');
  const lift = card && width < 760 ? Math.round(card.getBoundingClientRect().height / 2) : 0;
  if (lift) camera.setViewOffset(width, height, 0, lift, width, height);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}

/* The mountain takes the whole window between the masthead and, on a phone,
   the bottom bar: the stylesheet pins it there and locks the page, so no
   swipe lands on the page instead of the stack. This measures the bars. */
function fitMountain() {
  const root = mountain.root;
  if (!root || !root.isConnected || document.body.dataset.viz !== 'mountain') return;
  window.scrollTo(0, 0);
  const bar = $('#mobilebar');
  root.style.setProperty('--mountain-top', `${Math.round($('.masthead').getBoundingClientRect().bottom)}px`);
  root.style.setProperty('--mountain-bottom', `${bar ? Math.round(bar.getBoundingClientRect().height) : 0}px`);
}

/* The division and season pickers, refilled from the report each render
   (the names, the seasons on offer and the language can all change). */
function syncMountainWhere(report) {
  const root = mountain.root;
  const league = root.querySelector('#mountain-league');
  league.replaceChildren(...Object.entries(state.reports).map(([slug, r]) => new Option(r.league.name, slug)));
  league.value = state.league;
  league.setAttribute('aria-label', t('mountain.league'));
  const season = root.querySelector('#mountain-season');
  const seasons = report.league.seasons || [report.league.season];
  season.replaceChildren(...[...seasons].reverse().map((s) => new Option(
    s === report.league.current_season ? t('season.live', { season: s }) : String(s), String(s),
  )));
  season.value = String(report.league.season);
  season.setAttribute('aria-label', t('mountain.season'));
}

async function renderMountain(report, body) {
  const root = mountainRoot();
  if (body.firstChild !== root) body.replaceChildren(root);
  syncMountainWhere(report);
  fitMountain(); // before the camera is framed, which reads the stage's shape
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  root.querySelector('canvas').setAttribute('aria-label', t('mountain.aria'));
  // The floating buttons go icon-only on a phone, so they carry their names.
  root.querySelector('.mountain__back').setAttribute('aria-label', t('explore.back'));
  root.querySelector('.mountain__info').setAttribute('aria-label', t('explore.facts'));
  root.querySelector('.mountain__gear').setAttribute('aria-label', t('mountain.settings'));
  root.querySelector('#mountain-upto').setAttribute('aria-label', t('mountain.builtUp'));
  const status = root.querySelector('.mountain__status');
  const key = `${report.league.season}|${report.league.slug}|${state.asof}|${report.model.matches_played}`;
  const token = ++mountainToken;
  if (key !== mountain.key) {
    mountainStop();
    status.textContent = t('mountain.loading');
    status.hidden = false;
    try {
      const [layers] = await Promise.all([mountainLayers(report), loadThree()]);
      if (token !== mountainToken) return;
      if (!layers.length) throw new Error('no layers');
      if (!mountain.scene) mountain.scene = mountainScene(root.querySelector('canvas'));
      mountain.layers = layers;
      mountain.teams = mountainTeams(report, layers);
      // A cut through a club that is not in this league or season is dropped.
      if (!mountain.teams.some((team) => team.id === mountain.cutTeam)) mountain.cutTeam = '';
      if (mountain.cutPlace > mountain.teams.length) mountain.cutPlace = 0;
      mountain.upto = layers.length - 1;
      mountain.key = key;
      drawMountain(); // places the rows, which the framing aims at
      frameMountain({ home: true });
    } catch (error) {
      console.warn('[Mountain]', error);
      if (token === mountainToken) status.textContent = t('mountain.failed');
      return;
    }
  }
  if (token !== mountainToken) return;
  status.hidden = true;
  drawMountain();
  fitMountain();
  if (!mountain.raf) mountain.raf = requestAnimationFrame(mountainLoop);
}
