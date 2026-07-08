'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const S = {
  page:       'dashboard',
  running:    false,
  ws:         null,
  history:    [],
  latest:     null,   // { stats, specs[] }
  testFiles:  [],
  filter:     'all',
  search:     '',
  charts:     {},
  expandedRows: new Set(),
};

// ── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  connectWS();
  await loadData();
  renderDashboard();
  renderResults();
  renderHistory();
  navigate('dashboard');
});

// ── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  const ws = new WebSocket(`ws://${location.host}`);
  S.ws = ws;

  ws.onopen = () => setWsStatus(true);
  ws.onclose = () => {
    setWsStatus(false);
    setTimeout(connectWS, 3000);
  };
  ws.onmessage = e => handleWS(JSON.parse(e.data));
}

function setWsStatus(connected) {
  const el = document.getElementById('ws-status');
  if (!el) return;
  el.innerHTML = connected
    ? '<span class="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0"></span><span class="text-emerald-400">Connected</span>'
    : '<span class="w-2 h-2 rounded-full bg-red-400 flex-shrink-0"></span><span class="text-red-400">Reconnecting…</span>';
}

function handleWS(msg) {
  switch (msg.type) {

    case 'run:start':
      S.running = true;
      S.expandedRows.clear();
      setRunningUI(true);
      termClear();
      termWrite(`▶  npx ${msg.args.join(' ')}\n    ${msg.ts}\n\n`, 'info');
      break;

    case 'run:output':
      termWrite(msg.text);
      parseProgress(msg.text);
      break;

    case 'run:complete':
      S.running = false;
      setRunningUI(false);
      if (msg.entry) {
        S.history.unshift(msg.entry);
        S.latest = { stats: msg.entry.stats, specs: msg.entry.specs };
      }
      termWrite(
        msg.exitCode === 0
          ? '\n\n  ✅  All tests passed.\n'
          : '\n\n  ❌  Some tests failed.\n',
        msg.exitCode === 0 ? 'success' : 'error'
      );
      renderDashboard();
      renderResults();
      renderHistory();
      break;

    case 'run:stopped':
      S.running = false;
      setRunningUI(false);
      termWrite('\n\n  ⏹  Run stopped.\n', 'warn');
      break;
  }
}

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadData() {
  const [hist, latest, files, status] = await Promise.all([
    api('/api/history'),
    api('/api/results/latest'),
    api('/api/tests'),
    api('/api/status'),
  ]);

  S.history   = hist   || [];
  S.latest    = latest || null;
  S.testFiles = files  || [];
  S.running   = status?.running || false;

  // Populate file selector
  const sel = $('cfg-file');
  if (sel && S.testFiles.length) {
    S.testFiles.forEach(f => {
      const o = document.createElement('option');
      o.value = f.path;
      o.textContent = f.name;
      sel.appendChild(o);
    });
  }

  if (S.running) setRunningUI(true);
}

async function api(url, opts) {
  try {
    const r = await fetch(url, opts);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigate(page) {
  S.page = page;
  document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  const pg = document.getElementById(`page-${page}`);
  if (pg) pg.classList.remove('hidden');

  const nav = document.getElementById(`nav-${page}`);
  if (nav) nav.classList.add('active');

  const titles = { dashboard: 'Dashboard', runner: 'Run Tests', results: 'Test Results', history: 'History' };
  setText('page-title', titles[page] || page);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const s = S.latest?.stats;
  if (!s) {
    ['stat-total','stat-passed','stat-failed','stat-rate'].forEach(id => setText(id, '—'));
  } else {
    const total  = (s.expected || 0) + (s.unexpected || 0) + (s.skipped || 0);
    const passed = s.expected   || 0;
    const failed = s.unexpected || 0;
    const skipped= s.skipped    || 0;
    const rate   = total > 0 ? Math.round((passed / total) * 100) : 0;
    const dur    = s.duration ? (s.duration / 1000).toFixed(1) + 's' : '—';

    setText('stat-total',      total);
    setText('stat-passed',     passed);
    setText('stat-failed',     failed);
    setText('stat-rate',       `${rate}%`);
    setText('stat-total-sub',  `${skipped} skipped · ${dur}`);
    setText('stat-passed-sub', `${rate}% pass rate`);
    setText('stat-failed-sub', failed > 0 ? 'needs attention' : 'clean run ✓');
    setText('stat-rate-sub',   `of ${total} tests`);
  }

  renderCharts();
  renderRecentRuns();

  if (S.history.length) {
    const ts = new Date(S.history[0].timestamp);
    setText('last-run-info', `Last: ${fmtDate(ts)}`);
  }
}

function renderCharts() {
  const hist = S.history.slice(0, 10).reverse();
  const labels = hist.map(h => {
    const d = new Date(h.timestamp);
    return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  });
  const rates   = hist.map(h => {
    const t = (h.stats?.expected||0)+(h.stats?.unexpected||0);
    return t ? Math.round((h.stats.expected/t)*100) : 0;
  });
  const durs    = hist.map(h => Math.round((h.stats?.duration||0)/1000));

  const chartDefaults = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
  };
  const gridColor = 'rgba(51,65,85,0.5)';
  const tickColor = '#475569';

  // Pass rate chart
  const prCtx = document.getElementById('chart-pass-rate');
  if (prCtx) {
    if (S.charts.pr) S.charts.pr.destroy();
    S.charts.pr = new Chart(prCtx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: rates,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,0.12)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointBackgroundColor: '#6366f1',
          pointRadius: 4,
          pointHoverRadius: 6,
        }],
      },
      options: {
        ...chartDefaults,
        scales: {
          y: { min:0, max:100, ticks:{ color:tickColor, callback:v=>`${v}%` }, grid:{ color:gridColor }, border:{ display:false } },
          x: { ticks:{ color:tickColor, maxRotation:0, font:{ size:10 } }, grid:{ display:false }, border:{ display:false } },
        },
      },
    });
  }

  // Duration chart
  const durCtx = document.getElementById('chart-duration');
  if (durCtx) {
    if (S.charts.dur) S.charts.dur.destroy();
    S.charts.dur = new Chart(durCtx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: durs,
          backgroundColor: 'rgba(99,102,241,0.25)',
          borderColor: '#6366f1',
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        ...chartDefaults,
        scales: {
          y: { min:0, ticks:{ color:tickColor, callback:v=>`${v}s` }, grid:{ color:gridColor }, border:{ display:false } },
          x: { ticks:{ color:tickColor, maxRotation:0, font:{ size:10 } }, grid:{ display:false }, border:{ display:false } },
        },
      },
    });
  }
}

function renderRecentRuns() {
  const el = $('recent-runs');
  if (!el) return;
  const runs = S.history.slice(0, 6);
  if (!runs.length) {
    el.innerHTML = '<p class="p-8 text-center text-sm text-slate-500">No runs yet — click <strong class="text-slate-400">Run All Tests</strong> to start.</p>';
    return;
  }
  el.innerHTML = runs.map(run => {
    const t = (run.stats?.expected||0) + (run.stats?.unexpected||0) + (run.stats?.skipped||0);
    const p = run.stats?.expected    || 0;
    const f = run.stats?.unexpected  || 0;
    const rate = t ? Math.round((p/t)*100) : 0;
    const dur  = run.stats?.duration ? (run.stats.duration/1000).toFixed(1)+'s' : '—';
    const ok   = f === 0;
    return `
      <div class="flex items-center justify-between px-4 py-3 hover:bg-slate-700/20 transition-colors cursor-pointer" onclick="navigate('results')">
        <div class="flex items-center gap-3 min-w-0">
          <span class="text-lg flex-shrink-0 ${ok ? 'text-emerald-400' : 'text-red-400'}">${ok ? '✓' : '✗'}</span>
          <div class="min-w-0">
            <p class="text-sm font-medium text-slate-200 truncate">${run.testFile === 'all' ? 'All Tests' : run.testFile.replace('tests/','')}</p>
            <p class="text-xs text-slate-500">${fmtDate(new Date(run.timestamp))} · ${run.project || 'chromium'}</p>
          </div>
        </div>
        <div class="flex items-center gap-5 text-xs flex-shrink-0 ml-4">
          <span class="text-emerald-400 font-medium">${p} passed</span>
          <span class="${f>0?'text-red-400 font-medium':'text-slate-500'}">${f} failed</span>
          <span class="text-slate-500">${dur}</span>
          <div class="w-20">
            <div class="flex h-1.5 rounded overflow-hidden bg-slate-700">
              <div class="pass-bar" style="width:${rate}%"></div>
              <div class="fail-bar" style="width:${100-rate}%"></div>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── Results ───────────────────────────────────────────────────────────────────
function renderResults() {
  const specs = filteredSpecs();
  const tbody = $('res-tbody');
  if (!tbody) return;

  if (!specs.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">${
      S.latest?.specs?.length ? 'No tests match the current filter.' : 'No results yet — run a test suite first.'
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = specs.map((spec, i) => {
    const dur = fmtDuration(spec.duration);
    const ss  = (spec.attachments || []).filter(a => a.contentType?.startsWith('image/'));
    const hasError = !!spec.error;

    return `
      <tr class="border-b border-slate-700/40 hover:bg-slate-700/15 cursor-pointer transition-colors"
          onclick="toggleRow(${i})">
        <td class="td">${badge(spec.status)}</td>
        <td class="td">
          <p class="text-slate-100 font-medium text-xs leading-snug">${esc(spec.title)}</p>
        </td>
        <td class="td">
          <p class="text-slate-500 text-xs truncate" title="${esc(spec.suite)}">${esc(spec.suite)}</p>
        </td>
        <td class="td text-slate-500">${esc(spec.projectName || 'chromium')}</td>
        <td class="td text-slate-400">${dur}</td>
        <td class="td">${spec.retries > 0 ? `<span class="badge badge-other">↺${spec.retries}</span>` : '<span class="text-slate-600">—</span>'}</td>
        <td class="td">
          <div class="flex gap-2">
            ${ss.length ? `<button class="text-indigo-400 hover:text-indigo-200 text-xs" onclick="event.stopPropagation();showImg('${ss[0].url}')" title="View screenshot">📸</button>` : ''}
            ${hasError ? `<button class="text-red-400 hover:text-red-200 text-xs" onclick="event.stopPropagation();toggleRow(${i})" title="View error">⚠</button>` : ''}
          </div>
        </td>
      </tr>
      <tr id="drow-${i}" class="hidden detail-row">
        <td colspan="7" class="px-6 py-4">
          <div id="dcontent-${i}"></div>
        </td>
      </tr>`;
  }).join('');
}

function filteredSpecs() {
  const specs  = S.latest?.specs || [];
  const search = S.search.toLowerCase();
  return specs.filter(s => {
    if (S.filter !== 'all' && s.status !== S.filter) return false;
    if (search && !s.title.toLowerCase().includes(search) && !s.suite.toLowerCase().includes(search)) return false;
    return true;
  });
}

function filterBy(f) {
  S.filter = f;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById(`ftab-${f}`);
  if (tab) tab.classList.add('active');
  S.expandedRows.clear();
  renderResults();
}

function applyFilter() {
  S.search = ($('res-search')?.value || '').trim();
  S.expandedRows.clear();
  renderResults();
}

function toggleRow(i) {
  const row = document.getElementById(`drow-${i}`);
  if (!row) return;

  if (S.expandedRows.has(i)) {
    S.expandedRows.delete(i);
    row.classList.add('hidden');
    return;
  }
  S.expandedRows.add(i);
  row.classList.remove('hidden');

  const specs = filteredSpecs();
  const spec  = specs[i];
  const cont  = document.getElementById(`dcontent-${i}`);
  if (!spec || !cont) return;

  let html = '';

  if (spec.error) {
    html += `
      <div class="mb-4">
        <p class="text-xs font-semibold text-red-400 uppercase tracking-wider mb-2">Error Message</p>
        <pre class="text-xs text-red-300 bg-red-950/40 border border-red-900/40 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap leading-5 font-mono">${esc(spec.error)}</pre>
      </div>`;
  }

  const images = (spec.attachments || []).filter(a => a.contentType?.startsWith('image/'));
  if (images.length) {
    html += `
      <div>
        <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Screenshots</p>
        <div class="flex gap-3 flex-wrap">
          ${images.map(img => `
            <img src="${img.url}" alt="${esc(img.name)}"
              class="h-40 rounded-lg border border-slate-600 cursor-pointer hover:border-indigo-400 transition-colors object-contain bg-slate-900"
              onclick="showImg('${img.url}')" />`).join('')}
        </div>
      </div>`;
  }

  if (!html) html = '<p class="text-sm text-slate-500">No additional details.</p>';
  cont.innerHTML = html;
}

// ── History ───────────────────────────────────────────────────────────────────
function renderHistory() {
  const el = $('history-list');
  if (!el) return;

  if (!S.history.length) {
    el.innerHTML = '<p class="p-8 text-center text-sm text-slate-500">No run history yet.</p>';
    return;
  }

  el.innerHTML = S.history.map(run => {
    const t   = (run.stats?.expected||0)+(run.stats?.unexpected||0)+(run.stats?.skipped||0);
    const p   = run.stats?.expected   || 0;
    const f   = run.stats?.unexpected || 0;
    const sk  = run.stats?.skipped    || 0;
    const fl  = run.stats?.flaky      || 0;
    const dur = run.stats?.duration ? (run.stats.duration/1000).toFixed(1)+'s' : '—';
    const rate= t ? Math.round((p/t)*100) : 0;
    const ok  = f === 0;
    return `
      <div class="flex items-center gap-4 px-5 py-4 hover:bg-slate-700/20 transition-colors">
        <div class="w-9 h-9 rounded-full flex items-center justify-center text-base flex-shrink-0
                    ${ok ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-800/40'
                          : 'bg-red-900/40 text-red-400 border border-red-800/40'}">
          ${ok ? '✓' : '✗'}
        </div>

        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-slate-200 truncate">
            ${run.testFile === 'all' ? 'All Tests' : run.testFile.replace('tests/','')}
          </p>
          <p class="text-xs text-slate-500">${fmtDate(new Date(run.timestamp))} · ${run.project || 'chromium'}</p>
        </div>

        <div class="flex gap-6 text-center flex-shrink-0">
          ${stat('Passed',  p,  'text-emerald-400')}
          ${stat('Failed',  f,  f>0 ? 'text-red-400' : 'text-slate-500')}
          ${stat('Skipped', sk, 'text-amber-400')}
          ${fl > 0 ? stat('Flaky', fl, 'text-purple-400') : ''}
          ${stat('Total',   t,  'text-slate-400')}
          ${stat('Rate',    rate+'%', rate===100 ? 'text-emerald-400' : rate>=80 ? 'text-amber-400' : 'text-red-400')}
          ${stat('Time',    dur, 'text-slate-400')}
        </div>

        <div class="w-24 flex-shrink-0">
          <div class="flex h-1.5 rounded overflow-hidden bg-slate-700">
            <div class="pass-bar" style="width:${rate}%"></div>
            <div class="fail-bar flex-1"></div>
          </div>
          <p class="text-xs text-slate-600 mt-1 text-right">${t} tests</p>
        </div>
      </div>`;
  }).join('');
}

function stat(label, val, cls) {
  return `<div class="text-center">
    <p class="text-xs text-slate-600 mb-0.5">${label}</p>
    <p class="text-sm font-semibold ${cls}">${val}</p>
  </div>`;
}

async function clearHistory() {
  if (!confirm('Clear all run history? This cannot be undone.')) return;
  await api('/api/history', { method: 'DELETE' });
  S.history = [];
  S.latest  = null;
  renderDashboard();
  renderResults();
  renderHistory();
}

// ── Terminal ──────────────────────────────────────────────────────────────────
function termClear() {
  const t = $('terminal');
  if (t) t.innerHTML = '';
}

function termWrite(text, type) {
  const t = $('terminal');
  if (!t) return;

  const div = document.createElement('span');
  div.innerHTML = ansiToHtml(text);
  if (type === 'info')    div.style.color = '#818cf8';
  if (type === 'success') div.style.color = '#4ade80';
  if (type === 'error')   div.style.color = '#f87171';
  if (type === 'warn')    div.style.color = '#fbbf24';

  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
}

function clearTerminal() {
  termClear();
  const t = $('terminal');
  if (t) t.innerHTML = '<span class="text-slate-600">Terminal cleared.\n</span>';
}

function ansiToHtml(raw) {
  const colorMap = {
    '\\x1b\\[0m' : '</span>',
    '\\x1b\\[1m' : '<span style="font-weight:700">',
    '\\x1b\\[2m' : '<span style="opacity:0.6">',
    '\\x1b\\[31m': '<span style="color:#f87171">',
    '\\x1b\\[32m': '<span style="color:#4ade80">',
    '\\x1b\\[33m': '<span style="color:#fbbf24">',
    '\\x1b\\[34m': '<span style="color:#818cf8">',
    '\\x1b\\[35m': '<span style="color:#c084fc">',
    '\\x1b\\[36m': '<span style="color:#67e8f9">',
    '\\x1b\\[37m': '<span style="color:#e2e8f0">',
    '\\x1b\\[90m': '<span style="color:#475569">',
    '\\x1b\\[91m': '<span style="color:#f87171">',
    '\\x1b\\[92m': '<span style="color:#4ade80">',
    '\\x1b\\[93m': '<span style="color:#fbbf24">',
    '\\x1b\\[94m': '<span style="color:#818cf8">',
    '\\x1b\\[95m': '<span style="color:#c084fc">',
    '\\x1b\\[96m': '<span style="color:#67e8f9">',
  };
  // Split on ANSI codes, escape HTML in text parts, convert codes to HTML
  const parts = raw.split(/(\x1b\[[0-9;]*m)/);
  return parts.map((part, i) => {
    if (i % 2 === 0) return esc(part);
    for (const [re, html] of Object.entries(colorMap)) {
      if (new RegExp('^' + re + '$').test(part)) return html;
    }
    return ''; // unknown ANSI code — strip
  }).join('');
}

// ── Device / Browser options ──────────────────────────────────────────────────
const DEVICE_OPTIONS = {
  desktop: [
    { value: 'chromium', label: 'Chromium',            info: '1280×720 · Desktop Chrome'   },
    { value: 'firefox',  label: 'Firefox',              info: '1280×720 · Desktop Firefox'  },
    { value: 'webkit',   label: 'WebKit (Safari)',      info: '1280×720 · Desktop Safari'   },
  ],
  mobile: [
    { value: 'mobile-iphone-15', label: '🍎 iPhone 15 (Safari)',  info: '393×659 · iOS 17 · WebKit'      },
    { value: 'mobile-iphone-12', label: '🍎 iPhone 12 (Safari)',  info: '390×664 · iOS 14 · WebKit'      },
    { value: 'mobile-pixel-7',   label: '🤖 Pixel 7 (Chrome)',    info: '412×839 · Android 12 · Chrome'  },
    { value: 'mobile-galaxy-s5', label: '🤖 Galaxy S5 (Chrome)',  info: '360×640 · Android 5 · Chrome'   },
    { value: 'mobile-moto-g4',   label: '🤖 Moto G4 (Chrome)',    info: '360×640 · Android 6 · Chrome'   },
  ],
  tablet: [
    { value: 'tablet-ipad-pro',  label: '🍎 iPad Pro 11" (Safari)',  info: '834×1194 · iPadOS · Safari'   },
    { value: 'tablet-ipad-mini', label: '🍎 iPad Mini (Safari)',      info: '768×1024 · iPadOS · Safari'   },
    { value: 'tablet-nexus-10',  label: '🤖 Nexus 10 (Chrome)',       info: '800×1280 · Android · Chrome'  },
  ],
};

function setDeviceType(type) {
  ['desktop', 'mobile', 'tablet'].forEach(t => {
    document.getElementById(`dtype-${t}`)?.classList.toggle('active', t === type);
  });
  const sel = $('cfg-project');
  if (!sel) return;
  sel.innerHTML = '';
  (DEVICE_OPTIONS[type] || []).forEach(opt => {
    const o = document.createElement('option');
    o.value        = opt.value;
    o.textContent  = opt.label;
    o.dataset.info = opt.info;
    sel.appendChild(o);
  });
  updateDeviceInfo();
}

function updateDeviceInfo() {
  const sel = $('cfg-project');
  const el  = $('device-info');
  if (!sel || !el) return;
  const opt = sel.options[sel.selectedIndex];
  el.textContent = opt?.dataset?.info || '';
}

// ── Test Runner ───────────────────────────────────────────────────────────────
function quickRunAll() {
  navigate('runner');
  startRun({ testFile: null });
}

function runFromPanel() {
  const testFile = $('cfg-file')?.value  || null;
  const project  = $('cfg-project')?.value || 'chromium';
  const grep     = $('cfg-grep')?.value?.trim() || null;
  const headed   = $('cfg-headed')?.checked || false;
  startRun({ testFile: testFile || null, project, grep, headed });
}

async function startRun(opts) {
  if (S.running) return;
  navigate('runner');
  await api('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

async function stopRun() {
  await api('/api/run/stop', { method: 'POST' });
}

function parseProgress(text) {
  const m = text.match(/\s+(\d+)\/(\d+)\s/);
  if (!m) return;
  const [, cur, tot] = m;
  const pct = Math.round((+cur / +tot) * 100);
  const bar = $('progress-bar');
  const lbl = $('progress-label');
  if (bar) bar.style.width = `${pct}%`;
  if (lbl) lbl.textContent = `${cur} / ${tot}`;
}

// ── Running UI State ──────────────────────────────────────────────────────────
function setRunningUI(running) {
  S.running = running;

  // Sidebar status
  const rs = $('runner-status');
  if (rs) {
    rs.innerHTML = running
      ? '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"></span><span class="text-emerald-400">Running…</span>'
      : '<span class="w-2 h-2 rounded-full bg-slate-600 flex-shrink-0"></span><span class="text-slate-500">Idle</span>';
  }

  // Header buttons
  toggleHidden('btn-run-all',      running);
  toggleHidden('btn-stop-header', !running);

  // Panel buttons
  toggleHidden('btn-run',          running);
  toggleHidden('btn-stop-panel',  !running);

  // Progress bar
  const prog = $('run-progress');
  if (prog) prog.classList.toggle('hidden', !running);
  if (!running) {
    const bar = $('progress-bar');
    const lbl = $('progress-label');
    if (bar) { bar.style.width = '100%'; setTimeout(() => { bar.style.width = '0%'; }, 1200); }
    if (lbl) lbl.textContent = '';
  }

  // Terminal spinner
  const spin = $('terminal-spinner');
  if (spin) spin.classList.toggle('hidden', !running);
}

// ── Export ────────────────────────────────────────────────────────────────────
function exportCSV() {
  const specs = S.latest?.specs;
  if (!specs?.length) return alert('No results to export.');

  const rows = [
    ['Status','Test Name','Suite','Browser','Duration (ms)','Retries','Error'],
    ...specs.map(s => [
      s.status, s.title, s.suite, s.projectName, s.duration, s.retries,
      (s.error || '').replace(/\n/g,' '),
    ]),
  ];
  const csv  = rows.map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `playwright-results-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function showImg(url) {
  const modal = $('img-modal');
  const img   = $('modal-img');
  if (modal && img) {
    img.src = url;
    modal.classList.remove('hidden');
  }
}

function closeModal() {
  $('img-modal')?.classList.add('hidden');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function setText(id, val) { const el = $(id); if (el) el.textContent = val; }
function toggleHidden(id, hidden) { $(id)?.classList.toggle('hidden', hidden); }

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function badge(status) {
  const map = {
    passed:  ['badge-pass',  '✓ Passed'],
    failed:  ['badge-fail',  '✗ Failed'],
    skipped: ['badge-skip',  '⊘ Skipped'],
    flaky:   ['badge-flaky', '↺ Flaky'],
  };
  const [cls, label] = map[status] || ['badge-other', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function fmtDuration(ms) {
  if (!ms) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`;
}

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric' }) +
         ' ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
}
