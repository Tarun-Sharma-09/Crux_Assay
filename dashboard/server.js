'use strict';

const express    = require('express');
const { WebSocketServer } = require('ws');
const { spawn }  = require('child_process');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');

const PORT         = process.env.PORT || 3000;
const PROJECT_ROOT = path.join(__dirname, '..');
const DB_DIR       = path.join(__dirname, 'db');
const HISTORY_FILE = path.join(DB_DIR, 'history.json');
const LAST_JSON    = path.join(DB_DIR, 'last-results.json');

fs.mkdirSync(DB_DIR, { recursive: true });

// ── Utilities ─────────────────────────────────────────────────────────────────

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function artifactUrl(absPath) {
  if (!absPath) return null;
  const norm = absPath.replace(/\\/g, '/');
  const marker = '/test-results/';
  const idx = norm.indexOf(marker);
  return idx !== -1 ? '/artifacts/' + norm.slice(idx + marker.length) : null;
}

function flattenSpecs(suites, parent) {
  const out = [];
  parent = parent || '';
  for (const suite of (suites || [])) {
    const name = parent ? `${parent} › ${suite.title}` : suite.title;
    for (const spec of (suite.specs || [])) {
      for (const test of (spec.tests || [])) {
        const results = test.results || [];
        const last    = results[results.length - 1] || {};
        out.push({
          suite:       name,
          title:       spec.title,
          status:      last.status || 'unknown',
          duration:    last.duration || 0,
          retries:     Math.max(0, results.length - 1),
          error:       last.errors && last.errors[0] ? last.errors[0].message : null,
          attachments: (last.attachments || [])
            .map(a => ({ name: a.name, contentType: a.contentType, url: artifactUrl(a.path) }))
            .filter(a => a.url),
          projectName: test.projectName || 'chromium',
        });
      }
    }
    out.push(...flattenSpecs(suite.suites, name));
  }
  return out;
}

// ── App ───────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/artifacts',  express.static(path.join(PROJECT_ROOT, 'test-results')));
app.use('/html-report', express.static(path.join(PROJECT_ROOT, 'playwright-report')));

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => res.json({ running: !!currentProcess }));

app.get('/api/tests', (_req, res) => {
  const dir = path.join(PROJECT_ROOT, 'tests');
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /\.(spec|test)\.(js|ts)$/.test(f))
      .map(f => ({ name: f, path: `tests/${f}` }));
    res.json(files);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', (_req, res) => res.json(loadJSON(HISTORY_FILE, [])));

app.delete('/api/history', (_req, res) => {
  saveJSON(HISTORY_FILE, []);
  res.json({ ok: true });
});

app.get('/api/results/latest', (_req, res) => {
  const raw = loadJSON(LAST_JSON, null);
  if (!raw) return res.json(null);
  res.json({ stats: raw.stats || {}, specs: flattenSpecs(raw.suites) });
});

// ── Test Runner ───────────────────────────────────────────────────────────────

let currentProcess = null;

app.post('/api/run', (req, res) => {
  if (currentProcess) return res.status(409).json({ error: 'Already running.' });

  const { testFile, project = 'chromium', grep, headed = false } = req.body || {};
  res.json({ started: true });

  const args = ['playwright', 'test', '--project', project];
  if (testFile) args.push(testFile);
  if (grep)     args.push('--grep', grep);
  if (headed)   args.push('--headed');

  broadcast({ type: 'run:start', args, ts: new Date().toISOString() });

  currentProcess = spawn('npx', args, {
    cwd: PROJECT_ROOT,
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  currentProcess.stdout.on('data', d => broadcast({ type: 'run:output', text: d.toString() }));
  currentProcess.stderr.on('data', d => broadcast({ type: 'run:output', text: d.toString() }));

  currentProcess.on('close', code => {
    currentProcess = null;
    let entry = null;
    try {
      const raw = loadJSON(LAST_JSON, null);
      if (raw) {
        entry = {
          id:        Date.now(),
          timestamp: new Date().toISOString(),
          testFile:  testFile || 'all',
          project:   project  || 'chromium',
          exitCode:  code,
          stats:     raw.stats || {},
          specs:     flattenSpecs(raw.suites),
        };
        const hist = loadJSON(HISTORY_FILE, []);
        hist.unshift(entry);
        if (hist.length > 50) hist.length = 50;
        saveJSON(HISTORY_FILE, hist);
      }
    } catch (e) { console.error('[server] result parse error:', e.message); }
    broadcast({ type: 'run:complete', exitCode: code, entry });
  });
});

app.post('/api/run/stop', (req, res) => {
  if (currentProcess) {
    currentProcess.kill('SIGTERM');
    currentProcess = null;
    broadcast({ type: 'run:stopped' });
    res.json({ stopped: true });
  } else {
    res.json({ stopped: false });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('\n  ======================================');
  console.log('  🎭  Playwright Dashboard');
  console.log(`  →   http://localhost:${PORT}`);
  console.log('  ======================================\n');
});
