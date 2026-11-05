import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFor as pf, placeFor, activityFor, weigh } from '../lib/classify.mjs';
import { createStore } from '../lib/store.mjs';

const H = '/Users/alex';
const RULES = [
  { prefix: 'Desktop/secret-project', id: 'ops', name: 'Acme Ops' },
  { prefix: 'Desktop/client.work', id: 'aicap', name: 'Acme' },
  { prefix: 'Desktop/client-work', id: 'aicap', name: 'Acme' },
  { prefix: 'acme-runtime', id: 'aicap', name: 'Acme' },
];
const SCHOOL = [{ prefix: 'Desktop/MSBA Courses', name: 'MSBA' }];
const projectFor = (cwd, home) => pf(cwd, home, RULES, SCHOOL);

test('folders map to the rooms in the config', () => {
  assert.equal(projectFor(`${H}/Desktop/secret-project/state`, H).id, 'ops');
  assert.equal(projectFor(`${H}/Desktop/client-work`, H).id, 'aicap');
  assert.equal(projectFor(`${H}/Desktop/client.work/apps/unified-platform`, H).id, 'aicap');
  assert.equal(projectFor(`${H}/Desktop/Gym_app/ios`, H).name, 'Gym app');
  assert.equal(projectFor(`${H}/acme-runtime/apps/x`, H).id, 'aicap');
  assert.equal(projectFor(H, H).id, 'home');
  assert.equal(projectFor(`${H}/.claude/skills`, H).id, 'home');
});

test('MSBA assignment folders group into their course classroom', () => {
  const a = projectFor(`${H}/Desktop/MSBA Courses/437 Forecasting and Time Series Analysis/Assignment 1`, H);
  const b = projectFor(`${H}/Desktop/MSBA Courses/437 Forecasting and Time Series Analysis`, H);
  assert.equal(a.id, 'msba-437'); assert.equal(b.id, 'msba-437'); assert.equal(a.group, 'school');
});

test('other projects take the first folder under a container', () => {
  assert.equal(projectFor(`${H}/Desktop/Gym app/ios/App`, H).name, 'Gym app');
  assert.equal(projectFor(`${H}/Documents/ChatGPT/History Notes`, H).name, 'History Notes');
  assert.equal(projectFor(`${H}/apps/agent-house/lib`, H).name, 'agent-house');
});

test('online tools send agents to the right neighbour', () => {
  assert.equal(placeFor('WebSearch'), 'library');
  assert.equal(placeFor('mcp__claude_ai_Gmail__send_message'), 'post');
  assert.equal(placeFor('mcp__claude-in-chrome__navigate'), 'cafe');
  assert.equal(placeFor('mcp__claude_ai_Notion__notion-fetch'), 'archive');
  assert.equal(placeFor('Bash', { command: 'git push origin main' }), 'github');
  assert.equal(placeFor('Bash', { command: 'npm test' }), null);
  assert.equal(activityFor('Edit'), 'typing');
  assert.equal(activityFor('AskUserQuestion'), 'waiting');
});

test('usage weighting counts cache reads at a tenth', () => {
  assert.deepEqual(weigh({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100 }), { raw: 112, w: 30 });
});

test('a pending question becomes an ask with options, and an answer clears it', () => {
  let t = Date.parse('2026-11-02T10:00:00Z');
  const s = createStore({ home: H, rules: RULES, now: () => t });
  const cwd = `${H}/Desktop/client-work`;
  s.ingest('s1', { type: 'user', cwd, timestamp: '2026-11-02T09:59:00Z', message: { content: 'where should we host?' } });
  s.ingest('s1', { type: 'assistant', cwd, timestamp: '2026-11-02T09:59:30Z', requestId: 'r1', message: { id: 'm1', usage: { input_tokens: 5, output_tokens: 1 }, content: [
    { type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which platform?', options: [{ label: 'Cloudflare' }, { label: 'VPS' }] }] } }] } });
  let snap = s.snapshot();
  assert.equal(snap.asks.length, 1);
  assert.equal(snap.asks[0].kind, 'question');
  assert.deepEqual(snap.asks[0].options, ['Cloudflare', 'VPS']);
  assert.equal(snap.projects.find((p) => p.id === 'aicap').today.raw, 6);
  // duplicate streamed record must not double-count usage
  s.ingest('s1', { type: 'assistant', cwd, timestamp: '2026-11-02T09:59:30Z', requestId: 'r1', message: { id: 'm1', usage: { input_tokens: 5, output_tokens: 1 }, content: [] } });
  assert.equal(s.snapshot().projects.find((p) => p.id === 'aicap').today.raw, 6);
  s.ingest('s1', { type: 'user', cwd, timestamp: '2026-11-02T10:00:10Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Cloudflare' }] } });
  snap = s.snapshot();
  assert.equal(snap.asks.filter((a) => a.kind === 'question').length, 0);
});

test('an agent reply that ends in a question shows as "asked you" with the thread', () => {
  const t = Date.parse('2026-11-02T10:00:00Z');
  const s = createStore({ home: H, rules: RULES, now: () => t });
  const cwd = `${H}/Desktop/client-work`;
  s.ingest('s2', { type: 'user', cwd, timestamp: '2026-11-02T09:50:00Z', message: { content: 'how different are the fees?' } });
  s.ingest('s2', { type: 'assistant', cwd, timestamp: '2026-11-02T09:51:00Z', message: { id: 'm2', content: [{ type: 'text', text: 'Cloudflare Tunnel is free; a VPS is about $5/month. Which one do you want?' }] } });
  const ask = s.snapshot().asks.find((a) => a.key === 's2');
  assert.equal(ask.kind, 'reply');
  assert.match(ask.thread.you, /fees/);
  assert.match(ask.thread.agent, /Which one/);
});

test('inbox pages: open asks parsed from both layouts, done and hidden ones skipped', async () => {
  const { parseInbox } = await import('../lib/inbox.mjs');
  const html = `<title>Team&#39;s Inbox</title>
  <article class="ask" id="ask27"><div class="ask-head"><h2>27. Gym notes &amp; fixes</h2><span class="chip c-now">Now</span></div>
    <dl><dt>What</dt><dd><p>Back throws the workout away.</p></dd><dt>Your answer</dt><dd><p>"27: yes"</p></dd></dl></article>
  <article class="ask" id="ask25"><h2>25. Notes</h2><span class="chip c-later">Done: editable</span></article>
  <article class="ask" id="ask15" hidden><h2>15. Old</h2><span class="chip c-now">Now</span></article>
  <article class="ask" id="ask13"><h2>13. Ticket</h2><span class="chip c-later">Waiting on Supabase</span></article>
  <article class="ask"><div class="ask-head"><h3><span class="num">14</span>A Mac mini</h3><span class="chip c-later">plan, no rush</span></div></article>`;
  const r = parseInbox(html);
  assert.equal(r.title, "Team's Inbox");
  const open = r.asks.filter((a) => a.open);
  assert.deepEqual(open.map((a) => a.num), ['27', '14']);
  assert.equal(open[0].title, 'Gym notes & fixes');
  assert.equal(open[0].urgency, 'now');
  assert.equal(open[0].what, 'Back throws the workout away.');
  assert.equal(open[0].answer, '"27: yes"');
  assert.equal(open[1].title, 'A Mac mini');
});

test('a published page remembers its local source file and url', () => {
  const s = createStore({ home: H, rules: RULES, now: () => Date.parse('2026-11-04T10:00:00Z') });
  const cwd = `${H}/Desktop/secret-project`;
  s.ingest('s3', { type: 'assistant', cwd, timestamp: '2026-11-04T09:00:00Z', message: { id: 'm3', content: [
    { type: 'tool_use', id: 'tu3', name: 'Artifact', input: { file_path: 'team/inbox.html' } },
    { type: 'tool_use', id: 'tu4', name: 'Artifact', input: { action: 'read', url: 'https://claude.ai/artifact/zzz' } }] } });
  s.ingest('s3', { type: 'user', cwd, timestamp: '2026-11-04T09:00:05Z', message: { content: [
    { type: 'tool_result', tool_use_id: 'tu3', content: 'Published https://claude.ai/artifact/abc123' },
    { type: 'tool_result', tool_use_id: 'tu4', content: 'read https://claude.ai/artifact/zzz' }] } });
  const pub = s.published();
  assert.equal(pub.length, 1);
  assert.equal(pub[0].url, 'https://claude.ai/artifact/abc123');
  assert.equal(pub[0].file, `${H}/Desktop/secret-project/team/inbox.html`);
});

test('with no config, projects still get rooms from their folder names', () => {
  assert.equal(pf(`${H}/Desktop/secret-project/state`, H).name, 'secret-project');
  assert.equal(pf(`${H}/Desktop/MSBA Courses/437 Forecasting/A1`, H).name, 'MSBA Courses');
  assert.equal(pf(`${H}/Documents/Uni/101 Intro`, H, [], [{ prefix: 'Documents/Uni', name: 'Uni' }]).id, 'uni-101');
});

test('a failed tool call is remembered so the house can show trouble in that room', () => {
  const s = createStore({ home: H, rules: RULES, now: () => Date.parse('2026-11-04T10:00:05Z') });
  const cwd = `${H}/Desktop/app`;
  s.ingest('k', { type: 'assistant', cwd, timestamp: '2026-11-04T10:00:00Z', message: { id: 'm9', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'npm test' } }] } });
  s.ingest('k', { type: 'user', cwd, timestamp: '2026-11-04T10:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 't9', is_error: true, content: 'failed' }] } });
  assert.equal(s.snapshot().agents[0].errorAt, Date.parse('2026-11-04T10:00:02Z'));
});

test('usage per day for the last 30 days and per two hours for the last day', () => {
  const t = Date.parse('2026-11-05T15:00:00Z');
  const s = createStore({ home: H, rules: RULES, now: () => t });
  const cwd = `${H}/Desktop/app`;
  s.ingest('d1', { type: 'assistant', cwd, timestamp: '2026-11-05T14:00:00Z', requestId: 'r1', message: { id: 'a1', usage: { input_tokens: 10, output_tokens: 2 }, content: [] } });
  s.ingest('d1', { type: 'assistant', cwd, timestamp: '2026-11-01T14:00:00Z', requestId: 'r2', message: { id: 'a2', usage: { input_tokens: 4 }, content: [] } });
  const snap = s.snapshot();
  assert.equal(snap.daily.length, 30);
  assert.equal(snap.daily.at(-1).raw, 12, 'today is last');
  assert.equal(snap.daily.reduce((a, d) => a + d.raw, 0), 16);
  assert.equal(snap.hours.length, 12);
  assert.equal(snap.hours.reduce((a, h) => a + h.raw, 0), 12, 'only the last 24 hours');
});
