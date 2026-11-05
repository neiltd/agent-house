// House-owned project conversations (pilot). Pure rules, no I/O except the realpath/isDir callbacks the caller passes.
// Which projects may run comes from your own pilot.local.json (git-ignored; see pilot.example.json), never from code or the page.
import path from 'node:path';

/**
 * Read the local pilot file's contents: { targets: [{ id, name, folder }], refused: [folders], refusePatterns: [regex source] }.
 * Anything malformed is dropped. No file, no targets: the safe default.
 */
export function readPilotLocal(raw) {
  let j; try { j = JSON.parse(raw); } catch { return { targets: [], refused: [], refusePatterns: [] }; }
  const str = (x) => typeof x === 'string' && x.length > 0 && x.length < 400;
  const targets = (Array.isArray(j.targets) ? j.targets : []).filter((t) => t && /^[a-z0-9-]{1,40}$/.test(t.id) && str(t.folder))
    .map((t) => ({ id: t.id, name: str(t.name) ? t.name : t.id, folder: t.folder }));
  const refused = (Array.isArray(j.refused) ? j.refused : []).filter(str);
  const refusePatterns = (Array.isArray(j.refusePatterns) ? j.refusePatterns : []).filter(str)
    .map((p) => { try { return new RegExp(p, 'i'); } catch { return null; } }).filter(Boolean);
  return { targets, refused, refusePatterns };
}

/**
 * Resolve the pilot targets.
 * @param ctx { home, config, env, local: readPilotLocal(...), realpath(p) -> string (throws if missing), isDir(p) -> bool, projectId(dir) -> string, extraRefused: [abs dirs] }
 * The agent-house config may rename or disable a local target, never add one.
 * env.AGENT_HOUSE_PILOT_TEST = "id=/abs/dir" adds one test-only target (for the scratch end-to-end check). It can't be set from the page.
 */
export function pilotTargets(ctx) {
  const { home, config = {}, env = {} } = ctx;
  const local = ctx.local || { targets: [], refused: [], refusePatterns: [] };
  const cfg = new Map(((config.pilot && config.pilot.targets) || []).filter((t) => t && typeof t.id === 'string').map((t) => [t.id, t]));
  const list = local.targets.map((d) => ({ ...d, ...(cfg.has(d.id) && typeof cfg.get(d.id).name === 'string' ? { name: cfg.get(d.id).name } : {}), enabled: cfg.get(d.id)?.enabled !== false }));
  const test = typeof env.AGENT_HOUSE_PILOT_TEST === 'string' ? env.AGENT_HOUSE_PILOT_TEST.match(/^([a-z0-9-]{1,40})=(\/.+)$/) : null;
  if (test) list.push({ id: test[1], name: test[1], folder: test[2], enabled: true });
  const homeReal = (() => { try { return ctx.realpath(home); } catch { return home; } })();
  const refused = [path.join(home, '.claude'), path.join(home, '.agent-house'), ...local.refused.map((r) => path.resolve(home, r)), ...(ctx.extraRefused || [])]
    .map((d) => { try { return ctx.realpath(d); } catch { return d; } });
  const out = [];
  for (const t of list) {
    if (!t.enabled) continue;
    let dir; try { dir = ctx.realpath(path.resolve(home, t.folder)); } catch { continue; }
    if (!dir.startsWith(home + path.sep) || !ctx.isDir(dir)) continue;
    if (dir === homeReal) continue; // the home folder itself, never a project
    if (refused.some((r) => dir === r || dir.startsWith(r + path.sep) || r.startsWith(dir + path.sep))) continue; // inside a refused folder, or containing one
    if (local.refusePatterns.some((re) => re.test(dir))) continue; // belt and braces: name patterns that are never run
    out.push({ id: t.id, name: t.name, dir, project: ctx.projectId ? ctx.projectId(dir) : null });
  }
  return out;
}

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
/** A message from the page: trimmed, zero-width characters removed, never a command or a flag. */
export function cleanMessage(text) {
  if (typeof text !== 'string') return { ok: false, error: 'message must be text' };
  const t = text.replace(ZERO_WIDTH, '').trim();
  if (!t) return { ok: false, error: 'message is empty' };
  if (t.length > 8000) return { ok: false, error: 'message is longer than 8000 characters' };
  if (/^[/!-]/.test(t)) return { ok: false, error: 'messages can\'t start with /, ! or - (they would be commands)' };
  return { ok: true, text: t };
}

/** An inbox answer is built from the card number and the letter you pick, never from card text. */
export const ANSWER_RE = /^\d{1,4}: [A-Z]$/;
export function answerText(num, letter) {
  const t = `${String(num ?? '').trim()}: ${String(letter ?? '').trim()}`;
  return ANSWER_RE.test(t) ? t : null;
}
