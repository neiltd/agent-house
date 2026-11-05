# Security model

Agent House is read-only unless you install the hook. This page covers what changes when you do.

## Without the hook

- Reads `~/.claude/projects/**/*.jsonl` and the local HTML files that sessions published as Artifacts. Writes nothing there.
- Listens on 127.0.0.1 only. Requests with any other `Host` header are refused, which blocks DNS-rebinding from web pages.
- The page loads nothing from outside: no fonts, no scripts, no analytics. It's served with a Content-Security-Policy (`default-src 'self'`, a per-response script nonce, `frame-ancestors 'none'`).
- One optional outbound call: with `weather` set in your config, the server asks Open-Meteo for the current weather every 15 minutes, sending only the coordinates you set.
- Anything running as you can already read your transcripts, so the state API adds no new exposure for local processes.

## With the hook

The hook lets a click on the page answer a prompt, so the page can approve actions. What matters is who can click.

### The threat that matters: your own agents

Every Claude Code agent runs as you. If one is prompt-injected, it can read any file you can and send any request to localhost. Checking `Host`, `Origin` or a custom header stops other web pages, not local processes. So the rules are:

1. **Two secrets.**
   - The *hook token* (`~/.agent-house/hook-token`, mode 600) lets the hook script create asks. Agents can read that file, so it can't answer anything.
   - The *page credential* is an `HttpOnly; SameSite=Strict` cookie. A browser gets it once, through a one-time pairing link printed **only to the terminal the server was started in**. It never goes into a file, the HTML, or an API response.
   - If the server isn't attached to a terminal (an agent started it, so its output would land in a transcript), answering stays off.
2. **Allow-list, not deny-list.** Only Read, Glob, Grep, Edit, Write, ExitPlanMode and AskUserQuestion. Never Bash: a deny-list of risky commands is easy to dodge (quoting, `base64 -d | sh`, writing a script and running it). Never WebFetch, because a URL can carry data out. Never MCP tools.
3. **One random id per ask**, made by the server. The first answer closes it. A late click, a second click, or a click after the terminal already answered is refused.
4. **Exclusions use facts the agent can't change.** A session is matched by its transcript folder, which is fixed when it starts, not by its current `cwd`, which moves with `cd`. Sessions started in `~/.claude` or a configured `exclude` folder never get page answers. Paths under those folders, plus `.env*`, key files and `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/Library` and `~/.agent-house`, always go to the terminal.
5. **The hook payload isn't trusted.** `transcript_path` must sit directly under `~/.claude/projects/<folder>/`, be named `<session_id>.jsonl`, and match the launch folder the house saw in that transcript. Bodies are capped at 64 KB and open asks at 20.
6. **Answers can't widen anything.** An allow is for that one call: no `updatedPermissions`, no mode change, no edited input. A question answer must be one of the labels Claude offered, and the hook checks that again before it replies.
7. **Writes stay home.** Edit and Write are only answerable for paths inside the folder the session started in, and never for a session started in your home folder itself.

The installer adds deny rules for `Read(~/.agent-house/**)` and `Edit(~/.agent-house/**)`, so agents can't casually read the hook files. A shell command can still read them, so treat this as an extra layer. Rule 1 is what protects you.

### What it doesn't protect against

- **Browser extensions** (browser-automation ones included) can read the page and click Allow. Use a browser profile with no extensions for the house, and don't give automation tools access to `127.0.0.1:4317`.
- **Code that can edit Agent House itself or your Claude Code settings.** At that point it doesn't need the page.
- **Someone at your unlocked computer.**

### Logs

- `~/.agent-house/answers.log`: time, decision, tool, path, session id prefix. Never file contents, commands or question text. Long token-like strings are masked. Mode 600, rotated at 1 MB.
- `~/.agent-house/hook-runs.log`: one line per hook run (event, tool, outcome). Mode 600.

### Fail-safe

When anything is off (house not running, not paired, no paired page open, an excluded session, a timeout, a bad reply), the hook prints nothing and exits 0. To Claude Code that means "no decision", and it carries on with the normal terminal prompt.

## Reporting a problem

Open an issue, or for anything sensitive, a private security advisory on the GitHub repo.
