#!/usr/bin/env node
// Command-line painter for the Ink simulation. A background daemon serves the
// project and runs headless Chrome; every command attaches to that page over
// the DevTools protocol, drives window.inkBot (bot.js), and keeps the run's
// checkpoint tree in paintings/<run>/run.json. No npm dependencies.
//
//   node ink.mjs help
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Library, KINDS, calibrationSheets, fitCalibration, verificationSheet, residuals } from './strokes.mjs';
import * as CB from './codebook.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const ROOT = findRoot(SKILL);
const PAINTINGS = path.join(ROOT, 'paintings');
const STATE = path.join(PAINTINGS, '.ink');
const DAEMON_FILE = path.join(STATE, 'daemon.json');
const IMGTOOL = path.join(HERE, 'imgtool.py');
const HTTP_PORT = +(process.env.INK_HTTP_PORT || 5199);
const CDP_PORT = +(process.env.INK_CDP_PORT || 9339);
const DEFAULT_MODEL = 'gpt-image-2.5-sunburst';
const STROKES = path.join(SKILL, 'strokes');   // the stroke library's calibrations, reference sheets and saved recipes

function findRoot(from) {
  let d = from;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'index.html')) && fs.existsSync(path.join(d, 'js', 'engine.js'))) return d;
    d = path.dirname(d);
  }
  throw new Error('could not find the Ink project (index.html + js/engine.js) above ' + from);
}

// Replays are exact only while the simulation and bot code are unchanged.
function codeHash() {
  const h = createHash('sha1');
  for (const f of ['index.html', 'js/pigments.js', 'js/shaders.js', 'js/engine.js', 'js/brush.js', 'js/pencilview.js', 'js/app.js']) h.update(fs.readFileSync(path.join(ROOT, f)));
  h.update(fs.readFileSync(path.join(HERE, 'bot.js')));
  return h.digest('hex').slice(0, 12);
}

// the simulation alone (not the bot): what a codebook's marks depend on
function physicsHash() {
  const h = createHash('sha1');
  for (const f of ['js/pigments.js', 'js/shaders.js', 'js/engine.js', 'js/brush.js']) {
    let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // how gouache is displayed does not change what is on the sheet
    if (f === 'js/shaders.js') src = src.replace(/const FS_PAINT_DISPLAY = [\s\S]*?\n`;/, '');
    h.update(src);
  }
  return h.digest('hex').slice(0, 12);
}

// ------------------------------------------------------------ small utils
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg) => { console.error('error: ' + msg); process.exit(1); };
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJSON = (p, v) => { fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(p + '.tmp', p); };
const rel = (p) => path.relative(ROOT, p);
const now = () => new Date().toISOString();
const FLAGS = new Set(['zoom', 'recorded', 'no-blame', 'blame', 'rerender', 'no-preview', 'no-style-ref', 'dry-run', 'force', 'reject', 'no-brush', 'brush', 'no-dry', 'take', 'keep-sheets', 'no-masses', 'act', 'no-band']);
function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq), v = eq < 0 ? undefined : a.slice(eq + 1);
      if (v !== undefined) opt[k] = v;
      else if (!FLAGS.has(k) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
      if (k === 'style-ref' || k === 'image') { opt[k + 's'] = (opt[k + 's'] || []).concat(opt[k] === true ? [] : [opt[k]]); }
    } else pos.push(a);
  }
  return { pos, opt };
}
function savePng(dataUrl, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  return file;
}
function py(args) {
  const r = spawnSync('python3', [IMGTOOL, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error('imgtool ' + args[0] + ' failed: ' + (r.stderr || r.stdout));
  const out = r.stdout.trim().split('\n').pop();
  try { return JSON.parse(out); } catch { return out; }
}
function pyAsync(args) {
  return new Promise((res, rej) => {
    const ch = spawn('python3', [IMGTOOL, ...args]);
    let out = '', err = '';
    ch.stdout.on('data', (d) => (out += d)); ch.stderr.on('data', (d) => (err += d));
    ch.on('close', (code) => {
      if (code !== 0) return rej(new Error('imgtool ' + args[0] + ' failed: ' + (err || out)));
      const last = out.trim().split('\n').pop();
      try { res(JSON.parse(last)); } catch { res(last); }
    });
  });
}
function readActions(src) {
  if (!src) die('give an actions file (JSON array) or - for stdin');
  const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : src;
  let v;
  try { v = JSON.parse(text); } catch (e) { die('actions are not valid JSON: ' + e.message); }
  if (!Array.isArray(v)) v = v.actions;
  if (!Array.isArray(v)) die('actions must be a JSON array (or {"actions": [...]})');
  return v;
}

// ------------------------------------------------------------ daemon
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function cdpUp() {
  try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(800) }); return r.ok; } catch { return false; }
}
function chromePath() {
  const c = [process.env.INK_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const p of c) if (p && fs.existsSync(p)) return p;
  die('no Chrome found; set INK_CHROME to a Chrome/Chromium binary');
}
async function startDaemon(quiet) {
  fs.mkdirSync(STATE, { recursive: true });
  if (fs.existsSync(DAEMON_FILE)) {
    const d = readJSON(DAEMON_FILE);
    if (alive(d.pid) && await cdpUp()) { if (!quiet) console.log(`already running (pid ${d.pid}, http ${d.http}, cdp ${d.cdp})`); return d; }
    fs.rmSync(DAEMON_FILE, { force: true });
  }
  const log = fs.openSync(path.join(STATE, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon'], { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    if (fs.existsSync(DAEMON_FILE) && await cdpUp()) {
      const d = readJSON(DAEMON_FILE);
      if (!quiet) console.log(`started (pid ${d.pid}, http ${d.http}, cdp ${d.cdp}); log ${rel(path.join(STATE, 'daemon.log'))}`);
      return d;
    }
  }
  die('daemon did not come up; see ' + rel(path.join(STATE, 'daemon.log')));
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
async function runDaemon() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    const hidden = p.split(/[/\\]/).some((seg) => seg.startsWith('.')) || p.startsWith('paintings');
    if (!f.startsWith(ROOT + path.sep) || hidden || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r, j) => server.listen(HTTP_PORT, '127.0.0.1', r).on('error', j));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-chrome-'));
  const chrome = spawn(chromePath(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1600,1100', '--ignore-gpu-blocklist', '--enable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--hide-scrollbars', '--mute-audio', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  chrome.stderr.on('data', (d) => { tail = (tail + d).slice(-6000); });   // kept for the log if it dies
  const cleanup = () => {
    try { chrome.kill('SIGTERM'); } catch {}
    try { fs.rmSync(DAEMON_FILE, { force: true }); } catch {}
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(0); }, 500);
  };
  chrome.on('exit', (code, sig) => { console.log(now(), `chrome exited (${code ?? sig})\n` + tail.split('\n').slice(-25).join('\n')); cleanup(); });
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  writeJSON(DAEMON_FILE, { pid: process.pid, chrome: chrome.pid, http: HTTP_PORT, cdp: CDP_PORT, started: now() });
  console.log(now(), `daemon up: http ${HTTP_PORT}, cdp ${CDP_PORT}, root ${ROOT}`);
}
async function stopDaemon() {
  if (!fs.existsSync(DAEMON_FILE)) { console.log('not running'); return; }
  const d = readJSON(DAEMON_FILE);
  if (alive(d.pid)) process.kill(d.pid, 'SIGTERM');
  for (let i = 0; i < 40 && alive(d.pid); i++) await sleep(100);
  fs.rmSync(DAEMON_FILE, { force: true });
  console.log('stopped');
}

// ------------------------------------------------------------ CDP
class Page {
  // the painting's tab, or a named tab of its own (a long job such as a
  // codebook build runs in one, so the painting stays usable meanwhile)
  static async open(tab) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const mine = (x) => x.type === 'page' && (tab ? x.url.includes(`tab=${tab}`) || x.title === `ink-${tab}` : !/[?&]tab=/.test(x.url) && !/^ink-/.test(x.title || ''));
    let t = list.find(mine);
    if (!t) t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const p = new Page();
    p.ws = new WebSocket(t.webSocketDebuggerUrl);
    p.id = 0; p.pending = new Map(); p.logs = [];
    p.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') p.logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') p.logs.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    });
    p.ws.addEventListener('close', (ev) => {
      p.logs.push(`socket closed ${ev.code} ${ev.reason || ''}`);
      const err = { error: { message: 'lost the connection to headless Chrome (the page may have crashed or run out of GPU memory)' + (p.logs.length ? ': ' + p.logs.slice(-3).join('; ') : '') } };
      for (const r of p.pending.values()) r(err);
      p.pending.clear();
      p.closed = true;
    });
    await new Promise((r, j) => { p.ws.addEventListener('open', r, { once: true }); p.ws.addEventListener('error', j, { once: true }); });
    // keep the process alive while a call is outstanding
    p.keepAlive = setInterval(() => {}, 1 << 30);
    return p;
  }
  send(method, params = {}) {
    if (this.closed) return Promise.resolve({ error: { message: 'connection to headless Chrome is closed' } });
    return new Promise((r) => { const i = ++this.id; this.pending.set(i, r); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async eval(expr) {
    const m = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (m.error) throw new Error(m.error.message);
    if (m.result.exceptionDetails) {
      const d = m.result.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return m.result.result.value;
  }
  async call(fn, ...args) {
    const argStr = JSON.stringify(args);
    const t0 = Date.now();
    if (process.env.INK_TRACE) process.stderr.write(`[call] ${String(fn).replace(/\s+/g, ' ').slice(0, 70)} (${(argStr.length / 1024).toFixed(0)} KB)\n`);
    const r = await this.eval(`window.inkBot._pack((${fn})(...${argStr}))`);
    if (process.env.INK_TRACE) process.stderr.write(`[done] ${Date.now() - t0} ms\n`);
    const fetchBig = async (b) => {
      const parts = [];
      for (let i = 0; i < b.n; i += 1 << 20) parts.push(await this.eval(`inkBot._take(${JSON.stringify(b.__big)}, ${i}, ${1 << 20})`));
      await this.eval(`inkBot._free(${JSON.stringify(b.__big)})`);
      return parts.join('');
    };
    if (r && r.__big) return fetchBig(r);
    if (r && typeof r === 'object') for (const k of Object.keys(r)) {
      if (r[k] && r[k].__big) r[k] = await fetchBig(r[k]);
      else if (Array.isArray(r[k])) for (let i = 0; i < r[k].length; i++) if (r[k][i] && r[k][i].__big) r[k][i] = await fetchBig(r[k][i]);
    }
    return r;
  }
  close() { clearInterval(this.keepAlive); try { this.ws.close(); } catch {} }
}

// ------------------------------------------------------------ runs
const runDir = (id) => path.join(PAINTINGS, id);
const runFile = (id) => path.join(runDir(id), 'run.json');
function loadRun(id) {
  if (!id) die('name the run (see: ink.mjs list)');
  if (!fs.existsSync(runFile(id))) die(`no run "${id}" in ${rel(PAINTINGS)} (create it with: ink.mjs new ${id})`);
  return readJSON(runFile(id));
}
const saveRun = (run) => writeJSON(runFile(run.id), run);
const cpDir = (run) => path.join(runDir(run.id), 'checkpoints');
function logEvent(run, ev) { fs.appendFileSync(path.join(runDir(run.id), 'log.jsonl'), JSON.stringify(Object.assign({ t: now() }, ev)) + '\n'); }
function pathTo(run, id) {
  const out = [];
  for (let c = id; c; c = run.checkpoints[c].parent) out.unshift(c);
  return out;
}
function ancestor(run, id, n) {
  let c = id;
  for (let i = 0; i < n && run.checkpoints[c].parent; i++) c = run.checkpoints[c].parent;
  return c;
}
function resolveCp(run, ref) {
  if (!ref || ref === 'head') return run.head;
  if (run.checkpoints[ref]) return ref;
  const m = /^(\d+)$/.exec(ref);
  if (m) { const id = 'cp-' + String(+m[1]).padStart(4, '0'); if (run.checkpoints[id]) return id; }
  if (ref === 'best') return bestCp(run);
  die(`no checkpoint "${ref}"`);
}
function bestCp(run) {
  let best = null;
  for (const [id, c] of Object.entries(run.checkpoints)) if (c.score && (!best || c.score.score < run.checkpoints[best].score.score)) best = id;
  return best || run.head;
}

// Make the page hold this run at checkpoint `id`, restoring a resident
// snapshot or replaying actions from the nearest one (or from blank).
async function attach(run, id, tab) {
  await startDaemon(true);
  // each run gets its own page by default, so two runs worked on at once
  // never draw into each other's canvas
  tab = tab || run.id;
  const page = await Page.open(tab);
  page.tab = tab;
  await page.send('Runtime.enable');
  const want = id || run.head;
  let st = null;
  try { st = await page.eval(`window.inkBot ? { runId: inkBot.runId, head: inkBot.head, resident: inkBot.status().resident, code: inkBot.code } : null`); } catch {}
  // a page loaded with older app or bot code is rebuilt (by replay) with the current code
  if (!st || st.runId !== run.id || st.code !== codeHash()) {
    await load(page, run);
    st = { runId: run.id, head: 'cp-0000', resident: ['cp-0000'] };
  }
  if (st.head === want && st.resident.includes(want)) return page;
  const chain = pathTo(run, want);
  let k = chain.length - 1;
  while (k > 0 && !st.resident.includes(chain[k])) k--;
  if (!(await page.call((i) => inkBot.restore(i), chain[k]))) {
    await load(page, run); k = 0;
  }
  if (k < chain.length - 1) {
    process.stderr.write(`replaying ${chain.length - 1 - k} checkpoint(s) to rebuild ${want}...\n`);
    if (run.code && run.code !== codeHash()) process.stderr.write(`warning: the simulation or bot code changed since this run was started (${run.code} → ${codeHash()}); replayed checkpoints can differ from their saved renders\n`);
  }
  for (let i = k + 1; i < chain.length; i++) {
    const c = run.checkpoints[chain[i]];
    const r = await page.call((a) => inkBot.run(a), c.actions);
    if (r.error) die(`replay of ${chain[i]} failed: ${r.error}`);
    await page.call((i2) => inkBot.snapshot(i2), chain[i]);
  }
  return page;
}
async function load(page, run) {
  const url = `http://127.0.0.1:${HTTP_PORT}/?blank&res=${run.res}&orient=${run.orient}${page.tab ? `&tab=${page.tab}` : ''}`;
  await page.send('Page.enable');
  await page.send('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try { if (await page.eval('!!(window.inkApp && window.inkEngine && document.readyState === "complete")')) break; } catch {}
    if (i === 99) die('the app did not start in headless Chrome: ' + page.logs.join('; '));
  }
  await sleep(250);   // let the initial resize observer settle
  await page.eval(fs.readFileSync(path.join(HERE, 'bot.js'), 'utf8'));
  await page.eval(`inkBot.code = ${JSON.stringify(codeHash())}`);
  await page.call((o) => inkBot.init(o), { medium: run.medium, paper: run.paper, seed: run.seed, humidity: run.humidity, runId: run.id, maxResident: run.maxResident || 12, displayWidth: run.displayWidth || 1536, palette: run.palette, engine: run.engine });
  await page.call(() => inkBot.snapshot('cp-0000'));
}

// Snapshot the page as a new checkpoint under the run's head, render it wet
// and dried, and score the dried look against the target.
async function checkpoint(run, page, actions, opt, extra, footprints, fpLabels) {
  const id = 'cp-' + String(run.next).padStart(4, '0');
  run.next++;
  await page.call((i) => inkBot.snapshot(i), id);
  const dir = cpDir(run);
  const st = await page.call(() => inkBot.status());
  const wet = savePng(await page.call(() => inkBot.render()), path.join(dir, id + '.png'));
  let dry = wet, dryInfo = { seconds: 0, dry: true };
  if (st.awake && !opt['no-preview']) {
    const p = await page.call((o) => inkBot.previewDry(o), { max: +opt['preview-max'] || 240 });
    dry = savePng(p.png, path.join(dir, id + '-dry.png'));
    dryInfo = { seconds: p.seconds, dry: p.dry };
  }
  const parent = run.head;
  const cp = { parent, actions, created: now(), clock: st.clock, wet: st.awake, render: rel(wet), dry: rel(dry), preview: dryInfo, note: opt.note || '' };
  Object.assign(cp, extra || {});
  if (run.target && fs.existsSync(path.join(runDir(run.id), run.target))) {
    const prev = run.checkpoints[parent] && run.checkpoints[parent].score;
    const args = scoreArgs(run, dry, ['--eval', path.join(dir, id + '-eval.png'), '--title', `${run.id} ${id} (from ${parent}, +${actions.length} actions, ${st.clock}s)`]);
    if (prev) args.push('--prev', JSON.stringify(prev));
    const s = py(args);
    cp.score = s;
    cp.eval = rel(s.eval);
    const blank = run.checkpoints['cp-0000'].score;
    if (blank) cp.progress = Math.round((100 * (blank.score - s.score)) / blank.score);
    // local judge: did this batch improve the sheet where it painted, and which action hurt
    const par = run.checkpoints[parent];
    if (par && par.dry) {
      const fp = (footprints || []).map((d, k) => savePng(d, path.join(dir, `${id}-a${k + 1}.png`)));
      const jargs = ['judge', path.join(runDir(run.id), run.target), path.join(ROOT, par.dry), dry];
      if (run.paperRGB) jargs.push('--paper', run.paperRGB.join(','));
      if (run.medium === 'gouache') jargs.push('--opaque');
      if (fp.length && par.render) jargs.push('--parent-wet', path.join(ROOT, par.render), '--footprints', ...fp, '--labels', JSON.stringify(fpLabels || actions.map((a) => a.label || a.type)));
      cp.judge = py(jargs);
      cp.footprints = fp.map(rel);
    }
  }
  run.checkpoints[id] = cp;
  run.head = id;
  saveRun(run);
  return id;
}
function scoreArgs(run, render, extra) {
  const a = ['score', path.join(runDir(run.id), run.target), render];
  if (run.paperRGB) a.push('--paper', run.paperRGB.join(','));
  if (run.medium === 'gouache') a.push('--opaque');
  return a.concat(extra || []);
}
function describe(run, id) {
  const c = run.checkpoints[id];
  const s = c.score;
  const bits = [`${id} ← ${c.parent || '-'}  +${c.actions.length} actions  t=${c.clock}s${c.wet ? ' (wet)' : ''}`];
  if (s) {
    const d = s.delta || {};
    const f = (k, lbl) => `${lbl} ${s[k]}${d[k] != null ? ` (${d[k] >= 0 ? '+' : ''}${d[k]})` : ''}`;
    bits.push('  ' + [f('score', 'score'), f('error', 'error'), f('too_dark', 'too-dark'), f('too_light', 'too-light'), f('colour', 'colour'), f('ssim', 'ssim'), f('whites_lost', 'whites-lost')].join('  '));
    bits.push('  worst: ' + s.worst.slice(0, 4).map((w) => `${w.cell} x${w.x[0]}-${w.x[1]} y${w.y[0]}-${w.y[1]} ${w.kind} (L ${w.render_L} vs ${w.target_L})`).join('; '));
  }
  const j = c.judge;
  if (j) {
    if (j.verdict === 'no change') bits.push('  judge: no visible change');
    else {
      let line = `  judge: ${j.verdict.toUpperCase()}  net ${j.net >= 0 ? '+' : ''}${j.net}${j.net_fine != null ? ` [fine ${j.net_fine} · near ${j.net_coarse}]` : ''}  (where it painted: error ${j.local_error_change >= 0 ? '−' : '+'}${Math.abs(j.local_error_change)}%, precision ${j.precision}, over-dark ${j.over_dark}, texture ${j.texture})`;
      if (c.progress != null) line += `  progress ${c.progress}%`;
      bits.push(line);
      if (j.actions && j.actions.length) {
        bits.push('  per action: ' + j.actions.map((a) => `${a.i + 1}:${a.label || '?'} ${a.area ? `${a.net >= 0 ? '+' : ''}${a.net}${a.over_share >= 0.2 ? ` (${Math.round(a.over_share * 100)}% of over-dark)` : ''}` : '—'}`).join(' · '));
        if (j.culprit != null) bits.push(`  culprit: action ${j.culprit + 1} (${j.actions[j.culprit].label}) → to keep the rest: checkout ${run.id} ${id}@${j.culprit}  (the batch minus it and what followed)`);
      }
    }
  }
  bits.push(`  view: ${c.eval || c.dry}${c.wet ? `  (wet: ${c.render}, dried in ${c.preview.seconds}s${c.preview.dry ? '' : ', still damp'})` : ''}`);
  if (c.note) bits.push('  note: ' + c.note);
  return bits.join('\n');
}

// ------------------------------------------------------------ commands
const C = {};

C.help = () => console.log(`ink.mjs — paint with the Ink simulation from the command line

daemon     start | stop                        headless Chrome + static server (auto-started)
runs       list
           new <run> [--medium watercolor|ink|pencil] [--paper P] [--orient landscape|portrait]
                     [--res 1024] [--seed N] [--humidity 55] [--every 6] [--subject "..."]
           info <run>                          palette, brushes, tools, sheet size
reference  reference <run> --prompt "subject" [--quality high] [--size 1536x1024] [--model ${DEFAULT_MODEL}]
                     [--no-style-ref] [--style-ref img.png ...] [--from existing.png] [--dry-run]
           target <run> [--fit crop|pad]       (re)build target.png from reference.png
           calibrate <run> [--force]           painted swatches: pigment x load -> colour on this paper
           regions <run> [--by value|color] [--levels 4] [--k 6]
painting   act <run> <actions.json|-> [--every N] [--no-preview] [--note "..."]
           try <run> <actions.json|->          lookahead: act, then roll back (the branch stays in the tree)
           scratch <run> <actions.json|->      test on blank scrap paper (painting untouched)
           back <run> [n]                      roll back n checkpoints (default 1)
           checkout <run> <cp|best|cp@k>       jump to any checkpoint (any branch); cp@k = its first k actions
           judge <run> [cp]                    verdict where the batch painted, per-action blame, alternatives
strokes    strokes list | calibrate <run> | sheet <run> | test <run> <file> | save <run> <name> <file>
           trace <run> --box x0,y0,x1,y1 [--darker-than 60]   measure marks in the target (centreline, width, value)
           rejudge <run>                       re-run the judge over every checkpoint
search     search <run> <spec.json> [--keep 3] [--sheet 8] [--no-dry] [--rank net|sheet] [--take]
zoom       zoom <run> --box x0,y0,x1,y1 [--cp id] [--grid 0.01]   a close look: target | painting | difference, fine grid
preview    preview <run> <file> [--box x0,y0,x1,y1]   where gestures will go (integrated, not painted), over target and painting
codebook   codebook build <run> [--n 12000] | info <run> | query <run> ... | fit <run> --box ... | test <run>
                                               variants of a batch (or alternatives) evaluated in the page, best kept
           note <run> <cp> "text" [--reject]
           tree <run> | show <run> [cp] | status <run>
           finish <run> [--from cp]            dry, render final.png + final-eval.png
           verify <run>                        check a replay from blank reproduces the head exactly
video      record <run> on|off [--every 4] [--width 1280]   time-lapse frames while painting (act)
           video <run> [--out file.mp4] [--fps 30] [--speed 1]   build the painting video (with checkpoints and rollbacks)
           timelapse <run> [--seconds 36] [--brush] [--no-tool]   just the canvas (and the pencil, on pencil runs), only what was kept
                     [--zoom [--lag 4,20] [--seed 7]] [--frames N] [--total S] [--realtime last]
                     follow the zoom levels; exactly S seconds long; the last checkpoint (a signature) in real time

actions: see .claude/skills/paint/ACTIONS.md`);

C.start = () => startDaemon(false);
C.stop = () => stopDaemon();
C.__daemon = () => runDaemon();

// ---------------------------------------------------------- stroke library
function libMarkCells(lib, actions) {
  // for each lib action, a measuring cell around the mark it asked for
  const cells = [];
  actions.forEach((a, i) => {
    if (!a || a.type !== 'lib' || ['mist', 'wash', 'stack'].includes(a.stroke) || (a.stroke || '').startsWith('saved:')) return;
    let A, B;
    if (a.stroke === 'band') { A = [a.x0, a.y]; B = [a.x1, a.y]; }
    else if (a.stroke === 'dab') {
      const ang = ((a.angle || 0) * Math.PI) / 180, h = a.length / 2;
      A = [a.at[0] - (Math.cos(ang) * h) / lib.sheetMM[0], a.at[1] - (Math.sin(ang) * h) / lib.sheetMM[1]];
      B = [a.at[0] + (Math.cos(ang) * h) / lib.sheetMM[0], a.at[1] + (Math.sin(ang) * h) / lib.sheetMM[1]];
    } else if (a.stroke === 'blade') { A = a.from; B = a.to; }
    else { const p = a.path || [a.from, a.to]; A = p[0]; B = p[p.length - 1]; }
    const pad = ((a.width || 6) * 1.5 + 8) / lib.sheetMM[0];
    cells.push({ i, kind: a.stroke === 'blade' ? 'blade' : 'width', stroke: a.stroke, want: { width: a.width, value: a.value }, axis: [A, B],
      box: [Math.min(A[0], B[0]) - pad, Math.min(A[1], B[1]) - pad * 1.33, Math.max(A[0], B[0]) + pad, Math.max(A[1], B[1]) + pad * 1.33] });
  });
  return cells;
}
// Paint library strokes on scrap, measure each mark against what was asked.
async function verifyLibrary(run, page, src, out) {
  const lib = library(run);
  const acts = expandRegions(run, src);
  const img = savePng(await scratchRender(run, page, acts, 'verification'), out);
  const cells = libMarkCells(lib, src);
  const cf = path.join(STROKES, '.cells-verify.json');
  fs.writeFileSync(cf, JSON.stringify(cells));
  const measured = cells.length ? py(['measure', img, cf, '--paper', (run.paperRGB || [244, 240, 229]).join(','), '--sheet', (run.sheetMM || [304.8, 228.6]).join(',')]) : [];
  fs.rmSync(cf, { force: true });
  const marked = img.replace(/\.png$/, '-marked.png');
  py(['grid', img, marked]);
  const errs = { ends: [], width: [], value: [] };
  const rows = measured.map((r) => {
    const a = src[r.i];
    if (!r.found) return { i: r.i, label: a.label || a.stroke, found: false };
    const endErr = r.kind === 'blade' ? [r.a * lenOf(a.from, a.to), (1 - r.b) * lenOf(a.from, a.to)] : [r.start_mm, r.end_mm];
    errs.ends.push(Math.abs(endErr[0]), Math.abs(endErr[1]));
    if (a.width) errs.width.push(Math.abs(r.width_mm - a.width) / a.width);
    if (a.value != null) errs.value.push(Math.abs(r.L - a.value));
    return { i: r.i, label: a.label || a.stroke, found: true, width: r.width_mm, want_width: a.width, L: r.L, want_L: a.value, ends: endErr.map((v) => +v.toFixed(1)) };
  });
  const med = (xs) => { const s = [...xs].sort((p, q) => p - q); return s.length ? +s[s.length >> 1].toFixed(2) : null; };
  return { img, marked, measured, rows, summary: { ends_mm: med(errs.ends), width_rel: med(errs.width), value_L: med(errs.value), missing: rows.filter((r) => !r.found).length } };
}
const lenOf = (A, B) => Math.hypot((B[0] - A[0]) * 304.8, (B[1] - A[1]) * 228.6);
function printAccuracy(res) {
  for (const r of res.rows) {
    if (!r.found) { console.log(`  ${String(r.i).padStart(2)}: ${r.label.padEnd(16)} no mark found`); continue; }
    console.log(`  ${String(r.i).padStart(2)}: ${r.label.padEnd(16)} width ${String(r.width).padStart(5)} mm (asked ${r.want_width})  L${String(Math.round(r.L)).padStart(3)} (asked ${r.want_L})  ends ${r.ends[0] >= 0 ? '+' : ''}${r.ends[0]} / ${r.ends[1] >= 0 ? '+' : ''}${r.ends[1]} mm`);
  }
  const s = res.summary;
  console.log(`  median error: ends ${s.ends_mm} mm · width ${Math.round(s.width_rel * 100)}% · value ${s.value_L} L*${s.missing ? ` · ${s.missing} missing` : ''}`);
}
async function scratchRender(run, page, actions, name) {
  const r = await page.call((a, o) => inkBot.scratch(a, o), actions, { max: 300 });
  if (r.error) die(`${name}: ${r.error}`);
  return r.png;
}

C.strokes = async ({ pos, opt }) => {
  const sub = pos[0];
  if (!sub || sub === 'list') {
    console.log('library strokes (use as {"type": "lib", "stroke": <name>, ...}; see LIBRARY.md):');
    for (const [k, v] of Object.entries(KINDS)) console.log(`  ${k.padEnd(9)} ${v}`);
    for (const m of ['ink', 'watercolor', 'gouache']) {
      const f = savedFile(m);
      if (fs.existsSync(f)) console.log(`\nsaved (${m}): ` + Object.entries(readJSON(f)).map(([k, v]) => `saved:${k} — ${v.description || ''}`).join('\n  '));
      const cals = fs.existsSync(STROKES) ? fs.readdirSync(STROKES).filter((x) => x.startsWith(`calibration-${m}-`)) : [];
      if (cals.length) console.log(`calibrated (${m}): ${cals.map((x) => x.replace(/^calibration-|\.json$/g, '')).join(', ')}`);
    }
    return;
  }
  const run = loadRun(pos[1]);
  fs.mkdirSync(STROKES, { recursive: true });
  if (sub === 'calibrate') {
    if (fs.existsSync(calFile(run)) && !opt.force) { console.log(`already calibrated: ${rel(calFile(run))} (--force to redo)`); return; }
    if (run.medium === 'pencil') return pencilCalibrate(run);
    const page = await attach(run);
    const page2 = () => page;
    const lib = library(run);
    const measured = [];
    for (const sh of calibrationSheets(run.medium)) {
      process.stderr.write(`painting calibration sheet "${sh.name}" (${sh.actions.length} strokes)...\n`);
      const acts = sh.actions.flatMap((a) => (a.type === 'lib' ? lib.expand(a) : [a]));
      const img = savePng(await scratchRender(run, page, acts, sh.name), path.join(STROKES, `cal-${run.medium}-${run.paper}-${sh.name}.png`));
      const cf = path.join(STROKES, `.cells-${sh.name}.json`);
      fs.writeFileSync(cf, JSON.stringify(sh.cells));
      const m = py(['measure', img, cf, '--paper', (run.paperRGB || [244, 240, 229]).join(','), '--sheet', (run.sheetMM || [304.8, 228.6]).join(',')]);
      fs.rmSync(cf, { force: true });
      measured.push(...m);
    }
    const passes = +opt.passes || 3;
    const cal = fitCalibration(measured, { medium: run.medium, paper: run.paper, brush: run.medium === 'ink' ? 'fude' : 'round', paperL: run.paperRGB ? sRGBtoL(run.paperRGB) : 95, code: codeHash() });
    writeJSON(calFile(run), cal);
    // closed loop: paint marks asked for in mark space, measure what is still
    // off for each kind of stroke, fold it into per-kind corrections
    const vs = verificationSheet(run.medium);
    for (let k = 0; k < passes; k++) {
      process.stderr.write(`verification pass ${k + 1}/${passes}...\n`);
      const res = await verifyLibrary(run, page2(), vs, path.join(STROKES, `verify-${run.medium}-${run.paper}-${k + 1}.png`));
      cal.corrections = residuals(vs, res.measured, cal.corrections);
      cal.accuracy = res.summary;
      writeJSON(calFile(run), cal);
    }
    const fin = await verifyLibrary(run, page2(), vs, path.join(STROKES, `reference-${run.medium}-${run.paper}.png`));
    cal.accuracy = fin.summary;
    writeJSON(calFile(run), cal);
    const miss = measured.filter((m) => !m.found).length;
    console.log(`stroke calibration → ${rel(calFile(run))} (${measured.length - miss} marks measured${miss ? `, ${miss} not found` : ''})`);
    console.log('width mm (size × pressure 0.3 / 0.45 / 0.6 / 0.8), lag start/end mm:');
    for (const size of cal.width.sizes) {
      const rows = cal.width.rows.filter((r) => r.size === size).sort((a, b) => a.pressure - b.pressure);
      console.log(`  size ${size}: ` + rows.map((r) => `${r.width.toFixed(1)}`).join(' / ') + `   lag ${rows.map((r) => `${r.start.toFixed(1)}/${r.end.toFixed(1)}`).join(' ')}`);
    }
    for (const [k, v] of Object.entries(cal.value)) if (['line', 'drybrush', 'band', 'mist'].includes(k)) console.log(`  ${k.padEnd(8)} L by load: ` + v.rows.map((r) => `${r.load}:L${Math.round(r.L)}`).join(' '));
    console.log('  blades (size/press → max width mm, mark covers path a..b): ' + cal.blade.rows.map((r) => `${r.size}/${r.press}:${r.width.toFixed(1)} ${r.a.toFixed(2)}..${r.b.toFixed(2)}`).join('  '));
    console.log('corrections per kind (ends mm, width ×, darkness × at D): ' + Object.entries(cal.corrections || {}).map(([k, v]) => `${k} ${v.start}/${v.end} ×${v.width} [${(v.dark || []).map((q) => `${q[0]}:${q[1]}`).join(' ')}]`).join(' · '));
    console.log(`\naccuracy after calibration (reference sheet ${rel(path.join(STROKES, `reference-${run.medium}-${run.paper}-marked.png`))}):`);
    printAccuracy(fin);
    page.close();
    return;
  }
  if (sub === 'test' || sub === 'sheet') {
    const src = sub === 'sheet' ? verificationSheet(run.medium) : readActions(pos[2]);
    const page = await attach(run);
    const out = sub === 'sheet' ? path.join(STROKES, `reference-${run.medium}-${run.paper}.png`) : path.join(runDir(run.id), 'scratch', `strokes-test-${Date.now()}.png`);
    const res = await verifyLibrary(run, page, src, out);
    page.close();
    console.log(`${sub === 'sheet' ? 'reference sheet' : 'stroke test'}: ${rel(res.marked)}`);
    printAccuracy(res);
    return;
  }
  if (sub === 'save') {
    const name = pos[2], file = pos[3];
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || !file) die('usage: strokes save <run> <name> <actions.json> [--from x,y --to x,y] [--value L] [--description "..."]');
    const written = readActions(file);
    // recorded from gestures only: a motion, usable on runs that draw by motion
    const motion = written.every((a) => !a || MOTION_OK.has(a.type) || (a.type === 'lib' && a.stroke === 'gesture'));
    const acts = expandRegions(run, written);
    const pts = acts.flatMap((a) => a.pts || (a.at ? [a.at] : []) || []);
    const from = opt.from ? opt.from.split(',').map(Number) : pts[0], to = opt.to ? opt.to.split(',').map(Number) : pts[pts.length - 1];
    const f = savedFile(run.medium);
    const all = fs.existsSync(f) ? readJSON(f) : {};
    all[name] = { description: opt.description || '', from: from.slice(0, 2), to: to.slice(0, 2), value: opt.value != null ? +opt.value : null, paper: run.paper, motion, actions: acts, saved: now() };
    writeJSON(f, all);
    console.log(`saved stroke "${name}" (${acts.length} actions${motion ? ', a recorded motion' : ''}) → ${rel(f)}; use {"type": "lib", "stroke": "saved:${name}", "from": [x, y], "to": [x, y]}`);
    return;
  }
  die('strokes: list | calibrate <run> | test <run> <file> | sheet <run> | save <run> <name> <file>');
};

C.list = () => {
  if (!fs.existsSync(PAINTINGS)) return console.log('no runs yet');
  for (const d of fs.readdirSync(PAINTINGS)) {
    if (!fs.existsSync(runFile(d))) continue;
    const r = readJSON(runFile(d));
    const s = r.checkpoints[r.head].score;
    console.log(`${d.padEnd(24)} ${r.medium}/${r.paper}  ${Object.keys(r.checkpoints).length} checkpoints  head ${r.head}${s ? ` score ${s.score}` : ''}  ${r.subject || ''}`);
  }
};

C.new = async ({ pos, opt }) => {
  const id = pos[0];
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) die('run names are letters, digits, . _ -');
  if (fs.existsSync(runFile(id)) && !opt.force) die(`run "${id}" exists (use --force to start it over)`);
  const medium = opt.medium || 'watercolor';
  if (!['watercolor', 'ink', 'pencil', 'gouache'].includes(medium)) die('--medium is watercolor, ink, pencil or gouache');
  const papers = medium === 'ink' ? ['xuan', 'xuanHalf', 'xuanSized'] : medium === 'pencil' ? ['bristol', 'drawing', 'toothy'] : medium === 'gouache' ? ['board', 'canvas', 'cold'] : ['hot', 'cold', 'rough'];
  const paper = opt.paper || papers[medium === 'ink' || medium === 'gouache' ? 0 : 1];
  if (!papers.includes(paper)) die(`--paper for ${medium} is one of ${papers.join(', ')}`);
  fs.rmSync(runDir(id), { recursive: true, force: true });
  fs.mkdirSync(cpDir({ id }), { recursive: true });
  const run = {
    id, created: now(), medium, paper, orient: opt.orient === 'portrait' ? 'portrait' : 'landscape',
    res: +opt.res || 1024, seed: +opt.seed || (1 + Math.floor(Math.random() * 2e9)), humidity: +opt.humidity || 55,
    every: +opt.every || 6, subject: opt.subject || '', displayWidth: 1536, maxResident: +opt['max-resident'] || 12,
    authoring: medium === 'pencil' || medium === 'gouache' ? 'motion' : 'paths',   // pencil and gouache: marks are written as gestures only
    reference: null, target: null, head: 'cp-0000', next: 1, code: codeHash(),
    checkpoints: { 'cp-0000': { parent: null, actions: [], created: now(), clock: 0, wet: false, note: 'blank sheet' } },
  };
  saveRun(run);
  const page = await attach(run);
  const info = await page.call(() => inkBot.info());
  savePng(await page.call(() => inkBot.render()), path.join(runDir(id), 'blank.png'));
  run.checkpoints['cp-0000'].render = run.checkpoints['cp-0000'].dry = rel(path.join(runDir(id), 'blank.png'));
  run.sheetMM = info.sheetMM;
  saveRun(run);
  logEvent(run, { ev: 'new', medium, paper });
  page.close();
  console.log(`new run ${id}: ${medium} on ${paper}, ${info.sheetMM[0]}×${info.sheetMM[1]} mm, sim ${info.sim.join('×')}, seed ${run.seed}`);
  console.log(`dir ${rel(runDir(id))}  (next: reference, target, calibrate, regions)`);
  printInfo(info);
};

function printInfo(info) {
  console.log(`\npigments (${info.medium}):`);
  for (const p of info.pigments) console.log(`  ${p.index} ${p.short.padEnd(16)} ${p.code.padEnd(12)} ${p.opacity}${p.staining ? ', staining' : ''}${p.granulating ? ', granulating' : ''}  masstone rgb(${p.preview.masstone}) tint rgb(${p.preview.tint})`);
  console.log('\nbrushes (size index: width mm):');
  for (const [b, sizes] of Object.entries(info.brushes)) console.log(`  ${b.padEnd(7)} ` + sizes.map((s) => `${s.size}:${s.widthMM}`).join(' '));
  console.log(`\ntools: ${info.tools.join(', ')}   papers: ${info.papers.join(', ')}   defaults: ${JSON.stringify(info.defaults)}`);
}

C.info = async ({ pos }) => {
  const run = loadRun(pos[0]);
  const page = await attach(run);
  printInfo(await page.call(() => inkBot.info()));
  page.close();
};

// ---------------------------------------------------------- reference image
function apiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const envf = path.join(ROOT, '.env');
  if (fs.existsSync(envf)) {
    const m = /^\s*OPENAI_API_KEY\s*=\s*["']?([^"'\s]+)/m.exec(fs.readFileSync(envf, 'utf8'));
    if (m) return m[1];
  }
  return null;
}
function stylePrompt(run, info, subject, withRef) {
  const names = info.pigments.map((p) => p.name).join(', ');
  const ink = run.medium === 'ink', pencil = run.medium === 'pencil', gouache = run.medium === 'gouache';
  const paper = gouache ? { board: 'smooth white illustration board', canvas: 'fine primed cotton canvas', cold: 'cold-press watercolor paper' }[run.paper]
    : pencil ? { bristol: 'smooth bristol board', drawing: 'medium-tooth white drawing paper', toothy: 'toothy laid drawing paper' }[run.paper]
    : { xuan: 'raw, unsized xuan (rice) paper', xuanHalf: 'half-sized xuan paper', xuanSized: 'fully sized xuan paper', hot: 'hot-press cotton watercolor paper', cold: '300 gsm cold-press cotton watercolor paper', rough: 'rough cotton watercolor paper' }[run.paper];
  const aspect = run.orient === 'portrait' ? '3:4 portrait' : '4:3 landscape';
  const lines = [];
  if (withRef) lines.push('The attached image shows the exact materials to use: paper, pigments and brushes, painted in a simulation. Make a NEW painting in that same medium and material look (same paper texture, same pigment behaviour, same kind of brush marks). Do not copy its subject or layout.');
  lines.push(`Subject and composition: ${subject}`);
  if (gouache) {
    lines.push(`Medium: opaque gouache on ${paper}, painted with flat, filbert and round synthetic brushes, using only these paints: ${names}.`);
    lines.push('Look: a painterly gouache study by a skilled illustrator. Flat, matte, opaque shapes of colour with visible, confident brushstrokes that follow the forms; built up dark to light, with lighter opaque paint laid over darker; soft blended transitions where wet paint met wet paint, crisp edges elsewhere; highlights and the lightest lights painted in white gouache. Simplified, not fussy. No pencil lines, no ink outlines, no text, no signature.');
  } else if (pencil) {
    lines.push(`Medium: a graphite pencil drawing on ${paper}, drawn with pencils from 2H to 8B. Graphite only: no colour, no ink, no paint, no charcoal smears.`);
    lines.push('Look: confident drawn lines that vary in weight (lost and found edges), tones built from hatching and cross-hatching that follow the form, soft shading with the side of the lead where it helps, the paper grain showing through the lighter tones, the white of the paper for the lightest lights. Darkest darks are soft graphite, not black. No text, no signature, no frame lines.');
  } else if (ink) {
    lines.push(`Medium: traditional sumi-e ink painting on ${paper}, made with soft goat-hair fude brushes. Ink: ${names}; mostly sumi in its five tones from pale grey wash to dense black, colours only as small accents if at all.`);
    lines.push('Look: each shape is a single confident brush stroke; ink bleeds softly into the paper at wet edges; fast strokes break into dry-brush streaks; generous empty paper. No outlines drawn with a pen, no white or gold paint, no text, no calligraphy, no signature, no seal.');
  } else {
    lines.push(`Medium: transparent watercolor on ${paper}, painted only with these pigments: ${names}.`);
    lines.push('Look: loose and painterly, built light to dark in two to four transparent layers; graded and wet-in-wet washes, soft blooms and crisp dried edges, granulation of the earth and ultramarine pigments in the paper tooth. The lightest lights are bare unpainted paper: no white paint, no gouache, no masking-fluid spots, no pen or pencil lines, no text, no signature.');
  }
  lines.push(pencil ? 'Keep it drawable with a pencil in an hour: clear contours, a few value masses built from strokes, nothing photographic.' : gouache ? 'Keep it paintable with a brush in an afternoon: big simple shapes, clear light and shadow, a simple background, no detail smaller than about 1.5 mm, nothing photographic.' : 'Keep it paintable with a brush: broad shapes, a few clear value masses, no detail smaller than about 2 mm, nothing photographic.');
  lines.push(`Presentation: a flat, straight-on scan of the whole sheet filling the frame edge to edge, even lighting, no frame, no table, no border, no shadow. ${aspect} composition; keep everything important away from the outer 6% on the long sides, which will be cropped.`);
  return lines.join('\n');
}
C.reference = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const dir = runDir(run.id);
  if (opt.from) {
    if (!fs.existsSync(opt.from)) die('no such image: ' + opt.from);
    fs.copyFileSync(opt.from, path.join(dir, 'reference.png'));
    run.reference = 'reference.png';
    saveRun(run);
    console.log('reference copied from ' + opt.from);
    return C.target({ pos, opt });
  }
  const subject = opt.prompt || run.subject;
  if (!subject) die('--prompt "what to paint" is required');
  const model = opt.model || DEFAULT_MODEL;
  const size = opt.size || (run.orient === 'portrait' ? '1024x1536' : '1536x1024');
  const quality = opt.quality || 'high';
  let refs = opt['style-refs'] || [];
  let page = null, info;
  page = await attach(run);
  info = await page.call(() => inkBot.info());
  if (!refs.length && !opt['no-style-ref']) {
    const f = path.join(STATE, `style-${run.medium}-${run.paper}-${run.orient}.png`);
    if (!fs.existsSync(f)) {
      process.stderr.write('painting a style sample with the simulation (once per medium/paper)...\n');
      savePng((await page.call(() => inkBot.demoSample())).png, f);
    }
    refs = [f];
  }
  page.close();
  const prompt = stylePrompt(run, info, subject, refs.length > 0);
  fs.writeFileSync(path.join(dir, 'reference-prompt.txt'), prompt + '\n');
  const endpoint = refs.length ? 'https://api.openai.com/v1/images/edits' : 'https://api.openai.com/v1/images/generations';
  if (opt['dry-run']) {
    console.log(JSON.stringify({ endpoint, model, size, quality, images: refs.map(rel), prompt }, null, 1));
    return;
  }
  const key = apiKey();
  if (!key) die('OPENAI_API_KEY is not set (export it, or put OPENAI_API_KEY=... in ' + rel(path.join(ROOT, '.env')) + ')');
  process.stderr.write(`requesting ${model} (${quality}, ${size}${refs.length ? `, ${refs.length} style reference` : ''})... this can take a minute or two\n`);
  const t0 = Date.now();
  let res;
  if (refs.length) {
    const fd = new FormData();
    fd.append('model', model); fd.append('prompt', prompt); fd.append('size', size); fd.append('quality', quality); fd.append('n', '1');
    for (const r of refs) fd.append('image[]', new Blob([fs.readFileSync(r)], { type: 'image/png' }), path.basename(r));
    res = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(900000) });
  } else {
    res = await fetch(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, size, quality, n: 1 }), signal: AbortSignal.timeout(900000),
    });
  }
  const body = await res.text();
  if (!res.ok) die(`OpenAI ${res.status}: ${body.slice(0, 800)}`);
  const j = JSON.parse(body);
  const d = j.data && j.data[0];
  if (!d) die('no image in response: ' + body.slice(0, 400));
  const buf = d.b64_json ? Buffer.from(d.b64_json, 'base64') : Buffer.from(await (await fetch(d.url)).arrayBuffer());
  const n = fs.readdirSync(dir).filter((f) => /^reference-\d+\.png$/.test(f)).length + 1;
  const keep = path.join(dir, `reference-${n}.png`);
  fs.writeFileSync(keep, buf);
  fs.copyFileSync(keep, path.join(dir, 'reference.png'));
  run.reference = 'reference.png';
  run.referenceMeta = { model, size, quality, styleRefs: refs.map(rel), seconds: Math.round((Date.now() - t0) / 1000), usage: j.usage || null, revised_prompt: d.revised_prompt || null, file: path.basename(keep) };
  if (!run.subject) run.subject = subject;
  saveRun(run);
  logEvent(run, { ev: 'reference', file: path.basename(keep), model });
  console.log(`reference saved: ${rel(keep)} (${run.referenceMeta.seconds}s)`);
  return C.target({ pos, opt });
};

C.target = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const dir = runDir(run.id);
  if (!fs.existsSync(path.join(dir, 'reference.png'))) die('no reference.png yet (run: reference)');
  const r = py(['prepare', path.join(dir, 'reference.png'), path.join(dir, 'blank.png'), path.join(dir, 'target.png'), '--fit', opt.fit || 'crop', ...(run.medium === 'gouache' ? ['--no-balance'] : [])]);
  py(['grid', path.join(dir, 'target.png'), path.join(dir, 'target-grid.png')]);
  py(['palette', path.join(dir, 'target.png'), '--k', '8', '--out', path.join(dir, 'palette.png')]);
  run.target = 'target.png';
  run.paperRGB = r.paper_sim;
  // re-score existing checkpoints against the new target
  for (const [id, c] of Object.entries(run.checkpoints)) {
    if (!c.dry) continue;
    const s = py(scoreArgs(run, path.join(ROOT, c.dry)));
    c.score = s;
    if (id === 'cp-0000') c.eval = null;
  }
  saveRun(run);
  console.log(`target ${rel(path.join(dir, 'target.png'))} ${r.size.join('×')} (paper ${r.paper_ref} → ${r.paper_sim})`);
  console.log(`grid   ${rel(path.join(dir, 'target-grid.png'))}   palette ${rel(path.join(dir, 'palette.png'))}`);
  const s = run.checkpoints['cp-0000'].score;
  if (s) console.log(`blank sheet scores ${s.score} (error ${s.error}, too-light ${s.too_light}) — that is the starting point`);
};

C.calibrate = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const key = `calibration-${run.medium}-${run.paper}-${run.res}`;
  const jf = path.join(STATE, key + '.json'), pf = path.join(STATE, key + '.png');
  if (!fs.existsSync(jf) || opt.force) {
    const page = await attach(run);
    process.stderr.write('painting calibration swatches on scrap paper...\n');
    const c = await page.call(() => inkBot.calibrate());
    savePng(c.png, pf);
    delete c.png;
    writeJSON(jf, c);
    page.close();
  }
  fs.copyFileSync(jf, path.join(runDir(run.id), 'calibration.json'));
  fs.copyFileSync(pf, path.join(runDir(run.id), 'calibration.png'));
  const c = readJSON(jf);
  const L = (rgb) => { const f = (v) => { v /= 255; v = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return v; }; const Y = 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); return Math.round(Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y); };
  console.log(`calibration (${run.medium} on ${run.paper}, water ${c.swatches[0].water}); paper rgb(${c.paper}) L${L(c.paper)}`);
  console.log(`image ${rel(path.join(runDir(run.id), 'calibration.png'))}\n`);
  const loads = [...new Set(c.swatches.map((s) => s.load))];
  console.log('pigment'.padEnd(18) + loads.map((l) => `load ${l}`.padEnd(24)).join(''));
  const names = [...new Set(c.swatches.map((s) => s.name))];
  for (const n of names) {
    console.log(n.padEnd(18) + loads.map((l) => { const s = c.swatches.find((q) => q.name === n && q.load === l); return `L${L(s.rgb)} rgb(${s.rgb})`.padEnd(24); }).join(''));
  }
};

C.regions = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const dir = runDir(run.id);
  if (!run.target) die('no target yet');
  const by = opt.by || 'value';
  const out = path.join(dir, `regions-${by}.json`), ov = path.join(dir, `regions-${by}.png`);
  const args = ['regions', path.join(dir, run.target), '--by', by, '--out', out, '--overlay', ov];
  for (const k of ['levels', 'k', 'res', 'blur', 'min-area', 'tol', 'max-per']) if (opt[k]) args.push('--' + k, String(opt[k]));
  const r = py(args);
  console.log(`${r.regions} regions → ${rel(out)}  overlay ${rel(ov)}`);
  console.log('use in a wash as {"type":"wash","region":"<id>", ...}; ids: ' + r.ids.map(([i, a]) => `${i}(${(a * 100).toFixed(1)}%)`).join(' '));
};

// Swap {"region": "v1.0"} for that region's rings (the log keeps the rings,
// so replays do not depend on the regions file).
function sRGBtoL(rgb) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const Y = 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  return Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
}
const calFile = (run) => path.join(STROKES, `calibration-${run.medium}-${run.paper}.json`);
const savedFile = (medium) => path.join(STROKES, `saved-${medium}.json`);
function library(run) {
  const cal = fs.existsSync(calFile(run)) ? readJSON(calFile(run)) : null;
  const pc = path.join(runDir(run.id), 'calibration.json');
  const pigCal = fs.existsSync(pc) ? readJSON(pc).swatches.map((q) => ({ pigment: q.pigment, load: q.load, L: sRGBtoL(q.rgb) })) : null;
  const saved = fs.existsSync(savedFile(run.medium)) ? readJSON(savedFile(run.medium)) : {};
  const paperL = run.paperRGB ? sRGBtoL(run.paperRGB) : cal && cal.paperL ? cal.paperL : 95;
  const sheetMM = run.sheetMM || [304.8, 228.6];
  // a mark on the target measured along a path (for fit strokes)
  const profile = run.target ? (pathFrac, extend) => {
    const args = ['profile', path.join(runDir(run.id), run.target), '--path', JSON.stringify(pathFrac), '--sheet', sheetMM.join(','), '--extend', String(extend == null ? 15 : extend)];
    if (run.paperRGB) args.push('--paper', run.paperRGB.join(','));
    return py(args);
  } : null;
  return new Library({ sheetMM, medium: run.medium, paper: run.paper, paperL, cal, pigCal, saved, codebook: () => loadCodebook(run), profile });
}
// Expand {"type": "lib", ...} into brush actions (the log keeps the
// expansion, so replays do not depend on the library changing later).
function expandLib(run, actions, grouped) {
  const lib = actions.some((a) => a && a.type === 'lib') ? library(run) : null;
  const groups = actions.map((a, i) => {
    if (!a || a.type !== 'lib') return [a];
    try { return lib.expand(a); } catch (e) { die(`action ${i} (lib ${a.stroke}): ${e.message}`); }
  });
  followTone(run, lib, actions, groups);
  for (const w of new Set(((lib && lib.warnings) || []).map((m) => m.replace(/L\d+\.\d+/g, (x) => 'L' + Math.round(parseFloat(x.slice(1))))))) process.stderr.write('library: ' + w + '\n');
  return grouped ? groups : groups.flat();
}
// "follow": "tone" on a pencil gesture: the hand keeps its motion but presses
// as the reference asks along the way — harder where the reference is darker
// than the drawing so far, lifting where the drawing is already dark enough.
// A layer multiplies what is there, so at each point the layer that is still
// missing is Y(paper)·Y(target)/Y(now); its value, at the family's spacing,
// picks the grade (once, for the darkest need) and the pressure (per point,
// smoothed over a couple of millimetres: a hand cannot change faster).
function followTone(run, lib, actions, groups) {
  const want = actions.map((a, i) => (a && a.type === 'lib' && a.follow === 'tone' ? i : -1)).filter((i) => i >= 0);
  if (!want.length) return;
  if (!run.target) die('follow: tone needs a target');
  const c = run.checkpoints[run.head];
  const img = c.dry || c.render ? path.join(ROOT, c.dry || c.render) : path.join(runDir(run.id), 'blank.png');
  const strokes = [];
  const ok = (s) => s && s.type === 'stroke' && (s.tool === 'pencil' || s.tool === 'eraser');
  for (const i of want) for (const s of groups[i]) if (ok(s)) strokes.push(s);
  if (!strokes.length) return;
  // sampled per sampling radius (an action's follow_mm: how fine a detail it follows)
  const L = [];
  {
    const byR = new Map();
    let k0 = 0;
    for (const i of want) {
      const n = groups[i].filter(ok).length, r = actions[i].follow_mm || 0.6;
      if (!byR.has(r)) byR.set(r, []);
      byR.get(r).push([k0, n]); k0 += n;
    }
    for (const [r, spans] of byR) {
      const sf = path.join(os.tmpdir(), `ink-follow-${process.pid}.json`);
      const list = spans.flatMap(([a0, n]) => strokes.slice(a0, a0 + n));
      fs.writeFileSync(sf, JSON.stringify(list.map((s) => s.pts.map((q) => [q[0], q[1]]))));
      const got = py(['sample', path.join(runDir(run.id), run.target), img, sf, '--radius', String(r / 2)]);
      let m = 0;
      for (const [a0, n] of spans) for (let j = 0; j < n; j++) L[a0 + j] = got[m++];
    }
  }
  const Y = (l) => Math.pow((l + 16) / 116, 3), Lof = (y) => 116 * Math.cbrt(y) - 16;
  const P = lib.paperL || 94;
  const T = lib.cal && lib.cal.pencil && lib.cal.pencil.tone;
  const order = ['2H', 'HB', '2B', '4B', '6B', '8B'];
  const curve = (g) => (T && T[g]) || null;
  const valueAt = (g, p) => { const r = curve(g); return r ? interp1(r.map((q) => q[0]), r.map((q) => q[1]), p) : 94 - 62 * { '2H': 0.35, HB: 0.5, '2B': 0.62, '4B': 0.74, '6B': 0.84, '8B': 0.92 }[g] * Math.pow(p, 0.7); };
  const pressureFor = (g, v) => { if (v >= valueAt(g, 0.05)) return 0.03; let a = 0.05, b = 0.95; for (let k = 0; k < 22; k++) { const m = 0.5 * (a + b); if (valueAt(g, m) > v) a = m; else b = m; } return 0.5 * (a + b); };
  let k = 0;
  for (const i of want) {
    const a = actions[i], st = (a.repeat && a.repeat.step) || [1.2, 0];
    const cover = Math.min(1.6, Math.max(0.3, 1.2 / Math.max(0.3, Math.hypot(st[0], st[1]))));
    const mine = groups[i].filter(ok);
    if (mine.length && mine[0].tool === 'eraser') {
      // an eraser presses where the drawing is darker than the reference: the
      // share of the excess to lift, a firm pass taking most of a light mark
      mine.forEach((s, j) => {
        const tol = a.follow_tol == null ? 2 : a.follow_tol;
        // the share of graphite to lift, then the pressure that lifts it: an
        // eraser takes strength·p^0.6 of what is there (app.js ERASERS)
        const strength = (mine[0].eraser === 'kneaded' ? 0.36 : 0.95);
        const raw = L[k + j].map(([lt, lc]) => {
          if (lc >= lt - tol) return 0.02;
          const f = Math.min(0.97, (Y(lt) - Y(lc)) / Math.max(1e-4, Y(P) - Y(lc)));
          return Math.min(1, Math.pow(f / strength, 1 / 0.6));
        });
        smoothInto(s, raw, a, lib);
      });
      k += mine.length;
      continue;
    }
    const ptol = a.follow_tol == null ? 1 : a.follow_tol;
    const eqs = mine.map((s, j) => L[k + j].map(([lt, lc]) => {
      if (lc <= lt + ptol) return null;
      const layer = Lof(Y(P) * Math.min(1, Y(lt) / Y(lc)));
      return P - (P - layer) / cover;
    }));
    k += mine.length;
    const all = eqs.flat().filter((v) => v != null).sort((x, y) => x - y);
    if (!all.length) { for (const s of mine) s.pts.forEach((q) => { q[2] = 0.03; }); continue; }
    const darkest = all[Math.floor(all.length * 0.1)];
    const g = a.grade || order.find((gg) => valueAt(gg, 0.85) <= darkest) || '8B';
    mine.forEach((s, j) => { s.grade = g; smoothInto(s, eqs[j].map((v) => (v == null ? 0.03 : pressureFor(g, v))), a, lib); });
  }
}
// per-point pressures onto a stroke, smoothed over ~2 mm, keeping its own
// lift in and out at the ends
function smoothInto(s, raw, a, lib) {
  const span = a.follow_smooth_mm || 2;
  const S = [0];
  for (let n = 1; n < s.pts.length; n++) S.push(S[n - 1] + Math.hypot((s.pts[n][0] - s.pts[n - 1][0]) * lib.sheetMM[0], (s.pts[n][1] - s.pts[n - 1][1]) * lib.sheetMM[1]));
  const base = s.pts.map((q) => q[2]);
  const top = Math.max(0.05, ...base);
  s.pts.forEach((q, n) => {
    let sum = 0, w = 0;
    for (let m = 0; m < raw.length; m++) { const d = Math.abs(S[m] - S[n]); if (d < span) { const ww = 1 - d / span; sum += raw[m] * ww; w += ww; } }
    const taper = Math.min(1, (1.4 * base[n]) / top);
    q[2] = +Math.max(0.02, Math.min(1, (sum / w) * taper)).toFixed(3);
  });
}
function interp1(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1] || 1);
  return ys[ys.length - 1];
}
// "frame": [x0, y0, x1, y1] on an action: its coordinates are fractions of
// that box (as read off `ink zoom`), not of the sheet
function unframe(a) {
  if (!a || !Array.isArray(a.frame)) return a;
  const [x0, y0, x1, y1] = a.frame;
  const m = (p) => (Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' ? [+(x0 + p[0] * (x1 - x0)).toFixed(4), +(y0 + p[1] * (y1 - y0)).toFixed(4), ...p.slice(2)] : p);
  const b = Object.assign({}, a);
  delete b.frame;
  for (const k of ['path', 'pts', 'poly']) if (Array.isArray(b[k])) b[k] = b[k].map(m);
  for (const k of ['at', 'from', 'to', 'start']) if (Array.isArray(b[k])) b[k] = m(b[k]);
  if (Array.isArray(b.rings)) b.rings = b.rings.map((r) => r.map(m));
  if (Array.isArray(b.rect)) { const p0 = m([b.rect[0], b.rect[1]]), p1 = m([b.rect[2], b.rect[3]]); b.rect = [p0[0], p0[1], p1[0], p1[1]]; }
  return b;
}
// On a run that draws by motion (pencil runs: authoring "motion"), a mark
// can only be written as a gesture — how the hand starts and is pushed —
// never as the curve it should trace.
const MOTION_OK = new Set(['set', 'wait', 'dry', 'tilt', 'dryer', 'humidity']);
function checkMotionOnly(run, actions) {
  if (run.authoring !== 'motion') return;
  actions.forEach((a, i) => {
    if (!a || MOTION_OK.has(a.type)) return;
    if (a.type === 'lib' && a.stroke === 'gesture') return;
    // a saved recipe recorded from gestures is a practised motion replayed
    // (a signature): allowed, moved and scaled onto from→to
    if (a.type === 'lib' && (a.stroke || '').startsWith('saved:')) {
      const f = savedFile(run.medium), r = fs.existsSync(f) && readJSON(f)[a.stroke.slice(6)];
      if (r && r.motion) return;
    }
    const what = a.type === 'lib' ? `lib "${a.stroke}"` : `"${a.type}"`;
    die(`action ${i} (${a.label || what}): this run draws by motion, so marks are written as gestures, not paths or regions.\n` +
      `  {"type": "lib", "stroke": "gesture", "start": [x, y], "v0": {"dir": 20, "speed": 40}, "pushes": [{"dir": 20, "mag": 1800, "ms": 140}, {"dir": 200, "mag": 1800, "ms": 140}], "value": 70}\n` +
      `  (preview where it goes first: ink preview ${run.id} file.json --box x0,y0,x1,y1)`);
  });
}
function expandRegions(run, actions, grouped) {
  const dir = runDir(run.id);
  const cache = {};
  checkMotionOnly(run, actions);
  actions = actions.map(unframe);
  return expandLib(run, actions.map((a) => {
    if (!a || !a.region) return a;
    const by = a.region.startsWith('v') ? 'value' : 'color';
    const f = path.join(dir, `regions-${by}.json`);
    if (!cache[f]) { if (!fs.existsSync(f)) die(`region ${a.region}: no ${rel(f)} (run: regions --by ${by})`); cache[f] = readJSON(f).regions; }
    const r = cache[f].find((q) => q.id === a.region);
    if (!r) die(`no region "${a.region}" in ${rel(f)}`);
    const b = Object.assign({}, a, { rings: r.rings });
    delete b.region;
    return b;
  }), grouped);
}

// Save the frames recorded in the page as the time-lapse of checkpoint seg.
// The camera for a zoom box (sheet fractions): the box with a margin, at the
// sheet's aspect, no closer than zoomMin of the sheet; null = the whole sheet
function camBox(z, zoomMin) {
  if (!z || !z.box || z.level === 0) return null;
  const [x0, y0, x1, y1] = z.box;
  const w = Math.min(1, Math.max(zoomMin || 0.16, Math.max(x1 - x0, y1 - y0) * 1.35));
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  cx = Math.min(1 - w / 2, Math.max(w / 2, cx)); cy = Math.min(1 - w / 2, Math.max(w / 2, cy));
  return w >= 0.999 ? null : [cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2];
}

async function drainFrames(run, page, seg, keep) {
  const dir = path.join(runDir(run.id), 'frames');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (;;) {
    const fr = await page.eval('JSON.stringify(inkBot.takeFrames(6))').then(JSON.parse);
    if (!fr.length) break;
    if (!keep) continue;
    for (const f of fr) {
      const seq = (run.frameSeq = (run.frameSeq || 0) + 1);
      const file = String(seq).padStart(6, '0') + '.jpg';
      fs.writeFileSync(path.join(dir, file), Buffer.from(f.jpg.slice(f.jpg.indexOf(',') + 1), 'base64'));
      lines.push(JSON.stringify({ seq, file, t: f.t, label: f.label, painting: f.painting, seg, parent: run.head, cam: f.cam || false, view: f.view || null }));
    }
  }
  if (lines.length) fs.appendFileSync(path.join(dir, 'manifest.jsonl'), lines.join('\n') + '\n');
  return lines.length;
}

C.record = ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const on = pos[1] !== 'off';
  run.record = on ? { every: +opt.every || 4, sparseEvery: +opt['sparse-every'] || 30, width: +opt.width || 1280, quality: +opt.quality || 0.85, brush: !opt['no-brush'] } : null;
  saveRun(run);
  console.log(on ? `recording ${run.id}: a frame every ${run.record.every} sim frames while painting (every ${run.record.sparseEvery} while waiting/drying), ${run.record.width} px wide → paintings/${run.id}/frames/` : `recording off for ${run.id}`);
};

// ink camera <run> full|x0,y0,x1,y1: with recording on, move the camera (a
// pull-back to the whole sheet at the end of a painting) and record it
C.camera = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  if (!run.record) die('recording is off for this run (ink record <run> on)');
  const to = !pos[1] || pos[1] === 'full' ? null : camBox({ level: 1, box: pos[1].split(',').map(Number) }, +opt['zoom-min']);
  const page = await attach(run);
  await page.call((o) => { inkBot.record(o); return 0; }, run.record);
  const n = await page.call((t, k) => { const m = inkBot.cameraMove(t, k); return m + inkBot.grabNow(); }, to, +opt['cam-frames'] || 0);
  await drainFrames(run, page, run.head, true);
  await page.call(() => inkBot.record(null));
  page.close();
  console.log(`camera → ${to ? to.map((v) => v.toFixed(3)).join(',') : 'whole sheet'} (${n} frames recorded)`);
};

// A clean time-lapse of the painting as it was kept: replay the path to the
// final checkpoint from a blank sheet (replays are exact), recording just
// the canvas, then keep the frames where the ink visibly moves.
C.timelapse = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const head = resolveCp(run, opt.from || (run.final && run.final.cp) || run.head);
  const chain = pathTo(run, head).slice(1);
  if (opt.recorded) {
    // from the frames recorded while painting: only checkpoints on the kept
    // path (rolled-back lookaheads are left out); nothing is replayed
    const fdir = path.join(runDir(run.id), 'frames');
    const mf = path.join(fdir, 'manifest.jsonl');
    if (!fs.existsSync(mf)) die('no recorded frames (turn recording on before painting: ink record <run> on)');
    const keep = new Set(['cp-0000', ...chain]);
    const lines = fs.readFileSync(mf, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((f) => keep.has(f.seg) || (f.seg === head));
    fs.writeFileSync(path.join(fdir, 'manifest-kept.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const out = opt.out || path.join(runDir(run.id), `${run.id}-timelapse.mp4`);
    const args = [path.join(HERE, 'video.py'), runDir(run.id), '--timelapse', fdir, '--manifest', 'manifest-kept.jsonl', '--out', out, '--seconds', String(opt.seconds || 36)];
    if (opt.bitrate) args.push('--bitrate', String(opt.bitrate));
    const res = spawnSync('python3', args, { stdio: 'inherit' });
    if (res.status !== 0) die('time-lapse encoding failed');
    return;
  }
  // --frames N: about how many frames to record (what the video needs, with
  // some to spare), instead of a fixed every
  if (opt.frames && !opt.every) {
    let ms = 0;
    for (const id of chain) for (const a of run.checkpoints[id].actions) if (a.type === 'stroke') ms += (a.ts && a.ts.length ? a.ts[a.ts.length - 1] : 300) + 150;
    opt.every = String(Math.max(2, Math.round(ms / (1000 / 60) / +opt.frames)));
    process.stderr.write(`about ${Math.round(ms / 1000)} s of brush on paper: a frame every ${opt.every} sim frames\n`);
  }
  const dir = path.join(runDir(run.id), 'timelapse');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await startDaemon(true);
  const page = await Page.open(opt.tab);   // --tab name: its own page, so time-lapses can render side by side
  page.tab = opt.tab;
  await page.send('Runtime.enable');
  await load(page, run);
  const rec = { every: +opt.every || 2, sparseEvery: +opt['sparse-every'] || 12, width: +opt.width || 1440, quality: +opt.quality || 0.92, brush: opt['no-tool'] ? false : run.medium === 'pencil' || run.medium === 'gouache' ? true : !!opt.brush };
  await page.call((o) => { inkBot.record(o); return inkBot.grabNow(); }, rec);
  let seq = 0;
  const lines = [];
  // --realtime cp[,cp]|last: those checkpoints recorded every 2 sim frames and
  // played 1:1 (a signature at the speed it is written), the rest time-lapsed
  const rtSet = new Set(String(opt.realtime || '').split(',').filter(Boolean).map((c) => (c === 'last' ? head : c)));
  let rtNow = false;
  const drain = async (cp) => {
    for (;;) {
      const fr = await page.eval('JSON.stringify(inkBot.takeFrames(6))').then(JSON.parse);
      if (!fr.length) break;
      for (const f of fr) {
        const file = String(++seq).padStart(6, '0') + '.jpg';
        fs.writeFileSync(path.join(dir, file), Buffer.from(f.jpg.slice(f.jpg.indexOf(',') + 1), 'base64'));
        lines.push(JSON.stringify({ seq, file, t: f.t, label: f.label, painting: f.painting, cp, cam: f.cam || false, view: f.view || null, ...(rtNow ? { rt: true } : {}) }));
      }
    }
  };
  // replay a checkpoint a slice at a time and collect its frames after each
  // slice: a checkpoint of thousands of strokes otherwise piles up more
  // memory in the page than it can hold: what a frame grab allocates is only
  // freed when the call returns (run keeps no state between calls)
  const slice = +opt.slice || 5;
  // --zoom: the camera follows the work: each checkpoint is seen at the box
  // that batch was painted at (its zoom level), at the sheet's aspect. Leaving
  // a close-up cuts straight back to the whole sheet; going into one waits a
  // random few frames of the brush at work first (--lag a,b frames, --seed):
  // a painter steps back to look at the whole for a varying moment.
  const camFor = (z) => camBox(z, +opt['zoom-min']);
  const [lagA, lagB] = String(opt.lag || '4,20').split(',').map(Number);
  let seed = +opt.seed || 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const same = (p, q) => (!p && !q) || (p && q && p.every((v, i) => Math.abs(v - q[i]) < 0.01));
  let camNow = null;
  const camTo = async (b) => {
    if (same(camNow, b)) return;
    if (+opt['cam-frames'] > 0) await page.call((t, n) => inkBot.cameraMove(t, n), b, +opt['cam-frames']);
    else {
      if (camNow) await page.call(() => inkBot.cameraMove(null, 0));   // back to the whole sheet at once
      if (b) await page.call((t, k) => inkBot.cameraCutAfter(t, k), b, Math.round(lagA + (lagB - lagA) * rand() ** 1.4));
    }
    camNow = b;
    await drain(null);
  };
  for (const id of chain) {
    const acts = run.checkpoints[id].actions;
    if (rtSet.has(id) !== rtNow) {
      await drain(id);
      rtNow = rtSet.has(id);
      await page.call((o) => inkBot.record(o), rtNow ? Object.assign({}, rec, { every: 2 }) : rec);
    }
    if (opt.zoom) await camTo(camFor(run.checkpoints[id].zoom));
    process.stderr.write(`replaying ${id} (${acts.length} actions)...\n`);
    for (let s0 = 0; s0 < acts.length; s0 += slice) {
      if (process.env.INK_DEBUG) process.stderr.write(`  ${id} actions ${s0}..${Math.min(acts.length, s0 + slice) - 1}\n`);
      const r = await page.call((a) => inkBot.run(a), acts.slice(s0, s0 + slice));
      if (r.error) die(`replay of ${id} failed: ${r.error}`);
      await drain(id);
    }
  }
  // --append actions.json [--append-zoom x0,y0,x1,y1]: more actions after the
  // chain, as if they were one more checkpoint (replays are exact, so these
  // frames are what that checkpoint will record): e.g. the signature, while
  // the run's own page is still being rebuilt to commit it
  if (opt.append) {
    const extra = expandRegions(run, readActions(opt.append));
    const id = 'append';
    if (rtSet.has('append') || rtSet.has(head) !== rtNow) {
      await drain(id);
      rtNow = rtSet.has('append') || rtSet.has(head);
      await page.call((o) => inkBot.record(o), rtNow ? Object.assign({}, rec, { every: 2 }) : rec);
    }
    if (opt.zoom) await camTo(opt['append-zoom'] ? camFor({ level: 3, box: String(opt['append-zoom']).split(',').map(Number) }) : null);
    process.stderr.write(`replaying the appended actions (${extra.length})...\n`);
    for (let s0 = 0; s0 < extra.length; s0 += slice) {
      const r = await page.call((a) => inkBot.run(a), extra.slice(s0, s0 + slice));
      if (r.error) die(`appended actions failed: ${r.error}`);
      await drain(id);
    }
  }
  if (opt.zoom) await camTo(null);   // pull back to the whole sheet for the end
  // the finished painting, without the brush: the last frame and the end hold
  await page.call((o) => { inkBot.record(o); return inkBot.grabNow(); }, Object.assign({}, rec, { brush: false }));
  await drain(head);
  if (lines.length) { const l = JSON.parse(lines[lines.length - 1]); l.final = true; lines[lines.length - 1] = JSON.stringify(l); }
  await page.call(() => inkBot.record(null));
  page.close();
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), lines.join('\n') + '\n');
  const out = opt.out || path.join(runDir(run.id), `${run.id}-timelapse.mp4`);
  const args = [path.join(HERE, 'video.py'), runDir(run.id), '--timelapse', dir, '--out', out, '--seconds', String(opt.seconds || 36)];
  if (opt.total) args.push('--total', String(opt.total));
  if (opt['rt-every']) args.push('--rt-every', String(opt['rt-every']));
  if (opt.bitrate) args.push('--bitrate', String(opt.bitrate));
  const res = spawnSync('python3', args, { stdio: 'inherit' });
  if (res.status !== 0) die('time-lapse encoding failed');
};

C.video = ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const args = [path.join(HERE, 'video.py'), runDir(run.id)];
  for (const k of ['out', 'fps', 'speed', 'hold']) if (opt[k]) args.push('--' + k, String(opt[k]));
  const r = spawnSync('python3', args, { stdio: 'inherit' });
  if (r.status !== 0) die('video failed');
};

C.act = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  // checkpoint every N actions as written: a library stroke's expansion
  // (a mist is a pre-wet and a wash) is never split across checkpoints
  const groups = expandRegions(run, readActions(pos[1]), true);
  const actions = groups.flat();
  const every = +opt.every || run.every || 6;
  let page = await attach(run);
  const v = await page.call((a) => inkBot.validate(a), actions);
  if (!v.ok) { page.close(); die(v.error + '\n(nothing was painted)'); }
  if (run.record) await page.call((o) => { inkBot.record(o); return inkBot.grabNow(); }, run.record);
  // --zoom-box x0,y0,x1,y1 [--zoom-level n --zoom-part name]: where this batch
  // looks; a recording camera moves there first, and the checkpoints remember it
  const zoom = opt['zoom-box'] ? { level: +opt['zoom-level'] || 1, part: opt['zoom-part'] || 'zoom', box: String(opt['zoom-box']).split(',').map(Number) } : (opt['zoom-level'] === '0' ? { level: 0, part: 'sheet', box: [0, 0, 1, 1] } : null);
  if (run.record && zoom) {
    // as in the time-lapse: back to the whole sheet at once, then lean in
    // after a random few frames of the brush at work (--lag a,b)
    const [lagA, lagB] = String(opt.lag || '4,20').split(',').map(Number);
    const to = camBox(zoom, +opt['zoom-min']), now = await page.call(() => inkBot.cameraView());
    const same = (p, q) => (!p && !q) || (p && q && p.every((v, i) => Math.abs(v - q[i]) < 0.01));
    if (+opt['cam-frames'] > 0) await page.call((t, n) => inkBot.cameraMove(t, n), to, +opt['cam-frames']);
    else if (!same(now, to)) {
      if (now) await page.call(() => inkBot.cameraMove(null, 0));
      if (to) await page.call((t, k) => inkBot.cameraCutAfter(t, k), to, Math.round(lagA + (lagB - lagA) * Math.random() ** 1.4));
    }
    await drainFrames(run, page, 'cp-' + String(run.next).padStart(4, '0'), true);
  }
  const made = [];
  let retried = false;
  for (let g = 0; g < groups.length; g += every) {
    const chunk = groups.slice(g, g + every).flat();
    const i = groups.slice(0, g).flat().length;
    // footprints per written action when they expand to many raw strokes
    let at = null, fpLabels = null;
    if (chunk.length > 40) {
      at = []; fpLabels = [];
      let n = 0;
      for (const gr of groups.slice(g, g + every)) { n += gr.length; at.push(n - 1); fpLabels.push((gr[0] && (gr[0].label || gr[0].type)) || 'action'); }
    }
    // past a few hundred written actions per checkpoint, per-action blame is
    // noise and its footprint images cost gigabytes: judge the batch whole
    // (gouache passes are hundreds of planned strokes: their blame is noise)
    const blame = groups.slice(g, g + every).length <= 300 && !opt['no-blame'] && !(run.medium === 'gouache' && !opt.blame);
    if (!blame) { at = null; fpLabels = null; }
    let r;
    try { r = await page.call((a, o) => inkBot.run(a, o), chunk, { footprints: blame ? 384 : 0, at }); }
    catch (e) {
      // the headless page can die mid-chunk (GPU); everything up to the last
      // checkpoint replays exactly, so rebuild it and try this chunk again once
      if (retried || !/lost the connection/.test(String(e.message))) throw e;
      retried = true;
      process.stderr.write(`the page died during the chunk at action ${i}; rebuilding ${run.head} and trying it again\n`);
      await sleep(1500);
      page = await attach(run);
      if (run.record) await page.call((o) => { inkBot.record(o); return inkBot.grabNow(); }, run.record);
      g -= every;
      continue;
    }
    const seg = 'cp-' + String(run.next).padStart(4, '0');
    if (run.record) await drainFrames(run, page, seg, !r.error);
    if (r.error) {
      await page.call(() => inkBot.record(null));
      await page.call((h) => inkBot.restore(h), run.head);   // drop the partial chunk
      for (const id of made) console.log(describe(run, id));
      page.close();
      die(`${r.error}\n(the chunk starting at action ${i} was discarded; head is ${run.head})`);
    }
    made.push(await checkpoint(run, page, chunk, opt, Object.assign(at ? { footprintEnds: at } : {}, zoom ? { zoom } : {}), r.footprints, fpLabels));
    logEvent(run, { ev: 'act', cp: run.head, parent: run.checkpoints[run.head].parent, n: chunk.length, labels: [...new Set(chunk.map((a) => a.label).filter(Boolean))], lookahead: !!opt.lookahead });
  }
  if (run.record) await page.call(() => inkBot.record(null));
  saveRun(run);
  page.close();
  for (const id of made) console.log(describe(run, id));
};

// A lookahead is just painting forward and then rolling back: the branch
// stays in the tree (and the video), can be compared with its siblings, and
// can be returned to later with checkout.
C.try = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const start = run.head;
  await C.act({ pos, opt: Object.assign({}, opt, { lookahead: true }) });
  const after = loadRun(pos[0]);
  if (after.head !== start) {
    console.log(`\nlookahead ${after.head} kept in the tree; back at ${start}. To continue from it instead: checkout ${run.id} ${after.head}`);
    await moveHead(after, start, 'back', true);
  }
};

C.scratch = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const actions = expandRegions(run, readActions(pos[1]));
  const page = await attach(run);
  const r = await page.call((a, o) => inkBot.scratch(a, o), actions, { max: +opt['preview-max'] || 240 });
  page.close();
  const dir = path.join(runDir(run.id), 'scratch');
  const n = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^scratch-\d+\.png$/.test(f)).length + 1 : 1;
  const img = savePng(r.png, path.join(dir, `scratch-${String(n).padStart(3, '0')}.png`));
  fs.writeFileSync(img.replace(/\.png$/, '.json'), JSON.stringify(actions, null, 1));
  const gridded = img.replace(/\.png$/, '-grid.png');
  py(['grid', img, gridded]);
  if (r.error) console.log(`note: stopped early: ${r.error}`);
  console.log(`scrap test: ${r.done} actions, ${r.paintSeconds}s painting, dried in ${r.drySeconds}s → ${rel(gridded)} (painting untouched)`);
};

async function moveHead(run, id, why, quiet) {
  const page = await attach(run, id);
  page.close();
  const from = run.head;
  run.head = id;
  saveRun(run);
  logEvent(run, { ev: why, from, to: id });
  console.log(`head ${from} → ${id}`);
  if (!quiet) console.log(describe(run, id));
}
C.back = async ({ pos }) => {
  const run = loadRun(pos[0]);
  const n = pos[1] == null ? 1 : +pos[1];
  if (!(n >= 1)) die('back takes a positive number of checkpoints');
  const to = ancestor(run, run.head, n);
  if (to === run.head) die('already at the blank sheet');
  await moveHead(run, to, 'back');
};
C.checkout = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const ref = pos[1] || '';
  const at = ref.indexOf('@');
  if (at < 0) return moveHead(run, resolveCp(run, ref), 'checkout');
  // cp@k: the state after the first k actions of cp's batch, rebuilt from
  // cp's parent (replays are exact), as a new branch
  const src = resolveCp(run, ref.slice(0, at));
  let k = +ref.slice(at + 1);
  const c = run.checkpoints[src];
  // where the judge counted written actions (library strokes that expand
  // to many raw ones), @k keeps the first k of those
  if (c.footprintEnds) { if (!(k >= 0 && k < c.footprintEnds.length)) die(`${src} has ${c.footprintEnds.length} actions; @k takes 0..${c.footprintEnds.length - 1}`); k = k ? c.footprintEnds[k - 1] + 1 : 0; }
  if (!(k >= 0 && k < c.actions.length)) die(`${src} has ${c.actions.length} actions; @k takes 0..${c.actions.length - 1}`);
  if (k === 0) return moveHead(run, c.parent, 'checkout');
  await moveHead(run, c.parent, 'checkout', true);
  const again = loadRun(pos[0]);
  const page = await attach(again, c.parent);
  const keep = c.actions.slice(0, k);
  if (again.record) await page.call((o) => { inkBot.record(o); return inkBot.grabNow(); }, again.record);
  const r = await page.call((a, o) => inkBot.run(a, o), keep, { footprints: 384 });
  if (again.record) { await drainFrames(again, page, 'cp-' + String(again.next).padStart(4, '0'), !r.error); await page.call(() => inkBot.record(null)); }
  if (r.error) die('replay failed: ' + r.error);
  const id = await checkpoint(again, page, keep, Object.assign({}, opt, { note: opt.note || `first ${k} of ${c.actions.length} actions of ${src}` }), { partialOf: src }, r.footprints);
  logEvent(again, { ev: 'act', cp: id, parent: c.parent, n: k, labels: [...new Set(keep.map((a) => a.label).filter(Boolean))], partialOf: src });
  page.close();
  console.log(describe(again, id));
};

C.note = ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const id = resolveCp(run, pos[1]);
  const c = run.checkpoints[id];
  c.note = pos.slice(2).join(' ') || c.note;
  if (opt.reject) c.rejected = true;
  if (opt.keep) c.rejected = false;
  saveRun(run);
  console.log(`${id}: ${c.rejected ? '[rejected] ' : ''}${c.note}`);
};

C.tree = ({ pos }) => {
  const run = loadRun(pos[0]);
  const kids = {};
  for (const [id, c] of Object.entries(run.checkpoints)) (kids[c.parent] = kids[c.parent] || []).push(id);
  const best = bestCp(run);
  const onHead = new Set(pathTo(run, run.head));
  const lines = [];
  const walk = (id, pre, last) => {
    const c = run.checkpoints[id];
    const s = c.score;
    const tag = [id === run.head ? 'HEAD' : '', id === best ? 'best' : '', onHead.has(id) ? '' : 'lookahead', c.wet ? 'wet' : ''].filter(Boolean).join(',');
    const j = c.judge && c.judge.verdict !== 'no change' ? `  ${c.judge.verdict} ${c.judge.net >= 0 ? '+' : ''}${c.judge.net}` : '';
    lines.push(`${pre}${c.parent ? (last ? '└─ ' : '├─ ') : ''}${onHead.has(id) ? '*' : ' '}${id} +${c.actions.length}${s ? `  score ${s.score}${c.progress != null ? ` (${c.progress}%)` : ''}` : ''}${j}${tag ? `  [${tag}]` : ''}${c.note ? `  — ${c.note}` : ''}`);
    const ch = kids[id] || [];
    ch.forEach((k, i) => walk(k, pre + (c.parent ? (last ? '   ' : '│  ') : ''), i === ch.length - 1));
  };
  walk('cp-0000', '', true);
  console.log(lines.join('\n'));
};

// The decision at a checkpoint: this batch against its alternatives (the
// other lookaheads from the same parent) and what each would leave.
C.judge = ({ pos }) => {
  const run = loadRun(pos[0]);
  const id = resolveCp(run, pos[1]);
  const c = run.checkpoints[id];
  console.log(describe(run, id));
  const sibs = Object.entries(run.checkpoints).filter(([k, v]) => v.parent === c.parent && v.judge && v.judge.verdict !== 'no change');
  if (sibs.length > 1) {
    console.log(`\nalternatives from ${c.parent} (lookaheads), best first:`);
    sibs.sort((a, b) => b[1].judge.net - a[1].judge.net);
    for (const [k, v] of sibs) console.log(`  ${k === id ? '*' : ' '}${k}  ${v.judge.verdict.padEnd(7)} net ${String(v.judge.net).padStart(7)}  over-dark ${v.judge.over_dark}  precision ${v.judge.precision}  ${v.note || ''}`);
  }
  const chain = pathTo(run, id).slice(1);
  const flawed = chain.filter((k) => run.checkpoints[k].judge && run.checkpoints[k].judge.verdict !== 'better' && run.checkpoints[k].judge.verdict !== 'no change');
  if (flawed.length) console.log(`\nflawed or worse on the way here: ${flawed.map((k) => `${k} (${run.checkpoints[k].judge.verdict}${run.checkpoints[k].note ? ': ' + run.checkpoints[k].note : ''})`).join(', ')} — any of them can be rolled back to (checkout <cp>, or <cp>@k inside it)`);
  const j = c.judge;
  let say = 'keep going';
  if (j && j.verdict === 'worse') say = `roll back (back ${run.id}) and try differently`;
  else if (j && j.verdict === 'flawed') say = j.culprit != null ? `mostly right: keep the rest with checkout ${run.id} ${id}@${j.culprit}, then repaint action ${j.culprit + 1}` : 'flawed: consider a lookahead with a changed approach and keep the better';
  console.log(`\nsuggestion: ${say}`);
};

// Measure marks in the target instead of reading positions by eye: dark
// elongated pieces in a box, as centreline / width / value for lib strokes.
C.trace = ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  if (!run.target) die('no target yet');
  const box = opt.box || '0,0,1,1';
  const ov = path.join(runDir(run.id), `trace-${box.replace(/,/g, '_')}.png`);
  const r = py(['trace', path.join(runDir(run.id), run.target), '--box', box, '--darker-than', String(opt['darker-than'] || 60), '--min-len', String(opt['min-len'] || 12), '--overlay', ov]);
  console.log(`traced ${r.length} marks darker than L${opt['darker-than'] || 60} in ${box} → ${rel(ov)}`);
  r.forEach((m, i) => console.log(`  t${i}: ${m.length_mm} mm, width ${m.width} mm, L${m.value}, taper ${m.taper.join('/')}  ` + JSON.stringify({ type: 'lib', stroke: 'line', path: m.path, width: m.width, value: m.value, taper: m.taper })));
  console.log('overlapping strokes merge into one piece: raise --darker-than to split them into their dark cores');
};

// ---------------------------------------------------------- search
// Candidates are variations of a batch (or explicit alternatives), each
// painted from the head in the page, dried, and scored where it painted;
// the best few become lookahead checkpoints with the full judge.
function prng(seed) {
  let t = seed >>> 0 || 1;
  return () => { t = (t + 0x6d2b79f5) | 0; let x = Math.imul(t ^ (t >>> 15), t | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
function varyAction(a, v, rnd, sheet, notes) {
  const b = JSON.parse(JSON.stringify(a));
  notes = notes || [];
  // travel the other way (the thick landing and the tapered lift swap ends)
  if (v.reverse && rnd() < v.reverse) {
    if (b.path) b.path = b.path.slice().reverse();
    if (b.pts) b.pts = b.pts.slice().reverse();
    if (b.from && b.to) { const f = b.from; b.from = b.to; b.to = f; }
    if (b.taper) b.taper = b.taper.slice().reverse();
    if (b.taper_mm) b.taper_mm = b.taper_mm.slice().reverse();
    notes.push('reversed');
  }
  if (Array.isArray(v.taper) && b.type === 'lib' && b.stroke === 'line') {
    const [lo, hi] = v.taper;
    b.taper = [+(lo + (hi - lo) * rnd()).toFixed(2), +(lo + (hi - lo) * rnd()).toFixed(2)];
  }
  if (Array.isArray(v.taper_mm) && b.type === 'lib' && b.stroke === 'line') {
    const [lo, hi] = v.taper_mm;
    b.taper_mm = [Math.round(lo + (hi - lo) * rnd()), Math.round(lo + (hi - lo) * rnd())];
    notes.push(`points ${b.taper_mm.join('/')} mm`);
  }
  const mm = (p) => [p[0] * sheet[0], p[1] * sheet[1]];
  const fr = (q, p) => (p && p.length > 2 ? [+(q[0] / sheet[0]).toFixed(4), +(q[1] / sheet[1]).toFixed(4), p[2]] : [+(q[0] / sheet[0]).toFixed(4), +(q[1] / sheet[1]).toFixed(4)]);
  const u = () => rnd() * 2 - 1;
  // one rigid-ish move per action: shift, rotate and scale about its first point
  const ang = ((v.rotate_deg || 0) * u() * Math.PI) / 180, sc = 1 + (v.scale || 0) * u();
  const r = (v.shift_mm || 0) * Math.sqrt(rnd()), th = rnd() * Math.PI * 2;
  const dx = r * Math.cos(th), dy = r * Math.sin(th);
  const pts0 = b.path || b.pts || (b.from ? [b.from] : b.at ? [b.at] : b.poly || (b.rings && b.rings[0]) || (b.x0 != null ? [[b.x0, b.y]] : null));
  if (!pts0) return b;
  const A = mm(pts0[0]);
  const T = (p) => { const q = mm(p), x = (q[0] - A[0]) * sc, y = (q[1] - A[1]) * sc; return fr([A[0] + dx + x * Math.cos(ang) - y * Math.sin(ang), A[1] + dy + x * Math.sin(ang) + y * Math.cos(ang)], p); };
  if (b.path) b.path = b.path.map(T);
  if (b.pts) b.pts = b.pts.map(T);
  if (b.from) b.from = T(b.from);
  if (b.to) b.to = T(b.to);
  if (b.at) b.at = T(b.at);
  if (b.poly) b.poly = b.poly.map(T);
  if (b.rings) b.rings = b.rings.map((ring) => ring.map(T));
  if (b.x0 != null && b.x1 != null && b.y != null) { const p0 = T([b.x0, b.y]), p1 = T([b.x1, b.y]); b.x0 = p0[0]; b.x1 = p1[0]; b.y = (p0[1] + p1[1]) / 2; }
  if (r > 0.05) notes.push(`moved ${r.toFixed(1)} mm`);
  if (Math.abs(ang) > 0.005) notes.push(`${ang > 0 ? '+' : ''}${((ang * 180) / Math.PI).toFixed(0)}°`);
  if (Math.abs(sc - 1) > 0.01) notes.push(`×${sc.toFixed(2)}`);
  if (b.angle != null) b.angle = +(b.angle + (ang * 180) / Math.PI).toFixed(1);
  if (b.length != null) b.length = +(b.length * sc).toFixed(1);
  if (v.width && b.width != null) b.width = +Math.max(0.5, b.width * (1 + v.width * u())).toFixed(2);
  if (v.value && b.value != null) b.value = +Math.min(95, Math.max(3, b.value + v.value * u())).toFixed(1);
  if (Array.isArray(v.texture) && b.type === 'lib' && ['line', 'dab', 'blade'].includes(b.stroke)) b.texture = v.texture[Math.floor(rnd() * v.texture.length)];
  if (Array.isArray(v.speed)) b.speed = Math.round(v.speed[0] + (v.speed[1] - v.speed[0]) * rnd());
  if (v.curve && (b.stroke === 'blade' || b.type === 'dab')) b.curve = +((b.curve || 0) + v.curve * u()).toFixed(2);
  if (b.width != null && a.width != null && b.width !== a.width) notes.push(`${b.width} mm`);
  if (b.value != null && a.value != null && b.value !== a.value) notes.push(`L${Math.round(b.value)}`);
  if (b.texture && b.texture !== a.texture) notes.push(b.texture);
  if (b.speed && b.speed !== a.speed) notes.push(`${b.speed} mm/s`);
  if (b.taper && JSON.stringify(b.taper) !== JSON.stringify(a.taper) && !notes.includes('reversed')) notes.push(`taper ${b.taper.join('/')}`);
  if (v.pressure) {
    const f = 1 + v.pressure * u();
    if (b.pts) b.pts = b.pts.map((p) => (p.length > 2 ? [p[0], p[1], +Math.min(1, Math.max(0, p[2] * f)).toFixed(3)] : p));
    if (b.press != null) b.press = +Math.min(1, Math.max(0.05, b.press * f)).toFixed(3);
    if (b.type === 'lib' && b.pressure != null) b.pressure = +Math.min(0.95, Math.max(0.3, b.pressure * f)).toFixed(3);
  }
  return b;
}
function makeCandidates(spec, sheet, run) {
  if (spec.fit) {
    // codebook marks for one target mark: the nearest few, aligned to it, and
    // their interpolations
    const lib = library(run);
    const r = lib.fitCandidates(spec.fit, spec.k || spec.fit.k || 10);
    const before = spec.before || [{ type: 'dry' }];
    return r.candidates.map((c) => ({ label: c.label, actions: [...before, ...c.actions], match: c.match }));
  }
  if (Array.isArray(spec.candidates)) return spec.candidates.map((c, i) => ({ label: (spec.labels && spec.labels[i]) || `candidate ${i}`, actions: c }));
  if (!Array.isArray(spec.base) || !spec.base.length) die('search spec needs "base": [actions] with "vary", or "candidates": [[actions], ...]');
  const n = spec.n || 32, v = spec.vary || {}, rnd = prng(spec.seed || 1);
  const out = [{ label: 'as written', actions: spec.base }];
  for (let k = 1; k < n; k++) {
    const notes = [];
    if (spec.together) {
      const seed = Math.floor(rnd() * 2 ** 31);
      out.push({ actions: spec.base.map((a, j) => varyAction(a, v, prng(seed), sheet, j ? [] : notes)) });
    } else {
      out.push({ actions: spec.base.map((a) => (a && a.type !== 'dry' && a.type !== 'wait' ? varyAction(a, v, rnd, sheet, notes) : a)) });
    }
    out[out.length - 1].label = `v${k}: ${notes.join(', ') || 'unchanged'}`;
  }
  return out;
}
C.search = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  if (!run.target) die('no target yet');
  let spec = (() => { const src = pos[1]; const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8'); try { return JSON.parse(text); } catch (e) { die('search spec is not JSON: ' + e.message); } })();
  if (Array.isArray(spec)) spec = { base: spec };
  const sheet = run.sheetMM || [304.8, 228.6];
  const cands = makeCandidates(spec, sheet, run);
  const expanded = cands.map((c) => expandRegions(run, c.actions));
  const dir = runDir(run.id);
  const thumb = path.join(dir, 'target-384.png');
  if (!fs.existsSync(thumb) || fs.statSync(thumb).mtimeMs < fs.statSync(path.join(dir, run.target)).mtimeMs) py(['thumb', path.join(dir, run.target), thumb, '--width', '384']);
  const page = await attach(run);
  const start = run.head;
  const v = await page.call((a) => inkBot.validate(a), expanded.flat());
  if (!v.ok) { page.close(); die(v.error); }
  const key = run.id + ':' + fs.statSync(thumb).mtimeMs;
  await page.eval(`inkBot.setTarget(${JSON.stringify('data:image/png;base64,' + fs.readFileSync(thumb).toString('base64'))}, ${JSON.stringify(key)}, ${run.paperRGB ? sRGBtoL(run.paperRGB) : 95})`);
  const dry = !opt['no-dry'];
  process.stderr.write(`evaluating ${cands.length} candidates from ${start}${dry ? ' (each dried)' : ' (wet)'}...\n`);
  const t0 = Date.now();
  const ev = await page.call((o) => inkBot.evaluate(o), { candidates: expanded, dry, structure: opt.structure != null ? +opt.structure : undefined });
  const byKey = opt.rank === 'sheet' ? (r) => -r.sheet_error_change : (r) => r.net;
  const ranked = ev.results.filter((r) => !r.error && r.verdict !== 'no change').sort((a, b) => byKey(b) - byKey(a));
  const nd = fs.existsSync(path.join(dir, 'search')) ? fs.readdirSync(path.join(dir, 'search')).filter((f) => /^search-\d+\.json$/.test(f)).length + 1 : 1;
  const sid = `search-${String(nd).padStart(3, '0')}`;
  fs.mkdirSync(path.join(dir, 'search'), { recursive: true });
  console.log(`${cands.length} candidates in ${((Date.now() - t0) / 1000).toFixed(1)} s (${Math.round(ev.ms / cands.length)} ms each in the page)`);
  console.log('rank  cand  verdict  net    tone  structure  precision  over-dark  sheet Δ   label');
  ranked.slice(0, +opt.show || 10).forEach((r, k) => console.log(`${String(k + 1).padStart(4)}  ${String(r.i).padStart(4)}  ${r.verdict.padEnd(7)} ${String(r.net).padStart(6)}  ${String(r.net_tone ?? r.net).padStart(5)}  ${String(r.structure ?? '-').padStart(9)}  ${String(r.precision).padStart(9)}  ${String(r.over_dark).padStart(9)}  ${String(r.sheet_error_change).padStart(7)}   ${cands[r.i].label}`));
  const bad = ev.results.filter((r) => r.error);
  if (bad.length) console.log(`${bad.length} candidates failed: ${bad[0].error}`);
  // the best few become lookahead checkpoints (full renders and judge)
  const keepN = Math.min(opt.keep != null ? +opt.keep : 3, ranked.length);
  const kept = [];
  for (let k = 0; k < keepN; k++) {
    const r = ranked[k];
    await page.call((h) => inkBot.restore(h), start);
    run.head = start;
    const fr = await page.call((a, o) => inkBot.run(a, o), expanded[r.i], { footprints: 384 });
    if (fr.error) continue;
    const id = await checkpoint(run, page, expanded[r.i], { note: `${spec.label || sid} rank ${k + 1}: ${cands[r.i].label} (search net ${r.net})` }, { search: { id: sid, rank: k + 1, candidate: r.i, source: cands[r.i].actions } }, fr.footprints);
    logEvent(run, { ev: 'act', cp: id, parent: start, n: expanded[r.i].length, labels: [spec.label || sid], lookahead: true, search: sid });
    kept.push(id);
  }
  await page.call((h) => inkBot.restore(h), start);
  run.head = start;
  saveRun(run);
  logEvent(run, { ev: 'back', from: kept[kept.length - 1] || start, to: start });
  fs.writeFileSync(path.join(dir, 'search', sid + '.json'), JSON.stringify({ spec, start, dry, candidates: cands, results: ev.results, kept }, null, 1));
  // one sheet: the target, the start and the leading candidates (all of them for
  // a short explicit list), cropped to where they painted; replays are exact,
  // so re-running the shown ones for pictures gives the same marks
  const showN = Math.min(ranked.length, opt.sheet != null ? +opt.sheet : Array.isArray(spec.candidates) && ranked.length <= 12 ? ranked.length : 8);
  if (showN) {
    const shown = ranked.slice(0, showN);
    const shots = await page.call((o) => inkBot.evaluate(o), { candidates: shown.map((r) => expanded[r.i]), dry, shots: true });
    const sdir = path.join(dir, 'search', sid);
    fs.mkdirSync(sdir, { recursive: true });
    const bb = shown.reduce((b, r) => [Math.min(b[0], r.bbox[0]), Math.min(b[1], r.bbox[1]), Math.max(b[2], r.bbox[2]), Math.max(b[3], r.bbox[3])], [1, 1, 0, 0]);
    const pad = 0.03, crop = [Math.max(0, bb[0] - pad), Math.max(0, bb[1] - pad), Math.min(1, bb[2] + pad), Math.min(1, bb[3] + pad)];
    const items = shown.map((r, k) => {
      const f = path.join(sdir, `rank-${String(k + 1).padStart(2, '0')}-cand-${r.i}.jpg`);
      fs.writeFileSync(f, Buffer.from(shots.results[k].jpg.split(',')[1], 'base64'));
      const id = kept[k], j = id && run.checkpoints[id].judge;
      return `${f}=#${k + 1} net ${r.net}${id ? ` · ${id} judge ${j ? j.verdict + ' ' + j.net : '?'}` : ''} · ${cands[r.i].label}`;
    });
    const start_img = path.join(ROOT, run.checkpoints[start].dry || run.checkpoints[start].render);
    const out = path.join(dir, 'search', sid + '.png');
    py(['sheet', '--target', path.join(dir, run.target), '--crop', crop.join(','), '--out', out, `${start_img}=before (${start})`, ...items]);
    if (kept.length) console.log(`\nkept as lookaheads: ${kept.map((id, k) => `${id} (#${k + 1}, judge ${run.checkpoints[id].judge ? run.checkpoints[id].judge.verdict + ' ' + run.checkpoints[id].judge.net : '?'})`).join(', ')}`);
    console.log(`compare: ${rel(out)} (${showN} of ${ranked.length} candidates)`);
    if (kept.length) console.log(`head is still ${start}; to continue from the best: checkout ${run.id} ${kept[0]}`);
  }
  if (kept.length) {
    if (opt.take) { page.close(); return moveHead(loadRun(run.id), kept[0], 'checkout'); }
  }
  page.close();
};

// ------------------------------------------------------------ codebook
// Thousands of gestures painted once each (horizontally), measured, and
// placed anywhere by rotation, mirror and translation (see codebook.mjs).
function codebookDir(run) { return path.join(STROKES, `codebook-${run.medium}-${run.paper}-${run.res || 1024}`); }
function loadCodebook(run, quiet) {
  const dir = codebookDir(run);
  const f = path.join(dir, 'entries.jsonl');
  if (!fs.existsSync(f)) return null;
  const meta = readJSON(path.join(dir, 'meta.json'));
  const entries = [];
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l) continue; try { entries.push(JSON.parse(l)); } catch {} }   // (a build may be appending)
  if (!quiet && meta.physics !== physicsHash()) process.stderr.write(`codebook: built with different simulation code (${meta.physics}, now ${physicsHash()}); marks may differ — rebuild with: codebook build ${run.id} --force\n`);
  return new CB.Codebook(entries, Object.assign({ dir }, meta));
}

C.codebook = async ({ pos, opt }) => {
  const sub = pos[0];
  const run = loadRun(pos[1]);
  const dir = codebookDir(run);
  const sheetMM = run.sheetMM || [304.8, 228.6];
  if (sub === 'build') {
    const n = +opt.n || 12000, seed = +opt.seed || 1;
    fs.mkdirSync(path.join(dir, 'sheets'), { recursive: true });
    const metaF = path.join(dir, 'meta.json'), entF = path.join(dir, 'entries.jsonl');
    if (opt.force) { for (const f of [metaF, entF]) if (fs.existsSync(f)) fs.rmSync(f); for (const f of fs.readdirSync(path.join(dir, 'sheets'))) fs.rmSync(path.join(dir, 'sheets', f)); }
    const page = await attach(run, 'cp-0000', 'codebook');
    const brush = run.medium === 'ink' ? 'fude' : 'round';
    const brushW = await page.call((b) => { const x = new BristleBrush(inkBrush.cpm); const w = []; for (let i = 0; i < 10; i++) { x.configure(b, i); w.push(+(2 * x.Wc / x.cpm).toFixed(2)); } return w; }, brush);
    const sizes = opt.sizes ? String(opt.sizes).split(',').map(Number) : [...Array(10).keys()];
    let meta = fs.existsSync(metaF) ? readJSON(metaF) : null;
    if (meta && (meta.seed !== seed || meta.brush !== brush)) die(`${rel(dir)} was built with seed ${meta.seed} / ${meta.brush}; use --force to rebuild`);
    meta = { version: 1, medium: run.medium, paper: run.paper, res: run.res || 1024, sheetMM, brush, brushW, sizes, seed, n: Math.max(n, (meta && meta.n) || 0), physics: physicsHash(), P: CB.P, created: (meta && meta.created) || now() };
    fs.writeFileSync(metaF, JSON.stringify(meta, null, 1));
    const done = new Set(fs.existsSync(entF) ? fs.readFileSync(entF, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
    const items = [];
    for (let i = 0; i < n; i++) { if (done.has(i)) continue; const g = CB.sampleGesture(i, seed, brush, sizes); items.push({ id: i, g, box: CB.gestureBox(g, brushW) }); }
    const sheets = CB.packSheets(items, sheetMM);
    const s0 = fs.readdirSync(path.join(dir, 'sheets')).filter((f) => /^\d+\.png$/.test(f)).length;
    process.stderr.write(`codebook ${rel(dir)}: ${done.size} done, ${items.length} to paint on ${sheets.length} sheets\n`);
    const t0 = Date.now();
    let painted = 0, tPaint = 0, tMeasure = 0;
    // each sheet is measured while the next one paints
    let pending = null;
    const finish = async () => {
      if (!pending) return;
      const { job, cells, tmp, cf } = pending;
      const tB = Date.now();
      const ds = await job;
      tMeasure += Date.now() - tB;
      const byId = new Map(ds.map((d) => [d.id, d.d]));
      fs.appendFileSync(entF, cells.map((c) => JSON.stringify({ id: c.id, g: c.g, sheet: c.sheet, x: c.x, y: c.y, box: c.box, d: byId.get(c.id) || null })).join('\n') + '\n');
      for (const f of [tmp, cf]) fs.rmSync(f, { force: true });
      painted += cells.length;
      pending = null;
    };
    for (let k = 0; k < sheets.length; k++) {
      const sid = s0 + k;
      const cells = sheets[k].map((c) => ({ id: items[c.i].id, sheet: sid, x: +c.x.toFixed(2), y: +c.y.toFixed(2), box: items[c.i].box.map((v) => +v.toFixed(2)), g: items[c.i].g }));
      const actions = cells.flatMap((c) => CB.placeGesture(c.g, { x: c.x, y: c.y, angle: 0 }, sheetMM));
      if (k === 0) { const v = await page.call((a) => inkBot.validate(a), actions); if (!v.ok) { page.close(); die(v.error); } }
      const tA = Date.now();
      const r = await page.call((a, o) => inkBot.scratch(a, o), actions, { max: 240 });
      tPaint += Date.now() - tA;
      if (r.error) process.stderr.write(`sheet ${sid}: ${r.error}\n`);
      await finish();
      const tmp = path.join(os.tmpdir(), `ink-cb-${process.pid}-${sid}.png`), cf = path.join(os.tmpdir(), `ink-cb-${process.pid}-${sid}.json`);
      savePng(r.png, tmp);
      fs.writeFileSync(cf, JSON.stringify(cells.map(({ id, x, y, box, g }) => ({ id, x, y, box, path: g.kind === 'press' ? [[0, 0]] : CB.gesturePath(g, Math.max(2.5, g.L / 12)).map((q) => [+q[0].toFixed(1), +q[1].toFixed(1)]) }))));
      const atlas = path.join(dir, 'sheets', `${String(sid).padStart(4, '0')}.png`);
      const args = ['cbmeasure', tmp, cf, '--sheet', sheetMM.join(','), '--atlas', atlas];
      if (run.paperRGB) args.push('--paper', run.paperRGB.join(','));
      if (opt['keep-sheets']) fs.copyFileSync(tmp, atlas.replace(/\.png$/, '-full.png'));
      pending = { job: pyAsync(args), cells, tmp, cf };
      const el = (Date.now() - t0) / 1000;
      if (painted) process.stderr.write(`\rsheet ${k + 1}/${sheets.length}: ${painted} gestures in ${el.toFixed(0)} s (${(painted / el).toFixed(1)}/s, ${((items.length - painted) / (painted / el) / 60).toFixed(1)} min left; painting ${(tPaint / 1000).toFixed(0)} s, waiting on measurement ${(tMeasure / 1000).toFixed(0)} s)   `);
    }
    await finish();
    process.stderr.write('\n');
    page.close();
    const cb = loadCodebook(run, true);
    console.log(`codebook: ${cb.size} marks (${cb.entries.filter((e) => e.g.kind === 'press').length} presses) in ${rel(dir)}`);
    return;
  }
  if (sub === 'info') {
    const cb = loadCodebook(run);
    if (!cb) die(`no codebook for ${run.medium}/${run.paper} yet: codebook build ${run.id}`);
    const lens = cb.entries.map((e) => e.d.len).sort((a, b) => a - b), q = (a, f) => a[Math.floor(f * (a.length - 1))];
    const wmax = cb.entries.map((e) => Math.max(...e.d.w)).sort((a, b) => a - b), vmin = cb.entries.map((e) => e.d.vmin).sort((a, b) => a - b);
    console.log(`${cb.size} marks, ${cb.entries.filter((e) => e.g.kind === 'press').length} presses; brush ${cb.meta.brush} sizes ${cb.meta.sizes.join(',')}; physics ${cb.meta.physics}${cb.meta.physics === physicsHash() ? ' (current)' : ' (OUT OF DATE)'}`);
    console.log(`length mm   5/50/95%: ${q(lens, 0.05)} / ${q(lens, 0.5)} / ${q(lens, 0.95)}`);
    console.log(`widest mm   5/50/95%: ${q(wmax, 0.05)} / ${q(wmax, 0.5)} / ${q(wmax, 0.95)}`);
    console.log(`darkest L*  5/50/95%: ${q(vmin, 0.05)} / ${q(vmin, 0.5)} / ${q(vmin, 0.95)}`);
    return;
  }
  if (sub === 'query') {
    // the nearest marks to one described or measured mark, without painting
    const lib = library(run);
    const a = { path: JSON.parse(opt.path), k: +opt.k || 8 };
    if (opt.width) a.width = +opt.width;
    if (opt.value) a.value = +opt.value;
    if (opt.ends) a.ends = String(opt.ends).split(',').map(Number);
    const r = lib.fitCandidates(a, a.k);
    const t = r.target;
    console.log(`target: ${t.len.toFixed(1)} mm long, width ${Math.max(...t.w).toFixed(1)} mm max, L${Math.min(...t.v).toFixed(0)}–${Math.max(...t.v).toFixed(0)}`);
    for (const c of r.candidates) console.log(`  ${c.label}  rms ${c.match.rms} mm  ` + JSON.stringify(c.match.g));
    return;
  }
  if (sub === 'fit') return codebookFit(run, opt);
  if (sub === 'paint') return codebookPaint(run, opt);
  if (sub === 'test') return codebookTest(run, opt);
  die('codebook: build <run> [--n 12000] [--seed 1] [--sizes 0,1,..] [--force] | info <run> | query <run> --path JSON [--width mm --value L] | fit <run> --box x0,y0,x1,y1 | test <run>');
};

// Paint a passage of the target out of codebook marks: trace its marks, and
// for each (palest first) evaluate the nearest codebook marks and their
// interpolations in the page from the painting as it stands plus the marks
// already chosen, keep the best, and go on. Writes a batch; the painting is
// left as it was.
async function codebookFit(run, opt) {
  if (!run.target) die('no target yet');
  const box = opt.box || die('fit needs --box x0,y0,x1,y1');
  const marks = py(['trace', path.join(runDir(run.id), run.target), '--box', box, '--darker-than', String(opt['darker-than'] || 60), '--min-len', String(opt['min-len'] || 8)]);
  if (!marks.length) die(`no marks darker than L${opt['darker-than'] || 60} in ${box}`);
  const pick = opt.marks ? new Set(String(opt.marks).split(',').map((x) => +String(x).replace(/^t/, ''))) : null;
  const order = marks.map((m, i) => ({ m, i })).filter((x) => !pick || pick.has(x.i)).sort((a, b) => b.m.value - a.m.value);
  const lib = library(run);
  const page = await attach(run);
  const dir = runDir(run.id);
  const thumb = path.join(dir, 'target-384.png');
  if (!fs.existsSync(thumb) || fs.statSync(thumb).mtimeMs < fs.statSync(path.join(dir, run.target)).mtimeMs) py(['thumb', path.join(dir, run.target), thumb, '--width', '384']);
  const key = run.id + ':' + fs.statSync(thumb).mtimeMs;
  await page.eval(`inkBot.setTarget(${JSON.stringify('data:image/png;base64,' + fs.readFileSync(thumb).toString('base64'))}, ${JSON.stringify(key)}, ${run.paperRGB ? sRGBtoL(run.paperRGB) : 95})`);
  const dry = !opt['no-dry'];
  const batch = [{ type: 'dry', label: 'dry before the fitted marks' }];
  await page.call((a) => inkBot.run(a), batch);   // candidates are judged on the sheet the batch will paint on
  const report = [];
  const t0 = Date.now();
  let tried = 0;
  for (const { m, i } of order) {
    let r;
    try { r = lib.fitCandidates({ path: m.path, k: +opt.k || 8 }); } catch (e) { report.push(`t${i}: ${e.message}`); continue; }
    const cands = r.candidates;
    const ev = await page.call((o) => inkBot.evaluate(o), { candidates: cands.map((c) => c.actions), dry });
    tried += cands.length;
    const ranked = ev.results.filter((x) => !x.error).sort((a, b) => b.net - a.net);
    const best = ranked[0];
    if (!best || best.net <= 0) { report.push(`t${i}: skipped (best of ${cands.length} would not improve the sheet: net ${best ? best.net : '-'})`); continue; }
    const c = cands[best.i];
    const acts = c.actions.map((x) => Object.assign({}, x, { label: `fit t${i}: ${c.label}` }));
    const rr = await page.call((a) => inkBot.run(a), acts);
    if (rr.error) { report.push(`t${i}: ${rr.error}`); continue; }
    batch.push(...acts);
    report.push(`t${i} (${m.length_mm} mm, L${m.value}): ${c.label} — net ${best.net} (${best.verdict}), best of ${cands.length}`);
  }
  await page.call((h) => inkBot.restore(h), run.head);
  const outF = opt.out || path.join(dir, 'batches', `fit-${box.replace(/,/g, '_')}.json`);
  fs.mkdirSync(path.dirname(outF), { recursive: true });
  fs.writeFileSync(outF, JSON.stringify(batch, null, 1));
  // what the batch does, dried, beside the target
  const look = await page.call((a, o) => inkBot.lookahead(a, o), batch, { max: 240 });
  page.close();
  const img = savePng(look.png, path.join(dir, 'scratch', `fit-${Date.now()}.png`));
  const b = box.split(',').map(Number), pad = 0.02;
  const crop = [Math.max(0, b[0] - pad), Math.max(0, b[1] - pad), Math.min(1, b[2] + pad), Math.min(1, b[3] + pad)];
  const head = run.checkpoints[run.head];
  const sheetOut = path.join(dir, 'search', `fit-${box.replace(/,/g, '_')}.png`);
  fs.mkdirSync(path.dirname(sheetOut), { recursive: true });
  py(['sheet', '--target', path.join(dir, run.target), '--crop', crop.join(','), '--out', sheetOut, `${path.join(ROOT, head.dry || head.render)}=before (${run.head})`, `${img}=fitted (${batch.length - 1} marks)`]);
  report.forEach((l) => console.log(l));
  console.log(`\n${order.length} marks, ${tried} candidates evaluated in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`batch: ${rel(outF)}   compare: ${rel(sheetOut)}`);
  console.log(`paint it with: act ${run.id} ${rel(outF)}   (or try, to keep it as a lookahead)`);
}

// Does the codebook do what it claims? (1) Rotation: the same gestures
// painted at other angles and mirrored leave the same marks. (2) Prediction:
// new gestures (not in the codebook) are painted, measured, looked up, and
// the nearest entry and the interpolation of the nearest are painted in their
// place; how close do they come?
async function codebookTest(run, opt) {
  const cb = loadCodebook(run);
  if (!cb) die('no codebook yet');
  const sheetMM = cb.meta.sheetMM;
  const n = +opt.n || 24;
  const page = await attach(run, 'cp-0000', 'codebook-test');
  const measureAlong = async (actionsList, paths, extend = 12) => {
    // paint each mark alone on scrap and measure it along its path
    const out = [];
    for (let k = 0; k < actionsList.length; k++) {
      const r = await page.call((a, o) => inkBot.scratch(a, o), actionsList[k], { max: 240 });
      const f = path.join(os.tmpdir(), `ink-cbt-${process.pid}.png`);
      savePng(r.png, f);
      out.push(py(['profile', f, '--path', JSON.stringify(paths[k].map((q) => [q[0] / sheetMM[0], q[1] / sheetMM[1]])), '--sheet', sheetMM.join(','), '--search', '14', '--thr', '4', '--extend', String(extend)]));
    }
    return out;
  };
  const cmp = (a, b) => {
    // mean width error (mm), mean value error (L*), length error (%)
    let dw = 0, dv = 0;
    for (let j = 0; j < CB.P; j++) { dw += Math.abs(a.w[j] - b.w[j]); dv += Math.abs(a.v[j] - b.v[j]); }
    return { w: dw / CB.P, v: dv / CB.P, len: (100 * Math.abs(a.len - b.len)) / Math.max(1, b.len) };
  };
  const mean = (xs, k) => +(xs.reduce((s, x) => s + x[k], 0) / xs.length).toFixed(2);
  // (1) rotation, against the noise floor: the same gesture repainted at 0°
  // (each loading of the brush lays its hairs differently)
  const strokes = cb.entries.filter((e) => e.g.kind === 'stroke' && e.d.len > 20 && e.d.len < 90 && e.g.bow < 0.12);
  const pickE = [...Array(Math.min(+opt.rot || 10, strokes.length)).keys()].map((k) => strokes[Math.floor((k * 7919 + 13) % strokes.length)]);
  const variants = [[0, false], [0, false], [0, false, 45, 0], [0, false, -30, 35], [37, false], [90, false], [143, false], [216, false], [300, false], [37, true], [216, true]];
  const rot = {};
  for (const e of pickE) {
    const acts = [], paths = [];
    for (const [deg, mirror, dx, dy] of variants) {
      const ang = (deg * Math.PI) / 180, pose = { x: 0, y: 0, angle: ang, mirror };
      const mid = CB.transform(pose)([e.g.L / 2, 0]);
      pose.x = sheetMM[0] / 2 - mid[0] + (dx || 0); pose.y = sheetMM[1] / 2 - mid[1] + (dy || 0);
      const T = CB.transform(pose);
      acts.push(CB.placeGesture(e.g, pose, sheetMM));
      const cl = []; for (let j = 0; j < CB.P; j++) cl.push(T([e.d.x0 + ((e.d.x1 - e.d.x0) * (j + 0.5)) / CB.P, e.d.c[j]]));
      paths.push(cl);
    }
    const got = await measureAlong(acts, paths);
    const base = got[0];
    got.forEach((g, k) => {
      if (!k) return;
      const key = k === 1 ? 'same place, 0°' : variants[k][2] != null ? `moved ${Math.hypot(variants[k][2], variants[k][3]).toFixed(0)} mm, 0°` : `${variants[k][0]}°${variants[k][1] ? ' mirrored' : ''}`;
      (rot[key] = rot[key] || []).push(cmp(g, base));
    });
  }
  console.log(`rotation: ${pickE.length} gestures, each against itself painted at 0° (widths in mm, values in L*, length in %):`);
  for (const [k, xs] of Object.entries(rot)) console.log(`  ${k.padEnd(20)} width ${mean(xs, 'w')}  value ${mean(xs, 'v')}  length ${mean(xs, 'len')}`);
  // (2) prediction
  const pred = { nearest: [], blend: [], solve: [] };
  const brushW = cb.meta.brushW;
  for (let k = 0; k < n; k++) {
    const g = CB.sampleGesture(k, 9000 + (+opt.seed || 7), cb.meta.brush, cb.meta.sizes);
    if (g.kind !== 'stroke') continue;
    const ang = (((k * 67) % 360) * Math.PI) / 180;
    const pose0 = { x: 0, y: 0, angle: ang };
    const T0 = CB.transform(pose0), mid = T0([g.L / 2, 0]);
    const pose = { x: sheetMM[0] / 2 - mid[0], y: sheetMM[1] / 2 - mid[1], angle: ang };
    const T = CB.transform(pose);
    const pathMM = CB.gesturePath(g, 3).map((q) => T(q));
    const [truth] = await measureAlong([CB.placeGesture(g, pose, sheetMM)], [pathMM]);
    if (!truth || truth.len < 4 || Math.max(...truth.w) < 0.5) continue;
    const t = CB.makeTarget(truth.pts, truth.w, truth.v, truth.cov);
    const ms = cb.nearest(t, 8, { direction: 'forward', kinds: ['stroke'] });
    if (!ms.length) continue;
    const ms32 = cb.nearest(t, 32, { direction: 'forward', kinds: ['stroke'] });
    const tries = { nearest: { g: ms[0].entry.g, d: ms[0].entry.d, mirror: ms[0].mirror }, blend: (() => { const B = CB.blendMatches(ms32, 6); return { g: B.g, d: B.d, mirror: B.flip ? !ms32[0].mirror : ms32[0].mirror }; })() };
    const S = CB.solveMatches(ms32, t);
    if (S) tries.solve = { g: S.g, d: S.d, mirror: S.flip ? !ms32[0].mirror : ms32[0].mirror };
    for (const [name, c] of Object.entries(tries)) {
      const pz = CB.alignPose({ d: c.d }, c.mirror, t.pts);
      const [got] = await measureAlong([CB.placeGesture(c.g, pz, sheetMM)], [truth.pts]);
      pred[name].push(cmp(got, truth));
    }
  }
  page.close();
  console.log(`prediction: ${pred.nearest.length} new gestures painted, looked up (forward), and repainted from the codebook:`);
  for (const k of ['nearest', 'blend', 'solve']) if (pred[k].length) console.log(`  ${k.padEnd(8)} width off ${mean(pred[k], 'w')} mm, value off ${mean(pred[k], 'v')} L*, length off ${mean(pred[k], 'len')}%`);
}

// ---------------------------------------------------------- codebook paint
// Paint gestures on scrap in the codebook's own tab, measure them, and add
// them to the codebook (a grown neighbourhood, kept for later fits).
async function paintGestures(run, cbPage, cb, gs) {
  const meta = cb.meta, sheetMM = meta.sheetMM;
  const entF = path.join(meta.dir, 'entries.jsonl');
  let next = Math.max(1000000, cb.maxId() + 1);
  const items = gs.map((g) => ({ id: next++, g, box: CB.gestureBox(g, meta.brushW) }));
  const added = [];
  for (const sh of CB.packSheets(items, sheetMM)) {
    const cells = sh.map((c) => ({ id: items[c.i].id, x: +c.x.toFixed(2), y: +c.y.toFixed(2), box: items[c.i].box.map((v) => +v.toFixed(2)), g: items[c.i].g }));
    const r = await cbPage.call((a, o) => inkBot.scratch(a, o), cells.flatMap((c) => CB.placeGesture(c.g, { x: c.x, y: c.y, angle: 0 }, sheetMM)), { max: 240 });
    const tmp = path.join(os.tmpdir(), `ink-grow-${process.pid}.png`), cf = path.join(os.tmpdir(), `ink-grow-${process.pid}.json`);
    savePng(r.png, tmp);
    fs.writeFileSync(cf, JSON.stringify(cells.map(({ id, x, y, box, g }) => ({ id, x, y, box, path: g.kind === 'press' ? [[0, 0]] : CB.gesturePath(g, Math.max(2.5, g.L / 12)).map((q) => [+q[0].toFixed(1), +q[1].toFixed(1)]) }))));
    const args = ['cbmeasure', tmp, cf, '--sheet', sheetMM.join(',')];
    if (run.paperRGB) args.push('--paper', run.paperRGB.join(','));
    const byId = new Map(py(args).map((d) => [d.id, d.d]));
    const es = cells.map((c) => ({ id: c.id, g: c.g, sheet: -1, grown: true, x: c.x, y: c.y, box: c.box, d: byId.get(c.id) || null }));
    fs.appendFileSync(entF, es.map((e) => JSON.stringify(e)).join('\n') + '\n');
    added.push(...es);
  }
  cb.add(added);
  return added.length;
}

// Grow the codebook toward one target mark: perturb the gestures of its
// nearest marks, paint and measure them, keep the nearest, narrow, repeat
// (a cross-entropy search in gesture space, judged on clean paper).
async function growFor(run, cbPage, cb, t, rounds, per, rnd) {
  const sig = [0.35, 0.18, 0.1, 0.06];
  let best = cb.nearest(t, 8, { kinds: ['stroke'] });
  const d0 = best.length ? best[0].d : Infinity;
  let n = 0;
  for (let r = 0; r < rounds && best.length; r++) {
    const elite = best.slice(0, 6).map((m) => m.entry.g);
    const gs = [];
    for (let k = 0; k < per; k++) gs.push(CB.perturbGesture(elite[Math.floor(Math.pow(rnd(), 1.6) * elite.length)], sig[Math.min(r, sig.length - 1)], rnd));
    n += await paintGestures(run, cbPage, cb, gs);
    best = cb.nearest(t, 8, { kinds: ['stroke'] });
  }
  return { d0, d1: best.length ? best[0].d : Infinity, painted: n };
}

// Small moves of a stroke already placed: shift, turn and scale about its
// middle, press, load and speed.
function jitterActions(acts, s, rnd, sheetMM) {
  const u = () => rnd() * 2 - 1;
  const ang = (6 * s * u() * Math.PI) / 180, sc = 1 + 0.08 * s * u(), r = 2.5 * s * Math.sqrt(rnd()), th = rnd() * 2 * Math.PI;
  const dx = r * Math.cos(th), dy = r * Math.sin(th), pf = 1 + 0.12 * s * u(), lf = 1 + 0.2 * s * u(), vf = 1 + 0.15 * s * u();
  return acts.map((a) => {
    const b = JSON.parse(JSON.stringify(a));
    const pts = b.pts ? b.pts.map((q) => [q[0] * sheetMM[0], q[1] * sheetMM[1]]) : b.at ? [[b.at[0] * sheetMM[0], b.at[1] * sheetMM[1]]] : null;
    if (pts) {
      const cx = pts.reduce((z, q) => z + q[0], 0) / pts.length, cy = pts.reduce((z, q) => z + q[1], 0) / pts.length;
      const c = Math.cos(ang), sn = Math.sin(ang);
      const T = (q) => { const x = (q[0] - cx) * sc, y = (q[1] - cy) * sc; return [+((cx + dx + c * x - sn * y) / sheetMM[0]).toFixed(4), +((cy + dy + sn * x + c * y) / sheetMM[1]).toFixed(4)]; };
      if (b.pts) b.pts = b.pts.map((q, i) => [...T(pts[i]), q[2] == null ? q[2] : +Math.min(1, q[2] * pf).toFixed(3)]);
      if (b.at) b.at = T(pts[0]);
    }
    if (b.press != null) b.press = +Math.min(0.98, b.press * pf).toFixed(3);
    if (b.load != null) b.load = +Math.min(0.98, Math.max(0.02, b.load * lf)).toFixed(3);
    if (b.speed != null) b.speed = Math.round(b.speed * vf);
    return b;
  });
}

// Paint a passage (or the sheet) from the codebook: the pale masses first,
// then strokes level by level from the darkest, each level found in what is
// still missing (the residual: target over painting). Every stroke is fitted
// from the codebook, the codebook grown toward it, the best candidate
// refined in place, and kept only if it improves the sheet.
async function codebookPaint(run, opt) {
  if (!run.target) die('no target yet');
  const box = opt.box || '0,0,1,1';
  const levels = String(opt.levels || '40,55,68,80').split(',').map(Number);
  const rounds = opt.grow != null ? +opt.grow : 2, per = +opt.per || 40, nRefine = opt.refine != null ? +opt.refine : 16, k = +opt.k || 8;
  const minLen = +opt['min-len'] || 6, maxPer = +opt.max || 40, minNet = opt['min-net'] != null ? +opt['min-net'] : 1;
  const lib = library(run);
  const cb = lib.book();
  const dir = runDir(run.id);
  const tag = `paint-${box.replace(/,/g, '_')}`;
  const work = path.join(dir, 'fit', tag);
  fs.mkdirSync(work, { recursive: true });
  const target = path.join(dir, run.target);
  const paperArgs = run.paperRGB ? ['--paper', run.paperRGB.join(',')] : [];
  const page = await attach(run);
  const thumb = path.join(dir, 'target-384.png');
  if (!fs.existsSync(thumb) || fs.statSync(thumb).mtimeMs < fs.statSync(target).mtimeMs) py(['thumb', target, thumb, '--width', '384']);
  const key = run.id + ':' + fs.statSync(thumb).mtimeMs;
  await page.eval(`inkBot.setTarget(${JSON.stringify('data:image/png;base64,' + fs.readFileSync(thumb).toString('base64'))}, ${JSON.stringify(key)}, ${run.paperRGB ? sRGBtoL(run.paperRGB) : 95})`);
  const cbPage = rounds > 0 ? await attach(run, 'cp-0000', 'codebook') : null;
  const rnd = prng(+opt.seed || 5);
  const batch = [{ type: 'dry', label: 'dry before the codebook passage' }];
  await page.call((a) => inkBot.run(a), batch);
  const t0 = Date.now();
  const stats = { tried: 0, kept: 0, candidates: 0, grown: 0 };
  let rstep = 0;
  const residual = async () => {
    const pr = await page.call((o) => inkBot.previewDry(o), { max: 240 });
    const pf = savePng(pr.png, path.join(work, `paint-${rstep}.png`)), rf = path.join(work, `residual-${rstep}.png`);
    rstep++;
    const r = py(['residual', target, pf, rf, '--box', box, ...paperArgs]);
    return { file: rf, missing: r.missing };
  };
  const judge = async (cands, band) => {
    const ev = await page.call((o) => inkBot.evaluate(o), { candidates: cands.map((c) => c.actions), dry: true, band });
    stats.candidates += cands.length;
    const ranked = ev.results.filter((x) => !x.error).sort((a, b) => b.net - a.net);
    return ranked.length ? Object.assign({}, cands[ranked[0].i], { net: ranked[0].net, verdict: ranked[0].verdict }) : null;
  };
  const keep = async (c, label) => {
    const acts = c.actions.map((x) => Object.assign({}, x, { label }));
    const r = await page.call((a) => inkBot.run(a), acts);
    if (r.error) return false;
    batch.push(...acts);
    stats.kept++;
    return true;
  };
  const say = (m) => process.stderr.write(m + '\n');
  const first = await residual();
  say(`${tag}: ink missing in the box ${first.missing} (mean L* below paper)`);
  // ---- pale masses: mist or a wash
  if (!opt['no-masses']) {
    const masses = py(['masses', first.file, '--box', box, '--depth', String(opt['mass-depth'] || 4), '--min-area', String(opt['min-area'] || 500), ...paperArgs]);
    for (const [i, m] of masses.entries()) {
      if (m.value < 62) continue;   // darker areas are strokes' business
      const opts = [['mist', Math.min(95, Math.max(86, m.value))], ['wash', m.value], ['wash', Math.min(95, m.value + 4)]];
      const cands = [];
      for (const [kind, v] of opts) { try { cands.push({ label: `${kind} L${Math.round(v)}`, actions: lib.expand({ type: 'lib', stroke: kind, rings: m.rings, value: v }) }); } catch {} }
      stats.tried++;
      const best = cands.length ? await judge(cands) : null;
      if (best && best.net > minNet && await keep(best, `mass ${i}: ${best.label} (${m.area_mm2} mm²)`)) say(`  mass ${i} (${m.area_mm2} mm², L${m.value}): ${best.label} — net ${best.net}`);
      else say(`  mass ${i} (${m.area_mm2} mm², L${m.value}): skipped (${best ? 'net ' + best.net : 'no candidate'})`);
    }
    await page.call((a) => inkBot.run(a), [{ type: 'dry' }]);
    batch.push({ type: 'dry', label: 'dry after the masses' });
  }
  // ---- strokes, darkest first, in what is still missing
  for (const level of levels) {
    const res = await residual();
    const strokes = py(['strokes', res.file, '--box', box, '--darker-than', String(level), '--min-len', String(minLen), '--max', String(maxPer), '--overlay', path.join(work, `strokes-L${level}.png`)]);
    say(`level L${level}: ink missing ${res.missing}, ${strokes.length} strokes`);
    for (const [i, st] of strokes.entries()) {
      const pr = py(['profile', res.file, '--path', JSON.stringify(st.path), '--sheet', (run.sheetMM || [304.8, 228.6]).join(','), '--extend', '15', ...paperArgs]);
      if (!pr.w.some((w) => w > 0.6) || pr.len < minLen) continue;
      stats.tried++;
      const tgt = { pts: pr.pts, w: pr.w, v: pr.v, cov: pr.cov };
      let r;
      try { r = lib.fitCandidates({ target: tgt, k }); } catch (e) { say(`  L${level} s${i}: ${e.message}`); continue; }
      // ink must land on this mark, not just darken the area around it
      const band = opt['no-band'] ? null : CB.targetBand(r.target, run.sheetMM || [304.8, 228.6]);
      let best = await judge(r.candidates, band);
      let note = '';
      if (cbPage) {
        const g = await growFor(run, cbPage, cb, r.target, rounds, per, rnd);
        stats.grown += g.painted;
        note = ` (codebook grown: nearest ${g.d0.toFixed(1)} → ${g.d1.toFixed(1)})`;
        const r2 = lib.fitCandidates({ target: tgt, k: 6, library: false });
        const b2 = await judge(r2.candidates, band);
        if (b2 && (!best || b2.net > best.net)) best = b2;
      }
      if (best && nRefine > 0) {
        const vars = [];
        for (let q = 0; q < nRefine; q++) vars.push({ label: best.label + ' (refined)', actions: jitterActions(best.actions, q < nRefine / 2 ? 1 : 0.5, rnd, run.sheetMM || [304.8, 228.6]) });
        const b3 = await judge(vars, band);
        if (b3 && b3.net > best.net) best = b3;
      }
      if (best && best.net > minNet && await keep(best, `L${level} s${i}: ${best.label}`)) say(`  s${i} (${pr.len.toFixed(0)} mm): ${best.label} — net ${best.net}${note}`);
      else say(`  s${i} (${pr.len.toFixed(0)} mm): skipped (${best ? 'net ' + best.net : 'no candidate'})${note}`);
    }
    await page.call((a) => inkBot.run(a), [{ type: 'dry' }]);
    batch.push({ type: 'dry', label: `dry after level L${level}` });
  }
  const last = await residual();
  await page.call((h) => inkBot.restore(h), run.head);
  const outF = opt.out || path.join(dir, 'batches', `${tag}.json`);
  fs.mkdirSync(path.dirname(outF), { recursive: true });
  fs.writeFileSync(outF, JSON.stringify(batch, null, 1));
  const look = await page.call((a, o) => inkBot.lookahead(a, o), batch, { max: 240 });
  page.close();
  if (cbPage) cbPage.close();
  const img = savePng(look.png, path.join(work, 'result.png'));
  const b = box.split(',').map(Number), pad = 0.01;
  const crop = [Math.max(0, b[0] - pad), Math.max(0, b[1] - pad), Math.min(1, b[2] + pad), Math.min(1, b[3] + pad)];
  const head = run.checkpoints[run.head];
  const sheetOut = path.join(dir, 'search', `${tag}.png`);
  fs.mkdirSync(path.dirname(sheetOut), { recursive: true });
  const beforeImg = head.dry || head.render ? [`${path.join(ROOT, head.dry || head.render)}=before (${run.head})`] : [];
  py(['sheet', '--target', target, '--crop', crop.join(','), '--out', sheetOut, ...beforeImg, `${img}=codebook-painted (${stats.kept} marks)`]);
  console.log(`\n${stats.kept} of ${stats.tried} marks kept; ${stats.candidates} candidates painted in place, ${stats.grown} gestures added to the codebook; ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`ink missing in the box: ${first.missing} → ${last.missing}`);
  console.log(`batch: ${rel(outF)}   compare: ${rel(sheetOut)}`);
  if (opt.act) { await C.act({ pos: [run.id, outF], opt: { note: opt.note || `codebook passage ${box}` } }); }
  else console.log(`paint it with: act ${run.id} ${rel(outF)}`);
}

// Pencil: how dark each grade lays at each pressure, as hatching (1.2 mm
// apart), as shading with the side of the lead, and as one line — measured
// on scrap, so the library can pick a grade and pressure for a value.
async function pencilCalibrate(run) {
  const sheetMM = run.sheetMM || [304.8, 228.6];
  const lib = new Library({ sheetMM, medium: 'pencil', paper: run.paper, paperL: run.paperRGB ? sRGBtoL(run.paperRGB) : 94 });
  const grades = ['2H', 'HB', '2B', '4B', '6B', '8B'];
  const cols = [['tone', 0.25], ['tone', 0.45], ['tone', 0.65], ['tone', 0.85], ['side', 0.3], ['side', 0.55], ['side', 0.8], ['line', 0.3], ['line', 0.6], ['line', 0.9]];
  const actions = [], cells = [];
  const fx = (mm) => mm / sheetMM[0], fy = (mm) => mm / sheetMM[1];
  grades.forEach((g, r) => cols.forEach(([kind, pr], c) => {
    const x0 = 9 + c * 29, y0 = 10 + r * 35, w = 16, h = 16;
    const rect = [fx(x0), fy(y0), fx(x0 + w), fy(y0 + h)];
    if (kind === 'line') {
      const y = y0 + h / 2;
      actions.push(...lib._pencilLine({ path: [[fx(x0), fy(y)], [fx(x0 + w), fy(y)]], width: 0.7, grade: g, pressure: pr, taper_mm: [0, 0] }));
      cells.push({ id: `${kind}:${g}:${pr}`, kind: 'line', axis: [[fx(x0), fy(y)], [fx(x0 + w), fy(y)]], box: [fx(x0 - 2), fy(y - 4), fx(x0 + w + 2), fy(y + 4)] });
    } else {
      actions.push(...(kind === 'tone' ? lib._hatch({ rect, angle: 45, spacing: 1.2, grade: g, pressure: pr, jitter: 0, seed: r * 31 + c }) : lib._tone({ rect, grade: g, pressure: pr, seed: r * 31 + c })));
      cells.push({ id: `${kind}:${g}:${pr}`, area: true, box: [fx(x0 + 3), fy(y0 + 3), fx(x0 + w - 3), fy(y0 + h - 3)] });
    }
  }));
  const page = await attach(run);
  process.stderr.write(`painting the pencil calibration sheet (${actions.length} strokes)...\n`);
  const r = await page.call((a, o) => inkBot.scratch(a, o), actions, { max: 5 });
  page.close();
  const img = savePng(r.png, path.join(STROKES, `cal-pencil-${run.paper}.png`));
  const cf = path.join(os.tmpdir(), `ink-pcal-${process.pid}.json`);
  fs.writeFileSync(cf, JSON.stringify(cells));
  const m = py(['measure', img, cf, '--paper', (run.paperRGB || [244, 240, 229]).join(','), '--sheet', sheetMM.join(',')]);
  const tables = { tone: {}, side: {}, line: {} };
  for (const c of m) {
    if (!c.found) continue;
    const [kind, g, pr] = c.id.split(':');
    (tables[kind][g] = tables[kind][g] || []).push([+pr, c.L]);
  }
  for (const k of Object.keys(tables)) for (const g of Object.keys(tables[k])) tables[k][g].sort((a, b) => a[0] - b[0]);
  const cal = { version: 1, created: now(), medium: 'pencil', paper: run.paper, paperL: run.paperRGB ? sRGBtoL(run.paperRGB) : 94, code: codeHash(), pencil: tables };
  // closed loop: hatching asked for at a range of values (with its layers
  // and spacing chosen as usual), measured; the library then asks for
  // whatever value lands where it should
  const lib2 = new Library({ sheetMM, medium: 'pencil', paper: run.paper, paperL: cal.paperL, cal });
  const asks = [28, 36, 44, 52, 60, 68, 76, 84, 90];
  const acts2 = [], cells2 = [];
  asks.forEach((v, i) => {
    const x0 = 10 + (i % 5) * 58, y0 = 20 + Math.floor(i / 5) * 90, w = 40, h = 60;
    acts2.push(...lib2._hatch({ rect: [fx(x0), fy(y0), fx(x0 + w), fy(y0 + h)], value: v, seed: 100 + i }));
    cells2.push({ id: String(v), area: true, box: [fx(x0 + 6), fy(y0 + 8), fx(x0 + w - 6), fy(y0 + h - 8)] });
  });
  const page2 = await attach(run);
  const r2 = await page2.call((a, o) => inkBot.scratch(a, o), acts2, { max: 5 });
  page2.close();
  const img2 = savePng(r2.png, path.join(STROKES, `cal-pencil-${run.paper}-hatch.png`));
  fs.writeFileSync(cf, JSON.stringify(cells2));
  const m2 = py(['measure', img2, cf, '--paper', (run.paperRGB || [244, 240, 229]).join(','), '--sheet', sheetMM.join(',')]);
  cal.pencil.hatchCurve = m2.filter((c) => c.found).map((c) => [+c.id, c.L]).sort((a, b) => a[0] - b[0]);
  writeJSON(calFile(run), cal);
  console.log(`pencil calibration → ${rel(calFile(run))}  (sheet ${rel(img)})`);
  console.log('  hatching asked for → measured: ' + cal.pencil.hatchCurve.map(([a, b]) => `L${a}→L${Math.round(b)}`).join('  '));
  for (const k of ['tone', 'side', 'line']) {
    console.log(`  ${k}:`);
    for (const g of grades) if (tables[k][g]) console.log(`    ${g.padEnd(3)} ` + tables[k][g].map(([p, L]) => `p${p} L${Math.round(L)}`).join('  '));
  }
}

// A close look at one region of the target and the painting (head or any
// checkpoint), with a fine grid in sheet and box coordinates.
C.zoom = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  if (!run.target) die('no target yet');
  const box = opt.box || die('zoom needs --box x0,y0,x1,y1');
  const id = opt.cp || run.head;
  const c = run.checkpoints[id] || die(`no checkpoint ${id}`);
  const img = c.dry || c.render ? path.join(ROOT, c.dry || c.render) : path.join(runDir(run.id), 'blank.png');
  const out = path.join(runDir(run.id), 'zoom', `${id}-${box.replace(/,/g, '_')}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ['zoom', path.join(runDir(run.id), run.target), img, out, '--box', box];
  if (opt.grid) args.push('--grid', String(opt.grid));
  if (opt.width) args.push('--width', String(opt.width));
  const r = py(args);
  console.log(`zoom ${id} ${box}: error ${r.error} (too dark ${r.too_dark}, too light ${r.too_light}); grid every ${r.grid} → ${rel(out)}`);
  console.log(`write actions in this box's own coordinates with "frame": [${box}] (u, v = 0..1 across it)`);
};

// Where gestures will go, without painting: integrate them and draw the
// trajectories over the target and the painting in a box.
C.preview = ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const raw = readActions(pos[1]);
  const groups = expandRegions(run, raw, true);
  const strokes = [];
  const sheetMM = run.sheetMM || [304.8, 228.6];
  let lo = [1, 1], hi = [0, 0];
  groups.forEach((g, gi) => g.forEach((s, k) => {
    if (!s || !s.pts) return;
    const pts = s.pts.map((q) => [q[0], q[1]]);
    for (const q of pts) { lo = [Math.min(lo[0], q[0]), Math.min(lo[1], q[1])]; hi = [Math.max(hi[0], q[0]), Math.max(hi[1], q[1])]; }
    strokes.push({ g: gi, first: k === 0, pts, ts: s.ts || pts.map((_, i) => i * 10) });
  }));
  if (!strokes.length) die('nothing to preview');
  if (opt.dump) fs.writeFileSync(opt.dump, JSON.stringify(strokes.map((q) => ({ g: q.g, label: raw[q.g] && raw[q.g].label, pts: q.pts, ts: q.ts }))));
  const box = opt.box ? opt.box.split(',').map(Number) : [Math.max(0, lo[0] - 0.03), Math.max(0, lo[1] - 0.03), Math.min(1, hi[0] + 0.03), Math.min(1, hi[1] + 0.03)];
  const id = opt.cp || run.head, c = run.checkpoints[id];
  const img = c.dry || c.render ? path.join(ROOT, c.dry || c.render) : path.join(runDir(run.id), 'blank.png');
  const sf = path.join(os.tmpdir(), `ink-preview-${process.pid}.json`);
  fs.writeFileSync(sf, JSON.stringify(strokes));
  const out = path.join(runDir(run.id), 'zoom', `preview-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  py(['overlay', path.join(runDir(run.id), run.target), img, sf, out, '--box', box.join(',')]);
  groups.forEach((g, gi) => {
    const ss = g.filter((s) => s && s.pts);
    if (!ss.length) return;
    const a = ss[0].pts[0], b = ss[0].pts[ss[0].pts.length - 1];
    let L = 0; for (let i = 1; i < ss[0].pts.length; i++) L += Math.hypot((ss[0].pts[i][0] - ss[0].pts[i - 1][0]) * sheetMM[0], (ss[0].pts[i][1] - ss[0].pts[i - 1][1]) * sheetMM[1]);
    const T = ss[0].ts ? ss[0].ts[ss[0].ts.length - 1] : 0;
    const P = ss[0].pts, q = P[Math.max(0, P.length - 4)];
    const hd = Math.round((Math.atan2((b[1] - q[1]) * sheetMM[1], (b[0] - q[0]) * sheetMM[0]) * 180) / Math.PI);
    let miss = '';
    const aim = raw[gi] && Array.isArray(raw[gi].aim) ? unframe({ frame: raw[gi].frame, at: raw[gi].aim }).at : null;
    if (aim) {
      const dx = (b[0] - aim[0]) * sheetMM[0], dy = (b[1] - aim[1]) * sheetMM[1];
      miss = `; misses aim by ${Math.hypot(dx, dy).toFixed(1)} mm (${dx >= 0 ? '+' : ''}${dx.toFixed(1)}, ${dy >= 0 ? '+' : ''}${dy.toFixed(1)})`;
    }
    console.log(`#${gi} ${raw[gi].label || ''}: ${ss.length > 1 ? ss.length + ' strokes; first ' : ''}starts [${a[0].toFixed(3)}, ${a[1].toFixed(3)}] ends [${b[0].toFixed(3)}, ${b[1].toFixed(3)}] heading ${hd}°, ${L.toFixed(1)} mm in ${Math.round(T)} ms${miss}`);
  });
  console.log(`preview: ${rel(out)}  (box ${box.map((v) => v.toFixed(3)).join(',')}; a dot every 50 ms)`);
};

// Re-run the judge over every checkpoint (after the judge itself changes).
C.rejudge = ({ pos }) => {
  const run = loadRun(pos[0]);
  let n = 0;
  for (const [id, c] of Object.entries(run.checkpoints)) {
    const par = run.checkpoints[c.parent];
    if (!par || !par.dry || !c.dry) continue;
    const jargs = ['judge', path.join(runDir(run.id), run.target), path.join(ROOT, par.dry), path.join(ROOT, c.dry)];
    if (run.paperRGB) jargs.push('--paper', run.paperRGB.join(','));
    if (run.medium === 'gouache') jargs.push('--opaque');
    if (c.footprints && c.footprints.length && par.render) jargs.push('--parent-wet', path.join(ROOT, par.render), '--footprints', ...c.footprints.map((f) => path.join(ROOT, f)), '--labels', JSON.stringify(c.footprintEnds ? c.footprintEnds.map((e) => c.actions[e].label || c.actions[e].type) : c.actions.map((a) => a.label || a.type)));
    c.judge = py(jargs);
    n++;
  }
  saveRun(run);
  console.log(`re-judged ${n} checkpoints`);
};

// ink dump <run> [cp]: save a checkpoint's simulation state (raw floats) so
// it can be re-rendered with `ink view` without replaying the painting
C.dump = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const id = resolveCp(run, pos[1] || (run.final && run.final.cp) || run.head);
  const page = await attach(run, id);
  const st = await page.call(() => inkBot.dumpState());
  page.close();
  const dir = path.join(runDir(run.id), 'state', id);
  fs.mkdirSync(dir, { recursive: true });
  const names = ['W', 'F', 'G0', 'G1', 'D0', 'D1', 'FN'];
  for (const k of names) fs.writeFileSync(path.join(dir, k + '.f32'), Buffer.from(st[k], 'base64'));
  writeJSON(path.join(dir, 'state.json'), { run: run.id, cp: id, nx: st.nx, ny: st.ny, code: codeHash(), physics: physicsHash(), meta: JSON.parse(st.meta) });
  console.log(`state of ${id} → ${rel(dir)}`);
};
// ink resume <run> [cp]: put a dumped state back into the run's own page as
// that checkpoint, so painting continues from it without a replay (after
// display-only code changes; the physics must be the same as when dumped)
C.resume = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const id = resolveCp(run, pos[1] || run.head);
  const dir = path.join(runDir(run.id), 'state', id);
  if (!fs.existsSync(path.join(dir, 'state.json'))) die(`no dumped state for ${id} (run: ink dump ${run.id} ${id})`);
  const info = readJSON(path.join(dir, 'state.json'));
  if (info.physics && info.physics !== physicsHash() && !opt.force) die(`the simulation changed since ${id} was dumped (${info.physics} → ${physicsHash()}); replay instead, or --force`);
  await startDaemon(true);
  const page = await Page.open(run.id);
  page.tab = run.id;
  await page.send('Runtime.enable');
  await load(page, run);
  const st = { meta: JSON.stringify(info.meta) };
  for (const k of ['W', 'F', 'G0', 'G1', 'D0', 'D1', 'FN'].filter((k) => fs.existsSync(path.join(dir, k + '.f32')))) {
    const b = fs.readFileSync(path.join(dir, k + '.f32')).toString('base64'), u = 'up-' + k;
    for (let i = 0; i < b.length; i += 1 << 20) await page.eval(`inkBot._put(${JSON.stringify(u)}, ${JSON.stringify(b.slice(i, i + (1 << 20)))})`);
    st[k] = { __big: u };
  }
  await page.call((o) => inkBot.loadState(o), st);
  await page.call((i) => inkBot.snapshot(i), id);
  if (opt.rerender) {
    // its images, rendered with the display code as it is now
    const c = run.checkpoints[id];
    const wet = savePng(await page.call(() => inkBot.render()), path.join(ROOT, c.render));
    if (c.dry && c.dry !== c.render) savePng((await page.call((o) => inkBot.previewDry(o), { max: 240 })).png, path.join(ROOT, c.dry));
    if (run.target) { c.score = py(scoreArgs(run, path.join(ROOT, c.dry || c.render))); saveRun(run); }
  }
  page.close();
  console.log(`${run.id} resumed at ${id} from its dumped state${opt.rerender ? ' (images re-rendered)' : ''}`);
};

// ink view <run> <cp> [--width 2400] [--out f.png]: render a dumped state
// with the current display code (no replay)
C.view = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  const id = resolveCp(run, pos[1] || (run.final && run.final.cp) || run.head);
  const dir = path.join(runDir(run.id), 'state', id);
  if (!fs.existsSync(path.join(dir, 'state.json'))) die(`no dumped state for ${id} (run: ink dump ${run.id} ${id})`);
  await startDaemon(true);
  const page = await Page.open('view-' + run.id);
  page.tab = 'view-' + run.id;
  await page.send('Runtime.enable');
  // --set impasto=1.8,furrow=0.4: try display settings without touching the run
  const set = Object.fromEntries(String(opt.set || '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, +v]; }));
  const r2 = Object.assign({}, run, { displayWidth: +opt.width || run.displayWidth || 1536, engine: Object.assign({}, run.engine || {}, set) });
  await load(page, r2);
  const st = {};
  for (const k of ['W', 'F', 'G0', 'G1', 'D0', 'D1', 'FN'].filter((k) => fs.existsSync(path.join(dir, k + '.f32')))) {
    const b = fs.readFileSync(path.join(dir, k + '.f32')).toString('base64'), id = 'up-' + k;
    for (let i = 0; i < b.length; i += 1 << 20) await page.eval(`inkBot._put(${JSON.stringify(id)}, ${JSON.stringify(b.slice(i, i + (1 << 20)))})`);
    st[k] = { __big: id };
  }
  await page.call((o) => inkBot.loadState(o), st);
  const out = opt.out || path.join(runDir(run.id), `view-${id}.png`);
  savePng(await page.call(() => inkBot.render()), out);
  page.close();
  console.log(`rendered ${id} → ${rel(out)}`);
};

C.show = ({ pos }) => {
  const run = loadRun(pos[0]);
  const id = resolveCp(run, pos[1]);
  console.log(describe(run, id));
  console.log('  actions: ' + JSON.stringify(run.checkpoints[id].actions).slice(0, 4000));
};

C.status = async ({ pos }) => {
  const run = loadRun(pos[0]);
  const page = await attach(run);
  const s = await page.call(() => inkBot.status());
  page.close();
  console.log(`${run.id}: ${run.medium}/${run.paper}  head ${run.head}  sim clock ${s.clock}s  ${s.awake ? `wet ${(s.wet * 100).toFixed(1)}%` : 'dry'}`);
  console.log(`brush ${JSON.stringify(s.cur)}\nboard ${JSON.stringify(s.board)}\nresident snapshots ${s.resident.join(' ')}`);
  console.log(describe(run, run.head));
};

C.finish = async ({ pos, opt }) => {
  const run = loadRun(pos[0]);
  if (opt.from) await moveHead(run, resolveCp(run, opt.from), 'checkout');
  const page = await attach(run);
  const st = await page.call(() => inkBot.status());
  if (st.awake) {
    await page.call((a) => inkBot.run(a), [{ type: 'dry', dryer: false, max: 600 }]);
    await checkpoint(run, page, [{ type: 'dry', dryer: false, max: 600 }], Object.assign({}, opt, { note: 'left to dry' }));
  }
  const dir = runDir(run.id);
  const f = savePng(await page.call(() => inkBot.render()), path.join(dir, 'final.png'));
  page.close();
  if (run.target) py(scoreArgs(run, f, ['--eval', path.join(dir, 'final-eval.png'), '--title', `${run.id} final (${run.head})`]));
  const n = pathTo(run, run.head).reduce((a, id) => a + run.checkpoints[id].actions.length, 0);
  const total = Object.keys(run.checkpoints).length - 1;
  const kept = pathTo(run, run.head).length - 1;
  run.final = { cp: run.head, file: 'final.png', actions: n, checkpoints: total, kept, rolledBack: total - kept, at: now() };
  saveRun(run);
  logEvent(run, { ev: 'finish', cp: run.head });
  console.log(`final: ${rel(f)}${run.target ? `  eval ${rel(path.join(dir, 'final-eval.png'))}` : ''}`);
  console.log(`${n} actions on the kept path; ${total} checkpoints made, ${total - kept} abandoned on other branches`);
  console.log(describe(run, run.head));
};

C.verify = async ({ pos }) => {
  const run = loadRun(pos[0]);
  const page = await attach(run);
  const a = await page.call(() => inkBot.render());
  await load(page, run);
  const chain = pathTo(run, run.head);
  for (const id of chain.slice(1)) {
    const r = await page.call((x) => inkBot.run(x), run.checkpoints[id].actions);
    if (r.error) die(`replay of ${id} failed: ${r.error}`);
    await page.call((i) => inkBot.snapshot(i), id);
  }
  const b = await page.call(() => inkBot.render());
  page.close();
  console.log(a === b ? `replay of ${chain.length - 1} checkpoints from blank reproduces ${run.head} exactly` : `replay differs from the live state at ${run.head} (rollbacks to evicted checkpoints will be approximate)`);
};

// ------------------------------------------------------------ main
const [cmd, ...rest] = process.argv.slice(2);
const fn = C[cmd || 'help'];
if (!fn) die(`unknown command "${cmd}" (see: ink.mjs help)`);
Promise.resolve(fn(parseArgs(rest))).catch((e) => die(e.stack || e.message || String(e)));
