/* Segmented controls: each group has one pill that slides to its pressed
   button, the site's and the model page's alike, so this file serves both.

   A group gets its thumb here unless its markup carries one. The pill
   slides only when the pressed button changes; a resize, a language or a
   late font that moves the buttons puts it straight in place, as does its
   first showing. A group that is drawn anew (the club page's tabs, on each
   visit) slides from where its predecessor's pill stood: the last place is
   kept per group, keyed by its class, label and order on the page. A slide
   starts from the old button's width as well as its place, and a button
   that moves while the pill is on its way (the page settling around a new
   view) is followed, not jumped to. The
   pill takes the button's size, except on the phone's tab bar, where it
   keeps its own and centres on the tab. Nothing here is called: pressed
   state, hidden buttons and new groups are watched, as are the buttons'
   sizes, since a button can change size with no resize of the window. */
(() => {
  const GROUPS = '.switch, .table-controls, .grid-anim-speed, .mobilebar';
  const placed = new WeakMap(); // thumb -> { target, x, width, until }
  const lastByKey = new Map(); // group key -> { x, width }, for groups drawn anew
  const SLIDE_MS = 350; // the stylesheet's 0.3s slide, and a frame to spare
  const sizes = window.ResizeObserver ? new ResizeObserver(() => schedule()) : null;
  const watched = new WeakSet();
  let frame = 0;

  function keyOf(group, groups) {
    const base = `${group.className}|${group.getAttribute('aria-label') || ''}`;
    return `${base}|${groups.filter((other) => `${other.className}|${other.getAttribute('aria-label') || ''}` === base).indexOf(group)}`;
  }

  function thumbOf(group) {
    let thumb = [...group.children].find((child) => child.matches('.switch__thumb, .mobilebar__thumb'));
    if (!thumb) {
      thumb = document.createElement('span');
      thumb.className = 'switch__thumb';
      thumb.setAttribute('aria-hidden', 'true');
      thumb.hidden = true;
      group.prepend(thumb);
    }
    if (sizes && !watched.has(group)) {
      watched.add(group);
      sizes.observe(group, { box: 'border-box' });
      for (const button of group.querySelectorAll('button')) sizes.observe(button, { box: 'border-box' });
    }
    return thumb;
  }

  function slide() {
    frame = 0;
    const groups = [...document.querySelectorAll(GROUPS)];
    for (const group of groups) {
      const thumb = thumbOf(group);
      const key = keyOf(group, groups);
      const target = [...group.querySelectorAll('[aria-pressed="true"]')].find((button) => !button.hidden);
      // Only on a change: this file watches the hidden attribute too.
      if (!target) {
        if (!thumb.hidden) thumb.hidden = true;
        placed.delete(thumb);
        continue;
      }
      const box = target.getBoundingClientRect();
      if (!box.width) {
        placed.delete(thumb); // not on screen: a closed menu, the strip on a phone
        continue;
      }
      if (thumb.hidden) thumb.hidden = false;
      const fit = !thumb.classList.contains('mobilebar__thumb');
      const rect = group.getBoundingClientRect();
      const width = fit ? box.width : thumb.offsetWidth;
      const x = box.left - rect.left - group.clientLeft + (box.width - width) / 2;
      const last = placed.get(thumb);
      if (last && last.target === target && Math.abs(last.x - x) < 0.5 && Math.abs(last.width - width) < 0.5) continue;
      const now = performance.now();
      const fitTo = () => {
        thumb.style.top = `${box.top - rect.top - group.clientTop}px`;
        thumb.style.height = `${box.height}px`;
      };
      if (last && last.target === target && now < last.until) {
        if (fit) {
          thumb.style.width = `${width}px`;
          fitTo();
        }
        thumb.style.transform = `translateX(${x}px)`;
        placed.set(thumb, { ...last, x, width });
        lastByKey.set(key, { x, width });
        continue;
      }
      const from = last ? (last.target !== target ? last : null) : lastByKey.get(key);
      const moves = from != null && (Math.abs(from.x - x) >= 0.5 || Math.abs(from.width - width) >= 0.5);
      thumb.style.transition = 'none';
      if (fit) {
        thumb.style.width = `${moves ? from.width : width}px`;
        fitTo();
      }
      thumb.style.transform = `translateX(${moves ? from.x : x}px)`;
      void thumb.offsetWidth;
      thumb.style.transition = '';
      if (moves) {
        thumb.style.transform = `translateX(${x}px)`;
        if (fit) thumb.style.width = `${width}px`;
      }
      placed.set(thumb, { target, x, width, until: moves ? now + SLIDE_MS : 0 });
      lastByKey.set(key, { x, width });
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(slide);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-pressed', 'hidden'],
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
  document.fonts?.ready.then(schedule);
})();
