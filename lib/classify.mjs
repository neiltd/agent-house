// Pure helpers: which room a folder belongs to, what a tool call looks like in the house,
// and how heavy a usage record is. No I/O here so it is easy to test.
import path from 'node:path';

// Folders that only hold other projects. The first folder below one of these is the project.
const CONTAINERS = new Set(['Desktop', 'Documents', 'apps', 'src', 'Projects', 'ChatGPT', 'code', 'dev', 'Downloads']);

// Named rooms come from agent-house.config.json "rules": [{ prefix, id, name }], checked in order, first match wins.
// prefix is a folder relative to your home folder, e.g. "Desktop/my-app".
export const DEFAULT_RULES = [];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Map a working directory to a room: { id, name, group, short? }. group is 'school', 'home' or 'project'.
 * school: [{ prefix: 'Desktop/MSBA Courses', name: 'MSBA' }] puts each course folder ("437 Forecasting") in its own
 * classroom in the school wing; assignment folders inside a course share that classroom.
 */
export function projectFor(cwd, home, rules = DEFAULT_RULES, school = []) {
  if (!cwd) return { id: 'home', name: 'Home Office', group: 'home' };
  let rel = path.relative(home, cwd);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    if (cwd.startsWith('/private/tmp') || cwd.startsWith('/tmp')) return { id: 'scratch', name: 'Scratch', group: 'project' };
    return { id: slug(cwd), name: path.basename(cwd), group: 'project' };
  }
  rel = rel.split(path.sep).join('/');
  for (const r of rules) if (rel === r.prefix || rel.startsWith(r.prefix + '/')) return { id: r.id, name: r.name, group: 'project' };
  if (rel === '' || rel === '.claude' || rel.startsWith('.claude/')) return { id: 'home', name: 'Home Office', group: 'home' };
  for (const w of school) {
    if (!rel.startsWith(w.prefix + '/')) continue;
    const course = rel.slice(w.prefix.length + 1).split('/')[0];
    const num = (course.match(/^(\d{2,})/) || [])[1];
    return { id: slug(w.name) + '-' + (num || slug(course)), name: `${w.name} ${course}`, short: course, group: 'school' };
  }
  const parts = rel.split('/');
  let i = 0;
  while (i < parts.length - 1 && CONTAINERS.has(parts[i])) i++;
  const name = parts[i].replace(/_/g, ' ');
  return { id: slug(parts.slice(0, i + 1).join('-')), name, group: 'project' };
}

const has = (name, ...keys) => keys.some((k) => name.includes(k));

/** Which neighbour on the internet street a tool call visits, or null when it stays home. */
export function placeFor(name, input = {}) {
  if (!name) return null;
  if (name === 'WebSearch' || name === 'WebFetch' || has(name, 'firecrawl')) return 'library';
  if (has(name, 'Gmail', 'Google_Calendar')) return 'post';
  if (has(name, 'claude-in-chrome', 'Claude_Browser')) return 'cafe';
  if (has(name, 'Notion', 'Google_Drive', 'Claude_Docs')) return 'archive';
  if (name === 'Bash' && /(^|[\s;&|])(gh\s|git\s+(push|pull|fetch|clone))/.test(String(input.command || ''))) return 'github';
  return null;
}

const TYPING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Artifact']);
const READING = new Set(['Read', 'Grep', 'Glob', 'LS', 'LSP', 'ToolSearch']);
const RUNNING = new Set(['Bash', 'Monitor', 'BashOutput']);
const ASKING = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** What the character is doing for a tool call. */
export function activityFor(name, input = {}) {
  if (ASKING.has(name)) return 'waiting';
  if (placeFor(name, input)) return 'outside';
  if (TYPING.has(name)) return 'typing';
  if (READING.has(name)) return 'reading';
  if (RUNNING.has(name)) return 'running';
  return 'thinking';
}

/** Tools that can legitimately run for a long time, so a long wait is not a permission prompt. */
export const LONG_RUNNING = (name) =>
  RUNNING.has(name) || ['Agent', 'Task', 'Workflow', 'ScheduleWakeup', 'SendMessage', 'WebFetch', 'WebSearch'].includes(name) || has(name, 'claude-in-chrome', 'firecrawl');

/** A short human label for what a tool call is working on. */
export function targetFor(name, input = {}) {
  const s = (v) => String(v ?? '');
  const short = (v, n = 48) => (v.length > n ? v.slice(0, n - 1) + '…' : v);
  if (input.file_path) return path.basename(s(input.file_path));
  if (input.notebook_path) return path.basename(s(input.notebook_path));
  if (input.command) return short(s(input.command).split('\n')[0]);
  if (input.pattern) return short(s(input.pattern));
  if (input.query) return short(s(input.query));
  if (input.url) { try { return new URL(s(input.url)).host; } catch { return short(s(input.url)); } }
  if (input.description) return short(s(input.description));
  if (name === 'AskUserQuestion' && input.questions?.[0]) return short(s(input.questions[0].question), 80);
  if (name.startsWith('mcp__')) return name.split('__').pop().replace(/_/g, ' ');
  return '';
}

/**
 * Cost-weighted size of one usage record, in "input-token equivalents".
 * Relative prices follow Anthropic's published ratios: output 5x input, cache write 1.25x, cache read 0.1x.
 */
export function weigh(u = {}) {
  const i = u.input_tokens || 0, o = u.output_tokens || 0, cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
  return { raw: i + o + cw + cr, w: i + 5 * o + 1.25 * cw + 0.1 * cr };
}

/** Local calendar day for a timestamp, e.g. "2026-11-02". */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
