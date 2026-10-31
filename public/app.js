'use strict';

// NorthStar Governance Portal UI. Vanilla JS, no build step.
// All dynamic content is rendered with textContent (never innerHTML) to avoid XSS.

const ENVS = ['dev', 'test', 'prod'];
const state = {
  tab: 'overview',
  envFilter: null,
  selectedAccount: null,
  selectedRunId: null,
  includeProd: false,
  approver: '',
  tamperAccount: 'ns-crew-prod',
  active: false,
  summary: null,
  timer: null,
};

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

const STATUS_CLASS = {
  PASS: 'pass', SUCCEEDED: 'pass', IN_SYNC: 'pass', ACTIVE: 'pass', ON: 'pass',
  FAIL: 'fail', FAILED: 'fail', DRIFTED: 'fail', ERROR: 'fail', HALTED: 'fail', EXPIRED: 'fail', OFF: 'fail',
  EXCEPTED: 'excepted', PARTIAL: 'excepted', EXPIRING: 'excepted',
  RUNNING: 'running', RETRYING: 'running',
  SKIPPED: 'neutral', NOT_DEPLOYED: 'neutral', 'N/A': 'neutral', PENDING: 'neutral', UNKNOWN: 'neutral',
};
const cls = (status) => STATUS_CLASS[status] || 'neutral';
const label = (status) => String(status).replace(/_/g, ' ');
const badge = (status, text) => el('span', { class: `badge s-${cls(status)}`, text: text || label(status) });
const envBadge = (env) => el('span', { class: `env env-${env}`, text: env });
const pct = (r) => (r === null || r === undefined ? '–' : `${Math.round(r * 100)}%`);
const secs = (ms) => (ms === undefined || ms === null ? '' : `${(ms / 1000).toFixed(1)}s`);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '–');
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '–');
const changes = (c) => (c ? `+${c.add} ~${c.change} -${c.destroy}` : '');
const duration = (a, b) => (a && b ? secs(Date.parse(b) - Date.parse(a)) : '');

function scoreBar(score) {
  const bar = el('div', { class: `bar ${score === null ? '' : score < 0.8 ? 'low' : score < 1 ? 'mid' : ''}` }, el('span'));
  bar.firstChild.style.width = `${Math.round((score || 0) * 100)}%`;
  return bar;
}

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  if (options.body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4000);
}

function banner(message) {
  const b = document.getElementById('banner');
  b.textContent = message || '';
  b.hidden = !message;
}

function panel(title, ...children) {
  return el('div', { class: 'panel' }, title ? el('h3', { text: title }) : null, ...children);
}

function table(headers, rows) {
  return el(
    'table',
    {},
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { text: h })))),
    el('tbody', {}, rows),
  );
}

function setView(id, ...children) {
  const view = document.getElementById(`view-${id}`);
  view.replaceChildren(...children.filter((c) => c !== null && c !== undefined));
}

// ---------- actions ----------

/** Same gate as CI: anything touching Prod (or Root/core SCPs) needs a named approver. Resolves to the name or null. */
function askProdApproval(what) {
  return new Promise((resolve) => {
    let done = false;
    const input = el('input', { type: 'text', value: state.approver, placeholder: 'Your name', 'aria-label': 'Approver name', maxlength: 60, required: true });
    const dialog = el('dialog', { class: 'approval', 'aria-label': 'Production approval' });
    const close = (value) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.append(
      el(
        'form',
        {
          onsubmit: (e) => {
            e.preventDefault();
            const who = input.value.trim();
            if (!who) return;
            state.approver = who;
            close(who);
          },
        },
        el('h3', { text: 'Production approval required' }),
        el('p', { text: what }),
        el('label', { class: 'approver' }, 'Approver (recorded in the run)', input),
        el(
          'div',
          { class: 'toolbar' },
          el('button', { type: 'submit', class: 'primary', text: 'Approve and run' }),
          el('button', { type: 'button', text: 'Cancel', onclick: () => close(null) }),
        ),
      ),
    );
    dialog.addEventListener('cancel', () => close(null));
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

async function startRun(body, message) {
  if ((body.kind === 'deploy' && body.includeProd) || body.prod) {
    const what = body.account
      ? `Re-apply ${body.account} (Prod).`
      : 'Deploy Dev and Test, then Root/core SCPs and the Prod ring (canary first).';
    const approvedBy = await askProdApproval(what);
    if (!approvedBy) return toast('Prod deployment cancelled: no approval given', true);
    body = { ...body, approvedBy };
  }
  delete body.prod;
  try {
    const { runId } = await api('/api/runs', { method: 'POST', body });
    state.selectedRunId = null;
    state.followRunId = runId;
    state.active = true;
    toast(`${message} (${runId})`);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

async function simulateManualChange() {
  try {
    const res = await api('/api/demo/tamper', { method: 'POST', body: { account: state.tamperAccount } });
    toast(`Manual change on ${res.account}: ${res.change}`);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- Overview ----------

async function renderOverview() {
  const s = state.summary;
  const accounts = await api('/api/accounts');
  const card = (labelText, value, hint, extra = '') =>
    el('div', { class: `card ${extra}` }, el('div', { class: 'label', text: labelText }), value, el('div', { class: 'hint', text: hint }));
  const big = (text) => el('div', { class: 'value', text });

  const last = s.lastRun;
  const cards = el(
    'div',
    { class: 'cards' },
    card('Accounts', big(String(s.accounts)), `${s.managed} managed · ${s.legacy} legacy · ${s.notDeployed} not deployed${s.synthetic ? ` · ${s.synthetic} synthetic` : ''}`),
    card('Estate compliance', big(pct(s.compliance)), 'PASS / (PASS + FAIL), deployed accounts', s.compliance === null ? '' : s.compliance >= 0.95 ? 'good' : 'alert'),
    card('Non-compliant accounts', big(String(s.nonCompliant)), 'at least one rule failing', s.nonCompliant > 0 ? 'alert' : 'good'),
    card('Drifted accounts', big(String(s.drifted)), 'from the latest drift check', s.drifted > 0 ? 'alert' : 'good'),
    card('Active exceptions', big(String(s.activeExceptions)), s.exceptionAlerts.length ? `${s.exceptionAlerts.length} expiring or expired` : 'time-bound, see Governance', s.exceptionAlerts.length ? 'alert' : ''),
    card(
      'Last pipeline run',
      el('div', { class: 'value' }, last ? badge(last.status) : el('span', { class: 'muted', text: 'none' })),
      last ? `${last.kind} · ${time(last.startedAt)}` : 'no runs yet',
    ),
  );

  const LIMIT = 12;
  const worstFirst = (a, b) =>
    (b.compliance.deployed ? b.compliance.fail : -1) - (a.compliance.deployed ? a.compliance.fail : -1) || a.name.localeCompare(b.name);
  const envPanels = s.byEnvironment.map((e) => {
    const envAccounts = accounts.filter((a) => a.environment === e.environment).sort(worstFirst);
    const shown = envAccounts.slice(0, LIMIT);
    return el(
      'div',
      { class: 'panel' },
      el(
        'div',
        { class: 'env-bar' },
        envBadge(e.environment),
        scoreBar(e.compliance),
        el('span', { text: `${pct(e.compliance)} · ${e.deployed}/${e.accounts} deployed` }),
      ),
      el(
        'div',
        {},
        shown.map((a) =>
          el(
            'div',
            { class: 'env-bar' },
            el('span'),
            el('span', { class: 'mono', text: a.name }),
            a.compliance.deployed
              ? badge(a.compliance.fail > 0 ? 'FAIL' : 'PASS', `${pct(a.compliance.score)}${a.managedBy === 'manual' ? ' · legacy' : ''}`)
              : badge('NOT_DEPLOYED'),
          ),
        ),
        envAccounts.length > LIMIT
          ? el('div', { class: 'small muted', text: `+ ${envAccounts.length - LIMIT} more (worst first; see Accounts)` })
          : null,
      ),
    );
  });

  const alerts = s.exceptionAlerts.length
    ? panel(
        'Governance exceptions needing action',
        table(
          ['ID', 'Account', 'Rule', 'Expires', 'Status'],
          s.exceptionAlerts.map((x) =>
            el(
              'tr',
              {},
              el('td', { class: 'mono', text: x.id }),
              el('td', { class: 'mono', text: x.account }),
              el('td', { class: 'mono', text: x.rule }),
              el('td', { class: 'small', text: x.expires }),
              el('td', {}, badge(x.state, x.state === 'EXPIRED' ? 'EXPIRED: re-apply to enforce' : `EXPIRING in ${x.daysRemaining} days`)),
            ),
          ),
        ),
      )
    : null;

  setView('overview', cards, alerts, el('h2', { text: 'Compliance by environment' }), el('div', { class: 'grid-3' }, envPanels));
}

// ---------- Accounts ----------

async function renderAccounts() {
  const query = state.envFilter ? `?env=${encodeURIComponent(state.envFilter)}` : '';
  const accounts = await api(`/api/accounts${query}`);

  const filters = el(
    'div',
    { class: 'toolbar filters' },
    [null, ...ENVS].map((env) =>
      el('button', {
        class: state.envFilter === env ? 'active' : '',
        text: env ? env.toUpperCase() : 'All',
        onclick: () => {
          state.envFilter = env;
          refresh();
        },
      }),
    ),
  );

  const rows = accounts.map((a) =>
    el(
      'tr',
      {
        class: `clickable${state.selectedAccount === a.name ? ' selected' : ''}`,
        onclick: () => {
          state.selectedAccount = a.name;
          refresh();
        },
      },
      el('td', {}, el('strong', { text: a.name }), a.canary ? [' ', el('span', { class: 'chip', text: 'canary' })] : null, el('div', { class: 'small muted mono', text: `${a.accountId}${a.synthetic ? ' · synthetic' : ''}` })),
      el('td', {}, envBadge(a.environment)),
      el('td', { class: 'mono', text: a.ou }),
      el('td', {}, badge(a.managedBy === 'landing-zone' ? 'PASS' : a.managedBy === 'manual' ? 'FAIL' : 'NOT_DEPLOYED', a.managedBy)),
      el(
        'td',
        { class: 'small' },
        a.lastDeployment ? [badge(a.lastDeployment.status), ' ', time(a.lastDeployment.at)] : el('span', { class: 'muted', text: 'never' }),
      ),
      el(
        'td',
        {},
        a.compliance.deployed
          ? el('div', {}, scoreBar(a.compliance.score), el('div', { class: 'small', text: `${pct(a.compliance.score)} · ${a.compliance.fail} failing${a.compliance.excepted ? ` · ${a.compliance.excepted} excepted` : ''}` }))
          : badge('NOT_DEPLOYED'),
      ),
      el('td', {}, badge(a.drift.status, a.drift.status === 'DRIFTED' && a.drift.components.length ? `DRIFTED (${a.drift.components.join(', ')})` : undefined)),
    ),
  );

  const list = panel(null, table(['Account', 'Env', 'OU', 'Managed by', 'Last deployment', 'Compliance', 'Drift'], rows));
  const detail = state.selectedAccount ? await renderAccountDetail(state.selectedAccount) : panel(null, el('div', { class: 'empty', text: 'Select an account to see rule results, effective settings, network, access and SCPs.' }));
  setView('accounts', filters, list, detail);
}

async function renderAccountDetail(name) {
  let d;
  try {
    d = await api(`/api/accounts/${encodeURIComponent(name)}`);
  } catch (e) {
    state.selectedAccount = null;
    return panel(null, el('div', { class: 'empty', text: e.message }));
  }

  const head = el(
    'div',
    { class: 'detail-head' },
    el('h2', { text: d.name }),
    envBadge(d.environment),
    el('span', { class: 'mono muted', text: d.accountId }),
    badge(d.managedBy === 'landing-zone' ? 'PASS' : d.managedBy === 'manual' ? 'FAIL' : 'NOT_DEPLOYED', `managed by: ${d.managedBy}`),
    d.compliance.deployed ? badge(d.compliance.fail ? 'FAIL' : 'PASS', `compliance ${pct(d.compliance.score)}`) : null,
    badge(d.drift.status),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'primary',
      text: 'Re-apply',
      title: `Runs lz apply --account ${d.name}`,
      disabled: state.active,
      onclick: () => startRun({ kind: 'deploy', account: d.name, prod: d.environment === 'prod' }, `Re-applying ${d.name}`),
    }),
  );

  const order = { FAIL: 0, EXCEPTED: 1, PASS: 2, NOT_DEPLOYED: 3, 'N/A': 4 };
  const ruleRows = [...d.results].sort((a, b) => order[a.status] - order[b.status]).map((r) => {
    let detail = '';
    if (r.status === 'EXCEPTED') detail = `${r.exception.id} · expires ${r.exception.expires} · ${r.exception.reason}`;
    else if (r.status === 'FAIL') detail = r.checks.filter((c) => !c.passed).map((c) => `${c.check} → ${c.detail}`).join('; ');
    else if (r.status === 'PASS') detail = r.checks.map((c) => c.check).join('; ');
    else if (r.status === 'NOT_DEPLOYED') detail = 'no estate files';
    return el(
      'tr',
      {},
      el('td', { class: 'mono nowrap', text: r.id }),
      el('td', {}, r.title, el('div', { class: 'small muted', text: r.severity })),
      el('td', {}, badge(r.status)),
      el('td', { class: 'small', text: detail || '–' }),
    );
  });

  const settingsRows = d.settings.map((s) =>
    el('tr', {}, el('td', { class: 'mono', text: s.key }), el('td', { class: 'mono', text: JSON.stringify(s.value) }), el('td', {}, el('span', { class: `src src-${s.source}`, text: s.source }))),
  );

  const kv = (obj) =>
    obj
      ? el('dl', { class: 'kv' }, Object.entries(obj).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: typeof v === 'object' ? JSON.stringify(v) : String(v) })]))
      : el('div', { class: 'empty', text: 'Not deployed' });

  const scps = d.scps.length
    ? el(
        'div',
        {},
        d.scps.map((s) =>
          el('div', {}, el('span', { class: `chip${s.exempt ? ' exempt' : ''}`, text: s.statement }), el('span', { class: 'small muted', text: ` from ${s.ou}${s.exempt ? ' · account exempted by exception' : ''}` })),
        ),
      )
    : el('div', { class: 'empty', text: 'No SCPs: account not placed in the organization yet' });

  return el(
    'div',
    { class: 'panel' },
    head,
    el(
      'div',
      { class: 'grid-2' },
      el('div', {}, el('h3', { text: 'Rule results' }), table(['Rule', 'Title', 'Status', 'Detail'], ruleRows)),
      el(
        'div',
        {},
        el('h3', { text: 'Effective settings' }),
        d.settingsRecorded ? null : el('div', { class: 'small muted', text: 'Desired configuration: this account is not yet managed by the landing zone.' }),
        table(['Setting', 'Value', 'Set by'], settingsRows),
        el('h3', { text: 'Effective SCPs' }),
        scps,
      ),
    ),
    el(
      'div',
      { class: 'grid-3' },
      el('div', {}, el('h3', { text: 'Network' }), kv(d.network)),
      el('div', {}, el('h3', { text: 'Access (permission sets)' }), kv(d.access)),
      el('div', {}, el('h3', { text: 'Tags' }), kv(d.tags)),
    ),
  );
}

// ---------- Pipeline ----------

function tile(name, status, metaParts, error) {
  return el(
    'div',
    { class: `tile t-${cls(status)}` },
    el('div', { class: 'name' }, el('span', { text: name }), badge(status)),
    metaParts.filter(Boolean).length ? el('div', { class: 'meta', text: metaParts.filter(Boolean).join(' · ') }) : null,
    error ? el('div', { class: 'err', text: error }) : null,
  );
}

function renderRun(run) {
  const head = el(
    'div',
    { class: 'run-head' },
    el('h3', { text: run.kind === 'drift' ? 'Drift detection' : 'Deployment' }),
    el('span', { class: 'mono', text: run.runId }),
    badge(run.status),
    el('span', { class: 'small muted', text: `trigger: ${run.trigger} · started ${time(run.startedAt)}${run.finishedAt ? ` · ${duration(run.startedAt, run.finishedAt)}` : ''}` }),
    run.options && run.options.account ? el('span', { class: 'chip', text: `--account ${run.options.account}` }) : null,
    run.options && run.options.approveProd
      ? el('span', { class: 'chip', text: `Prod approved${run.options.approvedBy ? ` by ${run.options.approvedBy}` : ''}` })
      : null,
  );
  const error = run.error ? el('div', { class: `tile t-${cls(run.status)}` }, el('div', { class: 'err', text: run.error })) : null;

  if (run.kind === 'drift') {
    const tiles = (run.drift || []).map((d) =>
      tile(d.name, d.status, [d.components.length ? `component: ${d.components.join(', ')}` : d.status === 'IN_SYNC' ? 'matches Git' : ''], d.error),
    );
    return panel(null, head, error, tiles.length ? el('div', { class: 'drift-grid' }, tiles) : el('div', { class: 'empty', text: run.status === 'RUNNING' ? 'Planning…' : 'No deployed accounts to check.' }));
  }

  // At scale, a ring shows counts plus only the accounts worth looking at.
  const COMPACT_AT = 16;
  const accountTile = (a) =>
    tile(
      a.canary ? `${a.name} · canary` : a.name,
      a.status,
      [a.attempts ? `attempts ${a.attempts}` : '', changes(a.changes), secs(a.durationMs)],
      a.status === 'SUCCEEDED' ? null : a.error,
    );
  const ringAccounts = (ring) => {
    if (!ring.accounts.length) return [el('div', { class: 'empty', text: 'No accounts' })];
    if (ring.accounts.length <= COMPACT_AT) return ring.accounts.map(accountTile);
    const counts = {};
    for (const a of ring.accounts) counts[a.status] = (counts[a.status] || 0) + 1;
    const notable = ring.accounts.filter((a) => a.canary || a.attempts > 1 || ['RUNNING', 'RETRYING', 'FAILED'].includes(a.status));
    const firstSkipped = ring.accounts.find((a) => a.status === 'SKIPPED' && a.error);
    return [
      el('div', { class: 'ring-counts' }, `${ring.accounts.length} accounts: `, Object.entries(counts).map(([st, n]) => [badge(st, `${n} ${label(st)}`), ' '])),
      firstSkipped ? el('div', { class: 'small muted', text: firstSkipped.error }) : null,
      ...notable.slice(0, COMPACT_AT).map(accountTile),
    ];
  };

  const rings = el(
    'div',
    { class: 'rings' },
    ENVS.map((env) => {
      const ring = run.rings.find((r) => r.name === env);
      return el(
        'div',
        { class: `ring ring-${env}` },
        el('div', { class: 'ring-head' }, el('span', { text: `${env.toUpperCase()} ring` }), ring ? badge(ring.status) : el('span', { class: 'small', text: 'not in this run' })),
        el(
          'div',
          { class: 'ring-body' },
          ring && ring.reason ? el('div', { class: 'tile t-excepted' }, el('div', { class: 'err', text: ring.reason })) : null,
          ring
            ? (ring.organization || []).map((o) =>
                tile(
                  `organization/${o.stage}`,
                  o.status,
                  [o.stage === 'core' ? 'Root + shared OU SCPs' : 'OU SCP + account placement', changes(o.changes), secs(o.durationMs)],
                  o.error,
                ),
              )
            : null,
          ring ? ringAccounts(ring) : el('div', { class: 'empty', text: '–' }),
        ),
      );
    }),
  );
  return panel(null, head, error, rings);
}

async function renderPipeline() {
  const [runs, accounts] = await Promise.all([api('/api/runs'), api('/api/accounts')]);
  const selectedId = state.selectedRunId || state.followRunId || (runs[0] && runs[0].runId);
  const run = selectedId ? await api(`/api/runs/${encodeURIComponent(selectedId)}`).catch(() => null) : null;

  const busy = state.active;
  const toolbar = el(
    'div',
    { class: 'toolbar' },
    el('button', {
      class: 'primary',
      text: 'Run pipeline',
      disabled: busy,
      onclick: () => startRun({ kind: 'deploy', includeProd: state.includeProd }, 'Pipeline started'),
    }),
    el(
      'label',
      { class: 'check' },
      el('input', { type: 'checkbox', checked: state.includeProd, onchange: (e) => (state.includeProd = e.target.checked) }),
      'Include Root/core + Prod (needs approval)',
    ),
    el('button', { text: 'Detect drift', disabled: busy, onclick: () => startRun({ kind: 'drift' }, 'Drift detection started') }),
    el('span', { class: 'spacer' }),
    state.summary.demoMode
      ? [
          el(
            'select',
            { 'aria-label': 'Account for manual change', onchange: (e) => (state.tamperAccount = e.target.value) },
            accounts
              .filter((a) => a.managedBy === 'landing-zone')
              .map((a) => el('option', { value: a.name, selected: a.name === state.tamperAccount, text: a.name })),
          ),
          el('button', { class: 'warn', text: 'Simulate manual change', disabled: busy, onclick: simulateManualChange }),
        ]
      : null,
  );

  const history = runs.map((r) =>
    el(
      'tr',
      { class: `clickable${r.runId === selectedId ? ' selected' : ''}`, onclick: () => ((state.selectedRunId = r.runId), (state.followRunId = null), refresh()) },
      el('td', { class: 'mono', text: r.runId }),
      el('td', { text: r.kind }),
      el('td', { text: r.trigger }),
      el('td', { class: 'small', text: [r.options.account && `account ${r.options.account}`, r.options.approveProd && 'prod approved'].filter(Boolean).join(' · ') || '–' }),
      el('td', {}, badge(r.status)),
      el('td', { class: 'small', text: dateTime(r.startedAt) }),
      el('td', { class: 'small', text: duration(r.startedAt, r.finishedAt) }),
    ),
  );

  setView(
    'pipeline',
    toolbar,
    run
      ? renderRun(run)
      : panel(null, el('div', { class: 'empty', text: busy ? 'Starting run…' : 'No runs yet. Click "Run pipeline".' })),
    panel(
      'Run history',
      state.selectedRunId ? el('button', { text: 'Follow latest run', onclick: () => ((state.selectedRunId = null), (state.followRunId = null), refresh()) }) : null,
      runs.length ? table(['Run', 'Kind', 'Trigger', 'Options', 'Status', 'Started', 'Duration'], history) : el('div', { class: 'empty', text: 'No runs yet.' }),
    ),
  );
}

// ---------- Governance ----------

async function renderGovernance() {
  const g = await api('/api/governance');

  const cmp = el(
    'table',
    { class: 'cmp' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Control' }), g.environments.map((e) => el('th', {}, envBadge(e))))),
    el(
      'tbody',
      {},
      g.comparison.map((row) =>
        el(
          'tr',
          {},
          el('td', { text: row.label }),
          g.environments.map((e) => {
            const v = row.values[e];
            return el('td', { class: /^Denied/.test(v) ? 'denied' : /^Allowed/.test(v) ? 'allowed' : /^Required/.test(v) ? 'strong' : 'mono', text: v });
          }),
        ),
      ),
    ),
  );

  const byParent = (parent) => g.ous.filter((o) => o.parent === parent);
  const tree = (parent) =>
    el(
      'ul',
      { class: parent === null ? 'ou-tree' : '' },
      byParent(parent).map((ou) =>
        el(
          'li',
          {},
          el(
            'div',
            { class: 'ou-node' },
            el('span', { class: 'ou-name', text: ou.name }),
            ' ',
            ou.scp.length ? ou.scp.map((s) => el('span', { class: 'chip', text: s })) : el('span', { class: 'small muted', text: 'inherits only' }),
            ou.accounts.length
              ? el('div', {
                  class: 'ou-accounts',
                  text: ou.accounts.length > 10 ? `${ou.accounts.slice(0, 10).join(', ')} + ${ou.accounts.length - 10} more` : ou.accounts.join(', '),
                })
              : null,
          ),
          byParent(ou.name).length ? tree(ou.name) : null,
        ),
      ),
    );

  const onOff = (obj) =>
    el('div', {}, Object.entries(obj).map(([k, v]) => el('div', { class: 'onoff' }, el('span', { class: 'mono', text: k }), badge(v ? 'ON' : 'OFF'))));

  const standards = el(
    'div',
    {},
    el('dl', { class: 'kv' }, el('dt', { text: 'Allowed regions' }), el('dd', { text: g.globalStandards.allowedRegions.join(', ') }), el('dt', { text: 'Mandatory tags' }), el('dd', { text: g.globalStandards.mandatoryTags.join(', ') })),
    el('h3', { text: 'Shared services (core accounts)' }),
    el(
      'dl',
      { class: 'kv' },
      g.sharedServices.flatMap((s) => [el('dt', { text: s.role.replace(/_/g, ' ') }), el('dd', { text: `${s.account} (${s.id})` })]),
    ),
    el('h3', { text: 'Security services' }),
    onOff(g.globalStandards.securityServices),
    el('h3', { text: 'Hardening' }),
    onOff(g.globalStandards.hardening),
  );

  const exceptions = g.exceptions.map((e) =>
    el(
      'tr',
      {},
      el('td', { class: 'mono', text: e.id }),
      el('td', { class: 'mono', text: e.account }),
      el('td', { class: 'mono', text: `${e.rule}${e.scp_statement ? ` / ${e.scp_statement}` : ''}` }),
      el('td', { class: 'small', text: e.reason }),
      el('td', { class: 'small', text: e.approved_by }),
      el('td', { class: 'small', text: e.expires }),
      el('td', {}, badge(e.state, e.state === 'EXPIRED' ? 'EXPIRED' : `${e.state} · ${e.daysRemaining} days left`)),
    ),
  );

  const rules = g.rules.map((r) =>
    el('tr', {}, el('td', { class: 'mono', text: r.id }), el('td', { text: r.title }), el('td', {}, r.environments.map((e) => [envBadge(e), ' '])), el('td', { class: 'small', text: r.severity })),
  );

  setView(
    'governance',
    panel('Environment-specific governance (Dev / Test / Prod)', cmp),
    el(
      'div',
      { class: 'grid-2' },
      panel(
        `OU tree and SCPs${g.organizationDeployed ? ` (deployed stages: ${g.organizationStages.join(', ')})` : ' (not deployed yet)'}`,
        tree(null),
      ),
      panel('Organization-wide standards (config/global.yaml)', standards),
    ),
    panel('Governance exceptions (config/exceptions.yaml)', table(['ID', 'Account', 'Rule / SCP', 'Reason', 'Approved by', 'Expires', 'Status'], exceptions)),
    panel('Compliance rules (policies/rules.yaml)', table(['Rule', 'Title', 'Environments', 'Severity'], rules)),
  );
}

// ---------- routing & polling ----------

const VIEWS = { overview: renderOverview, accounts: renderAccounts, pipeline: renderPipeline, governance: renderGovernance };

async function refresh() {
  clearTimeout(state.timer);
  try {
    state.summary = await api('/api/summary');
    document.getElementById('demo-pill').hidden = !state.summary.demoMode;
    const last = state.summary.lastRun;
    state.active = Boolean(state.summary.activeRunId) || (last && last.status === 'RUNNING');
    await VIEWS[state.tab]();
    banner('');
  } catch (e) {
    banner(e.message);
  }
  // Poll every 2 seconds while a pipeline run is active.
  if (state.active) state.timer = setTimeout(refresh, 2000);
}

function route() {
  // Deep links: #pipeline, #accounts/ns-booking-prod (opens that account's detail panel).
  const [tab, sub] = location.hash.replace('#', '').split('/');
  state.tab = VIEWS[tab] ? tab : 'overview';
  if (state.tab === 'accounts' && sub) state.selectedAccount = decodeURIComponent(sub);
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.tab === state.tab);
  for (const id of Object.keys(VIEWS)) document.getElementById(`view-${id}`).hidden = id !== state.tab;
  refresh();
}

window.addEventListener('hashchange', route);
route();
