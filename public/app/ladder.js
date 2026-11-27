/* ---------- rating ladder ----------------------------------------- */

function ladderTeams(reports) {
  return Object.entries(reports).flatMap(([slug, report]) =>
    report.table.map((row) => ({
      team: row.team, teamId: row.team_id, rating: row.rating, tier: slug === 'eliteserien' ? 1 : 2,
    })));
}

/* Both divisions on one axis, which is the only place the model compares
   them directly. A wide track is a strip: crests at their rating, percent
   across it, stacking into rows where they collide. A narrow track (a phone)
   is a ranked list instead -- one row per club at its rank, with the rating
   as a dot on a shared scale -- because crests alone cannot be told apart at
   that size. Ranks and placement are written onto the team objects; the ticks
   (every 50 points on the strip, 100 in the list) and track size come back.
   `maxStack` reserves extra stacking depth so an animated strip keeps one size. */
const LADDER_ROW = 2.75;    // rem per club in the list (44px at 16px base = 44px touch target)
const LADDER_HEAD = 1.75;   // rem above the first row, for the scale labels

function layoutLadder(teams, track, maxStack = 0) {
  const ratings = teams.map((t) => t.rating);
  const low = Math.min(...ratings);
  const high = Math.max(...ratings);
  const trackWidth = track.clientWidth || 1000;
  const list = trackWidth < 500;
  teams.sort((a, b) => a.rating - b.rating || a.team.localeCompare(b.team));
  teams.forEach((t, i) => { t._rank = teams.length - i; });
  const fraction = (rating) => (high === low ? 0.5 : (rating - low) / (high - low));
  // In the list the scale has a 0.5rem margin at each end, so the extreme dots
  // are not cut in half by the panel edge.
  const along = (f) => `calc(0.5rem + ${f.toFixed(4)} * (100% - 1rem))`;

  // The list's scale is a third of a phone's width: lines every 100 points,
  // labelled every 200, where the strip has room for every 50.
  const step = list ? 100 : 50;
  const ticks = [];
  for (let r = Math.ceil(low / step) * step; r <= high; r += step) {
    const label = !list || r % 200 === 0 ? String(r) : '';
    ticks.push({ label, left: list ? along(fraction(r)) : `${2 + fraction(r) * 96}%` });
  }

  if (list) {
    for (const team of teams) {
      team._tip = `${rankText(team._rank)}  ${team.team}  ${Math.round(team.rating)}`;
      team._top = `${LADDER_HEAD + (team._rank - 1) * LADDER_ROW}rem`;
      team._left = '0';
      team._x = along(fraction(team.rating));
    }
    return { list, ticks, depth: 1, height: `${LADDER_HEAD + teams.length * LADDER_ROW}rem`, width: '' };
  }

  const crestPx = parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.5;
  const overlap = Math.min(50, ((crestPx + 2) / trackWidth) * 100);
  const pos = (rating) => 2 + fraction(rating) * 96;

  // Highest-rated first; a crest overlapping one already placed steps out one stack level.
  const placed = [];
  for (let i = teams.length - 1; i >= 0; i--) {
    const team = teams[i];
    let stack = 0;
    for (const p of placed) {
      if (Math.abs(pos(p.rating) - pos(team.rating)) <= overlap) stack = Math.max(stack, p._stack + 1);
    }
    team._stack = stack;
    placed.push(team);
  }
  const depth = Math.max(maxStack, ...teams.map((t) => t._stack)) + 1;
  const rowHeight = depth <= 1 ? 0 : 2.2;

  for (const team of teams) {
    team._tip = `${rankText(team._rank)}  ${team.team}  ${Math.round(team.rating)}`;
    team._top = `${0.5 + team._stack * rowHeight}rem`;
    team._left = `${pos(team.rating)}%`;
  }
  return { list, ticks, depth, height: `${4 + (depth - 1) * rowHeight}rem`, width: '' };
}

function ladderAxis(track, layout) {
  track.querySelector('.ladder__axis')?.remove();
  track.classList.toggle('ladder__track--list', layout.list);
  const axis = el('div', 'ladder__axis');
  for (const tick of layout.ticks) {
    const node = el('div', 'ladder__tick');
    node.style.left = tick.left;
    node.appendChild(el('span', '', tick.label));
    axis.appendChild(node);
  }
  track.appendChild(axis);
  track.style.height = layout.height;
  track.style.width = layout.width;
}

/* One club. On the strip only the crest shows; the list row adds rank, name,
   rating and the dot, which the CSS hides on the strip. A button either way:
   it opens the club, as a row does in the table. */
function ladderTeamEl(team) {
  const wrap = el('button', 'ladder__team');
  wrap.type = 'button';
  wrap.dataset.tier = String(team.tier);
  wrap.dataset.teamId = team.teamId;
  wrap.dataset.team = team.team;
  wrap.appendChild(el('span', 'ladder__rank'));
  const img = el('img');
  img.src = `logos/${team.teamId}.webp`;
  img.alt = team.team;
  wrap.appendChild(img);
  wrap.appendChild(el('span', 'ladder__name', team.team));
  wrap.appendChild(el('span', 'ladder__rating'));
  const scale = el('span', 'ladder__scale');
  scale.appendChild(el('span', 'ladder__dot'));
  wrap.appendChild(scale);
  return wrap;
}

function placeLadderTeam(wrap, team) {
  wrap.style.top = team._top;
  wrap.style.left = team._left;
  if (team._x) wrap.style.setProperty('--x', team._x);
  wrap.dataset.tip = team._tip;
  wrap.setAttribute('aria-label', team._tip);
  wrap.querySelector('.ladder__rank').textContent = String(team._rank);
  wrap.querySelector('.ladder__rating').textContent = String(Math.round(team.rating));
}

/* Bound once: the track outlives every render, and a listener added per
   render stacked up until each tap toggled the tip an even number of times.
   A list row opens the club; on the strip a tap shows the crest's tip on
   touch screens, where there is no hover, and a click opens the club. */
function bindLadderClicks(track) {
  if (track.dataset.bound) return;
  track.dataset.bound = 'true';
  track.addEventListener('click', (event) => {
    const wrap = event.target.closest('.ladder__team');
    if (!wrap) return;
    event.stopPropagation();
    const tapToPeek = coarsePointer.matches && !track.classList.contains('ladder__track--list');
    if (tapToPeek && !wrap.hasAttribute('data-tip-visible')) {
      track.querySelectorAll('.ladder__team[data-tip-visible]').forEach((other) => other.removeAttribute('data-tip-visible'));
      wrap.setAttribute('data-tip-visible', '');
      return;
    }
    openTeamView(wrap.dataset.teamId, wrap.dataset.team);
  });
  track.addEventListener('keydown', (event) => handleLadderKeydown(event, track));
  document.addEventListener('click', () => {
    track.querySelectorAll('.ladder__team[data-tip-visible]').forEach((w) => w.removeAttribute('data-tip-visible'));
  }, { passive: true });
}

/* Keyboard navigation for the ladder: arrow keys move between teams. */
function handleLadderKeydown(event, track) {
  const items = [...track.querySelectorAll('.ladder__team')].filter((item) => item.offsetParent);
  if (!items.length) return;
  const activeIndex = items.findIndex((item) => item === document.activeElement);
  if (activeIndex === -1) return;

  let targetIndex = -1;
  switch (event.key) {
    case 'ArrowDown':
      if (track.classList.contains('ladder__track--list')) {
        event.preventDefault();
        targetIndex = Math.min(activeIndex + 1, items.length - 1);
      }
      break;
    case 'ArrowUp':
      if (track.classList.contains('ladder__track--list')) {
        event.preventDefault();
        targetIndex = Math.max(activeIndex - 1, 0);
      }
      break;
    case 'ArrowRight':
      if (!track.classList.contains('ladder__track--list')) {
        event.preventDefault();
        // On strip mode, move to next team by rating
        targetIndex = Math.min(activeIndex + 1, items.length - 1);
      }
      break;
    case 'ArrowLeft':
      if (!track.classList.contains('ladder__track--list')) {
        event.preventDefault();
        targetIndex = Math.max(activeIndex - 1, 0);
      }
      break;
    case 'Home':
      event.preventDefault();
      targetIndex = 0;
      break;
    case 'End':
      event.preventDefault();
      targetIndex = items.length - 1;
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      items[activeIndex].click();
      break;
    case 'Escape':
      hideTooltip();
      items[activeIndex].blur();
      break;
  }

  if (targetIndex >= 0 && targetIndex !== activeIndex) {
    items[targetIndex].focus();
    const target = items[targetIndex];
    if (target.dataset.tip) {
      showTooltip({
        clientX: target.getBoundingClientRect().left,
        clientY: target.getBoundingClientRect().top
      }, target.dataset.tip, target);
    }
  }
}

function renderLadder(reports) {
  const track = $('#ladder-lanes');
  track.replaceChildren();
  const teams = ladderTeams(reports);
  ladderAxis(track, layoutLadder(teams, track));
  for (const team of teams) {
    const wrap = ladderTeamEl(team);
    placeLadderTeam(wrap, team);
    track.appendChild(wrap);
  }

  bindLadderClicks(track);

  // Legend
  const legend = $('#ladder-legend');
  legend.replaceChildren();
  for (const [tier, name] of [[1, 'Eliteserien'], [2, 'OBOS-ligaen']]) {
    const key = el('span', 'legend__key');
    const swatch = el('span', 'legend__swatch');
    swatch.style.background = tier === 1 ? 'var(--tier-1)' : 'var(--tier-2)';
    swatch.style.borderRadius = '2px';
    key.appendChild(swatch);
    key.appendChild(el('span', '', name));
    legend.appendChild(key);
  }
}
