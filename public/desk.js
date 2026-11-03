import { api, money, esc, when, toast, modebar, config, STATUS } from '/common.js';

modebar();
const cfg = await config();

// ---------------- tabs ----------------
function showTab() {
  const tab = (location.hash || '#requests').slice(1).split('/')[0];
  for (const a of document.querySelectorAll('[data-tab]')) a.setAttribute('aria-selected', String(a.dataset.tab === tab));
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== tab;
  if (tab === 'policy') loadPolicy();
  if (tab === 'sales') loadSales();
}
window.addEventListener('hashchange', showTab);

// ---------------- requests ----------------
let cases = [];
let selectedId = null;
let selectedStamp = null;
let replyDirty = false;

const REASON = {
  duplicate_purchase: 'Duplicate purchase',
  changed_mind: 'Changed mind',
  bought_by_mistake: 'Bought by mistake',
  technical_issue: 'Does not work',
  not_as_described: 'Not as described',
  unauthorized: 'Says they did not buy it',
  other: 'Other',
};
const ICON = { pass: 'ph-check-circle', warn: 'ph-warning', fail: 'ph-x-circle', unknown: 'ph-question', info: 'ph-info' };
const ROUTE = {
  auto: 'Refunded without a click: under the limit and every check passed.',
  approval: 'Waiting for your OK.',
  human: 'Handed to you: the desk will not decide this one.',
};

function pill(status) {
  const s = STATUS[status] || { label: status, cls: '' };
  return `<span class="pill ${s.cls}">${esc(s.label)}</span>`;
}

async function loadCases() {
  try {
    cases = await api('GET', '/api/desk/cases');
  } catch (err) {
    return;
  }
  const open = cases.filter((c) => ['awaiting_approval', 'needs_human'].includes(c.status)).length;
  document.getElementById('openCount').textContent = open ? String(open) : '';
  const list = document.getElementById('caseList');
  if (!cases.length) {
    list.innerHTML = `<div class="empty"><i class="ph ph-tray" aria-hidden="true"></i>No requests yet. Buy something in the <a href="/store">demo store</a>, then ask for a refund from the receipt.</div>`;
  } else {
    list.innerHTML = cases
      .map(
        (c) => `<button data-id="${esc(c.id)}" aria-current="${c.id === selectedId}">
          <div class="line1"><strong>${esc(c.productName)}</strong>${pill(c.status)}</div>
          <div class="sum">${esc(c.summary)}</div>
          <div class="meta">${esc(c.email)} &nbsp; ${when(c.createdAt)}${c.amountCents ? ` &nbsp; <span class="amount">${money(c.amountCents)}</span>` : ''}</div>
        </button>`,
      )
      .join('');
  }
  const wanted = location.hash.startsWith('#requests/') ? location.hash.split('/')[1] : null;
  if (!selectedId && (wanted || cases[0])) selectCase(wanted || cases[0].id);
  else if (selectedId) refreshSelected();
}

document.getElementById('caseList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (b) selectCase(b.dataset.id);
});

async function selectCase(id) {
  selectedId = id;
  selectedStamp = null;
  replyDirty = false;
  for (const b of document.querySelectorAll('.caselist button')) b.setAttribute('aria-current', String(b.dataset.id === id));
  history.replaceState(null, '', `#requests/${id}`);
  document.getElementById('caseDetail').innerHTML = `<section><div class="stack"><div class="skeleton" style="width:40%;height:22px"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:65%"></div></div></section>`;
  await refreshSelected(true);
}

async function refreshSelected(force = false) {
  if (!selectedId) return;
  let c;
  try {
    c = await api('GET', `/api/desk/cases/${encodeURIComponent(selectedId)}`);
  } catch (err) {
    document.getElementById('caseDetail').innerHTML = `<section class="empty">${esc(err.message)}</section>`;
    return;
  }
  if (!force && (c.updatedAt === selectedStamp || replyDirty)) return;
  selectedStamp = c.updatedAt;
  renderCase(c);
}

function factsBlock(c) {
  const f = c.facts;
  if (!f) return `<p class="muted">PayPal facts are not available${c.status === 'reading' ? ' yet' : ''}.</p>`;
  const dispute = !c.dispute
    ? ''
    : c.dispute.state === 'none'
      ? '<span class="pill ok">None open</span>'
      : c.dispute.state === 'open'
        ? '<span class="pill fail">Open dispute</span>'
        : '<span class="pill warn">Unknown</span>';
  return `<dl class="kv">
    <dt>Captured</dt><dd class="amount">${money(f.capturedCents, f.currency)}</dd>
    <dt>Refunded before</dt><dd class="amount">${money(f.refundedCents, f.currency)}</dd>
    <dt>Refundable now</dt><dd class="amount"><strong>${money(f.remainingCents, f.currency)}</strong></dd>
    <dt>Paid</dt><dd>${when(f.capturedAt)} ${c.decision?.days !== undefined ? `<span class="muted">(day ${c.decision.days}${f.backdated ? ', demo-aged' : ''})</span>` : ''}</dd>
    <dt>Capture</dt><dd class="mono">${esc(f.captureId)} <span class="muted">${esc(f.captureStatus)}</span></dd>
    <dt>Disputes</dt><dd>${dispute}</dd>
    <dt>License</dt><dd>${c.sale?.activated ? `Activated ${when(c.sale.activatedAt)}` : 'Not activated'}</dd>
  </dl>`;
}

function triageBlock(t) {
  if (!t) return '<p class="muted">No AI reading.</p>';
  return `<dl class="kv">
      <dt>Reason</dt><dd><strong>${esc(REASON[t.reason] || t.reason)}</strong></dd>
      <dt>Summary</dt><dd>${esc(t.summary)}</dd>
      <dt>Language</dt><dd class="mono">${esc(t.language)}</dd>
    </dl>
    ${t.evidence.length ? `<ul class="evidence">${t.evidence.map((q) => `<li>"${esc(q)}"</li>`).join('')}</ul>` : ''}
    ${t.manipulation_signals.length ? `<p class="small" style="margin-top:12px;color:var(--warn)"><i class="ph ph-warning" aria-hidden="true"></i> Text that tries to steer the desk:</p><ul class="flags">${t.manipulation_signals.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}`;
}

function decisionBlock(c) {
  const d = c.decision;
  if (!d) return '<p class="muted">Deciding...</p>';
  const headline =
    d.action === 'refund' ? `<div class="bigamount amount">${money(d.amountCents)}</div><div class="route">refund</div>`
    : d.action === 'deny' ? '<div class="bigamount">No refund</div>'
    : '<div class="bigamount">You decide</div>';
  const rule = d.rule
    ? `<h3>${esc(d.rule.title)}</h3><blockquote style="margin-top:8px">${esc(d.rule.quote)}</blockquote>`
    : `<h3>No rule applied</h3>`;
  return `<div class="decision"><div>${headline}</div><div>${rule}<p class="route">${esc(d.why)} ${esc(ROUTE[d.route] || '')}</p></div></div>`;
}

function checksBlock(d) {
  if (!d) return '';
  return `<ul class="checks">${d.checks
    .map((k) => `<li class="${esc(k.status)}"><i class="ph ${ICON[k.status] || 'ph-info'}" aria-label="${esc(k.status)}"></i><div>${esc(k.label)}<small>${esc(k.detail)}</small></div></li>`)
    .join('')}</ul>`;
}

function replyAndActions(c) {
  const open = ['awaiting_approval', 'needs_human'].includes(c.status);
  if (c.sentReply) {
    const refunds = c.refunds
      .map((r) => `<p class="small" style="margin-top:10px"><i class="ph ph-check-circle" style="color:var(--accent)" aria-hidden="true"></i> PayPal refund <span class="mono">${esc(r.id)}</span>, <span class="amount">${money(r.cents)}</span>, ${esc(r.status)}, by ${r.by === 'auto' ? 'the desk' : 'you'}</p>`)
      .join('');
    return `<h3 class="sectitle"><i class="ph ph-paper-plane-tilt" aria-hidden="true"></i>Sent reply</h3>
      <blockquote class="customer"><strong>${esc(c.sentReply.subject)}</strong>\n\n${esc(c.sentReply.body)}</blockquote>${refunds}`;
  }
  if (!open || !c.reply) return '';
  const remaining = c.facts?.remainingCents ?? 0;
  const suggested = c.decision?.action === 'refund' ? c.decision.amountCents : 0;
  return `<h3 class="sectitle"><i class="ph ph-paper-plane-tilt" aria-hidden="true"></i>Reply draft <span class="pill">${c.reply.source === 'ai' ? (cfg.aiMode === 'claude' ? 'written by Claude' : 'offline draft') : 'template'}</span></h3>
    <textarea id="replyBody" rows="7">${esc(c.reply.body)}</textarea>
    <div class="actions">
      <div>
        <label for="refundAmount">Refund amount (USD)</label>
        <input id="refundAmount" inputmode="decimal" value="${suggested ? (suggested / 100).toFixed(2) : ''}" placeholder="0.00">
        <p class="help">Up to ${money(remaining)}</p>
      </div>
      <div class="row">
        <button id="decline">Send without refund</button>
        <button class="primary" id="approve"><i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>Refund with PayPal</button>
      </div>
    </div>
    <p class="help">If you change the amount and keep the draft, a matching reply is used instead.</p>`;
}

function renderCase(c) {
  const el = document.getElementById('caseDetail');
  el.innerHTML = `
    <section class="case-head">
      <div>
        <p class="small muted">${esc(c.invoiceId)} &nbsp; <span class="mono">${esc(c.orderId)}</span></p>
        <h2 style="margin-top:4px">${esc(c.productName)}</h2>
        <p class="small muted" style="margin-top:4px"><i class="ph ph-user" aria-hidden="true"></i> ${esc(c.customerName || '')} ${esc(c.email)} &nbsp; ${when(c.createdAt)}</p>
      </div>
      ${pill(c.status)}
    </section>
    <section>
      <h3 class="sectitle"><i class="ph ph-chat-circle-text" aria-hidden="true"></i>Customer wrote</h3>
      <blockquote class="customer">${esc(c.message)}</blockquote>
    </section>
    <div class="two" style="border-top:1px solid var(--line)">
      <div><h3 class="sectitle"><i class="ph ph-receipt" aria-hidden="true"></i>From PayPal, when the request came in</h3>${factsBlock(c)}</div>
      <div><h3 class="sectitle"><i class="ph ph-sparkle" aria-hidden="true"></i>${cfg.aiMode === 'claude' ? "Claude's reading" : 'AI reading (offline stand-in)'}</h3>${triageBlock(c.triage)}</div>
    </div>
    <section>
      <h3 class="sectitle"><i class="ph ph-scales" aria-hidden="true"></i>Decision</h3>
      ${decisionBlock(c)}
    </section>
    ${c.decision ? `<section><h3 class="sectitle"><i class="ph ph-shield-check" aria-hidden="true"></i>Checks</h3>${checksBlock(c.decision)}</section>` : ''}
    ${replyAndActions(c) ? `<section>${replyAndActions(c)}</section>` : ''}
    <section>
      <h3 class="sectitle"><i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i>Timeline</h3>
      <ol class="log">${c.log.map((l) => `<li><span>${when(l.at)}</span><span>${esc(l.text)}</span></li>`).join('')}</ol>
    </section>`;

  const reply = document.getElementById('replyBody');
  if (reply) reply.addEventListener('input', () => (replyDirty = true));
  const amountEl = document.getElementById('refundAmount');
  document.getElementById('approve')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const amount = amountEl.value.trim();
      const changedAmount = c.decision?.action !== 'refund' || amount !== (c.decision.amountCents / 100).toFixed(2);
      await api('POST', `/api/desk/cases/${encodeURIComponent(c.id)}/approve`, {
        amount,
        replyBody: replyDirty || !changedAmount ? reply.value : undefined,
      });
      toast('Refund sent through PayPal.');
      replyDirty = false;
      await loadCases();
      await refreshSelected(true);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
  document.getElementById('decline')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api('POST', `/api/desk/cases/${encodeURIComponent(c.id)}/decline`, { replyBody: reply.value });
      toast('Reply sent without a refund.');
      replyDirty = false;
      await loadCases();
      await refreshSelected(true);
    } catch (err) {
      toast(err.message);
      e.currentTarget.disabled = false;
    }
  });
}

// ---------------- policy ----------------
let policy = null;

async function loadPolicy() {
  policy = await api('GET', '/api/desk/policy');
  const text = document.getElementById('policyText');
  if (!text.value) text.value = policy.text || '';
  renderRules();
}

function renderPolicyState() {
  document.getElementById('policyState').textContent = policy?.active ? '' : 'not set';
}

function renderRules() {
  renderPolicyState();
  const box = document.getElementById('rulesBox');
  const draft = policy.draft;
  const active = policy.active;
  if (!draft && !active) {
    box.innerHTML = `<div class="empty"><i class="ph ph-book-open-text" aria-hidden="true"></i>Compile the policy to see the rules Claude finds. Until you approve rules, every request goes to you.</div>`;
    return;
  }
  const showing = draft && (!active || draft.compiledAt > active.approvedAt) ? draft : null;
  const rules = showing ? showing.rules : active.rules;
  const v = showing?.validation;
  box.innerHTML = `
    <div class="row spread">
      <h2>${showing ? 'Compiled rules, not approved yet' : 'Approved rules'}</h2>
      ${showing ? `<button class="primary" id="approvePolicy" ${v.ok ? '' : 'disabled'}><i class="ph ph-check-circle" aria-hidden="true"></i>Approve rules</button>` : `<span class="pill ok">In use since ${when(active.approvedAt)}</span>`}
    </div>
    <p class="small muted" style="margin:6px 0 14px">Checked top to bottom; the first rule that matches decides. Auto-refund limit: ${esc(cfg.autoRefundLimit)}.</p>
    ${v && v.problems.length ? `<p class="error-text">${v.problems.map(esc).join('<br>')}</p>` : ''}
    ${rules.map((r, i) => ruleCard(r, i, showing, v)).join('')}
    ${showing?.notes ? `<p class="small muted" style="margin-top:12px">Notes from Claude: ${esc(showing.notes)}</p>` : ''}`;

  box.querySelectorAll('[data-needs]').forEach((cb) =>
    cb.addEventListener('change', () => {
      showing.rules[Number(cb.dataset.needs)].needs_human = cb.checked;
    }),
  );
  document.getElementById('approvePolicy')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      policy = await api('POST', '/api/desk/policy/approve', { rules: showing.rules });
      toast('Rules approved. New requests use them now.');
      renderRules();
    } catch (err) {
      toast(err.message);
      e.currentTarget.disabled = false;
    }
  });
}

function ruleCard(r, i, editable, v) {
  const outcome =
    r.outcome === 'full' ? 'Full refund' : r.outcome === 'percent' ? `${r.percent}% refund` : r.outcome === 'none' ? 'No refund' : 'Hand to a person';
  const days =
    r.min_days !== null && r.max_days !== null ? `days ${r.min_days} to ${r.max_days}`
    : r.max_days !== null ? `within ${r.max_days} days`
    : r.min_days !== null ? `from day ${r.min_days}`
    : 'any time';
  const reasons = r.reasons.length ? r.reasons.map((x) => REASON[x] || x).join(', ') : 'Any reason';
  const license = r.license === 'any' ? '' : r.license === 'activated' ? ', license activated' : ', license not activated';
  const problems = v?.ruleProblems?.[i] || [];
  return `<div class="rule">
    <div class="row spread"><h3>${i + 1}. ${esc(r.title)}</h3><span class="pill ${r.outcome === 'none' ? '' : r.outcome === 'escalate' ? 'warn' : 'ok'}">${esc(outcome)}</span></div>
    <p class="small muted" style="margin-top:4px">${esc(reasons)}, ${esc(days)}${esc(license)}</p>
    <blockquote>${esc(r.quote)}</blockquote>
    ${problems.length ? `<ul class="problems">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    <div class="row" style="margin-top:8px">
      ${editable ? `<label class="inline"><input type="checkbox" data-needs="${i}" ${r.needs_human ? 'checked' : ''}> Always ask me first</label>` : r.needs_human ? '<span class="small muted">Always asks you first</span>' : ''}
    </div>
  </div>`;
}

document.getElementById('compile').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const note = document.getElementById('compileNote');
  btn.disabled = true;
  note.textContent = cfg.aiMode === 'claude' ? 'Claude is reading the policy...' : 'Compiling...';
  try {
    policy = await api('POST', '/api/desk/policy/compile', { text: document.getElementById('policyText').value });
    note.textContent = policy.draft.validation.ok ? 'Every quote was found word-for-word.' : 'Some rules need fixes; see the red notes.';
    renderRules();
  } catch (err) {
    note.textContent = '';
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------------- sales ----------------
async function loadSales() {
  const [sales, events] = await Promise.all([api('GET', '/api/desk/sales'), api('GET', '/api/desk/events')]);
  const table = document.getElementById('salesTable');
  table.innerHTML = sales.length
    ? `<thead><tr><th>Invoice</th><th>Product</th><th>Paid by</th><th>Amount</th><th>License</th><th>Purchase age</th></tr></thead><tbody>${sales
        .map(
          (s) => `<tr>
            <td class="mono">${esc(s.invoiceId)}</td>
            <td>${esc(s.productName)}</td>
            <td>${esc(s.payerEmail)}</td>
            <td class="amount">${money(s.amountCents, s.currency)}</td>
            <td>${s.activated ? 'Activated' : 'Not activated'}</td>
            <td><select data-order="${esc(s.orderId)}" aria-label="Purchase age for ${esc(s.invoiceId)}">
              ${[0, 10, 20, 40].map((d) => `<option value="${d}" ${(s.backdateDays || 0) === d ? 'selected' : ''}>${d === 0 ? 'Real date' : `${d} days old`}</option>`).join('')}
            </select></td>
          </tr>`,
        )
        .join('')}</tbody>`
    : '<tbody><tr><td class="empty">No sales yet.</td></tr></tbody>';
  table.querySelectorAll('select[data-order]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      try {
        await api('POST', `/api/desk/sales/${encodeURIComponent(sel.dataset.order)}/backdate`, { days: Number(sel.value) });
        toast('Purchase age updated for new requests.');
      } catch (err) {
        toast(err.message);
      }
    }),
  );
  document.getElementById('events').innerHTML = events.length
    ? events.map((ev) => `<li><time>${when(ev.at)}</time>${esc(ev.text)}</li>`).join('')
    : '<li class="muted">Nothing yet.</li>';
}

// ---------------- boot ----------------
showTab();
policy = await api('GET', '/api/desk/policy');
renderPolicyState();
await loadCases();
setInterval(loadCases, 4000);
