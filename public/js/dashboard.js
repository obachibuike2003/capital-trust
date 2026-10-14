// Customer banking app: overview, payments, history, card and profile views.
// The views live in one page and are switched by the URL hash.

(() => {
  const { api, money, date, account, esc, icon, toast } = CTB;

  const txForm = document.getElementById('tx-form');
  const txSubmit = document.getElementById('tx-submit');
  const transferFields = document.getElementById('transfer-fields');
  const savedField = document.getElementById('saved-field');
  const profileForm = document.getElementById('profile-form');
  const passwordForm = document.getElementById('password-form');
  const receipt = document.getElementById('receipt');

  let user = null;
  let transactions = [];
  let beneficiaries = [];
  let filter = 'all';
  let query = '';
  let card = null;
  let tiers = {};
  let price = { priceCents: 0, listPriceCents: 0 };
  let digitsShown = false;
  let flipped = false;
  let chartDrawn = false;
  let openReference = '';

  const VIEWS = {
    overview: ['Overview', ''],
    payments: ['Payments', 'Add money, send to someone or withdraw.'],
    history: ['History', 'Every transaction on your account.'],
    card: ['Card', 'Your virtual debit card.'],
    profile: ['Profile', 'Your details and security.'],
  };

  const SUBMIT_LABELS = { deposit: 'Add money', transfer: 'Send money', withdrawal: 'Withdraw' };

  // Customers see a plain processing state; the review itself happens behind the scenes.
  const STATUS = {
    pending: { label: 'Processing', icon: 'clock', badge: 'pending' },
    approved: { label: 'Completed', icon: 'check', badge: 'approved' },
    rejected: { label: 'Declined', icon: 'x', badge: 'rejected' },
  };

  const TYPE_ICON = { deposit: 'arrow-down', withdrawal: 'arrow-up', transfer: 'send', fee: 'card' };

  // ------------------------------------------------------------ helpers

  function title(tx) {
    if (tx.type === 'deposit') return 'Money added';
    if (tx.type === 'withdrawal') return 'Withdrawal';
    if (tx.type === 'fee') return 'Card fee';
    return tx.direction === 'in' ? 'Transfer received' : `Transfer to ${tx.recipientName}`;
  }

  function signed(tx) {
    return `${tx.direction === 'in' ? '+' : '-'}${money(tx.amountCents)}`;
  }

  function badge(tx) {
    const status = STATUS[tx.status];
    return `<span class="badge badge-${status.badge}">${icon(status.icon)} ${status.label}</span>`;
  }

  function bind(name, value) {
    for (const el of document.querySelectorAll(`[data-bind="${name}"]`)) el.textContent = value;
  }

  function empty(heading, text, iconName = 'list') {
    return `
      <div class="empty">
        <div class="feature-icon">${icon(iconName)}</div>
        <strong>${heading}</strong>
        ${text}
      </div>`;
  }

  // ------------------------------------------------------------ rendering

  function renderUser() {
    const first = user.fullName.split(/\s+/)[0];
    VIEWS.overview[1] = `Welcome back, ${first}.`;
    document.getElementById('user-name').textContent = user.fullName;
    document.getElementById('user-type').textContent = CTB.ACCOUNT_TYPES[user.accountType] || 'Account';
    document.getElementById('user-initials').textContent = user.fullName
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('');

    bind('balance', money(user.balanceCents));
    bind('available', money(user.availableCents));
    bind('accountNumber', account(user.accountNumber));
    bind('fullName', user.fullName);
    bind('accountType', CTB.ACCOUNT_TYPES[user.accountType] || 'Account');
    bind('country', CTB.countryName(user.country) || 'Not set');
    bind('memberSince', new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(user.createdAt)));

    showView(false);
  }

  // The Card page shows the issued card, or how to order one when there is none.
  function renderCard() {
    document.getElementById('card-none').hidden = Boolean(card);
    document.getElementById('card-issued').hidden = !card;

    if (!card) {
      document.getElementById('card-locked').innerHTML = CTB.atmCard({ holder: 'NO CARD YET', locked: true, back: false });
      document.getElementById('tiers').innerHTML = `
        <div class="card-price">
          <span>Card price</span>
          <s class="num notranslate">${esc(money(price.listPriceCents))}</s>
          <strong class="num notranslate">${esc(money(price.priceCents))}</strong>
        </div>
        <p class="field-label">Choose your design</p>
        ${Object.keys(tiers)
          .map(
            (tier) => `
              <div class="tier tier-${tier}">
                <span class="tier-swatch" aria-hidden="true"></span>
                <span class="tier-name">${tier[0].toUpperCase() + tier.slice(1)}</span>
              </div>`
          )
          .join('')}`;
      return;
    }

    const tierName = card.tier[0].toUpperCase() + card.tier.slice(1);
    document.getElementById('card-visual').innerHTML = CTB.atmCard({
      ...card,
      holder: user.fullName.toUpperCase(),
      masked: !digitsShown,
    });
    document.querySelector('#card-visual .atm').classList.toggle('is-flipped', flipped);
    document.getElementById('toggle-digits-label').textContent = digitsShown ? 'Hide card details' : 'Show card details';
    document.getElementById('toggle-digits').setAttribute('aria-pressed', String(digitsShown));
    document.getElementById('flip-card-label').textContent = flipped ? 'Show front of card' : 'Show back of card';
    document.getElementById('flip-card').setAttribute('aria-pressed', String(flipped));
    bind('cardTier', tierName);
    bind('cardIssued', date(card.issuedAt));
  }
  function renderMonth() {
    const now = new Date();
    let moneyIn = 0;
    let moneyOut = 0;
    for (const tx of transactions) {
      if (tx.status !== 'approved') continue;
      const when = new Date(tx.reviewedAt || tx.createdAt);
      if (when.getMonth() !== now.getMonth() || when.getFullYear() !== now.getFullYear()) continue;
      if (tx.direction === 'in') moneyIn += tx.amountCents;
      else moneyOut += tx.amountCents;
    }
    document.getElementById('month-in').textContent = money(moneyIn);
    document.getElementById('month-out').textContent = money(moneyOut);
    document.getElementById('month-label').textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(now);
  }

  // Grouped bars: money in and money out for each of the last six months.
  function renderChart() {
    const chart = document.getElementById('chart');
    const now = new Date();
    const months = [];
    for (let back = 5; back >= 0; back--) {
      const start = new Date(now.getFullYear(), now.getMonth() - back, 1);
      months.push({
        key: `${start.getFullYear()}-${start.getMonth()}`,
        short: new Intl.DateTimeFormat(undefined, { month: 'short' }).format(start),
        long: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(start),
        in: 0,
        out: 0,
      });
    }
    for (const tx of transactions) {
      if (tx.status !== 'approved') continue;
      const when = new Date(tx.reviewedAt || tx.createdAt);
      const month = months.find((item) => item.key === `${when.getFullYear()}-${when.getMonth()}`);
      if (month) month[tx.direction] += tx.amountCents;
    }

    document.getElementById('chart-table').innerHTML = `
      <table class="table">
        <thead><tr><th>Month</th><th class="col-end">Money in</th><th class="col-end">Money out</th></tr></thead>
        <tbody>
          ${months
            .map(
              (month) => `
                <tr>
                  <td data-label="Month"><span>${esc(month.long)}</span></td>
                  <td data-label="Money in" class="col-end"><span class="num notranslate">${esc(money(month.in))}</span></td>
                  <td data-label="Money out" class="col-end"><span class="num notranslate">${esc(money(month.out))}</span></td>
                </tr>`
            )
            .join('')}
        </tbody>
      </table>`;

    const highest = Math.max(...months.map((month) => Math.max(month.in, month.out)));
    if (!highest) {
      chart.innerHTML = '<p class="chart-empty">Your chart will appear after your first completed transaction.</p>';
      return;
    }

    // Round the axis up to a tidy number so the gridlines land on readable values.
    const rough = highest / 4;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough);
    const top = step * 4;

    // Draw at the panel's real width so labels stay a readable size on phones.
    const width = Math.max(280, Math.round(chart.clientWidth) || 640);
    const height = 260;
    const left = 52;
    const bottom = 30;
    const plotWidth = width - left - 8;
    const plotHeight = height - bottom - 12;
    const band = plotWidth / months.length;
    const barWidth = Math.min(24, band * 0.3);
    const y = (cents) => 12 + plotHeight - (cents / top) * plotHeight;
    const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

    // A bar with its top corners rounded and its base flat on the axis.
    const bar = (x, cents, className) => {
      if (!cents) return '';
      const yTop = y(cents);
      const radius = Math.min(4, 12 + plotHeight - yTop);
      return `<path class="${className}" d="M${x} ${12 + plotHeight}V${yTop + radius}q0 ${-radius} ${radius} ${-radius}h${barWidth - 2 * radius}q${radius} 0 ${radius} ${radius}V${12 + plotHeight}z"/>`;
    };

    const grid = [0, 1, 2, 3, 4]
      .map((tick) => {
        const cents = step * tick;
        return `
          <line class="grid" x1="${left}" x2="${width - 8}" y1="${y(cents)}" y2="${y(cents)}"/>
          <text class="tick" x="${left - 8}" y="${y(cents) + 4}" text-anchor="end">${esc(compact.format(cents / 100))}</text>`;
      })
      .join('');

    const groups = months
      .map((month, i) => {
        const centre = left + band * i + band / 2;
        return `
          ${bar(centre - barWidth - 1, month.in, 'bar-in')}
          ${bar(centre + 1, month.out, 'bar-out')}
          <text class="tick" x="${centre}" y="${height - 8}" text-anchor="middle">${esc(month.short)}</text>
          <rect class="hit" data-month="${i}" tabindex="0" role="img" x="${left + band * i}" y="12" width="${band}" height="${plotHeight}"
            aria-label="${esc(`${month.long}: money in ${money(month.in)}, money out ${money(month.out)}`)}"/>`;
      })
      .join('');

    // Bars grow in on the first draw only, not on every background refresh.
    chart.classList.toggle('is-fresh', !chartDrawn);
    chartDrawn = true;

    chart.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="chart-title">${grid}${groups}</svg>
      <div class="chart-tip" id="chart-tip" hidden></div>`;

    const tip = document.getElementById('chart-tip');
    const showTip = (hit) => {
      const month = months[Number(hit.dataset.month)];
      tip.innerHTML = `
        <strong>${esc(month.long)}</strong>
        <span><i class="swatch swatch-in"></i> Money in <b class="num notranslate">${esc(money(month.in))}</b></span>
        <span><i class="swatch swatch-out"></i> Money out <b class="num notranslate">${esc(money(month.out))}</b></span>`;
      tip.hidden = false;
      const box = hit.getBoundingClientRect();
      const frame = chart.getBoundingClientRect();
      const centre = box.left - frame.left + box.width / 2;
      tip.style.left = `${Math.min(Math.max(centre, 90), frame.width - 90)}px`;
    };
    for (const hit of chart.querySelectorAll('.hit')) {
      hit.addEventListener('pointerenter', () => showTip(hit));
      hit.addEventListener('focus', () => showTip(hit));
      hit.addEventListener('pointerleave', () => (tip.hidden = true));
      hit.addEventListener('blur', () => (tip.hidden = true));
    }
  }

  function row(tx) {
    return `
      <button class="tx-row" type="button" data-tx="${tx.id}">
        <span class="tx-icon ${tx.direction === 'in' ? 'is-in' : ''}">${icon(tx.direction === 'in' ? 'arrow-down' : TYPE_ICON[tx.type])}</span>
        <span class="tx-main">
          <strong>${esc(title(tx))}</strong>
          <small>${esc(date(tx.createdAt))}<span class="tx-status is-${tx.status}">${STATUS[tx.status].label}</span></small>
        </span>
        ${badge(tx)}
        <span class="tx-amount num notranslate amount-${tx.direction}">${esc(signed(tx))}</span>
      </button>`;
  }

  function renderRecent() {
    document.getElementById('recent').innerHTML = transactions.length
      ? `<div class="tx-list">${transactions.slice(0, 5).map(row).join('')}</div>`
      : empty('No activity yet', 'Add money to get started. Your transactions will appear here.');
  }

  function renderHistory() {
    const needle = query.trim().toLowerCase();
    const rows = transactions.filter((tx) => {
      if (filter !== 'all' && tx.direction !== filter) return false;
      if (!needle) return true;
      return [title(tx), tx.reference, tx.description, tx.recipientName, tx.recipientAccount]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle));
    });
    document.getElementById('history').innerHTML = rows.length
      ? `<div class="tx-list">${rows.map(row).join('')}</div>`
      : transactions.length
        ? empty('No matches', 'Try a different search or filter.', 'search')
        : empty('No transactions yet', 'Your transactions will appear here.');
  }

  function renderBeneficiaries() {
    const list = document.getElementById('beneficiaries');
    list.innerHTML = beneficiaries.length
      ? `<div class="tx-list">${beneficiaries
          .map(
            (person) => `
              <div class="tx-row is-static">
                <span class="tx-icon">${icon('user')}</span>
                <span class="tx-main notranslate">
                  <strong>${esc(person.name)}</strong>
                  <small class="num">${esc(account(person.accountNumber))}</small>
                </span>
                <button class="btn btn-secondary btn-sm" type="button" data-pay="${person.id}">Send</button>
                <button class="btn btn-ghost btn-sm" type="button" data-remove="${person.id}" aria-label="Remove ${esc(person.name)}">${icon('trash')}</button>
              </div>`
          )
          .join('')}</div>`
      : empty('No saved recipients', 'Tick "Save this recipient" when you send money and they will appear here.', 'users');

    const select = document.getElementById('saved');
    savedField.hidden = !beneficiaries.length;
    select.innerHTML =
      '<option value="">Someone new</option>' +
      beneficiaries.map((person) => `<option value="${person.id}">${esc(person.name)} · ${esc(account(person.accountNumber))}</option>`).join('');
  }

  function fillProfile() {
    profileForm.elements.fullName.value = user.fullName;
    profileForm.elements.email.value = user.email;
    profileForm.elements.phone.value = user.phone || '';
    profileForm.elements.country.innerHTML = CTB.countryOptions(user.country || '');
  }

  function openReceipt(tx) {
    openReference = tx.reference;
    document.getElementById('receipt-icon').innerHTML = icon(tx.direction === 'in' ? 'arrow-down' : TYPE_ICON[tx.type]);
    document.getElementById('receipt-title').textContent = title(tx);
    document.getElementById('receipt-amount').textContent = signed(tx);
    document.getElementById('receipt-status').innerHTML = badge(tx);

    const lines = [
      ['Reference', tx.reference, true],
      ['Date', date(tx.createdAt)],
    ];
    if (tx.type === 'transfer' && tx.direction === 'out') {
      lines.push(['Recipient', tx.recipientName, true], ['Recipient account', tx.recipientAccount, true]);
    }
    if (tx.description) lines.push(['Your reference', tx.description, true]);
    if (tx.status === 'rejected' && tx.adminNote) lines.push(['Reason', tx.adminNote]);
    document.getElementById('receipt-details').innerHTML = lines
      .map(([label, value, literal]) => `<div><dt>${label}</dt><dd${literal ? ' class="notranslate"' : ''}>${esc(value)}</dd></div>`)
      .join('');
    receipt.showModal();
  }

  // ------------------------------------------------------------ navigation

  function showView(moveFocus = true) {
    const name = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
    for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== name;
    for (const link of document.querySelectorAll('[data-nav]')) {
      if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.getElementById('view-title').textContent = VIEWS[name][0];
    document.getElementById('view-sub').textContent = VIEWS[name][1];
    document.title = `${VIEWS[name][0]} - Capital Trust Bank`;
    if (moveFocus) window.scrollTo({ top: 0 });
  }

  function setType(type) {
    txForm.elements.type.value = type;
    transferFields.hidden = type !== 'transfer';
    txSubmit.textContent = SUBMIT_LABELS[type];
  }

  function useBeneficiary(id) {
    const person = beneficiaries.find((item) => item.id === Number(id));
    txForm.elements.recipientAccount.value = person ? person.accountNumber : '';
    txForm.elements.recipientName.value = person ? person.name : '';
    txForm.elements.saved.value = person ? String(person.id) : '';
  }

  // ------------------------------------------------------------ data

  async function load() {
    try {
      const [me, list, saved, cards] = await Promise.all([
        api('/api/me'),
        api('/api/transactions'),
        api('/api/beneficiaries'),
        api('/api/card'),
      ]);
      const firstLoad = !user;
      user = me.user;
      transactions = list.transactions;
      beneficiaries = saved.beneficiaries;
      card = cards.card;
      tiers = cards.tiers;
      price = cards.price;
      renderUser();
      if (firstLoad) {
        // Balances count up once, when the dashboard first opens.
        for (const el of document.querySelectorAll('[data-bind="balance"]')) CTB.countUp(el, user.balanceCents, money);
        for (const el of document.querySelectorAll('[data-bind="available"]')) CTB.countUp(el, user.availableCents, money);
      }
      renderCard();
      renderMonth();
      renderChart();
      renderRecent();
      renderHistory();
      // Leave the recipient picker and profile form alone while someone is using them.
      if (firstLoad) {
        renderBeneficiaries();
        fillProfile();
      }
    } catch (error) {
      if (user) return; // keep showing the last good data during a background refresh
      document.getElementById('recent').innerHTML = `
        <div class="empty">
          <strong>Could not load your account</strong>
          ${esc(error.message)}
          <p style="margin-top: 16px"><button class="btn btn-secondary" type="button" id="retry">Try again</button></p>
        </div>`;
      document.getElementById('retry').addEventListener('click', load);
    }
  }

  // ------------------------------------------------------------ events

  window.addEventListener('hashchange', () => {
    showView();
    if (user) renderChart(); // the chart cannot measure itself while its view is hidden
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => user && renderChart(), 150);
  });

  for (const quick of document.querySelectorAll('[data-quick]')) {
    quick.addEventListener('click', () => setType(quick.dataset.quick));
  }

  txForm.addEventListener('change', (event) => {
    if (event.target.name === 'type') setType(event.target.value);
    if (event.target.name === 'saved') useBeneficiary(event.target.value);
  });

  txForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    CTB.clearErrors(txForm);

    const values = Object.fromEntries(new FormData(txForm));
    const amount = Number(String(values.amount).replace(/[,\s$]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      return CTB.showError(txForm, 'Enter an amount greater than zero, for example 250.00.', 'amount');
    }
    if (values.type !== 'deposit' && user && Math.round(amount * 100) > user.availableCents) {
      return CTB.showError(txForm, `You have ${money(user.availableCents)} available. Enter a smaller amount.`, 'amount');
    }
    if (values.type === 'transfer') {
      if (!/^[A-Za-z0-9\s]{6,40}$/.test(values.recipientAccount.trim())) {
        return CTB.showError(txForm, 'Enter the recipient account number.', 'recipientAccount');
      }
      if (values.recipientName.trim().length < 2) {
        return CTB.showError(txForm, 'Enter the recipient name.', 'recipientName');
      }
    }

    CTB.setLoading(txSubmit, true);
    try {
      const { transaction } = await api('/api/transactions', {
        method: 'POST',
        body: { ...values, amount, saveRecipient: Boolean(values.saveRecipient) },
      });
      txForm.reset();
      setType('deposit');
      await load();
      beneficiaries = (await api('/api/beneficiaries')).beneficiaries;
      renderBeneficiaries();
      openReceipt({ ...transaction });
    } catch (error) {
      CTB.showError(txForm, error.message, error.field);
    } finally {
      CTB.setLoading(txSubmit, false);
    }
  });

  document.getElementById('beneficiaries').addEventListener('click', async (event) => {
    const pay = event.target.closest('[data-pay]');
    if (pay) {
      setType('transfer');
      useBeneficiary(pay.dataset.pay);
      txForm.elements.amount.focus();
      return;
    }
    const remove = event.target.closest('[data-remove]');
    if (!remove) return;
    try {
      await api(`/api/beneficiaries/${remove.dataset.remove}`, { method: 'DELETE' });
      beneficiaries = beneficiaries.filter((person) => person.id !== Number(remove.dataset.remove));
      renderBeneficiaries();
      toast('Recipient removed.');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  // Rows in both lists open the receipt.
  document.querySelector('.shell-content').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tx]');
    if (!button) return;
    const tx = transactions.find((item) => item.id === Number(button.dataset.tx));
    if (tx) openReceipt(tx);
  });

  document.getElementById('receipt-close').addEventListener('click', () => receipt.close());
  document.getElementById('receipt-copy').addEventListener('click', () => copy(openReference, 'Reference copied.'));

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      filter = tab.dataset.filter;
      for (const other of document.querySelectorAll('.tab')) other.setAttribute('aria-selected', String(other === tab));
      renderHistory();
    });
  }

  document.getElementById('search').addEventListener('input', (event) => {
    query = event.target.value;
    renderHistory();
  });

  async function copy(value, message) {
    try {
      await navigator.clipboard.writeText(value);
      toast(message);
    } catch {
      toast('Could not copy. Select the text and copy it manually.', 'error');
    }
  }

  for (const button of document.querySelectorAll('[data-copy-account]')) {
    button.addEventListener('click', () => user && copy(user.accountNumber, 'Account number copied.'));
  }

  document.getElementById('toggle-digits').addEventListener('click', () => {
    digitsShown = !digitsShown;
    renderCard();
  });

  // The card leans toward the pointer. Delegated because the card is redrawn on refresh.
  for (const id of ['card-visual', 'card-locked']) {
    const holder = document.getElementById(id);
    holder.addEventListener('pointermove', (event) => {
      const cardEl = holder.querySelector('.atm');
      if (!cardEl || CTB.reducedMotion || event.pointerType === 'touch') return;
      const box = cardEl.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      cardEl.style.setProperty('--tilt-x', `${(-y * 12).toFixed(2)}deg`);
      cardEl.style.setProperty('--tilt-y', `${(x * 14).toFixed(2)}deg`);
    });
    holder.addEventListener('pointerleave', () => {
      const cardEl = holder.querySelector('.atm');
      if (!cardEl) return;
      cardEl.style.removeProperty('--tilt-x');
      cardEl.style.removeProperty('--tilt-y');
    });
  }

  // Flip without redrawing so the turn animates.
  document.getElementById('flip-card').addEventListener('click', () => {
    flipped = !flipped;
    document.querySelector('#card-visual .atm').classList.toggle('is-flipped', flipped);
    document.getElementById('flip-card-label').textContent = flipped ? 'Show front of card' : 'Show back of card';
    document.getElementById('flip-card').setAttribute('aria-pressed', String(flipped));
  });

  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    CTB.clearErrors(profileForm);
    const button = profileForm.querySelector('[type="submit"]');
    CTB.setLoading(button, true);
    try {
      const values = Object.fromEntries(new FormData(profileForm));
      user = (await api('/api/me', { method: 'PATCH', body: values })).user;
      renderUser();
      toast('Your details have been saved.');
    } catch (error) {
      CTB.showError(profileForm, error.message, error.field);
    } finally {
      CTB.setLoading(button, false);
    }
  });

  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    CTB.clearErrors(passwordForm);
    const values = Object.fromEntries(new FormData(passwordForm));
    if (!values.currentPassword) return CTB.showError(passwordForm, 'Enter your current password.', 'currentPassword');
    if (values.newPassword.length < 8) return CTB.showError(passwordForm, 'Password must be at least 8 characters.', 'newPassword');
    if (values.newPassword !== values.confirmPassword) {
      return CTB.showError(passwordForm, 'The two passwords do not match.', 'confirmPassword');
    }
    const button = passwordForm.querySelector('[type="submit"]');
    CTB.setLoading(button, true);
    try {
      await api('/api/me/password', { method: 'POST', body: values });
      passwordForm.reset();
      toast('Your password has been updated.');
    } catch (error) {
      CTB.showError(passwordForm, error.message, error.field);
    } finally {
      CTB.setLoading(button, false);
    }
  });

  // Pick up balance and status changes without a manual refresh.
  setInterval(() => {
    if (!document.hidden && !receipt.open) load();
  }, 20000);

  showView(false);
  load();
})();
