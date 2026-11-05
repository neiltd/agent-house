#!/usr/bin/env node
// Adds or removes the Agent House hook. You run this yourself; the house never edits settings.
//   node hooks/install.mjs --scratch <dir>   only for one test folder (<dir>/.claude/settings.local.json)
//   node hooks/install.mjs --global          every session (~/.claude/settings.json, backup kept next to it)
//   add --remove to either to take it out again
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const scratch = args.includes('--scratch') ? args[args.indexOf('--scratch') + 1] : null;
const global = args.includes('--global');
if (!!scratch === global) { console.error('Use exactly one of --scratch <dir> or --global (plus --remove to undo).'); process.exit(1); }

const file = global ? path.join(os.homedir(), '.claude', 'settings.json') : path.join(path.resolve(scratch), '.claude', 'settings.local.json');
const HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), 'house-hook.mjs');
const command = `node ${JSON.stringify(HOOK)}`;
const MARK = 'agent-house/hooks/house-hook.mjs';
const DENY = ['Read(~/.agent-house/**)', 'Edit(~/.agent-house/**)'];

let settings = {};
if (fs.existsSync(file)) {
  const text = fs.readFileSync(file, 'utf8');
  try { settings = JSON.parse(text); } catch { console.error(`${file} is not valid JSON. Not touching it.`); process.exit(1); }
  if (global) { const bak = `${file}.before-agent-house-${Date.now()}`; fs.writeFileSync(bak, text, { mode: 0o600 }); console.log(`Backup: ${bak}`); }
}
settings.hooks ||= {};
const strip = (event) => {
  settings.hooks[event] = (settings.hooks[event] || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(MARK)) }))
    .filter((g) => g.hooks.length);
  if (!settings.hooks[event].length) delete settings.hooks[event];
};
strip('PermissionRequest'); strip('PreToolUse');
settings.permissions ||= {};
settings.permissions.deny = (settings.permissions.deny || []).filter((r) => !DENY.includes(r));

if (!remove) {
  const h = { type: 'command', command, timeout: 60 };
  (settings.hooks.PermissionRequest ||= []).push({ matcher: 'Read|Glob|Grep|Edit|Write|ExitPlanMode', hooks: [h] });
  (settings.hooks.PreToolUse ||= []).push({ matcher: 'AskUserQuestion', hooks: [h] });
  settings.permissions.deny.push(...DENY);
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;
if (!settings.permissions.deny.length) delete settings.permissions.deny;
if (!Object.keys(settings.permissions).length) delete settings.permissions;

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? 'Removed the Agent House hook from' : 'Added the Agent House hook to'} ${file}`);
