// Shared helpers for every Capital Trust Bank page: API calls, formatting,
// icons, toasts and the language switcher.

const CTB = (() => {
  // Lets the stylesheet hide scroll-reveal elements only when scripts run.
  document.documentElement.classList.add('js');

  // ------------------------------------------------------------ API

  async function api(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch {
      throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && !/^\/(login|register)?$/.test(location.pathname)) {
        location.href = '/login';
      }
      // An open admin page whose session has become a customer's (for example after
      // a customer logs in on another tab) reloads, and the server sends it to the right place.
      if (response.status === 403 && location.pathname === '/admin' && path.startsWith('/api/admin/')) {
        location.href = '/admin';
      }
      const error = new Error(data.error || 'Something went wrong. Please try again.');
      error.field = data.field;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  // ------------------------------------------------------------ formatting

  const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const money = (cents) => moneyFormat.format(cents / 100);
  const date = (iso) => (iso ? dateFormat.format(new Date(iso)) : '');
  const account = (number) => String(number).replace(/(.{4})(?=.)/g, '$1 ');

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ------------------------------------------------------------ icons (Lucide paths)

  const ICONS = {
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.500-8-4-8-9V5l8-3 8 3z"/><path d="m9 12 2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
    'arrow-right': '<path d="M5 12h14M12 5l7 7-7 7"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.870M16 3.130a4 4 0 0 1 0 7.750"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
    wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3v3a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5"/>',
    home: '<path d="M3 10.5 12 3l9 7.500V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.300-4.300"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    eye: '<path d="M2 12s3.500-7 10-7 10 7 10 7-3.500 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    hourglass: '<path d="M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2z"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="m7 4 13 8-13 8z"/>',
    bank: '<path d="M12 3 3 8v2h18V8zM6 12v6M10 12v6M14 12v6M18 12v6M4 20h16"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.700L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.700L3 16M3 21v-5h5"/>',
    languages: '<path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/>',
  };

  function icon(name) {
    return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  function hydrateIcons(root = document) {
    for (const el of root.querySelectorAll('[data-icon]')) {
      el.outerHTML = icon(el.dataset.icon);
    }
  }

  // ------------------------------------------------------------ bank card visual

  const CHIP = `
    <svg class="atm-chip" viewBox="0 0 50 38" aria-hidden="true">
      <defs>
        <linearGradient id="chip-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#f7e7a6"/><stop offset=".45" stop-color="#cfa53f"/><stop offset="1" stop-color="#f1dc8c"/>
        </linearGradient>
      </defs>
      <rect x=".5" y=".5" width="49" height="37" rx="6" fill="url(#chip-gold)" stroke="#8d6c1c" stroke-opacity=".6"/>
      <path d="M0 13h16M0 25h16M34 13h16M34 25h16M16 .5v37M34 .5v37M16 19h18" fill="none" stroke="#8d6c1c" stroke-opacity=".75"/>
      <rect x="20" y="12" width="10" height="14" rx="3" fill="none" stroke="#8d6c1c" stroke-opacity=".75"/>
    </svg>`;

  const CONTACTLESS = `
    <svg class="atm-wave" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 8.500a6 6 0 0 1 0 7M10 6a10 10 0 0 1 0 12M14 3.500a14 14 0 0 1 0 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;

  // A realistic debit card. `masked` hides the middle digits and the security
  // code; `locked` draws a blank card for customers who have not been issued one.
  function atmCard({ tier = 'classic', number = '', holder = '', expiry = '', cvv = '', masked = true, locked = false, back = true } = {}) {
    const dots = '\u2022\u2022\u2022\u2022';
    const groups = (number.match(/.{1,4}/g) || []).concat(['', '', '', '']).slice(0, 4);
    const digits = locked ? [dots, dots, dots, dots] : masked ? [groups[0], dots, dots, groups[3]] : groups;
    const tierName = tier[0].toUpperCase() + tier.slice(1);
    return `
      <div class="atm atm--${esc(tier)}${locked ? ' is-locked' : ''}">
        <div class="atm-inner">
          <div class="atm-face atm-front">
            <div class="atm-row">
              <span class="atm-bank notranslate"><img class="atm-logo" src="/img/${tier === 'gold' ? 'logo-mark' : 'logo-mark-clear'}.png" alt="" /> Capital Trust</span>
              <span class="atm-tier notranslate">${esc(tierName)}</span>
            </div>
            <div class="atm-row atm-row--start">${CHIP}${CONTACTLESS}</div>
            <p class="atm-number num notranslate">${digits.map((group) => `<span>${esc(group)}</span>`).join('')}</p>
            <div class="atm-row atm-row--end">
              <div class="atm-field">
                <small>Card holder</small>
                <span class="notranslate">${esc(holder)}</span>
              </div>
              <div class="atm-field">
                <small>Valid thru</small>
                <span class="num notranslate">${esc(expiry || '--/--')}</span>
              </div>
              <div class="atm-network" aria-hidden="true"><i></i><b>Debit</b></div>
            </div>
          </div>
          ${
            back
              ? `<div class="atm-face atm-back">
                   <div class="atm-stripe"></div>
                   <div class="atm-sign">
                     <span class="atm-sign-strip notranslate">${esc(holder)}</span>
                     <span class="atm-cvv num notranslate">${masked || locked ? '\u2022\u2022\u2022' : esc(cvv)}</span>
                   </div>
                   <p class="atm-small">This card remains the property of Capital Trust Bank. Use is subject to the cardholder agreement. Keep your card number and security code private.</p>
                   <div class="atm-row atm-row--end">
                     <span class="atm-bank notranslate"><img class="atm-logo" src="/img/${tier === 'gold' ? 'logo-mark' : 'logo-mark-clear'}.png" alt="" /> Capital Trust</span>
                     <div class="atm-network" aria-hidden="true"><i></i><b>Debit</b></div>
                   </div>
                 </div>`
              : ''
          }
        </div>
      </div>`;
  }

  // Static pages describe a card with data attributes; draw it here.
  function hydrateCards() {
    for (const el of document.querySelectorAll('[data-atm]')) {
      el.outerHTML = atmCard({ ...el.dataset, tier: el.dataset.atm, masked: true, back: false });
    }
  }

  // ------------------------------------------------------------ motion helpers

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Counts a number up from zero, writing format(value) into the element.
  function countUp(el, target, format = String, duration = 900) {
    if (reducedMotion || !target) {
      el.textContent = format(target);
      return;
    }
    const started = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      el.textContent = format(Math.round(target * eased));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ toasts

  function toast(message, type = 'success') {
    let region = document.querySelector('.toasts');
    if (!region) {
      region = document.createElement('div');
      region.className = 'toasts';
      region.setAttribute('aria-live', 'polite');
      document.body.append(region);
    }
    const el = document.createElement('div');
    el.className = `toast${type === 'error' ? ' toast-error' : ''}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = icon(type === 'error' ? 'alert' : 'check');
    el.append(message);
    region.append(el);
    setTimeout(() => el.remove(), 4500);
  }

  // ------------------------------------------------------------ forms

  function setLoading(button, loading) {
    button.disabled = loading;
    button.classList.toggle('is-loading', loading);
  }

  function clearErrors(form) {
    for (const el of form.querySelectorAll('.error')) el.remove();
    for (const el of form.querySelectorAll('[aria-invalid]')) {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
    }
    const alert = form.querySelector('.alert');
    if (alert) alert.hidden = true;
  }

  // Show an error under the named field, or in the form's alert box when
  // the error is not tied to a field.
  function showError(form, message, fieldName) {
    const input = fieldName && form.elements[fieldName];
    if (input && input.closest) {
      const error = document.createElement('p');
      error.className = 'error';
      error.id = `${fieldName}-error`;
      error.setAttribute('role', 'alert');
      error.innerHTML = icon('alert');
      error.append(message);
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', error.id);
      input.closest('.field').append(error);
      input.focus();
      return;
    }
    const alert = form.querySelector('.alert');
    if (alert) {
      alert.textContent = message;
      alert.hidden = false;
      alert.focus();
    } else {
      toast(message, 'error');
    }
  }

  function initPasswordToggles() {
    for (const button of document.querySelectorAll('.password-toggle')) {
      button.addEventListener('click', () => {
        const input = button.parentElement.querySelector('input');
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        button.textContent = show ? 'Hide' : 'Show';
        button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        button.setAttribute('aria-pressed', String(show));
      });
    }
  }

  // ------------------------------------------------------------ languages
  // Translation is done by Google Translate. We render our own selector and
  // drive it through the "googtrans" cookie that the Google script reads.

  const LANGUAGES = [
    'en|English', 'af|Afrikaans', 'sq|Shqip', 'am|አማርኛ', 'ar|العربية', 'hy|Հայերեն', 'as|অসমীয়া', 'ay|Aymar aru',
    'az|Azərbaycan', 'bm|Bamanankan', 'eu|Euskara', 'be|Беларуская', 'bn|বাংলা', 'bho|भोजपुरी', 'bs|Bosanski',
    'bg|Български', 'ca|Català', 'ceb|Cebuano', 'ny|Chichewa', 'zh-CN|中文 (简体)', 'zh-TW|中文 (繁體)', 'co|Corsu',
    'hr|Hrvatski', 'cs|Čeština', 'da|Dansk', 'dv|ދިވެހި', 'doi|डोगरी', 'nl|Nederlands', 'eo|Esperanto', 'et|Eesti',
    'ee|Eʋegbe', 'tl|Filipino', 'fi|Suomi', 'fr|Français', 'fy|Frysk', 'gl|Galego', 'ka|ქართული', 'de|Deutsch',
    'el|Ελληνικά', 'gn|Avañe\'ẽ', 'gu|ગુજરાતી', 'ht|Kreyòl ayisyen', 'ha|Hausa', 'haw|ʻŌlelo Hawaiʻi', 'iw|עברית',
    'hi|हिन्दी', 'hmn|Hmoob', 'hu|Magyar', 'is|Íslenska', 'ig|Igbo', 'ilo|Ilokano', 'id|Bahasa Indonesia',
    'ga|Gaeilge', 'it|Italiano', 'ja|日本語', 'jw|Basa Jawa', 'kn|ಕನ್ನಡ', 'kk|Қазақ', 'km|ខ្មែរ', 'rw|Kinyarwanda',
    'gom|कोंकणी', 'ko|한국어', 'kri|Krio', 'ku|Kurdî', 'ckb|کوردیی ناوەندی', 'ky|Кыргызча', 'lo|ລາວ', 'la|Latina',
    'lv|Latviešu', 'ln|Lingála', 'lt|Lietuvių', 'lg|Luganda', 'lb|Lëtzebuergesch', 'mk|Македонски', 'mai|मैथिली',
    'mg|Malagasy', 'ms|Bahasa Melayu', 'ml|മലയാളം', 'mt|Malti', 'mi|Māori', 'mr|मराठी', 'mni-Mtei|ꯃꯩꯇꯩꯂꯣꯟ',
    'lus|Mizo ṭawng', 'mn|Монгол', 'my|မြန်မာ', 'ne|नेपाली', 'no|Norsk', 'or|ଓଡ଼ିଆ', 'om|Afaan Oromoo', 'ps|پښتو',
    'fa|فارسی', 'pl|Polski', 'pt|Português', 'pa|ਪੰਜਾਬੀ', 'qu|Runasimi', 'ro|Română', 'ru|Русский', 'sm|Gagana Sāmoa',
    'sa|संस्कृतम्', 'gd|Gàidhlig', 'nso|Sepedi', 'sr|Српски', 'st|Sesotho', 'sn|ChiShona', 'sd|سنڌي', 'si|සිංහල',
    'sk|Slovenčina', 'sl|Slovenščina', 'so|Soomaali', 'es|Español', 'su|Basa Sunda', 'sw|Kiswahili', 'sv|Svenska',
    'tg|Тоҷикӣ', 'ta|தமிழ்', 'tt|Татар', 'te|తెలుగు', 'th|ไทย', 'ti|ትግርኛ', 'ts|Xitsonga', 'tr|Türkçe',
    'tk|Türkmen', 'ak|Twi', 'uk|Українська', 'ur|اردو', 'ug|ئۇيغۇرچە', 'uz|Oʻzbek', 'vi|Tiếng Việt', 'cy|Cymraeg',
    'xh|isiXhosa', 'yi|ייִדיש', 'yo|Yorùbá', 'zu|isiZulu',
  ].map((entry) => entry.split('|'));

  const RTL = new Set(['ar', 'iw', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']);

  function currentLanguage() {
    const match = document.cookie.match(/(?:^|;\s*)googtrans=\/en\/([^;]+)/);
    return match ? decodeURIComponent(match[1]) : 'en';
  }

  function setLanguage(code) {
    const expire = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
    // Clear on both the bare host and the domain form Google also writes.
    document.cookie = `googtrans=; path=/; ${expire}`;
    document.cookie = `googtrans=; path=/; domain=${location.hostname}; ${expire}`;
    if (code !== 'en') document.cookie = `googtrans=/en/${code}; path=/; max-age=31536000`;
    location.reload();
  }

  function initLanguages() {
    const mounts = document.querySelectorAll('[data-lang-switch]');
    if (!mounts.length) return;
    const active = currentLanguage();
    if (RTL.has(active)) document.documentElement.dir = 'rtl';

    for (const mount of mounts) {
      mount.className = 'lang-switch notranslate';
      mount.setAttribute('translate', 'no');
      mount.innerHTML =
        icon('globe') +
        '<label class="sr-only" for="lang-select">Language</label>' +
        '<select id="lang-select">' +
        LANGUAGES.map(([code, name]) => `<option value="${code}"${code === active ? ' selected' : ''}>${esc(name)}</option>`).join('') +
        '</select>';
      mount.querySelector('select').addEventListener('change', (event) => setLanguage(event.target.value));
    }

    // Only load Google's script when a translation is actually needed.
    if (active === 'en') return;
    const holder = document.createElement('div');
    holder.id = 'google_translate_element';
    document.body.append(holder);
    window.googleTranslateElementInit = () => {
      new google.translate.TranslateElement({ pageLanguage: 'en', autoDisplay: false }, 'google_translate_element');
    };
    const script = document.createElement('script');
    script.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    script.onerror = () => toast('Translation needs an internet connection.', 'error');
    document.head.append(script);
  }

  // ------------------------------------------------------------ countries + account types

  const ACCOUNT_TYPES = {
    savings: 'Savings account',
    current: 'Current account',
    business: 'Business account',
    joint: 'Joint account',
  };

  const COUNTRY_CODES =
    'AF AX AL DZ AS AD AO AI AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BA BW BR BN BG BF BI KH CM CA CV KY CF TD CL CN CO KM CG CD CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GF PF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NC NZ NI NE NG MK NO OM PK PW PS PA PG PY PE PH PL PT PR QA RE RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA SS ES LK SD SR SE CH SY TW TJ TZ TH TL TG TO TT TN TR TM TC TV UG UA AE GB US UY UZ VU VE VN YE ZM ZW';

  const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;

  function countryName(code) {
    if (!code) return '';
    try {
      return (regionNames && regionNames.of(code)) || code;
    } catch {
      return code;
    }
  }

  function countryOptions(selected = '') {
    const countries = COUNTRY_CODES.split(' ')
      .map((code) => [code, countryName(code)])
      .sort((a, b) => a[1].localeCompare(b[1]));
    return (
      '<option value="">Select a country</option>' +
      countries.map(([code, name]) => `<option value="${code}"${code === selected ? ' selected' : ''}>${esc(name)}</option>`).join('')
    );
  }

  // ------------------------------------------------------------ session

  function initLogout() {
    for (const button of document.querySelectorAll('[data-logout]')) {
      button.addEventListener('click', async () => {
        const scope = location.pathname === '/admin' ? 'admin' : 'customer';
        await api('/api/logout', { method: 'POST', body: { scope } }).catch(() => {});
        location.href = scope === 'admin' ? '/login' : '/';
      });
    }
  }

  // Fade sections in as they scroll into view.
  function initReveal() {
    const items = document.querySelectorAll('[data-reveal]');
    if (!('IntersectionObserver' in window)) {
      for (const el of items) el.classList.add('is-visible');
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px' }
    );
    for (const el of items) observer.observe(el);
  }

  document.addEventListener('DOMContentLoaded', () => {
    hydrateIcons();
    hydrateCards();
    initReveal();
    initLanguages();
    initPasswordToggles();
    initLogout();
  });

  return {
    api, money, date, account, esc, icon, hydrateIcons, toast, setLoading, clearErrors, showError,
    ACCOUNT_TYPES, countryName, countryOptions, atmCard, countUp, reducedMotion,
  };
})();
