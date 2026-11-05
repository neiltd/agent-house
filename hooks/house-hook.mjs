#!/usr/bin/env node
// Agent House hook: lets you answer a permission prompt, plan approval or question from the house page.
// Claude Code runs this for PermissionRequest (Read|Glob|Grep|Edit|Write|ExitPlanMode) and PreToolUse (AskUserQuestion).
// Rule: when in doubt, print nothing and exit 0. That means "no decision", and Claude Code carries on as normal
// (the usual terminal prompt). It only prints a decision when the house answers with this run's own nonce.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.AGENT_HOUSE_PORT || 4317);
const DIR = process.env.AGENT_HOUSE_DIR || path.join(os.homedir(), '.agent-house');
let EVENT = '?', TOOL = '?';
/** One line per run: time, event, tool, outcome. Never content. Lets you see whether Claude Code ran the hook. */
function trace(outcome) {
  try {
    const f = path.join(DIR, 'hook-runs.log');
    try { if (fs.statSync(f).size > 500_000) fs.renameSync(f, f + '.1'); } catch {}
    fs.appendFileSync(f, `${new Date().toISOString()} ${EVENT} ${TOOL} ${String(outcome).replace(/\s+/g, ' ').slice(0, 80)}\n`, { mode: 0o600 });
  } catch {}
}
const passThrough = (why = 'pass') => { trace(why); process.exit(0); };

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) passThrough('input too big'); });
process.stdin.on('end', main);
setTimeout(() => passThrough('hard stop'), 55_000).unref(); // hard stop under the 60 s hook timeout

function main() {
  let payload; try { payload = JSON.parse(raw); } catch { return passThrough('bad input'); }
  const event = payload.hook_event_name, tool = payload.tool_name;
  EVENT = event; TOOL = tool;
  trace('started');
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => passThrough(`stopped by Claude Code (${sig}): answered in the terminal?`));
  let token; try { token = fs.readFileSync(path.join(DIR, 'hook-token'), 'utf8').trim(); } catch { return passThrough('no hook token (house never started?)'); }
  if (!['PermissionRequest', 'PreToolUse'].includes(event)) return passThrough('other event');
  const hookNonce = crypto.randomBytes(16).toString('hex');
  const body = JSON.stringify({ hookNonce, payload });
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/hook/ask', method: 'POST', timeout: 52_000,
    headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-house-hook': token } }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { out += c; if (out.length > 64 * 1024) passThrough(); });
    res.on('end', () => {
      let r; try { r = JSON.parse(out); } catch { return passThrough('bad reply'); }
      if (res.statusCode !== 200 || r.hookNonce !== hookNonce) return passThrough('reply refused ' + res.statusCode);
      if (r.decision == null) return passThrough('to terminal: ' + (r.reason || 'no answer'));
      if (event === 'PermissionRequest' && (r.decision === 'allow' || r.decision === 'deny')) {
        // No updatedInput, no updatedPermissions, no mode change. Just this one call.
        const decision = r.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from the Agent House page.' };
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
        trace('answered on page: ' + r.decision);
        return process.exit(0);
      }
      if (event === 'PreToolUse' && tool === 'AskUserQuestion' && r.decision === 'allow' && r.answers && typeof r.answers === 'object') {
        // Check again here that every answer is one of the labels Claude offered.
        const qs = payload.tool_input?.questions || [];
        for (const q of qs) {
          const labels = (q.options || []).map((o) => o.label);
          const got = String(r.answers[q.question] ?? '');
          const picks = q.multiSelect ? got.split(', ') : [got];
          if (!got || picks.some((p) => !labels.includes(p))) return passThrough('answer not an offered label');
        }
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
          permissionDecisionReason: 'Answered on the Agent House page', updatedInput: { ...payload.tool_input, answers: r.answers } } }));
        trace('answered on page');
        return process.exit(0);
      }
      passThrough('unexpected reply');
    });
  });
  req.on('error', (e) => passThrough(e.code === 'ECONNREFUSED' ? 'house not running' : 'request error'));
  req.on('timeout', () => { req.destroy(); passThrough('timed out'); });
  req.end(body);
}
