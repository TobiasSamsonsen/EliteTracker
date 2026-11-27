/* ---------- analytics ----------------------------------------------- */

/* Google Analytics (the Firebase project's GA4 stream) loads only after the
   reader says yes: Norwegian law wants consent before non-essential cookies.
   Production only, so local runs and PR previews don't count. Page views come
   from pageView(), so the stream's "page changes based on browser history
   events" setting must stay off in GA, or every view counts twice. */
const GA_ID = 'G-RCMKSGYDSJ';
let booted = false; // boot has rewritten the URL (first render, ?season=, ?asof=)

function loadAnalytics() {
  if (location.hostname !== 'elitetracker.no' || window.gtag) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { dataLayer.push(arguments); };
  // Statistics only, as the consent bar says: no ad cookies, no Google
  // signals, nothing for ad personalisation, whatever the GA property allows.
  gtag('consent', 'default', {
    analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
  });
  gtag('js', new Date());
  gtag('config', GA_ID, {
    send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false,
  });
  pageView();
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.append(script);
}

/* One page view per view, club, league or season the reader opens, and none
   until boot is done, so a landing counts once, at the address it settles on.
   ?asof= is left out: a rewind is the 'rewind' event, not a new page. */
let lastPage = null;
function pageView() {
  if (!booted || !window.gtag) return;
  const url = new URL(location.href);
  url.searchParams.delete('asof');
  url.hash = '';
  if (url.href === lastPage) return;
  lastPage = url.href;
  gtag('event', 'page_view', { page_location: url.href, page_title: document.title });
}

/* Stored as 'yes:<ms>' or 'no:<ms>'; an answer older than a year counts as
   none, so the reader is asked again (public/personvern.html promises this). */
function initConsent() {
  const bar = $('#consent');
  const [choice, at] = (localStorage.getItem('elitetracker-analytics') || '').split(':');
  const fresh = Date.now() - Number(at) < 365 * 24 * 3600 * 1000;
  if (choice === 'yes' && fresh) loadAnalytics();
  else if (!fresh) bar.hidden = false;
  bar.addEventListener('click', (event) => {
    const answer = event.target.closest('[data-consent]')?.dataset.consent;
    if (!answer) return;
    localStorage.setItem('elitetracker-analytics', `${answer}:${Date.now()}`);
    bar.hidden = true;
    if (answer === 'yes') return loadAnalytics();
    // Withdrawn: drop GA's cookies, also those left by a yes that has since
    // lapsed, and reload if GA is running on this page.
    for (const name of document.cookie.split('; ').map((c) => c.split('=')[0]).filter((n) => n.startsWith('_ga'))) {
      document.cookie = `${name}=; Max-Age=0; path=/; domain=.${location.hostname}`;
    }
    if (window.gtag) location.reload();
  });
  $('#consent-open').addEventListener('click', () => { bar.hidden = false; });
}

/* What a page view can't show: which in-page tools get used. A no-op until
   the reader has said yes. Params need a custom dimension in GA to report. */
function track(name, params) {
  window.gtag?.('event', name, params);
}

/* ---------- mobile gestures ----------------------------------------- */

/* Mobile gesture handling: swipe navigation, pull-to-refresh, swipe-to-dismiss sheet */
/* A bottom sheet's swipe down to dismiss, shared by the More sheet, the
   phone's pickers and the "what it takes" popup. The drag starts only while
   the sheet's own scroll is at the top (or on its grip or head), so scrolling
   a long list inside it still scrolls; past 100px it closes, short of that it
   springs back. `scrim` dims with the pull. Bound once per panel. */
function attachSheetDrag(panel, { scrim = null, dismiss, handle = null } = {}) {
  if (!panel || panel.dataset.sheetDrag) return;
  panel.dataset.sheetDrag = '1';
  const drag = { startY: 0, currentY: 0, active: false };
  const reset = () => {
    panel.style.transform = '';
    panel.style.opacity = '';
    if (scrim) scrim.style.opacity = '';
  };
  panel.addEventListener('touchstart', (event) => {
    if (!PHONE_SHEETS.matches || event.touches.length !== 1) return;
    if (panel.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().progress < 1)) return;
    const onHandle = handle && event.target.closest(handle);
    if (!onHandle && panel.scrollTop > 0) return;
    drag.startY = drag.currentY = event.touches[0].clientY;
    drag.active = true;
    panel.classList.add('is-dragging');
  }, { passive: true });
  panel.addEventListener('touchmove', (event) => {
    if (!drag.active) return;
    drag.currentY = event.touches[0].clientY;
    const delta = drag.currentY - drag.startY;
    if (delta <= 0) { reset(); return; } // upward: the list scrolls as usual
    event.preventDefault();
    const pull = Math.min(delta * 0.6, 260);
    panel.style.transform = `translateY(${pull}px)`;
    panel.style.opacity = String(1 - pull / 520);
    if (scrim) scrim.style.opacity = String(1 - pull / 300);
  }, { passive: false });
  const end = () => {
    if (!drag.active) return;
    drag.active = false;
    panel.classList.remove('is-dragging');
    if (drag.currentY - drag.startY > 100) {
      panel.classList.add('is-dismissed');
      setTimeout(() => {
        panel.classList.remove('is-dismissed');
        reset();
        dismiss();
        if (navigator.vibrate) navigator.vibrate(20);
      }, 250);
    } else {
      panel.style.transition = 'transform 0.2s var(--ease), opacity 0.2s var(--ease)';
      reset();
      setTimeout(() => { panel.style.transition = ''; }, 200);
    }
  };
  panel.addEventListener('touchend', end, { passive: true });
  panel.addEventListener('touchcancel', end, { passive: true });
}

function initMobileGestures() {
  // Only on mobile
  if (window.innerWidth > 760) return;

  const content = $('#content');
  const mobilebar = $('#mobilebar');
  const sheet = $('#more-sheet');
  const sheetPanel = sheet?.querySelector('.sheet__panel');
  const viewsInBar = [...mobilebar.querySelectorAll('.mobilebar__item[data-view]')].map(b => b.dataset.view);

  // Pull-to-refresh
  let ptrState = { startY: 0, currentY: 0, pulling: false, triggered: false };
  const ptrIndicator = createPullToRefreshIndicator();
  content.prepend(ptrIndicator);

  // Swipe navigation on bottom bar
  let swipeState = { startX: 0, startY: 0, currentX: 0, swiping: false };

  // Swipe-to-dismiss sheet
  attachSheetDrag(sheetPanel, { scrim: sheet?.querySelector('.sheet__scrim'), dismiss: dismissSheet, handle: '.sheet__grip' });

  // Touch ripple for interactive elements
  addTouchRipple();

  // --- Pull to Refresh ---
  // Nothing pulls to refresh while something sits over the page (a sheet,
  // the "what it takes" popup, a picker, the share sheet), nor from a slider
  // or anything that scrolls sideways (a wide table, the chip strips).
  const overlayOpen = () => !$('#more-sheet')?.hidden
    || !!document.querySelector('.scenario, .menu-scrim:not([hidden]), .share-sheet:not([hidden]), .popover-menu:not([hidden])');
  content.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0) return; // Only at top of page
    // The mountain locks the page at the top, so every downward drag that
    // turns it would otherwise pull to refresh.
    if (document.body.dataset.viz === 'mountain') return;
    if (ptrState.pulling || e.touches.length !== 1 || overlayOpen()) return;
    if (e.target.closest('input[type="range"], .scroller, .tool-links__list, .odds, .grid-zones-wrap, .ptable__grip')) return;
    ptrState.startX = e.touches[0].clientX;
    ptrState.startY = e.touches[0].clientY;
    ptrState.axis = null;
    ptrState.pulling = true;
    ptrState.triggered = false;
  }, { passive: true });

  content.addEventListener('touchmove', (e) => {
    if (!ptrState.pulling || window.scrollY > 0) {
      ptrState.pulling = false;
      return;
    }
    ptrState.currentY = e.touches[0].clientY;
    const delta = ptrState.currentY - ptrState.startY;
    // Angle lock: the first 8px of movement decide; a drag more sideways
    // than down (a swipe, a diagonal scroll) never pulls.
    if (!ptrState.axis) {
      const dx = Math.abs(e.touches[0].clientX - ptrState.startX);
      if (Math.max(dx, Math.abs(delta)) < 8) return;
      ptrState.axis = Math.abs(delta) > dx * 1.5 ? 'y' : 'x';
    }
    if (ptrState.axis !== 'y' || delta <= 0) {
      ptrState.pulling = false;
      resetPullToRefresh();
      return;
    }
    e.preventDefault(); // Prevent native scroll bounce
    const pullDistance = Math.min(delta * 0.5, 80); // Resistance
    ptrIndicator.style.height = `${pullDistance}px`;
    ptrIndicator.style.opacity = '1';
    ptrIndicator.classList.toggle('pulling', pullDistance > 40);
    if (pullDistance > 60 && !ptrState.triggered) {
      ptrState.triggered = true;
      ptrIndicator.querySelector('.ptr-text').textContent = t('ptr.release');
      // Haptic feedback simulation
      if (navigator.vibrate) navigator.vibrate(10);
    }
  }, { passive: false });

  content.addEventListener('touchend', async () => {
    if (!ptrState.pulling || !ptrState.triggered) {
      resetPullToRefresh();
      return;
    }
    // Trigger refresh
    ptrIndicator.classList.remove('pulling');
    ptrIndicator.classList.add('loading');
    ptrIndicator.style.height = '60px';
    ptrIndicator.querySelector('.ptr-text').textContent = t('ptr.loading');
    ptrIndicator.querySelector('.ptr-spinner').style.display = 'block';

    // Reload current season data
    try {
      await loadSeason(state.season);
    } catch (err) {
      console.warn('Pull to refresh failed:', err);
    }
    resetPullToRefresh();
  }, { passive: true });

  function resetPullToRefresh() {
    ptrState.pulling = false;
    ptrState.triggered = false;
    ptrIndicator.classList.remove('pulling', 'loading');
    ptrIndicator.style.height = '';
    ptrIndicator.style.opacity = '0';
    ptrIndicator.querySelector('.ptr-spinner').style.display = 'none';
    ptrIndicator.querySelector('.ptr-text').textContent = t('ptr.pull');
  }

  function createPullToRefreshIndicator() {
    const div = document.createElement('div');
    div.className = 'ptr-indicator';
    div.innerHTML = `
      <div class="ptr-spinner" style="display:none;"></div>
      <span class="ptr-text">${t('ptr.pull')}</span>
    `;
    return div;
  }

  // --- Swipe Navigation on Bottom Bar ---
  mobilebar?.addEventListener('touchstart', (e) => {
    const target = e.target.closest('.mobilebar__item[data-view]');
    if (!target) return;
    swipeState.startX = e.touches[0].clientX;
    swipeState.startY = e.touches[0].clientY;
    swipeState.currentX = swipeState.startX;  // a tap must not fake a swipe delta
    swipeState.swiping = true;
  }, { passive: true });

  mobilebar?.addEventListener('touchmove', (e) => {
    if (!swipeState.swiping) return;
    swipeState.currentX = e.touches[0].clientX;
    const deltaX = swipeState.currentX - swipeState.startX;
    const deltaY = Math.abs(e.touches[0].clientY - swipeState.startY);
    // Allow vertical scroll if vertical movement > horizontal
    if (deltaY > Math.abs(deltaX) * 1.5) {
      swipeState.swiping = false;
      return;
    }
    e.preventDefault();
    // Visual feedback on the bar items
    const threshold = 50;
    if (Math.abs(deltaX) > threshold) {
      const direction = deltaX > 0 ? 1 : -1; // right = previous, left = next
      const currentIndex = viewsInBar.indexOf(state.activeView);
      const nextIndex = (currentIndex + direction + viewsInBar.length) % viewsInBar.length;
      const nextView = viewsInBar[nextIndex];
      highlightBarItem(nextView);
    }
  }, { passive: false });

  mobilebar?.addEventListener('touchend', () => {
    if (!swipeState.swiping) return;
    swipeState.swiping = false;
    const deltaX = swipeState.currentX - swipeState.startX;
    const threshold = 50;
    if (Math.abs(deltaX) > threshold) {
      const direction = deltaX > 0 ? 1 : -1;
      const currentIndex = viewsInBar.indexOf(state.activeView);
      const nextIndex = (currentIndex + direction + viewsInBar.length) % viewsInBar.length;
      const nextView = viewsInBar[nextIndex];
      switchView(nextView, { dir: deltaX > 0 ? -1 : 1 });
      track('swipe_view', { view: nextView });
      if (navigator.vibrate) navigator.vibrate(15);
    }
    clearBarHighlight();
  }, { passive: true });

  function highlightBarItem(view) {
    mobilebar.querySelectorAll('.mobilebar__item[data-view]').forEach(btn => {
      btn.style.opacity = btn.dataset.view === view ? '1' : '0.4';
      btn.style.transform = btn.dataset.view === view ? 'scale(1.05)' : 'scale(0.95)';
    });
  }
  function clearBarHighlight() {
    mobilebar.querySelectorAll('.mobilebar__item[data-view]').forEach(btn => {
      btn.style.opacity = '';
      btn.style.transform = '';
    });
  }

}

/* Touch ripple effect for buttons and interactive elements */
function addTouchRipple() {
  const interactiveSelectors = [
    // Not the Overview card's name button: its ::after is stretched over the card, and the ripple's
    // position: relative would shrink that to the name, so a tap anywhere else on the card hit nothing.
    'button:not(.switch button):not(.sort-btn):not(.grid-anim-speed button):not(.overview-card__open)',
    '.club-btn',
    '.played-card',
    '.ladder__team',
    '.compare__team',
    '.team-logo',
    '.hero-title-part',
    '.timeline__step',
    '.grid-anim-btn',
    '.played-nav__btn',
    '.timeline__now',
    '.compare__swap-center',
    '.sheet__item',
    '.mobilebar__item',
    '.settings-btn',
    '.popover-menu__btn',
    '.compare__option',
    '.team-grid-row__cell-wrap',
  ];

  // Use event delegation for performance
  document.addEventListener('touchstart', (e) => {
    const target = e.target.closest(interactiveSelectors.join(', '));
    if (!target) return;
    // Don't add ripple to elements that already have visual feedback
    if (target.classList.contains('switch') || target.closest('.switch')) return;
    if (target.classList.contains('sort-btn')) return;
    if (target.classList.contains('grid-anim-speed') || target.closest('.grid-anim-speed')) return;

    target.classList.add('touch-ripple');
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    const target = e.target.closest('.touch-ripple');
    if (target) {
      // Remove after animation
      setTimeout(() => target.classList.remove('touch-ripple'), 300);
    }
  }, { passive: true });

  document.addEventListener('touchcancel', (e) => {
    const target = e.target.closest('.touch-ripple');
    if (target) target.classList.remove('touch-ripple');
  }, { passive: true });
}

/* Reduced motion check for gestures */
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* Smooth scroll to element with offset for fixed headers */
function smoothScrollTo(element, offset = 0) {
  if (prefersReducedMotion()) {
    element.scrollIntoView({ block: 'start' });
    return;
  }
  const headerHeight = document.querySelector('.masthead')?.offsetHeight || 0;
  const mobilebarHeight = window.innerWidth <= 760 ? (document.querySelector('.mobilebar')?.offsetHeight || 0) : 0;
  const targetPosition = element.getBoundingClientRect().top + window.scrollY - headerHeight - mobilebarHeight - offset;
  window.scrollTo({ top: targetPosition, behavior: 'smooth' });
}

/* Handle orientation change */
function handleOrientationChange() {
  // Recalculate viewport heights for fixed elements
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);

  // Close any open menus/sheets on orientation change
  closeAllMenus();

  // The animation bar is a scaleX fraction of its track, so a new width
  // needs no redraw.
}
