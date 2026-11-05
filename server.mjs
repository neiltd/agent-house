#!/usr/bin/env node
// Agent House server. Read-only: it only reads ~/.claude/projects and never writes there.
// No third-party packages. Run: node server.mjs   then open http://127.0.0.1:4317
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import readline from 'node:readline';
import { createStore } from './lib/store.mjs';
import { projectFor, DEFAULT_RULES } from './lib/classify.mjs';
import { parseInbox } from './lib/inbox.mjs';
import { createDesk, checkHookPayload, mask } from './lib/answer.mjs';
import crypto from 'node:crypto';

const HOME = os.homedir();
const ROOT = process.env.CLAUDE_PROJECTS || path.join(HOME, '.claude', 'projects');
const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = process.env.AGENT_HOUSE_CONFIG || path.join(HERE, 'agent-house.config.json');
const WEEK_MS = 8 * 86400e3;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
let config = loadConfig();
const rules = [...(config.rules || []), ...DEFAULT_RULES];
const school = config.school || [];
const store = createStore({ home: HOME, rules, school });

// ---------- files ----------
const files = new Map(); // abs path -> { key, offset, partial, meta }

function keyFor(file) {
  const base = path.basename(file, '.jsonl');
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('subagents');
  if (i > 0) return { key: base, meta: { kind: 'sub', parentKey: parts[i - 1] } };
  return { key: base, meta: { kind: 'main' } };
}

async function walk(dir, out = []) {
  let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'memory' && e.name !== 'tool-results') await walk(p, out); }
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function readMeta(file) {
  const metaFile = file.replace(/\.jsonl$/, '.meta.json');
  try {
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return { agentType: m.agentType, desc: m.description || '', finished: !!m.finished };
  } catch { return {}; }
}

/** Read new bytes of a file and ingest complete lines. */
async function readNew(file, { live }) {
  let st; try { st = await fsp.stat(file); } catch { return; }
  let f = files.get(file);
  if (!f) {
    const { key, meta } = keyFor(file);
    f = { key, offset: 0, partial: '' };
    files.set(file, f);
    store.setMeta(key, meta);
  }
  if (f.key && file.includes(`${path.sep}subagents${path.sep}`)) store.setMeta(f.key, readMeta(file));
  if (st.size < f.offset) { f.offset = 0; f.partial = ''; }
  if (st.size === f.offset) return;
  const stream = fs.createReadStream(file, { start: f.offset, end: st.size - 1, encoding: 'utf8' });
  let buf = f.partial;
  for await (const chunk of stream) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line || line.length > 4_000_000) continue;
      if (!live && !line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !line.includes('"ai-title"') && !line.includes('"turn_duration"')) continue;
      try { store.ingest(f.key, JSON.parse(line), { live }); } catch { /* skip malformed line */ }
    }
  }
  f.partial = buf;
  f.offset = st.size;
}

/** For old files we don't parse, read just enough to learn which project they belong to. */
async function peekProject(file, mtime) {
  try {
    const fh = await fsp.open(file, 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(65536), 0, 65536, 0);
    await fh.close();
    const m = buffer.subarray(0, bytesRead).toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (m) store.touchProject(projectFor(JSON.parse(`"${m[1]}"`), HOME, rules, school), mtime);
  } catch { /* ignore */ }
}

let ready = false;
async function initialScan() {
  const t0 = Date.now();
  const all = await walk(ROOT);
  const recent = [];
  for (const file of all) {
    let st; try { st = await fsp.stat(file); } catch { continue; }
    if (Date.now() - st.mtimeMs < WEEK_MS) recent.push({ file, m: st.mtimeMs });
    else await peekProject(file, st.mtimeMs);
  }
  recent.sort((a, b) => a.m - b.m);
  let done = 0;
  for (const { file } of recent) { await readNew(file, { live: false }); done++; progress = { done, total: recent.length }; }
  ready = true;
  console.log(`Agent House: read ${recent.length} recent transcripts (${all.length} total) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
let progress = { done: 0, total: 0 };

const dirty = new Set();
function watch() {
  try {
    fs.watch(ROOT, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const abs = path.join(ROOT, name.toString());
      if (abs.endsWith('.jsonl')) dirty.add(abs);
      else if (abs.endsWith('.meta.json')) dirty.add(abs.replace(/\.meta\.json$/, '.jsonl'));
    });
  } catch (e) { console.warn('fs.watch unavailable, falling back to polling only:', e.message); }
  // Safety net: every 20s look for recently changed files the watcher may have missed.
  setInterval(async () => {
    for (const file of await walk(ROOT)) {
      try { const st = await fsp.stat(file); if (Date.now() - st.mtimeMs < 60e3) dirty.add(file); } catch {}
    }
  }, 20e3);
  let busy = false;
  setInterval(async () => {
    if (busy || !ready || !dirty.size) return;
    busy = true;
    try {
      const batch = [...dirty]; dirty.clear();
      for (const f of batch) await readNew(f, { live: true });
    } finally { busy = false; }
  }, 500);
}

// ---------- inboxes ----------
// Inbox pages (Artifacts whose <title> says "Inbox") are published from local HTML files.
// We read those files straight from disk: read-only, nothing is fetched from claude.ai.
const inboxCache = new Map(); // file -> { mtimeMs, parsed }
function inboxes() {
  const byFile = new Map();
  for (const p of store.published()) {
    if (!/\.html?$/i.test(p.file)) continue;
    const prev = byFile.get(p.file);
    if (!prev || p.ts > prev.ts) byFile.set(p.file, p);
  }
  const out = [];
  for (const p of byFile.values()) {
    let st; try { st = fs.statSync(p.file); } catch { continue; }
    if (!st.isFile() || st.size > 3_000_000) continue;
    let c = inboxCache.get(p.file);
    if (!c || c.mtimeMs !== st.mtimeMs) {
      try { c = { mtimeMs: st.mtimeMs, parsed: parseInbox(fs.readFileSync(p.file, 'utf8')) }; } catch { continue; }
      inboxCache.set(p.file, c);
    }
    const { title, asks } = c.parsed;
    if (!/inbox/i.test(title || p.title)) continue;
    const open = asks.filter((a) => a.open);
    // A page kept inside a project folder belongs to that project, even if a Home session published it.
    const inHome = p.file.startsWith(HOME + path.sep) && !p.file.startsWith(path.join(HOME, '.claude') + path.sep);
    const project = inHome ? projectFor(path.dirname(p.file), HOME, rules, school) : null;
    out.push({ url: p.url, title: title || p.title, project: project && project.id !== 'home' ? project.id : p.project, by: p.by, updated: Math.round(st.mtimeMs), asks: open });
  }
  return out.sort((a, b) => b.asks.length - a.asks.length);
}

// ---------- answering from the page (threat model: docs/SECURITY.md) ----------
// Two secrets:
//  - the HOOK token lives in ~/.agent-house/hook-token so the hook script can prove it's the hook. Agents can read
//    that file too, so it can only create asks, never answer them.
//  - the PAGE credential is an HttpOnly cookie, handed out once per pairing link. The link is printed only to the
//    terminal the server was started in. It never touches disk or the HTML.
const STATE_DIR = process.env.AGENT_HOUSE_DIR || path.join(HOME, '.agent-house');
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(STATE_DIR, 0o700); } catch {}
const HOOK_TOKEN_FILE = path.join(STATE_DIR, 'hook-token');
let hookToken = '';
try { hookToken = fs.readFileSync(HOOK_TOKEN_FILE, 'utf8').trim(); } catch {}
if (!/^[a-f0-9]{64}$/.test(hookToken)) { hookToken = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(HOOK_TOKEN_FILE, hookToken + '\n', { mode: 0o600 }); }
try { fs.chmodSync(HOOK_TOKEN_FILE, 0o600); } catch {}
const ANSWER_LOG = path.join(STATE_DIR, 'answers.log');

// Pairing only works when a person started the server in a terminal (so the link isn't captured in an agent's transcript).
// AGENT_HOUSE_PAIR_FILE is for the scratch test only: it writes the link to a 0600 file instead.
const PAIR_FILE = process.env.AGENT_HOUSE_PAIR_FILE || '';
const canPair = !!process.stdout.isTTY || !!PAIR_FILE;
const pairedSecrets = new Set();
let pairCode = '';
function newPairCode() {
  pairCode = crypto.randomBytes(16).toString('hex');
  const link = `http://${HOST}:${PORT}/pair?code=${pairCode}`;
  if (PAIR_FILE) fs.writeFileSync(PAIR_FILE, link + '\n', { mode: 0o600 });
  else console.log(`\nTo answer asks from the page, open this link once in your browser (works one time):\n  ${link}\n`);
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); }
  return '';
}
const isPaired = (req) => { const c = cookieOf(req, 'house_pair'); return !!c && [...pairedSecrets].some((s) => safeEq(s, c)); };
const answerCfg = () => (config.answering && typeof config.answering === 'object' ? config.answering : { enabled: config.answering !== false });
const answeringOn = () => canPair && answerCfg().enabled !== false;
const excludeDirs = () => (answerCfg().exclude || []).map((d) => path.resolve(HOME, d));

function logAnswer({ ask, decision }) {
  try {
    try { if (fs.statSync(ANSWER_LOG).size > 1_000_000) fs.renameSync(ANSWER_LOG, ANSWER_LOG + '.1'); } catch {}
    // Tool name and path only. Never content or commands .
    const line = `${new Date().toISOString()} ${decision} ${ask.tool} ${mask(ask.tool === 'AskUserQuestion' ? '' : ask.target)} session=${ask.sessionId.slice(0, 8)}\n`;
    fs.appendFileSync(ANSWER_LOG, line, { mode: 0o600 });
  } catch { /* logging must never break answering */ }
}
const waitMs = () => Math.min(50, Math.max(5, Number(answerCfg().waitSeconds) || 45)) * 1000;
let desk = createDesk({ waitMs: waitMs(), onLog: logAnswer });

// ---------- http ----------
const clients = new Map(); // res -> { paired }
let lastJson = '';
function stateJson() {
  config = loadConfig();
  const snap = store.snapshot(config);
  snap.ready = ready; snap.progress = progress; snap.pinned = config.pinned || [];
  snap.colors = config.colors || {}; snap.robots = config.robots || [];
  snap.characters = config.characters || {};
  snap.inboxes = inboxes();
  snap.answering = answeringOn();
  snap.live = desk.list().map((a) => {
    const s = store.sessions.get(a.sessionId);
    return { ...a, project: s?.project?.id || 'home', label: s ? (s.kind === 'sub' ? s.agentType || 'Subagent' : 'Main session') : 'Session', title: s?.title || '' };
  });
  return JSON.stringify(snap);
}
function broadcast(force = false) {
  if (!clients.size) return;
  const j = stateJson();
  if (j === lastJson && !force) return;
  lastJson = j;
  for (const res of clients.keys()) res.write(`data: ${j}\n\n`);
}
setInterval(broadcast, 1000);
const pairedPageOpen = () => [...clients.values()].some((c) => c.paired);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));

/** From the hook script. Holds the request open until you answer on the page, the wait runs out, or the hook goes away. */
async function hookAsk(req, res) {
  if (req.method !== 'POST' || !safeEq(req.headers['x-house-hook'] || '', hookToken)) return json(res, 403, { error: 'forbidden' });
  let body; try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return json(res, 400, { error: 'bad body' }); }
  const hookNonce = typeof body?.hookNonce === 'string' && /^[a-f0-9]{32}$/.test(body.hookNonce) ? body.hookNonce : null;
  if (!hookNonce) return json(res, 400, { error: 'bad nonce' });
  const pass = (reason) => json(res, 200, { hookNonce, decision: null, reason });
  if (!answeringOn()) return pass('answering is off');
  if (!pairedPageOpen()) return pass('no paired page open');
  const payload = body.payload || {};
  // Make sure we've read the newest lines of this session's transcript before checking it.
  const tp = typeof payload.transcript_path === 'string' ? path.resolve(payload.transcript_path) : '';
  if (tp.startsWith(path.resolve(ROOT) + path.sep) && tp.endsWith('.jsonl')) await readNew(tp, { live: true });
  const check = checkHookPayload(payload, { home: HOME, projectsRoot: ROOT, exclude: excludeDirs(), sessionCwd: (id) => store.firstCwd(id) });
  if (!check.ok) return pass(check.reason);
  let done = false;
  const id = desk.add(check.ask, (result) => { done = true; if (!res.writableEnded) json(res, 200, { hookNonce, ...result }); setImmediate(() => broadcast(true)); });
  if (!id) return pass('too many open asks');
  res.on('close', () => { if (!done) desk.cancel(id); });
  broadcast(true);
}

/** From the paired page only. */
async function pageAnswer(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!answeringOn()) return json(res, 403, { error: 'answering is off' });
  if (!isPaired(req)) return json(res, 403, { error: 'this browser is not paired' });
  if (req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'bad origin' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' });
  let body; try { body = JSON.parse(await readBody(req, 16 * 1024)); } catch { return json(res, 400, { error: 'bad body' }); }
  if (typeof body?.id !== 'string') return json(res, 400, { error: 'missing id' });
  const r = desk.answer(body.id, body);
  json(res, r.ok ? 200 : 409, r);
}

const SECURITY_HEADERS = { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin' };
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const server = http.createServer((req, res) => {
  // Only answer requests addressed to this machine (blocks DNS-rebinding from web pages).
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) { res.writeHead(403).end('forbidden'); return; }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/state') {
    json(res, 200, JSON.parse(stateJson()));
  } else if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${stateJson()}\n\n`);
    clients.set(res, { paired: isPaired(req) });
    req.on('close', () => clients.delete(res));
  } else if (url.pathname === '/api/me') {
    json(res, 200, { paired: isPaired(req), answering: answeringOn(), canPair });
  } else if (url.pathname === '/api/answer') {
    pageAnswer(req, res).catch(() => json(res, 500, { error: 'server error' }));
  } else if (url.pathname === '/hook/ask') {
    hookAsk(req, res).catch(() => { if (!res.writableEnded) json(res, 500, { error: 'server error' }); });
  } else if (url.pathname === '/pair') {
    if (!canPair || !pairCode || !safeEq(url.searchParams.get('code') || '', pairCode)) { res.writeHead(403, { 'content-type': 'text/plain' }).end('This pairing link is used or wrong. Use the newest link in the server terminal.'); return; }
    const secret = crypto.randomBytes(32).toString('hex');
    pairedSecrets.add(secret);
    newPairCode(); // one link, one browser
    res.writeHead(303, { 'set-cookie': `house_pair=${secret}; HttpOnly; SameSite=Strict; Path=/`, location: '/' }).end();
  } else if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(path.join(HERE, 'public', 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(500).end('missing public/index.html'); return; }
      const nonce = crypto.randomBytes(16).toString('base64');
      const csp = `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': csp })
        .end(html.replace('<script>', `<script nonce="${nonce}">`));
    });
  } else res.writeHead(404).end('not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Agent House is already running at http://${HOST}:${PORT} — just open that link.`);
    console.log(`To restart it, stop the other copy first:  lsof -ti tcp:${PORT} | xargs kill`);
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, HOST, () => {
  console.log(`Agent House: http://${HOST}:${PORT}  (reading ${ROOT})`);
  if (canPair) newPairCode();
  else console.log('Answering from the page is off: start the server yourself in a terminal to turn it on.');
  initialScan().then(watch);
});
