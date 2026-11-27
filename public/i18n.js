/* Internationalisation (i18n) support — English (en) and Norwegian Bokmål (no).
   Language tables live in public/i18n/en.js and public/i18n/no.js. */

const translations = {
  en: typeof translationsEn !== 'undefined' ? translationsEn : (typeof require !== 'undefined' ? require('./i18n/en.js') : null),
  no: typeof translationsNo !== 'undefined' ? translationsNo : (typeof require !== 'undefined' ? require('./i18n/no.js') : null),
};

const loadedScripts = new Map();
function loadScript(src) {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(src, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => {
        loadedScripts.delete(src);
        script.remove();
        reject(new Error(`${src} did not load`));
      };
      document.head.appendChild(script);
    }));
  }
  return loadedScripts.get(src);
}

function loadScriptsInOrder(files) {
  for (const src of files) {
    if (loadedScripts.has(src) || document.querySelector(`link[rel="preload"][href="${src}"]`)) continue;
    const hint = document.createElement('link');
    hint.rel = 'preload';
    hint.as = 'script';
    hint.href = src;
    document.head.appendChild(hint);
  }
  return files.reduce((chain, src) => chain.then(() => loadScript(src)), Promise.resolve());
}

async function ensureLang(lang) {
  const code = lang === 'en' ? 'en' : 'no';
  if (translations[code]) return;
  await loadScript(`/i18n/${code}.js`);
  translations[code] = code === 'en' ? translationsEn : translationsNo;
}

let currentLang = (() => { try { return localStorage.getItem('lang') || 'no'; } catch (error) { return 'no'; } })();

function getLang() {
  return currentLang;
}


function t(key, params = {}) {
  const str = (translations[currentLang] && translations[currentLang][key])
    || (translations.en && translations.en[key])
    || key;
  return Object.keys(params).reduce((s, k) => s.replaceAll(`{${k}}`, () => String(params[k])), str);
}

/* The stored key is 'no', but the page's language tag is 'nb' (Bokmål): 'no'
   is the macrolanguage, and screen readers and hyphenation pick their
   dictionary from the tag. */
function htmlLang(lang) {
  return lang === 'no' ? 'nb' : lang;
}

function setLang(lang) {
  currentLang = lang;
  try { localStorage.setItem('lang', lang); } catch (error) { /* kept for this visit only */ }
  document.documentElement.lang = htmlLang(lang);
  applyTranslations();
}

/* Walk every element with data-i18n and set its text content.
   Elements with data-i18n-attr get the translation set as that attribute
   instead (skipping textContent so child nodes are preserved). */
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    if (node.hasAttribute('data-i18n-attr')) return;
    const key = node.getAttribute('data-i18n');
    node.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    const attr = node.getAttribute('data-i18n-attr');
    if (key && attr) node.setAttribute(attr, t(key));
  });
  /* Footer contains an <a> — textContent would strip it. */
  const footer = document.getElementById('footer-text');
  if (footer) footer.innerHTML = t('footer.text');
}


if (typeof module !== 'undefined') {
  module.exports = { translations, getLang, ensureLang, t, htmlLang, setLang, applyTranslations };
}
