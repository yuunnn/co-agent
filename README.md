<p align="center">
  <img src="./src-tauri/icons/128x128.png" width="92" alt="Co-Agent icon" />
</p>

<h1 align="center">Co-Agent</h1>

<p align="center"><strong>You’ve spawned countless Subagents, but an assembly line is not a council.</strong></p>

<p align="center"><strong>Stop copying the same question between AI agents.</strong></p>

<p align="center">
  Keep working in Codex. Co-Agent asks your other configured agents for independent opinions,<br />
  lets them challenge the strongest disagreement, and brings one decision back.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/co-agent-council"><img alt="npm" src="https://img.shields.io/npm/v/co-agent-council?style=for-the-badge&color=cb3837" /></a>
  <a href="https://github.com/yuunnn/co-agent/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/yuunnn/co-agent/ci.yml?branch=main&style=for-the-badge&label=CI" /></a>
  <a href="./LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-d22128?style=for-the-badge" /></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/Node.js-20%2B-43853d?style=for-the-badge&logo=node.js&logoColor=white" />
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24c8db?style=for-the-badge&logo=tauri&logoColor=white" />
</p>

<p align="center">
  <code>one Codex task</code> → <code>ask the other agents</code> → <code>compare disagreements</code> → <code>one decision</code>
</p>

![A real Co-Agent council showing five eligible seats, a verified quorum, deliberation, agreements, and a Co-Result](./assets/co-agent-council-wide.png)

<p align="center"><sub>Actual Co-Agent UI with a public-safe demonstration council. No mock product surface.</sub></p>

## The problem

Most people who use several AI agents still do most of their work in one of them. The trouble starts when a question matters. You copy it into Claude Code, OpenCode, Cursor, or a browser model, wait for each answer, paste the answers back into your main task, and ask the main agent to compare them. If the question depends on code or documents, you also have to rebuild the context for every agent.

The extra opinions are useful. Acting as the message bus is not.

Co-Agent removes that manual relay. Your current Codex task stays in charge. It sends the same question and evidence to the terminal agents and API models you have configured, collects their independent judgments, asks them to challenge the strongest disagreement, and brings the result back to the task where you were already working.

| Without Co-Agent | With Co-Agent |
| --- | --- |
| Open several terminals and browser tabs, then paste the same question into each one | Ask once from the current Codex task |
| Rebuild the relevant context for every agent | Give every agent the same prompt, workspace, or sealed files |
| Receive several isolated answers that never address one another | Start with independent judgments, then challenge the strongest disagreement |
| Paste everything back and synthesize it by hand | Let Codex return one conclusion while keeping agreements and unresolved disputes visible |

Use Co-Agent for the questions you would otherwise copy to another model: a difficult code review, an architecture choice, a research judgment, a product decision, or an operational plan.

## What it does

- **One main agent.** The current Codex task remains the host and moderator; Co-Agent is a second screen, not another task inbox.
- **The agents you already use.** Enabled terminal agents and API models join as independent seats. Co-Agent does not create extra Codex clones.
- **Independent answers first.** External seats judge the task before seeing Codex's position or one another's answers.
- **A real challenge round.** The agents respond to the strongest competing claims instead of leaving you with five parallel drafts.
- **The same evidence for everyone.** Give the council a prompt, a read-only workspace, or a sealed packet of named files.
- **No fake consensus.** Failed, advisory, and evidence-noncompliant seats remain visible but cannot silently count as valid votes.
- **One result brought back.** Codex synthesizes the outcome, supporting evidence, unresolved disputes, and next actions into a Co-Result.
- **Local by default.** Sessions, events, provider metadata, and evidence packets stay under `~/.co-agent/`. API tokens are isolated in a permission-restricted file and never returned by the Settings API.

## Quick start

The v0.1 npm package ships a prebuilt **macOS Apple Silicon** desktop app. Node.js 20+ and Codex are required.

```bash
npm install -g co-agent-council
co-agent setup codex
```

Or ask Codex to install it for you:

```text
Open https://github.com/yuunnn/co-agent, inspect the repository, install Co-Agent,
run co-agent setup codex, verify the installation with co-agent doctor, and tell me
when I need to restart Codex.
```

Codex can perform this installation when you explicitly ask it to. It should inspect the repository first, use the published npm package, and report every change it makes to your local Codex configuration.

Restart Codex and open a new task so the Skill and MCP server are discovered. Then say:

```text
Open Co-Agent for this task. Ask my other agents to judge it independently,
challenge the strongest disagreement, and bring the final recommendation back here.
```

To configure seats first:

```bash
co-agent open
```

Open **Settings**, then add any combination of:

- terminal Agents already callable in your shell: `claude`, `cursor-agent`, or `opencode`;
- OpenAI-compatible API endpoints with a name, base URL, model ID, and token.

Co-Agent verifies a real response before saving a provider. Terminal adapters reuse the CLI's existing login and default model; Co-Agent does not inject a model override. Any number of enabled API providers can join a new council independently.

![The real Co-Agent settings screen showing multiple API seats, terminal Agents, and three appearance themes](./assets/co-agent-settings.png)

## Council protocol

```mermaid
flowchart LR
  C["Current Codex task<br/>host + moderator"] --> B["Bind council<br/>through MCP"]
  B --> E["Prompt, workspace,<br/>or sealed evidence"]
  E --> I["Independent round<br/>peers hidden"]
  I --> Q{"Eligible quorum?"}
  Q -->|yes| X["Challenge round"]
  Q -->|no| P["Partial council<br/>no false consensus"]
  X --> R["Co-Result<br/>agreement + dissent + actions"]
  P --> R
```

For material decisions, the bundled Skill guides Codex through this sequence:

1. `co_agent_bind_current` binds the current task and establishes its evidence mode.
2. `co_agent_start_council_round` launches enabled external seats asynchronously.
3. `co_agent_get_session` exposes live provider completion, evidence status, and quorum.
4. A challenge round tests the strongest disagreement from round one.
5. `co_agent_publish_result` records the scoped outcome, agreements, disputes, and next actions.

The app stores visible conclusions and evidence references—not private chain-of-thought.

## Evidence modes

| Mode | Use it for | Seat access |
| --- | --- | --- |
| `prompt` | The task statement contains all required evidence | Every seat receives the same prompt |
| `workspace` | Repository-wide analysis | Terminal Agents inspect the bound workspace read-only; API-only seats may be advisory |
| `sealed` | Named files, paper-only review, bounded audits | Files are copied into an immutable packet; API seats receive the same extracted text |

Sealed text sources include common code and document formats such as Markdown, JSON, YAML, TOML, Rust, Go, Python, TypeScript, TeX, CSV, and plain text. PDFs are converted to page-marked text once with `pdftotext`.

## MCP and ACP

### MCP — the full council path

`co-agent setup codex` installs the bundled Skill and registers the stdio MCP server. This is the production integration in v0.1: Codex binds the task, dispatches every enabled terminal/API seat, tracks quorum, and publishes the Co-Result.

```bash
co-agent mcp
```

### ACP — experimental single-host bridge

```bash
co-agent acp
```

The ACP endpoint is intentionally labeled **experimental**. It currently exposes one read-only Codex-hosted session through ACP and mirrors its visible output into Co-Agent. It does **not** yet dispatch the external terminal/API seats configured for the MCP council. ACP mode requires the optional `@openai/codex-sdk` peer dependency.

That boundary is deliberate: Co-Agent does not market a protocol adapter as feature parity before it actually has it.

## Local architecture

```text
Codex Skill + MCP server
          │
          ▼
Node control plane ───── terminal Agents (Claude Code / Cursor Agent / OpenCode)
          │
          ├───────────── OpenAI-compatible API models
          │
          ├───────────── ~/.co-agent/ file-backed sessions and sealed evidence
          │
          ▼
Tauri 2 desktop app ─── native system WebView + React UI
```

The daemon listens only on `127.0.0.1` and protects its API/WebSocket endpoints with a per-launch random token. Its runtime descriptor and provider secrets use mode `0600` on supported filesystems.

## Commands

```text
co-agent open [--session <id>]   Open history or a specific bound council
co-agent daemon                  Run the local authenticated daemon
co-agent mcp                     Serve the full Codex MCP integration over stdio
co-agent acp                     Serve the experimental ACP bridge over stdio
co-agent doctor                  Check Codex, daemon, frontend, and desktop readiness
co-agent setup codex             Install the Skill and register the MCP server
```

## Build from source

```bash
git clone https://github.com/yuunnn/co-agent.git
cd co-agent
npm ci
npm run build
npm test
npm run tauri:build
npm run open
```

`npm run tauri:build` follows the full Tauri production build and stages only the final `.app` in the package tree. Rust intermediates stay in `~/Library/Caches/co-agent/cargo-target`, not the repository. They can be removed independently without affecting installed Co-Agent data.

The release gate also recreates a clean production install and enforces a **50 MiB installed-package ceiling**:

```bash
npm run check:install-size
```

## Data and privacy

```text
~/.co-agent/
├── config.json
├── secrets.json                 # API tokens, mode 0600
├── runtime.json                 # local daemon token, mode 0600
└── sessions/<session-id>/
    ├── session.json
    ├── events.jsonl
    └── artifacts/evidence/<packet-id>/
        ├── manifest.json
        ├── task.txt
        ├── council-evidence.txt
        └── source-*
```

- No hosted Co-Agent account or telemetry service.
- No bundled third-party model credentials.
- No automatic discovery or activation of providers the user did not configure.
- No hidden substitution when a provider or proxy fails.
- Provider output can be wrong; inspect the evidence and dissent before acting on a Co-Result.

See [SECURITY.md](./SECURITY.md) for reporting and operational boundaries.

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), keep council behavior evidence-backed, and do not convert provider failure into synthetic consensus.

## License

Licensed under the [Apache License 2.0](./LICENSE).
