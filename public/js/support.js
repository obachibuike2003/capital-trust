// Live support chat: a floating button that opens a chat panel.
// Signed-in customers talk on their account thread. On the public pages the
// script tag carries data-mode="visitor", and visitors give a name first.

(() => {
  const { api, esc, icon } = CTB;
  const visitorPage = document.currentScript.dataset.mode === 'visitor';

  // The dashboard ships the chat markup; public pages get it injected here.
  if (!document.getElementById('chat')) {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<button class="chat-fab" type="button" id="chat-open" aria-label="Open live support chat" aria-expanded="false">
         ${icon('chat')}
         <span class="chat-fab-count num notranslate" id="chat-unread" hidden></span>
       </button>
       <section class="chat" id="chat" aria-labelledby="chat-title" hidden>
         <header class="chat-head">
           <span class="chat-status" aria-hidden="true"></span>
           <div>
             <h2 id="chat-title">Live support</h2>
             <p>We usually reply within a few minutes.</p>
           </div>
           <button class="chat-close" type="button" id="chat-close" aria-label="Close chat">${icon('x')}</button>
         </header>
         <div class="chat-log" id="chat-log" aria-live="polite"></div>
         <form class="chat-form" id="chat-form">
           <div class="chat-intro" id="chat-intro" hidden>
             <label for="chat-name">Your name</label>
             <input id="chat-name" name="name" type="text" autocomplete="name" maxlength="60" />
             <label for="chat-email">Email <span class="muted">(optional)</span></label>
             <input id="chat-email" name="email" type="email" autocomplete="email" maxlength="120" />
           </div>
           <label class="sr-only" for="chat-input">Message</label>
           <textarea id="chat-input" name="body" rows="1" maxlength="1000" placeholder="Type your message"></textarea>
           <button class="btn btn-primary" type="submit" aria-label="Send message">${icon('send')}</button>
         </form>
       </section>`
    );
  }

  const panel = document.getElementById('chat');
  const opener = document.getElementById('chat-open');
  const log = document.getElementById('chat-log');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const unread = document.getElementById('chat-unread');
  const intro = document.getElementById('chat-intro');

  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  let endpoint = '/api/support';
  let mine = 'customer';
  let started = true; // visitors start a chat by giving their name
  let shown = -1;

  function render(messages) {
    if (messages.length === shown) return;
    shown = messages.length;
    if (!messages.length) {
      log.innerHTML = '<p class="chat-empty">Hello! How can we help you today?</p>';
      return;
    }
    log.innerHTML = messages
      .map(
        (message) => `
          <div class="bubble ${message.sender === mine ? 'is-mine' : ''}">
            <p class="notranslate">${esc(message.body)}</p>
            <small>${message.sender === mine ? 'You' : 'Support'} &middot; ${esc(timeFormat.format(new Date(message.createdAt)))}</small>
          </div>`
      )
      .join('');
    log.scrollTop = log.scrollHeight;
  }

  function setStarted(value) {
    started = value;
    if (intro) intro.hidden = started;
  }

  async function refresh() {
    try {
      if (panel.hidden) {
        const { unread: count } = await api(`${endpoint}?peek=1`);
        unread.textContent = count;
        unread.hidden = !count;
      } else {
        const data = await api(endpoint);
        if ('started' in data) setStarted(data.started);
        render(data.messages);
        unread.hidden = true;
      }
    } catch {
      // Keep the last messages on screen; the next poll will try again.
    }
  }

  function open(prefill = '') {
    panel.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    if (prefill && !input.value) input.value = prefill;
    (started || !intro ? input : document.getElementById('chat-name')).focus();
    refresh();
  }

  function close() {
    panel.hidden = true;
    opener.setAttribute('aria-expanded', 'false');
    opener.focus();
  }

  opener.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.getElementById('chat-close').addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  // Buttons elsewhere on the page can open the chat with a suggested message.
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-open-support]');
    if (!trigger) return;
    event.preventDefault();
    open(trigger.dataset.openSupport);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = { body: input.value.trim() };
    if (!started) {
      const name = document.getElementById('chat-name');
      payload.name = name.value.trim();
      payload.email = document.getElementById('chat-email').value.trim();
      if (payload.name.length < 2) {
        CTB.toast('Enter your name so we know who we are talking to.', 'error');
        return name.focus();
      }
    }
    if (!payload.body) return input.focus();

    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const data = await api(endpoint, { method: 'POST', body: payload });
      setStarted(true);
      render(data.messages);
      input.value = '';
    } catch (error) {
      CTB.toast(error.message, 'error');
    } finally {
      button.disabled = false;
      input.focus();
    }
  });

  async function start() {
    if (visitorPage) {
      // Someone already signed in keeps their account thread; admins use the console instead.
      const me = await api('/api/me').catch(() => null);
      if (me && me.user.role === 'admin') {
        opener.hidden = true;
        return;
      }
      if (!me) {
        endpoint = '/api/visitor-support';
        mine = 'visitor';
        setStarted(false);
      }
    }

    // Poll quickly while the chat is open, slowly for the unread badge otherwise.
    setInterval(() => {
      if (!document.hidden && !panel.hidden) refresh();
    }, 4000);
    setInterval(() => {
      if (!document.hidden && panel.hidden) refresh();
    }, 15000);
    refresh();
  }

  start();
})();
