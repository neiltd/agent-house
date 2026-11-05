// Answering asks from the page: the rules (pure, no I/O) and the "desk" that holds open asks.
// Threat model and rules: docs/SECURITY.md.
import path from 'node:path';
import crypto from 'node:crypto';

// Allow-list. Never Bash, never WebFetch, never MCP tools.
export const PERMISSION_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'ExitPlanMode']);
export const QUESTION_TOOLS = new Set(['AskUserQuestion']);
const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Edit', 'Write']);

/** Claude Code names a transcript folder after the launch dir with every non-alphanumeric char turned into "-". */
export const encodeDir = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');

/** Launch dirs whose sessions never get page answers: ~/.claude always, plus the configured ones. */
export function excludedLaunchDirs(home, extra = []) {
  return [path.join(home, '.claude'), ...extra];
}

/** Paths a page answer may never touch, whatever the tool. */
function blockedPath(p, home, exclude = []) {
  const inside = (dir) => p === dir || p.startsWith(dir + path.sep);
  if (excludedLaunchDirs(home, exclude).some(inside)) return true;
  // A folder with the same name as an excluded one is treated the same, wherever it is.
  if (exclude.some((d) => p.split(path.sep).includes(path.basename(d)))) return true;
  if (['.ssh', '.aws', '.gnupg', '.config', '.agent-house', 'Library', '.netrc', '.npmrc'].some((d) => inside(path.join(home, d)))) return true;
  const base = path.basename(p).toLowerCase();
  if (base.startsWith('.env') || /\.(pem|p8|p12|key|keychain)$/.test(base) || /secret|token|credential|password|id_rsa|id_ed25519/.test(base)) return true;
  return false;
}

/** Mask anything that looks like a secret before it is shown or logged. */
export function mask(s) {
  return String(s ?? '')
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abp]|eyJ)[A-Za-z0-9_\-.]{10,}/g, '‹masked›')
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, '‹masked›'); // no '/' so file paths stay readable
}

/**
 * Decide whether a hook payload may be answered from the page.
 * @param payload  the JSON Claude Code passed the hook (plus nothing else we trust)
 * @param ctx      { home, projectsRoot, exclude: [absolute dirs], sessionCwd(sessionId) -> first cwd the store saw, or null }
 * @returns { ok: true, ask } or { ok: false, reason }
 */
export function checkHookPayload(payload, ctx) {
  const p = payload || {};
  const no = (reason) => ({ ok: false, reason });
  const event = p.hook_event_name, tool = p.tool_name, input = p.tool_input || {};
  if (event === 'PermissionRequest') { if (!PERMISSION_TOOLS.has(tool)) return no('tool not on the allow-list'); }
  else if (event === 'PreToolUse') { if (!QUESTION_TOOLS.has(tool)) return no('tool not on the allow-list'); }
  else return no('unsupported hook event');
  if (typeof p.session_id !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(p.session_id)) return no('bad session id');

  // The transcript must be a real Claude Code transcript that matches the session id.
  const tp = typeof p.transcript_path === 'string' ? path.resolve(p.transcript_path) : '';
  const root = path.resolve(ctx.projectsRoot);
  if (!tp.startsWith(root + path.sep) || path.basename(tp) !== p.session_id + '.jsonl') return no('transcript does not match session');
  const folder = path.basename(path.dirname(tp));
  if (path.dirname(path.dirname(tp)) !== root) return no('transcript not in a project folder');

  // Exclusions use the launch folder, which the agent cannot change with `cd`.
  const exclude = ctx.exclude || [];
  for (const d of excludedLaunchDirs(ctx.home, exclude)) { const e = encodeDir(d); if (folder === e || folder.startsWith(e + '-')) return no('excluded project'); }
  if (exclude.some((d) => folder.includes(encodeDir(path.basename(d))))) return no('excluded project');

  const launch = ctx.sessionCwd(p.session_id);
  if (!launch || encodeDir(launch) !== folder) return no('session not known yet');

  const ask = { event, tool, sessionId: p.session_id, launch, kind: 'permission', target: '', questions: null };
  if (tool === 'AskUserQuestion') {
    const qs = Array.isArray(input.questions) ? input.questions : [];
    if (!qs.length || qs.length > 4) return no('bad questions');
    ask.kind = 'question';
    ask.questions = qs.map((q) => ({ question: String(q.question || ''), multiSelect: !!q.multiSelect, options: (q.options || []).map((o) => String(o.label || '')).filter(Boolean) }));
    if (ask.questions.some((q) => !q.question || !q.options.length)) return no('bad questions');
    ask.input = input;
    ask.target = ask.questions[0].question;
    return { ok: true, ask };
  }
  if (tool === 'ExitPlanMode') { ask.kind = 'plan'; ask.target = 'Approve the plan (mode stays as it is)'; return { ok: true, ask }; }

  if (PATH_TOOLS.has(tool)) {
    const raw = input.file_path ?? input.path ?? (tool === 'Glob' || tool === 'Grep' ? launch : undefined);
    if (typeof raw !== 'string' || !raw) return no('no path');
    const abs = path.resolve(launch, raw);
    if (blockedPath(abs, ctx.home, exclude)) return no('protected path');
    // Writes must stay inside the folder the session was started in, and never from a session started in ~ itself.
    if (WRITE_TOOLS.has(tool)) {
      if (path.resolve(launch) === path.resolve(ctx.home)) return no('writes from a home-folder session go to the terminal');
      if (!(abs === launch || abs.startsWith(path.resolve(launch) + path.sep))) return no('write outside the project');
    }
    if (tool === 'Grep' && typeof input.pattern === 'string') ask.detail = mask(input.pattern).slice(0, 80);
    ask.target = abs;
  }
  return { ok: true, ask };
}

/** An answer to a question must be one of the offered labels. Returns the answers map or null. */
export function checkAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object') return null;
  const out = {};
  for (const q of questions) {
    let v = answers[q.question];
    const picks = Array.isArray(v) ? v : [v];
    if (!picks.length || picks.some((x) => typeof x !== 'string' || !q.options.includes(x))) return null;
    if (!q.multiSelect && picks.length !== 1) return null;
    out[q.question] = picks.join(', ');
  }
  return out;
}

/**
 * Holds asks that are waiting for an answer from the page.
 * Every ask gets a random server nonce; the first answer closes it; later answers are refused.
 */
export function createDesk({ max = 20, waitMs = 45_000, now = () => Date.now(), onLog = () => {} } = {}) {
  const open = new Map(); // id -> { ask, since, resolve, timer }
  const closed = new Map(); // id -> how it closed, kept briefly so a late click gets a clear answer

  function remember(id, how) { closed.set(id, how); if (closed.size > 200) closed.delete(closed.keys().next().value); }

  /** Add an ask. `resolve(result)` is called exactly once: {decision:'allow'|'deny', answers?} or {decision:null}. */
  function add(ask, resolve) {
    if (open.size >= max) return null;
    const id = crypto.randomBytes(16).toString('hex');
    const entry = { ask, since: now(), resolve, timer: null };
    entry.timer = setTimeout(() => close(id, { decision: null }, 'timed out'), waitMs);
    entry.timer.unref?.();
    open.set(id, entry);
    return id;
  }

  function close(id, result, how) {
    const e = open.get(id);
    if (!e) return false;
    clearTimeout(e.timer);
    open.delete(id);
    remember(id, how);
    e.resolve(result);
    return true;
  }

  /** From the page. Returns {ok:true} or {ok:false, error}. */
  function answer(id, body) {
    const e = open.get(id);
    if (!e) return { ok: false, error: closed.has(id) ? `already closed (${closed.get(id)})` : 'no such ask' };
    const { ask } = e;
    if (ask.kind === 'question') {
      const answers = checkAnswers(ask.questions, body?.answers);
      if (!answers) return { ok: false, error: 'answer must be one of the offered options' };
      close(id, { decision: 'allow', answers }, 'answered on the page');
      onLog({ id, ask, decision: 'answered' });
      return { ok: true };
    }
    if (body?.decision !== 'allow' && body?.decision !== 'deny') return { ok: false, error: 'decision must be allow or deny' };
    close(id, { decision: body.decision }, body.decision === 'allow' ? 'allowed on the page' : 'denied on the page');
    onLog({ id, ask, decision: body.decision });
    return { ok: true };
  }

  /** The hook went away (answered in the terminal, or killed). */
  function cancel(id) { return close(id, { decision: null }, 'answered in the terminal'); }

  function list() {
    return [...open.entries()].map(([id, e]) => ({ id, since: e.since, kind: e.ask.kind, tool: e.ask.tool, sessionId: e.ask.sessionId,
      target: mask(e.ask.target), detail: e.ask.detail || '', questions: e.ask.questions, expiresAt: e.since + waitMs }));
  }

  return { add, answer, cancel, list, size: () => open.size };
}
