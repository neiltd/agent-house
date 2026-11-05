import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHookPayload, checkAnswers, createDesk, encodeDir, mask } from '../lib/answer.mjs';

const H = '/Users/alex';
const ROOT = `${H}/.claude/projects`;
const APP = `${H}/Desktop/Workout_app`;
const sid = '3df92d90-77f6-4350-990e-b3307aa8d646';
const EXCLUDE = [`${H}/Desktop/secret-project`, `${H}/acme-runtime`];
const ctx = (cwd = APP) => ({ home: H, projectsRoot: ROOT, exclude: EXCLUDE, sessionCwd: () => cwd });
const payload = (over = {}, cwd = APP) => ({
  hook_event_name: 'PermissionRequest', session_id: sid, transcript_path: `${ROOT}/${encodeDir(cwd)}/${sid}.jsonl`, cwd,
  tool_name: 'Edit', tool_input: { file_path: `${APP}/ios/App.swift` }, ...over,
});

test('allow-list: Edit in the project is answerable, Bash and WebFetch never are', () => {
  assert.equal(checkHookPayload(payload(), ctx()).ok, true);
  assert.equal(checkHookPayload(payload({ tool_name: 'Bash', tool_input: { command: 'ls' } }), ctx()).reason, 'tool not on the allow-list');
  assert.equal(checkHookPayload(payload({ tool_name: 'WebFetch', tool_input: { url: 'https://x' } }), ctx()).ok, false);
  assert.equal(checkHookPayload(payload({ tool_name: 'mcp__claude_ai_Gmail__send_message' }), ctx()).ok, false);
  assert.equal(checkHookPayload(payload({ hook_event_name: 'PreToolUse' }), ctx()).ok, false, 'PreToolUse is only for questions');
});

test('the transcript must match the session and live under ~/.claude/projects', () => {
  assert.equal(checkHookPayload(payload({ transcript_path: `/tmp/${sid}.jsonl` }), ctx()).ok, false);
  assert.equal(checkHookPayload(payload({ transcript_path: `${ROOT}/${encodeDir(APP)}/other-session-id-1234.jsonl` }), ctx()).ok, false);
  assert.equal(checkHookPayload(payload({ transcript_path: `${ROOT}/${encodeDir(APP)}/../../x/${sid}.jsonl` }), ctx()).ok, false);
  assert.equal(checkHookPayload(payload(), ctx(null)).reason, 'session not known yet');
  assert.equal(checkHookPayload(payload(), ctx(`${H}/Desktop/other`)).ok, false, 'store launch dir must match the folder');
});

test('configured and ~/.claude sessions are excluded by launch folder, even after cd', () => {
  const relay = `${H}/Desktop/secret-project`;
  const p = payload({ cwd: APP, tool_input: { file_path: `${relay}/x.md` } }, relay);
  assert.equal(checkHookPayload(p, ctx(relay)).reason, 'excluded project');
  const sub = `${H}/Desktop/secret-project/team`;
  assert.equal(checkHookPayload(payload({}, sub), ctx(sub)).reason, 'excluded project');
  assert.equal(checkHookPayload(payload({}, `${H}/.claude`), ctx(`${H}/.claude`)).reason, 'excluded project');
});

test('protected paths and writes outside the project go to the terminal', () => {
  const edit = (file_path, tool_name = 'Edit') => checkHookPayload(payload({ tool_name, tool_input: { file_path } }), ctx());
  assert.equal(edit(`${APP}/.env.local`).reason, 'protected path');
  assert.equal(edit(`${H}/Desktop/secret-project/state/x`).reason, 'protected path');
  assert.equal(edit(`${H}/.ssh/config`, 'Read').reason, 'protected path');
  assert.equal(edit(`${H}/.agent-house/hook-token`, 'Read').reason, 'protected path');
  assert.equal(edit(`${APP}/AuthKey_ABC.p8`, 'Read').reason, 'protected path');
  assert.equal(edit(`${H}/Desktop/other/x.txt`).reason, 'write outside the project');
  assert.equal(edit(`${H}/Desktop/other/x.txt`, 'Read').ok, true, 'reading elsewhere is a fair question for the user');
  const home = checkHookPayload(payload({ tool_input: { file_path: `${H}/notes.md` } }, H), ctx(H));
  assert.equal(home.reason, 'writes from a home-folder session go to the terminal');
});

test('question answers must be offered labels', () => {
  const qs = [{ question: 'Which platform?', multiSelect: false, options: ['Cloudflare', 'VPS'] }, { question: 'Extras?', multiSelect: true, options: ['CDN', 'Logs'] }];
  assert.deepEqual(checkAnswers(qs, { 'Which platform?': 'VPS', 'Extras?': ['CDN', 'Logs'] }), { 'Which platform?': 'VPS', 'Extras?': 'CDN, Logs' });
  assert.equal(checkAnswers(qs, { 'Which platform?': 'rm -rf /', 'Extras?': 'CDN' }), null);
  assert.equal(checkAnswers(qs, { 'Which platform?': ['VPS', 'Cloudflare'], 'Extras?': 'CDN' }), null, 'single select takes one');
  assert.equal(checkAnswers(qs, { 'Which platform?': 'VPS' }), null, 'every question needs an answer');
  const q = checkHookPayload(payload({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which platform?', options: [{ label: 'Cloudflare' }, { label: 'VPS' }] }] } }), ctx());
  assert.equal(q.ok, true); assert.equal(q.ask.kind, 'question');
});

test('desk: random id per ask, first answer wins, late answers refused, cap of 20', async () => {
  const got = [];
  const desk = createDesk({ waitMs: 10_000 });
  const ask = { kind: 'permission', tool: 'Edit', sessionId: sid, target: 'x' };
  const a = desk.add(ask, (r) => got.push(['a', r])), b = desk.add(ask, (r) => got.push(['b', r]));
  assert.notEqual(a, b, 'two identical asks get different ids');
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.equal(desk.answer(a, { decision: 'yes please' }).ok, false);
  assert.equal(desk.answer(a, { decision: 'allow' }).ok, true);
  assert.match(desk.answer(a, { decision: 'deny' }).error, /already closed/);
  assert.equal(desk.cancel(b), true);
  assert.match(desk.answer(b, { decision: 'allow' }).error, /answered in the terminal/);
  assert.deepEqual(got, [['a', { decision: 'allow' }], ['b', { decision: null }]]);
  const many = createDesk({ max: 20, waitMs: 10_000 });
  for (let i = 0; i < 20; i++) assert.ok(many.add(ask, () => {}));
  assert.equal(many.add(ask, () => {}), null);
  for (const x of many.list()) many.cancel(x.id);
});

test('desk: an unanswered ask times out with no decision', async () => {
  const desk = createDesk({ waitMs: 30 });
  const r = await new Promise((resolve) => desk.add({ kind: 'plan', tool: 'ExitPlanMode', sessionId: sid, target: '' }, resolve));
  assert.deepEqual(r, { decision: null });
});

test('mask hides token-looking strings', () => {
  assert.equal(mask('key sk-ant-api03-abcdefghijklmnop rest'), 'key ‹masked› rest');
  assert.equal(mask('/Users/alex/a.txt'), '/Users/alex/a.txt');
  assert.equal(mask('/Users/alex/Desktop/Workout_app/ios/OurClub/Features/Session/SessionView.swift'), '/Users/alex/Desktop/Workout_app/ios/OurClub/Features/Session/SessionView.swift');
});
