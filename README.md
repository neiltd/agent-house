# Agent House

A live pixel-art house that shows every Claude Code agent on your computer at once.

Each project gets a room; when a project goes quiet, its room frees up for the next one. Agents sit at desks while they edit, stand at the shelf while they read, and walk out to the "internet street" when they search the web, send mail, push to GitHub or drive a browser. A mailbox on the porch raises its flag when an agent is waiting on you.

At a glance it shows:

- **What's running right now?** Every live session and subagent, by project.
- **What's waiting on me?** Permission prompts, questions, plans to approve, and replies that end in a question, each with your last message and the agent's answer.
- **Where did my usage go?** This week or today, split by project or by agent.

## Run it

Needs Node 22 or newer. No packages to install.

```
git clone https://github.com/neiltd/agent-house.git
cd agent-house
node server.mjs
```

Then open http://127.0.0.1:4317. The first start reads the last week of transcripts, which takes a few seconds.

## What it reads

Claude Code writes every session to `~/.claude/projects/<folder>/<session>.jsonl`. Agent House reads those files and nothing else. It never writes to them, it doesn't call any API, and the page loads nothing from the internet. The server only listens on 127.0.0.1 and refuses requests addressed to any other host name.

- **Rooms** come from each session's working folder. `~/Desktop/my-app/ios` becomes the "my-app" room. Your home folder is the Home Office.
- **Every project gets a room of the same size.** A project keeps its room while it's active. When it goes quiet for two weeks (it moves to the attic) or is marked finished, its room shows FREE until the next new project moves in. The house only grows when every room is taken. Who lives where is remembered in `~/.agent-house/rooms.json`.
- **Usage** is cost-weighted tokens: output counts 5×, cache writes 1.25×, cache reads 0.1×. A session that keeps re-reading a large cached context doesn't look bigger than it is. Raw totals are shown too.
- **Design walls** link to the latest Artifact page each project published.
- **Inbox pages**: if a session publishes an Artifact whose title contains "Inbox" and is built from `<article class="ask">` cards, its open asks show under "Needs you". It reads the local HTML file the session published from.

## Config

Copy `agent-house.config.example.json` to `agent-house.config.json` and edit it. It's optional, and changes apply on the next refresh.

| Key | What it does |
|---|---|
| `rules` | Name rooms yourself: `{ "prefix": "Desktop/my-app", "id": "my-app", "name": "My App" }`. Several prefixes can share one id. `prefix` is relative to your home folder. |
| `pinned` | Room ids that always get their own room, even in a quiet week. |
| `finished` | Room ids that move to the Trophies shelf. |
| `school` | `[{ "prefix": "Documents/University", "name": "Uni" }]` gives each course folder there a classroom in a School wing. Assignment folders inside a course share its room. |
| `colors` | Fixed colours per room id. |
| `robots` | Room ids whose main session is drawn as a robot. |
| `characters` | Give named subagents one look everywhere, keyed by agent name: `{ "reviewer": { "name": "Robin", "role": "Code review", "body": "#2f6b4f", "hair": "#1c1c1c", "skin": "#e0b48a", "extra": "glasses" } }`. Use `"holo": "<colour>"` to draw a hologram, and `"alias": "<other key>"` for an old name. Extras: glasses, tie, hood, vest, beret, ponytail, longhair, headset, visor, shield, book, clipboard, magnifier (`accent` sets their colour). Teammates who aren't working sit in the Staff Room; holograms wait in the Control Room. A Team panel shows where everyone is. |
| `weather` | `{ "lat": 34.05, "lon": -118.24, "place": "Los Angeles", "units": "c" }` turns on live weather: the sky follows real sunrise and sunset, with clouds, rain, storms, snow and fog. The server asks [Open-Meteo](https://open-meteo.com) every 15 minutes, sending only these coordinates. Wind slants the rain, drifts the snow, sways the trees, blows leaves in strong wind and turns the weathervane to the real wind direction. Snow whitens the lawn. Preview any weather by adding `?wx=rain`, `snow`, `storm`, `fog`, `wind` or `clear` to the page address. It's the only outbound call the house makes, and it's off unless you set it. |
| `theme` | `"classic"` (default) or `"victorian"`: a stone mansion with bay towers, a mansard roof with dormers, and a turret whose weathervane turns while agents work. |
| `cockpit` | `{ "budgetUsd": 1, "targets": [...] }` for the chat panel. See "Talk to your agents". |
| `answering` | `{ "enabled": true, "waitSeconds": 45, "exclude": ["Desktop/sensitive-project"] }`. See below. |

## Answering from the page (optional)

With a hook installed, you can answer some asks right on the page:

- **Allow once / Deny** on permission prompts for Read, Glob, Grep, Edit and Write
- **Approve** a plan
- **Pick an option** for a multiple-choice question

The terminal still asks at the same time, and whichever answer comes first wins. If you don't answer on the page within 45 seconds, it lets go.

It never answers shell commands, web fetches or MCP tools. It also skips sessions started in `~/.claude` or in an `exclude` folder, and files such as `.env`, keys and `~/.ssh`. Writes must stay inside the folder the session started in. All of these go to the terminal as usual. The full threat model is in [docs/SECURITY.md](docs/SECURITY.md).

To set it up:

1. **Start the server yourself, in a terminal.** It prints a one-time pairing link. Open it in the browser you'll use. A server started without a terminal (for example by an agent) keeps answering off.
2. Try it on one folder first:
   ```
   node hooks/install.mjs --scratch ~/house-test
   cd ~/house-test && claude
   ```
3. When you're happy, turn it on for every session. Your settings are backed up first.
   ```
   node hooks/install.mjs --global
   ```
4. To take it out: `node hooks/install.mjs --global --remove`

The hook logs one line per run to `~/.agent-house/hook-runs.log` and one per answer to `~/.agent-house/answers.log`: tool and path only, never content. If you run Claude Code in auto mode, permission prompts are rare, so mostly questions and plans will reach the page.

Use a browser profile with no extensions for the house page, and don't give browser-automation tools access to `127.0.0.1:4317`. Anything that can click on the page can answer for you.

## Talk to your agents (optional)

A chat panel on the page sends your message to an agent and streams the reply back, so you don't switch between terminals. Pick a target, type, press Send (or Cmd+Enter). Follow-ups continue the same conversation. Runs show up in the house like any other session, and you can click them to read their notebook.

- Targets come only from `cockpit.targets` in your config: `{ "id": "my-app", "name": "My App", "folder": "Desktop/my-app", "agent": "optional-agent-name" }`. Your home folder, `~/.claude`, `~/.agent-house` and any `answering.exclude` folder are always refused.
- Version 1 is **read-only**: agents can read, search and answer, not change files. Anything that would need permission is refused automatically.
- Each run has a dollar cap (`cockpit.budgetUsd`, default 1), a 30-minute timeout and an output cap, and Stop ends it. At most 3 runs at once and 20 an hour.
- It only works from the paired browser, and only when you started the server yourself in a terminal. Claude Code can't type into a terminal session that's already open, so the page runs its own sessions.

## Tests

```
npm test                    # unit tests
node test/e2e-scratch.mjs   # scratch server + the real hook script + forged requests
```

## Limits

- The transcript format is internal to Claude Code and may change. If it does, some states may show wrong until this is updated.
- A shell command waiting for approval looks the same as one that's running, because transcripts don't say which it is.
- Built and tested on macOS. Linux should work. Windows is untested.

## License

MIT
