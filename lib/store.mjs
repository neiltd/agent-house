// The house's memory: sessions, usage totals, designs, and the live feed.
// Records go in through ingest(); snapshot() turns them into what the page draws.
import path from 'node:path';
import { projectFor, activityFor, placeFor, targetFor, LONG_RUNNING, weigh, dayKey } from './classify.mjs';

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/;
const PERMISSION_AFTER_MS = 20_000;

export function createStore({ home, rules, school = [], now = () => Date.now() }) {
  const sessions = new Map();     // key -> session
  const seenMsg = new Set();      // de-duplicates streamed assistant records
  const usage = new Map();        // projectId -> Map(day -> {raw, w})
  const agentUsage = new Map();   // `${projectId}|${label}` -> Map(day -> {raw, w})
  const projects = new Map();     // projectId -> {id, name, group, lastActive}
  const designs = new Map();      // projectId -> {title, url, ts, by}
  const published = new Map();    // artifact url -> {url, file, title, project, ts, by}: latest local source of each page
  const feed = [];                // newest first
  const hourly = new Map();       // two-hour bucket (ts / 2h) -> {raw, w}, for the Today chart

  function touchProject(p, ts) {
    const cur = projects.get(p.id);
    if (!cur) projects.set(p.id, { ...p, lastActive: ts || 0 });
    else if (ts > cur.lastActive) cur.lastActive = ts;
  }

  function session(key, meta = {}) {
    let s = sessions.get(key);
    if (!s) {
      s = { key, kind: meta.kind || 'main', parentKey: meta.parentKey || null, agentType: meta.agentType || null,
        desc: meta.desc || '', finished: false, title: '', cwd: null, project: null, lastTs: 0,
        pending: new Map(), lastEvent: null, lastUser: null, lastAssistant: null, recent: [], log: [], artifacts: new Map() };
      sessions.set(key, s);
    }
    Object.assign(s, Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)));
    return s;
  }

  /** The agent's notebook: what it said, thought and did, newest last. Capped so memory stays small. */
  function note(s, kind, text, ts, extra = {}) {
    const t = String(text || '').trim(); if (!t && kind !== 'tool') return;
    s.log.push({ ts, kind, text: t.length > 1200 ? t.slice(0, 1200) + '…' : t, ...extra });
    if (s.log.length > 60) s.log.splice(0, s.log.length - 60);
  }

  const label = (s) => (s.kind === 'sub' ? s.agentType || 'Subagent' : 'Main session');

  function addUsage(map, key, ts, u) {
    const day = dayKey(ts);
    let m = map.get(key); if (!m) map.set(key, (m = new Map()));
    const cur = m.get(day) || { raw: 0, w: 0 };
    const add = weigh(u);
    cur.raw += add.raw; cur.w += add.w; m.set(day, cur);
  }

  function pushFeed(s, tool, target, ts) {
    if (!s.project) return;
    feed.unshift({ ts, project: s.project.id, agent: label(s), key: s.key, tool, target });
    if (feed.length > 60) feed.length = 60;
  }

  function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return '';
  }

  /** Feed one transcript record. `live` is false while replaying history, so old events stay out of the feed. */
  function ingest(key, o, { live = false } = {}) {
    if (!o || typeof o !== 'object') return;
    const s = session(key);
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (ts && ts > s.lastTs) s.lastTs = ts;
    if (o.cwd && !s.firstCwd) s.firstCwd = o.cwd; // launch folder; later records follow `cd`
    if (o.cwd) { s.cwd = o.cwd; s.project = projectFor(o.cwd, home, rules, school); touchProject(s.project, ts); }
    if (o.type === 'ai-title' && o.aiTitle) s.title = o.aiTitle;
    if (o.type === 'system' && o.subtype === 'turn_duration') s.lastEvent = 'end';

    if (o.type === 'assistant' && o.message) {
      const m = o.message;
      const id = (m.id || '') + '|' + (o.requestId || '');
      if (m.usage && ts && !seenMsg.has(id)) {
        seenMsg.add(id);
        const p = o.cwd ? projectFor(o.cwd, home, rules, school) : s.project;
        if (p) { addUsage(usage, p.id, ts, m.usage); addUsage(agentUsage, p.id + '|' + label(s), ts, m.usage); }
        { const hk = Math.floor(ts / 7200e3), cur = hourly.get(hk) || { raw: 0, w: 0 }, add = weigh(m.usage); cur.raw += add.raw; cur.w += add.w; hourly.set(hk, cur); }
      }
      const blocks = Array.isArray(m.content) ? m.content : [];
      let sawTool = false;
      for (const b of blocks) {
        if (b.type === 'text') note(s, 'say', b.text, ts);
        if (b.type === 'thinking') note(s, 'think', b.thinking, ts);
        if (b.type === 'tool_use') {
          const inp = b.input || {};
          const preview = b.name === 'Write' ? inp.content : b.name === 'Edit' ? inp.new_string : b.name === 'Bash' ? inp.command : '';
          note(s, 'tool', targetFor(b.name, inp), ts, { tool: b.name, preview: preview ? String(preview).slice(0, 600) : '' });
          sawTool = true;
          s.pending.set(b.id, { name: b.name, input: b.input || {}, ts: ts || now() });
          const target = targetFor(b.name, b.input || {});
          s.recent.unshift({ ts, tool: b.name, target }); if (s.recent.length > 6) s.recent.length = 6;
          const act = b.input?.action || 'publish';
          if (b.name === 'Artifact' && act === 'publish' && !b.input?.asset && (b.input?.file_path || b.input?.title)) {
            const fp = b.input.file_path ? String(b.input.file_path) : null;
            const file = fp ? (path.isAbsolute(fp) ? fp : path.resolve(s.cwd || home, fp)) : null;
            s.artifacts.set(b.id, { title: b.input.title || (fp ? fp.split('/').pop().replace(/\.(html|md)$/, '') : ''), ts, file, url: b.input.url || null });
          }
          if (live) pushFeed(s, b.name, target, ts);
        }
      }
      const text = textOf(m.content);
      if (sawTool) s.lastEvent = 'tool_use';
      else if (text.trim()) { s.lastEvent = 'end'; s.lastAssistant = { text, ts }; }
    }

    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          s.pending.delete(b.tool_use_id);
          if (b.is_error === true && ts) s.lastErrorTs = ts; // a failed tool call: the house shows trouble in that room for a while
          const art = s.artifacts.get(b.tool_use_id);
          if (art && s.project) {
            const url = art.url || (JSON.stringify(b.content || '').match(ARTIFACT_URL) || [])[0];
            const failed = b.is_error === true;
            if (url && !failed && art.file) {
              const prev = published.get(url);
              if (!prev || art.ts >= prev.ts) published.set(url, { url, file: art.file, title: art.title, project: s.project.id, ts: art.ts, by: label(s) });
            }
            if (url && !failed) {
              designs.set(s.project.id, { title: art.title, url, ts: art.ts, by: label(s) });
              if (live) pushFeed(s, 'published', art.title, art.ts);
            }
            s.artifacts.delete(b.tool_use_id);
          }
        }
        s.lastEvent = 'result';
      } else {
        const text = textOf(c);
        s.pending.clear();
        s.lastEvent = 'prompt';
        if (text && !o.isMeta && !text.trimStart().startsWith('<')) {
          s.lastUser = { text, ts };
          note(s, 'you', text, ts);
          if (live) pushFeed(s, 'you said', text.slice(0, 60), ts);
        }
      }
    }
  }

  function setMeta(key, meta) { session(key, meta); }

  function derive(s, t) {
    if (s.pending.size) {
      const p = [...s.pending.values()].pop();
      const target = targetFor(p.name, p.input);
      if (p.name === 'AskUserQuestion') {
        const q = p.input.questions?.[0] || {};
        return { state: 'waiting', ask: { kind: 'question', text: q.question || 'Has a question for you', options: (q.options || []).map((x) => x.label).filter(Boolean), since: p.ts } };
      }
      if (p.name === 'ExitPlanMode') return { state: 'waiting', ask: { kind: 'plan', text: 'Wants you to approve a plan', since: p.ts } };
      if (t - p.ts > PERMISSION_AFTER_MS && !LONG_RUNNING(p.name)) {
        return { state: 'waiting', ask: { kind: 'permission', text: `Waiting for your OK to use ${p.name}`, code: target, since: p.ts }, tool: p.name, target };
      }
      return { state: activityFor(p.name, p.input), place: placeFor(p.name, p.input), tool: p.name, target };
    }
    if (s.lastEvent === 'end') return { state: 'idle', yourTurn: true };
    return { state: 'thinking' };
  }

  function sum(map, key, days) {
    const m = map.get(key); if (!m) return { raw: 0, w: 0 };
    let raw = 0, w = 0;
    for (const d of days) { const v = m.get(d); if (v) { raw += v.raw; w += v.w; } }
    return { raw, w };
  }

  /** Everything the page needs, as plain JSON. */
  function snapshot(config = {}) {
    const t = now();
    const today = dayKey(t);
    const week = Array.from({ length: 7 }, (_, i) => dayKey(t - i * 86400e3));
    const month = Array.from({ length: 30 }, (_, i) => dayKey(t - i * 86400e3));
    const finished = new Set(config.finished || []);
    const agents = [], asks = [];
    for (const s of sessions.values()) {
      if (!s.project) continue;
      const age = t - s.lastTs;
      if (s.kind === 'sub' && (s.finished || age > 10 * 60e3)) continue;
      const d = derive(s, t);
      const thread = {
        you: s.lastUser && (!s.lastAssistant || s.lastUser.ts <= s.lastAssistant.ts + 1) ? clip(s.lastUser.text, 500) : null,
        agent: s.lastAssistant ? clip(s.lastAssistant.text, 900, true) : null,
        agentTs: s.lastAssistant?.ts || null,
      };
      const base = { key: s.key, project: s.project.id, kind: s.kind, label: label(s), title: s.title, desc: s.desc, parentKey: s.parentKey, lastTs: s.lastTs, errorAt: s.lastErrorTs || null };
      const visible = age < 30 * 60e3 || (d.state === 'waiting' && age < 6 * 3600e3);
      if (visible) agents.push({ ...base, ...d, ask: undefined, recent: s.recent.slice(0, 5) });
      if (d.ask && age < 6 * 3600e3) asks.push({ ...base, ...d.ask, thread });
      else if (d.yourTurn && s.kind === 'main' && s.lastAssistant && t - s.lastAssistant.ts < 24 * 3600e3) {
        const tail = s.lastAssistant.text.slice(-500);
        asks.push({ ...base, kind: /\?\s*(\*\*)?\s*$|\?\s*\n|\?[^?]{0,200}$/.test(tail) ? 'reply' : 'done', text: s.title || 'Finished its turn', since: s.lastAssistant.ts, thread });
      }
    }
    const projList = [...projects.values()].map((p) => ({
      ...p,
      finished: finished.has(p.id),
      today: sum(usage, p.id, [today]),
      week: sum(usage, p.id, week),
      month: sum(usage, p.id, month),
      agents: [...agentUsage.keys()].filter((k) => k.startsWith(p.id + '|')).map((k) => ({ label: k.slice(p.id.length + 1), today: sum(agentUsage, k, [today]), week: sum(agentUsage, k, week), month: sum(agentUsage, k, month) })).filter((a) => a.month.raw > 0),
      design: designs.get(p.id) || null,
    }));
    // per-day totals for the last 30 days (oldest first), and two-hour buckets for the last 24 hours
    const daily = month.slice().reverse().map((d) => { let raw = 0, w = 0; for (const m of usage.values()) { const v = m.get(d); if (v) { raw += v.raw; w += v.w; } } return { day: d, raw, w }; });
    const nowBucket = Math.floor(t / 7200e3);
    const hours = Array.from({ length: 12 }, (_, i) => { const hk = nowBucket - 11 + i, v = hourly.get(hk) || { raw: 0, w: 0 }; return { start: hk * 7200e3, raw: v.raw, w: v.w }; });
    return { generatedAt: t, today, daily, hours, projects: projList, agents, asks: asks.sort((a, b) => a.since - b.since), feed: feed.slice(0, 25) };
  }

  /** One agent's notebook for the detail panel. */
  function notebook(key) { const s = sessions.get(key); return s ? s.log.slice(-40) : null; }

  return { ingest, setMeta, snapshot, notebook, sessions, projects, touchProject, published: () => [...published.values()], firstCwd: (key) => sessions.get(key)?.firstCwd || null };
}

function clip(text, n, tail = false) {
  const s = String(text || '').trim();
  if (s.length <= n) return s;
  return tail ? '…' + s.slice(-n) : s.slice(0, n) + '…';
}
