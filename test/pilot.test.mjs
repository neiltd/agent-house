import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pilotTargets, readPilotLocal, cleanMessage, answerText, ANSWER_RE } from '../lib/pilot.mjs';
import { isControlFile, checkHookPayload, encodeDir } from '../lib/answer.mjs';

const H = '/Users/alex';
const dirs = new Set([`${H}/code/gym-app`, `${H}/Documents/history-site`, `${H}/code/payments`, `${H}/Desktop/private.stuff`, `${H}/house-test`, '/tmp/x']);
const ctx = (extra = {}) => ({ home: H, realpath: (d) => { const r = path.resolve(d); if (!dirs.has(r) && ![H, `${H}/.claude`, `${H}/.agent-house`, `${H}/secret-runtime`].includes(r)) throw new Error('missing'); return r; }, isDir: (d) => dirs.has(d), local: LOCAL, ...extra });
const LOCAL = readPilotLocal(JSON.stringify({
  targets: [{ id: 'gym', name: 'Gym app', folder: 'code/gym-app' }, { id: 'history', name: 'History site', folder: 'Documents/history-site' }, { id: 'pay', folder: 'code/payments' }],
  refused: ['code/payments', 'secret-runtime'], refusePatterns: ['private\\.stuff', '('],
}));

test('pilot targets: no local file means no targets', () => {
  assert.deepEqual(pilotTargets(ctx({ local: undefined })).map((t) => t.id), []);
  assert.deepEqual(readPilotLocal('not json'), { targets: [], refused: [], refusePatterns: [] });
  assert.equal(LOCAL.refusePatterns.length, 1, 'a broken pattern is dropped, not thrown');
});

test('pilot targets: only the local file\'s projects; config can rename or disable but not add', () => {
  assert.deepEqual(pilotTargets(ctx()).map((t) => t.id), ['gym', 'history'], 'a refused folder is never a target, even when listed');
  const cfg = { pilot: { targets: [{ id: 'gym', name: 'Lifting' }, { id: 'history', enabled: false }, { id: 'extra', folder: 'house-test' }] } };
  assert.deepEqual(pilotTargets(ctx({ config: cfg })).map((x) => [x.id, x.name]), [['gym', 'Lifting']]);
});

test('pilot targets: refused folders, patterns and folders outside home are refused even as a test target', () => {
  assert.equal(pilotTargets(ctx({ env: { AGENT_HOUSE_PILOT_TEST: `pay=${H}/code/payments` } })).some((t) => t.id === 'pay'), false);
  assert.equal(pilotTargets(ctx({ env: { AGENT_HOUSE_PILOT_TEST: `priv=${H}/Desktop/private.stuff` } })).some((t) => t.id === 'priv'), false);
  assert.equal(pilotTargets(ctx({ env: { AGENT_HOUSE_PILOT_TEST: 'tmp=/tmp/x' } })).some((t) => t.id === 'tmp'), false);
  assert.equal(pilotTargets(ctx({ env: { AGENT_HOUSE_PILOT_TEST: `housetest=${H}/house-test` } })).some((t) => t.id === 'housetest'), true);
  assert.equal(pilotTargets(ctx({ extraRefused: [`${H}/code/gym-app`] })).some((t) => t.id === 'gym'), false, 'answering.exclude folders are refused too');
});

test('messages from the page can never be commands or flags', () => {
  assert.equal(cleanMessage('  hello  ').text, 'hello');
  assert.equal(cleanMessage('/stop').ok, false);
  assert.equal(cleanMessage('​/stop').ok, false, 'zero-width characters are stripped first');
  assert.equal(cleanMessage('!rm -rf').ok, false);
  assert.equal(cleanMessage('--dangerously-skip-permissions').ok, false);
  assert.equal(cleanMessage('   ').ok, false);
  assert.equal(cleanMessage('x'.repeat(8001)).ok, false);
});

test('inbox answers are only a number and a letter', () => {
  assert.equal(answerText(27, 'B'), '27: B');
  assert.equal(answerText('27', 'b'), null);
  assert.equal(answerText('27; rm', 'A'), null);
  assert.equal(answerText('12345', 'A'), null);
  assert.ok(ANSWER_RE.test('3: Z'));
});

test('control files are never writable from the page', () => {
  for (const p of [`${H}/app/.claude/settings.json`, `${H}/app/.mcp.json`, `${H}/app/CLAUDE.md`, `${H}/app/docs/CLAUDE.md`, `${H}/app/AGENTS.md`, `${H}/app/.git/hooks/pre-commit`, `${H}/app/config/settings.local.json`]) assert.equal(isControlFile(p), true, p);
  assert.equal(isControlFile(`${H}/app/src/index.ts`), false);
  const APP = `${H}/code/gym-app`, sid = 'aaaaaaaa-1111-2222-3333-444444444444', ROOT = `${H}/.claude/projects`;
  const r = checkHookPayload({ hook_event_name: 'PermissionRequest', session_id: sid, transcript_path: `${ROOT}/${encodeDir(APP)}/${sid}.jsonl`, tool_name: 'Edit', tool_input: { file_path: `${APP}/.claude/settings.local.json` } },
    { home: H, projectsRoot: ROOT, exclude: [], sessionCwd: () => APP });
  assert.equal(r.ok, false);
});
