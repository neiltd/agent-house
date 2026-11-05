// Runs one headless Claude Code turn for the cockpit. Tool-neutral shape: start(opts) -> { stop() }, events via onEvent.
// Security (see the README's cockpit section): read-only tools, prompts auto-denied, user settings only, no MCP,
// a dollar cap, message on stdin (never as an argument), minimal env, whole process group killed on stop.
import { spawn } from 'node:child_process';
import os from 'node:os';

export const READ_ONLY_TOOLS = 'Read,Glob,Grep';

/** Sign-in problems, so the page can say "run claude auth login" instead of failing quietly. */
export const SIGNED_OUT = /claude auth login|\/login\b|not (?:signed|logged) in|log(?:ged)? ?in (?:has )?expired|sign-?in (?:has )?expired|invalid api key|authentication (?:failed|error)|oauth token (?:has )?expired/i;

/**
 * tools: a comma list (default read-only for the cockpit) or null for Claude Code's normal tool set.
 * permissionMode: e.g. "manual" for house-owned project conversations (prompts go to the hook; anything it doesn't allow is denied).
 */
export function startClaude({ cwd, text, agent, resume, budgetUsd = 1, timeoutMs = 30 * 60e3, tools = READ_ONLY_TOOLS, permissionMode = null, onEvent }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none',
    '--setting-sources', 'user', '--strict-mcp-config', '--max-budget-usd', String(budgetUsd)];
  if (tools) args.push('--tools', tools);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (agent) args.push('--agent', agent);
  if (resume) args.push('--resume', resume);
  const env = { PATH: process.env.PATH, HOME: os.homedir(), USER: process.env.USER || '', LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: os.tmpdir() };
  const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let buf = '', bytes = 0, ended = false;
  const LIMIT = 1_000_000;
  const finish = (ev) => { if (ended) return; ended = true; clearTimeout(timer); onEvent(ev); };
  const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000).unref(); };
  const timer = setTimeout(() => { kill(); finish({ type: 'error', text: 'Stopped: the run took longer than 30 minutes.' }); }, timeoutMs);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > LIMIT) { kill(); return finish({ type: 'error', text: 'Stopped: the run produced too much output.' }); }
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'system' && o.subtype === 'init' && o.session_id) onEvent({ type: 'session', sessionId: o.session_id });
      if (o.type === 'assistant') for (const b of o.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) onEvent({ type: 'text', text: b.text });
        if (b.type === 'tool_use') onEvent({ type: 'tool', tool: b.name, text: String(b.input?.file_path || b.input?.pattern || b.input?.path || '') });
      }
      if (o.type === 'result') { const t = o.is_error ? String(o.result || 'The run ended with an error.') : ''; finish({ type: 'done', text: t, sessionId: o.session_id, costUsd: o.total_cost_usd, signedOut: !!(t && SIGNED_OUT.test(t)) }); }
    }
  });
  let errTail = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (c) => { errTail = (errTail + c).slice(-500); });
  child.on('error', (e) => finish({ type: 'error', text: `Couldn't start claude: ${e.message}` }));
  child.on('exit', (code) => finish(code === 0 ? { type: 'done', text: '' } : { type: 'error', text: `claude exited (${code}). ${errTail.trim().split('\n').pop() || ''}`, signedOut: SIGNED_OUT.test(errTail) }));
  child.stdin.end(text); // the message goes on stdin, so nothing in it can be read as a command-line flag
  return { stop: () => { kill(); finish({ type: 'error', text: 'Stopped.' }); } };
}
