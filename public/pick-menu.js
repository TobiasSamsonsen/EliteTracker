/* Pick-one lists in the masthead's own picker style, not the browser's: a button shows the choice and opens the
   choices in a popover under it (a bottom sheet on a phone, where app.js is loaded: phoneMenu). A classic script,
   loaded before app.js and by model.html, which has no app.js.

   openPickMenu(anchor, { label, options, value, onPick }): the list for any button. options is a list of
   { value, text }, or a function giving one when the list opens; onPick gets the chosen value.
   pickSelect(select): hides a <select> and puts such a button in its place. The select stays the state
   holder, so the code that reads it, sets its value or listens for 'change' is not touched; the button
   follows the select's value, options and aria-label. */

let pickMenuEl = null;
let pickAnchorEl = null;
let pickMenuOff = null;

function closePickMenu(options = {}) {
  if (!pickMenuEl) return;
  const anchor = pickAnchorEl;
  pickMenuOff();
  pickMenuEl.remove();
  pickMenuEl = null;
  pickAnchorEl = null;
  pickMenuOff = null;
  anchor.setAttribute('aria-expanded', 'false');
  if (typeof hideMenuScrim === 'function') hideMenuScrim();
  if (options.refocus) anchor.focus();
}

function openPickMenu(anchor, { label, options, value, onPick }) {
  const wasOpen = pickAnchorEl === anchor;
  if (typeof closeAllMenus === 'function') closeAllMenus();
  closePickMenu();
  if (wasOpen) return;
  const menu = document.createElement('div');
  menu.className = 'popover-menu popover-menu--picker popover-menu--scroll popover-menu--pick';
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', label);
  for (const option of typeof options === 'function' ? options() : options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'popover-menu__btn';
    btn.textContent = option.text;
    btn.setAttribute('aria-pressed', String(option.value === value));
    if (option.value === value) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => {
      closePickMenu({ refocus: true });
      if (option.value !== value) onPick(option.value);
    });
    menu.appendChild(btn);
  }
  // A list opened from inside a popover (Explore's mountain settings) must sit above it, in the top layer too.
  const host = anchor.closest('[popover]') || document.body;
  menu.setAttribute('popover', 'manual');
  host.appendChild(menu);
  try { menu.showPopover(); } catch (error) { menu.removeAttribute('popover'); }
  anchor.setAttribute('aria-expanded', 'true');
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.minWidth = `${rect.width}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  const spaceBelow = window.innerHeight - rect.bottom - 14;
  if (spaceBelow < menu.offsetHeight && rect.top > spaceBelow) {          // more room above: open upward
    menu.style.top = `${Math.max(8, rect.top - 6 - menu.offsetHeight)}px`;
  }
  pickMenuEl = menu;
  pickAnchorEl = anchor;
  if (typeof phoneMenu === 'function') phoneMenu(menu, () => closePickMenu());

  const buttons = [...menu.querySelectorAll('.popover-menu__btn')];
  const onPointer = (event) => { if (!menu.contains(event.target) && !anchor.contains(event.target)) closePickMenu(); };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); closePickMenu({ refocus: true }); return; }
    const at = buttons.indexOf(document.activeElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (to !== undefined) { event.preventDefault(); buttons[(to + buttons.length) % buttons.length].focus(); }
    else if (event.key === 'Tab') closePickMenu();
  };
  const onScroll = (event) => { if (!menu.contains(event.target) && !menu.classList.contains('is-sheet')) closePickMenu(); };
  const onResize = () => closePickMenu();
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  pickMenuOff = () => {
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  };
  const current = menu.querySelector('[aria-current="true"]') || buttons[0];
  current?.scrollIntoView({ block: 'nearest' });
  current?.focus({ preventScroll: true });
}

function pickSelect(select) {
  if (select.dataset.pickReady) return select.previousElementSibling;
  select.dataset.pickReady = '1';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `${select.className} pickbtn`.trim();
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  const shown = document.createElement('span');
  shown.className = 'pickbtn__text';
  btn.appendChild(shown);
  const sync = () => {
    shown.textContent = select.selectedOptions[0] ? select.selectedOptions[0].text : '';
    const name = select.getAttribute('aria-label');
    if (name) btn.setAttribute('aria-label', name); else btn.removeAttribute('aria-label');
    btn.disabled = select.disabled;
  };
  // Code sets select.value directly (a reset, a new division): the button follows without being told.
  const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return native.get.call(this); },
    set(next) { native.set.call(this, next); sync(); },
  });
  new MutationObserver(sync).observe(select, { childList: true, attributes: true, attributeFilter: ['aria-label', 'disabled'] });
  select.addEventListener('change', sync);
  btn.addEventListener('click', () => openPickMenu(btn, {
    label: select.getAttribute('aria-label') || '',
    options: () => [...select.options].map((option) => ({ value: option.value, text: option.text })),
    value: select.value,
    onPick: (next) => { select.value = next; select.dispatchEvent(new Event('change', { bubbles: true })); },
  }));
  select.before(btn);
  select.hidden = true;
  sync();
  return btn;
}
