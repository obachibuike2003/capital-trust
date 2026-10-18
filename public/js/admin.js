// Admin console: approve transactions, manage customers and cards, answer support chats.

(() => {
  const { api, money, date, account, esc, icon, toast } = CTB;

  const view = document.getElementById('view');
  const reviewDialog = document.getElementById('review-dialog');
  const reviewForm = document.getElementById('review-form');
  const reviewConfirm = document.getElementById('review-confirm');
  const cardDialog = document.getElementById('card-dialog');
  const cardForm = document.getElementById('card-form');
  const cardConfirm = document.getElementById('card-confirm');
  const fundDialog = document.getElementById('fund-dialog');
  const fundForm = document.getElementById('fund-form');
  const fundConfirm = document.getElementById('fund-confirm');

  let current = 'pending';
  let transactions = [];
  let customers = [];
  let tiers = {};
  let threads = [];
  let thread = null; // open conversation: { kind, id, customer | visitor, messages }
  let reviewing = null; // { tx, action }
  let issuingTo = null; // customer receiving a card
  let funding = null; // customer being funded

  const TYPE_LABELS = { deposit: 'Deposit', withdrawal: 'Withdrawal', transfer: 'Transfer', fee: 'Card fee' };
  const STATUS = {
    pending: { label: 'Pending', icon: 'clock' },
    approved: { label: 'Approved', icon: 'check' },
    rejected: { label: 'Rejected', icon: 'x' },
  };
  const tierName = (tier) => tier[0].toUpperCase() + tier.slice(1);
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  function empty(title, text, iconName = 'list') {
    return `
      <div class="empty">
        <div class="feature-icon">${icon(iconName)}</div>
        <strong>${title}</strong>
        ${text}
      </div>`;
  }

  // ------------------------------------------------------------ transactions

  function details(tx) {
    const lines = [esc(TYPE_LABELS[tx.type] || tx.type)];
    // Withdrawals (and any older transfers) send money to a recipient account.
    if (tx.recipientName) {
      lines.push(`<span class="sub">To ${esc(tx.recipientName)} &middot; <span class="notranslate">${esc(tx.recipientAccount)}</span></span>`);
    }
    if (tx.type === 'withdrawal') {
      lines.push(`<span class="sub">2% exchange fee ${esc(money(tx.exchangeFeeCents))}</span>`);
    }
    if (tx.description) lines.push(`<span class="sub">${esc(tx.description)}</span>`);
    if (tx.adminNote) lines.push(`<span class="sub">Note: ${esc(tx.adminNote)}</span>`);
    return lines.join('');
  }

  function renderTransactions() {
    if (!transactions.length) {
      view.innerHTML =
        current === 'pending'
          ? empty('All caught up', 'There are no requests waiting for review.', 'check')
          : empty('No transactions yet', 'Customer requests will appear here.');
      return;
    }

    view.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Date</th><th>Customer</th><th>Details</th><th class="col-end">Amount</th>
            <th>${current === 'pending' ? '<span class="sr-only">Actions</span>' : 'Status'}</th>
          </tr>
        </thead>
        <tbody>
          ${transactions
            .map(
              (tx) => `
                <tr>
                  <td data-label="Date">
                    <span>${esc(date(tx.createdAt))}<span class="sub notranslate">${esc(tx.reference)}</span></span>
                  </td>
                  <td data-label="Customer">
                    <span class="notranslate">
                      ${esc(tx.customerName)}
                      <span class="sub">${esc(account(tx.customerAccount))}</span>
                      <span class="sub">Balance ${esc(money(tx.customerBalanceCents))}</span>
                    </span>
                  </td>
                  <td data-label="Details"><span>${details(tx)}</span></td>
                  <td data-label="Amount" class="col-end">
                    <span class="num notranslate amount-out">${esc(money(tx.amountCents))}</span>
                  </td>
                  <td data-label="${tx.status === 'pending' ? 'Decision' : 'Status'}">
                    ${
                      tx.status === 'pending'
                        ? `<span class="actions">
                             <button class="btn btn-primary btn-sm" type="button" data-action="approve" data-id="${tx.id}">Approve</button>
                             <button class="btn btn-danger btn-sm" type="button" data-action="reject" data-id="${tx.id}">Reject</button>
                           </span>`
                        : `<span class="badge badge-${tx.status}">${icon(STATUS[tx.status].icon)} ${STATUS[tx.status].label}</span>`
                    }
                    ${tx.status === 'pending' && tx.type === 'withdrawal' ? `
                      <form class="tx-progress-form" data-progress-form data-id="${tx.id}">
                        <label for="progress-${tx.id}">Progress (%)</label>
                        <span class="tx-progress-controls">
                          <input id="progress-${tx.id}" name="progressPercent" type="number" min="0" max="99" step="1" value="${Math.max(0, Math.min(99, tx.progressPercent || 0))}" required />
                          <button class="btn btn-secondary btn-sm" type="submit">Save</button>
                        </span>
                        <span class="sub">Approval completes it at 100%.</span>
                      </form>` : ''}
                  </td>
                </tr>`
            )
            .join('')}
        </tbody>
      </table>`;
  }

  // ------------------------------------------------------------ customers and cards

  function cardCell(customer) {
    if (!customer.card) {
      return `<span class="actions"><button class="btn btn-primary btn-sm" type="button" data-issue="${customer.id}">Issue card</button></span>`;
    }
    return `
      <span>
        <span class="badge badge-approved">${icon('card')} ${tierName(customer.card.tier)}</span>
        <span class="sub num notranslate">&bull;&bull;&bull;&bull; ${esc(customer.card.number.slice(-4))} &middot; ${esc(customer.card.expiry)}</span>
        <button class="link-btn" type="button" data-revoke="${customer.id}">Remove card</button>
      </span>`;
  }

  function renderCustomers() {
    if (!customers.length) {
      view.innerHTML = empty('No customers yet', 'New registrations will appear here.', 'users');
      return;
    }
    view.innerHTML = `
      <table class="table">
        <thead>
          <tr><th>Customer</th><th>Account</th><th>Contact</th><th class="col-end">Balance</th><th>Card</th><th><span class="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          ${customers
            .map(
              (customer) => `
                <tr>
                  <td data-label="Customer">
                    <span class="notranslate">${esc(customer.fullName)}<span class="sub">${esc(customer.email)}</span></span>
                  </td>
                  <td data-label="Account">
                    <span>
                      <span class="num notranslate">${esc(account(customer.accountNumber))}</span>
                      <span class="sub">${esc(CTB.ACCOUNT_TYPES[customer.accountType] || '')}</span>
                    </span>
                  </td>
                  <td data-label="Contact">
                    <span>
                      <span class="notranslate">${esc(customer.phone || 'No phone')}</span>
                      <span class="sub">${esc(CTB.countryName(customer.country) || 'No country')}</span>
                    </span>
                  </td>
                  <td data-label="Balance" class="col-end">
                    <span class="num notranslate amount-out">${esc(money(customer.balanceCents))}</span>
                  </td>
                  <td data-label="Card">${cardCell(customer)}</td>
                  <td data-label="Actions">
                    <span class="actions">
                      <button class="btn btn-primary btn-sm" type="button" data-fund="${customer.id}">${icon('arrow-down')} Fund</button>
                      <button class="btn btn-secondary btn-sm" type="button" data-chat="customer:${customer.id}">${icon('chat')} Message</button>
                    </span>
                  </td>
                </tr>`
            )
            .join('')}
        </tbody>
      </table>`;
  }

  // ------------------------------------------------------------ support

  function renderSupport() {
    const list = threads.length
      ? threads
          .map(
            (item) => `
              <button class="thread ${thread && thread.kind === item.kind && thread.id === item.id ? 'is-open' : ''}" type="button" data-chat="${item.kind}:${item.id}">
                <span class="avatar notranslate" aria-hidden="true">${esc(item.fullName[0].toUpperCase())}</span>
                <span class="thread-main">
                  <strong class="notranslate">${esc(item.fullName)}${item.kind === 'visitor' ? ' <span class="tag">Visitor</span>' : ''}</strong>
                  <small class="notranslate">${esc(item.lastBody)}</small>
                </span>
                ${item.unread ? `<span class="count num notranslate">${item.unread}</span>` : ''}
              </button>`
          )
          .join('')
      : '<p class="muted" style="padding: 16px">No conversations yet.</p>';

    const conversation = thread
      ? `
        <header class="convo-head">
          ${
            thread.kind === 'visitor'
              ? `<div class="notranslate">
                   <strong>${esc(thread.visitor.fullName)}</strong>
                   <small>${esc(thread.visitor.email || 'No email given')} &middot; Started ${esc(date(thread.visitor.createdAt))}</small>
                 </div>
                 <span class="badge badge-pending">${icon('globe')} Website visitor</span>`
              : `<div class="notranslate">
                   <strong>${esc(thread.customer.fullName)}</strong>
                   <small>${esc(account(thread.customer.accountNumber))} &middot; Available ${esc(money(thread.customer.availableCents))}</small>
                 </div>
                 <span class="actions">
                   <button class="btn btn-secondary btn-sm" type="button" data-fund="${thread.customer.id}">${icon('arrow-down')} Fund</button>
                   ${
                     thread.customer.card
                       ? `<span class="badge badge-approved">${icon('card')} ${tierName(thread.customer.card.tier)} card</span>`
                       : `<button class="btn btn-primary btn-sm" type="button" data-issue="${thread.customer.id}">${icon('card')} Issue card</button>`
                   }
                 </span>`
          }
        </header>
        <div class="chat-log" id="convo-log">
          ${
            thread.messages.length
              ? thread.messages
                  .map(
                    (message) => `
                      <div class="bubble ${message.sender === 'admin' ? 'is-mine' : ''}">
                        <p class="notranslate">${esc(message.body)}</p>
                        <small>${message.sender === 'admin' ? 'You' : thread.kind === 'visitor' ? 'Visitor' : 'Customer'} &middot; ${esc(timeFormat.format(new Date(message.createdAt)))}</small>
                      </div>`
                  )
                  .join('')
              : '<p class="chat-empty">No messages yet. Say hello.</p>'
          }
        </div>
        <form class="chat-form" id="reply-form">
          <label class="sr-only" for="reply">Reply</label>
          <textarea id="reply" name="body" rows="1" maxlength="1000" placeholder="Type your reply"></textarea>
          <button class="btn btn-primary" type="submit" aria-label="Send reply">${icon('send')}</button>
        </form>`
      : empty('Choose a conversation', 'Pick a customer on the left to read and reply.', 'chat');

    // Keep what the admin is typing when the view refreshes.
    const draft = document.getElementById('reply');
    const text = draft ? draft.value : '';
    const typing = draft && document.activeElement === draft;

    view.innerHTML = `<div class="inbox"><div class="threads">${list}</div><div class="convo">${conversation}</div></div>`;

    const log = document.getElementById('convo-log');
    if (log) log.scrollTop = log.scrollHeight;
    const reply = document.getElementById('reply');
    if (reply) {
      reply.value = text;
      if (typing) reply.focus();
    }
  }

  async function openThread(kind, id, body) {
    const path = kind === 'visitor' ? `/api/admin/visitor-support/${id}` : `/api/admin/support/${id}`;
    thread = { ...(await api(path, body ? { method: 'POST', body: { body } } : undefined)), kind, id };
    threads = (await api('/api/admin/support')).threads;
    renderSupport();
  }

  // ------------------------------------------------------------ loading

  async function loadStats() {
    const stats = await api('/api/admin/stats');
    for (const key of ['pending', 'approved', 'rejected', 'customers']) {
      document.getElementById(`stat-${key}`).textContent = stats[key];
    }
    for (const [id, value] of [['tab-pending-count', stats.pending], ['tab-support-count', stats.unreadSupport]]) {
      const count = document.getElementById(id);
      count.textContent = value;
      count.hidden = !value;
    }
  }

  async function load() {
    try {
      if (current === 'customers') {
        const data = await api('/api/admin/users');
        customers = data.users;
        tiers = data.tiers;
        renderCustomers();
      } else if (current === 'support') {
        if (thread) await openThread(thread.kind, thread.id);
        else {
          threads = (await api('/api/admin/support')).threads;
          renderSupport();
        }
      } else {
        const query = current === 'pending' ? '?status=pending' : '';
        transactions = (await api(`/api/admin/transactions${query}`)).transactions;
        renderTransactions();
      }
      await loadStats();
    } catch (error) {
      view.innerHTML = `
        <div class="empty">
          <strong>Could not load this view</strong>
          ${esc(error.message)}
          <p style="margin-top: 16px"><button class="btn btn-secondary" type="button" id="retry">Try again</button></p>
        </div>`;
      document.getElementById('retry').addEventListener('click', load);
    }
  }

  function switchTo(name) {
    current = name;
    for (const tab of document.querySelectorAll('.tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.view === name));
    }
    return load();
  }

  // ------------------------------------------------------------ dialogs

  function openReview(tx, action) {
    reviewing = { tx, action };
    const approve = action === 'approve';
    CTB.clearErrors(reviewForm);
    reviewForm.reset();

    document.getElementById('review-title').textContent = approve ? 'Approve transaction' : 'Reject transaction';
    document.getElementById('review-lead').textContent = approve
      ? "The customer's balance will be updated straight away."
      : "The customer's balance will not change.";
    document.getElementById('note-label').textContent = approve
      ? 'Note to customer (optional)'
      : 'Reason for rejection (shown to the customer)';
    document.getElementById('review-summary').innerHTML = `
      <strong>${esc(TYPE_LABELS[tx.type])} &middot; <span class="num notranslate">${esc(money(tx.amountCents))}</span></strong><br />
      <span class="notranslate">${esc(tx.customerName)} &middot; ${esc(account(tx.customerAccount))}</span>`;

    reviewConfirm.textContent = approve ? 'Approve' : 'Reject';
    reviewConfirm.className = approve ? 'btn btn-primary' : 'btn btn-danger';
    reviewDialog.showModal();
  }

  async function openIssue(userId) {
    if (!Object.keys(tiers).length) tiers = (await api('/api/admin/users')).tiers;
    issuingTo =
      customers.find((customer) => customer.id === userId) ||
      (thread && thread.customer && thread.customer.id === userId ? thread.customer : null);
    if (!issuingTo) return;
    CTB.clearErrors(cardForm);
    cardForm.elements.tier.innerHTML = Object.entries(tiers)
      .map(([tier, feeCents]) => `<option value="${tier}">${tierName(tier)} design</option>`)
      .join('');
    cardForm.elements.fee.value = (Object.values(tiers)[0] / 100).toFixed(2);
    document.getElementById('card-summary').innerHTML = `
      <strong class="notranslate">${esc(issuingTo.fullName)}</strong><br />
      <span class="notranslate">${esc(account(issuingTo.accountNumber))} &middot; Available ${esc(money(issuingTo.availableCents))}</span>`;
    cardDialog.showModal();
  }

  function openFund(userId) {
    funding =
      customers.find((customer) => customer.id === userId) ||
      (thread && thread.customer && thread.customer.id === userId ? thread.customer : null);
    if (!funding) return;
    CTB.clearErrors(fundForm);
    fundForm.reset();
    document.getElementById('fund-summary').innerHTML = `
      <strong class="notranslate">${esc(funding.fullName)}</strong><br />
      <span class="notranslate">${esc(account(funding.accountNumber))} &middot; Balance ${esc(money(funding.balanceCents))}</span>`;
    fundDialog.showModal();
  }

  fundForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!funding) return;
    CTB.clearErrors(fundForm);
    const amount = Number(String(fundForm.elements.amount.value).replace(/[,\s$]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) return CTB.showError(fundForm, 'Enter an amount greater than zero.', 'amount');
    CTB.setLoading(fundConfirm, true);
    try {
      await api(`/api/admin/users/${funding.id}/fund`, { method: 'POST', body: { amount, note: fundForm.elements.note.value } });
      fundDialog.close();
      toast(`Added ${money(Math.round(amount * 100))} to ${funding.fullName}.`);
      await load();
    } catch (error) {
      CTB.showError(fundForm, error.message, error.field);
    } finally {
      CTB.setLoading(fundConfirm, false);
    }
  });

  document.getElementById('fund-cancel').addEventListener('click', () => fundDialog.close());

  cardForm.elements.tier.addEventListener('change', (event) => {
    cardForm.elements.fee.value = (tiers[event.target.value] / 100).toFixed(2);
  });

  cardForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!issuingTo) return;
    CTB.clearErrors(cardForm);
    const fee = Number(String(cardForm.elements.fee.value).replace(/[,\s$]/g, ''));
    if (!Number.isFinite(fee) || fee < 0) return CTB.showError(cardForm, 'Enter a fee of zero or more.', 'fee');
    CTB.setLoading(cardConfirm, true);
    try {
      await api(`/api/admin/users/${issuingTo.id}/card`, { method: 'POST', body: { tier: cardForm.elements.tier.value, fee } });
      cardDialog.close();
      toast(`Card issued to ${issuingTo.fullName}.`);
      await load();
    } catch (error) {
      CTB.showError(cardForm, error.message, error.field);
    } finally {
      CTB.setLoading(cardConfirm, false);
    }
  });

  reviewForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!reviewing) return;
    CTB.clearErrors(reviewForm);
    CTB.setLoading(reviewConfirm, true);
    try {
      const { tx, action } = reviewing;
      await api(`/api/admin/transactions/${tx.id}/${action}`, {
        method: 'POST',
        body: { note: reviewForm.elements.note.value },
      });
      reviewDialog.close();
      toast(action === 'approve' ? 'Transaction approved.' : 'Transaction rejected.');
      await load();
    } catch (error) {
      CTB.showError(reviewForm, error.message);
    } finally {
      CTB.setLoading(reviewConfirm, false);
    }
  });

  document.getElementById('review-cancel').addEventListener('click', () => reviewDialog.close());
  document.getElementById('card-cancel').addEventListener('click', () => cardDialog.close());

  // ------------------------------------------------------------ events

  view.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action], [data-issue], [data-fund], [data-revoke], [data-chat]');
    if (!target) return;
    try {
      if (target.dataset.action) {
        const tx = transactions.find((item) => item.id === Number(target.dataset.id));
        if (tx) openReview(tx, target.dataset.action);
      } else if (target.dataset.fund) {
        openFund(Number(target.dataset.fund));
      } else if (target.dataset.issue) {
        await openIssue(Number(target.dataset.issue));
      } else if (target.dataset.revoke) {
        // Two-step confirm: the first click arms the button, the second removes the card.
        if (target.dataset.armed) {
          await api(`/api/admin/users/${target.dataset.revoke}/card`, { method: 'DELETE' });
          toast('Card removed.');
          await load();
        } else {
          target.dataset.armed = 'true';
          target.textContent = 'Click again to remove';
        }
      } else if (target.dataset.chat) {
        if (current !== 'support') {
          current = 'support';
          for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === 'support'));
        }
        const [kind, id] = target.dataset.chat.split(':');
        await openThread(kind, Number(id));
        await loadStats();
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  view.addEventListener('submit', async (event) => {
    if (event.target.matches('[data-progress-form]')) {
      event.preventDefault();
      const form = event.target;
      const progressPercent = form.elements.progressPercent.valueAsNumber;
      if (!Number.isInteger(progressPercent) || progressPercent < 0 || progressPercent > 99) {
        return toast('Progress must be a whole number from 0 to 99.', 'error');
      }
      try {
        await api(`/api/admin/transactions/${form.dataset.id}/progress`, {
          method: 'PATCH',
          body: { progressPercent },
        });
        toast('Withdrawal progress updated.');
        await load();
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    if (event.target.id !== 'reply-form') return;
    event.preventDefault();
    const reply = document.getElementById('reply');
    const body = reply.value.trim();
    if (!body || !thread) return reply.focus();
    try {
      reply.value = '';
      await openThread(thread.kind, thread.id, body);
      document.getElementById('reply').focus();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  view.addEventListener('keydown', (event) => {
    if (event.target.id === 'reply' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.target.form.requestSubmit();
    }
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchTo(tab.dataset.view));
  }

  document.getElementById('refresh').addEventListener('click', load);

  // Keep queues fresh; the support view refreshes faster so replies feel live.
  setInterval(() => {
    if (document.hidden || reviewDialog.open || cardDialog.open || fundDialog.open) return;
    if (current === 'support') load();
  }, 5000);
  setInterval(() => {
    if (document.hidden || reviewDialog.open || cardDialog.open || fundDialog.open) return;
    if (current !== 'support') load();
  }, 20000);

  load();
})();
