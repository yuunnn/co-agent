---
name: co-agent
description: Open and operate a local dynamically sized Co-Agent council through MCP. Use when the user asks to bind the current Codex task, compare Codex with user-configured terminal Agents and API models, run a structured debate, track agreement and dissent, or publish a Co-Result.
---

# Co-Agent

## Overview

Use Co-Agent as a second screen for the current Codex task, not as a separate task launcher. Keep the app record at the level of visible conclusions, evidence, objections, agreements, disputes, and decisions; never request or store private chain-of-thought.

## Entry boundary

- Work begins in Codex. Create a Co-Agent council only by binding the current Codex task with `co_agent_bind_current`.
- Do not ask the user to create a separate task inside the Co-Agent app. The app is for observing and steering the bound council.
- Keep all task instructions in Codex. Treat the app as a live, inspectable council console rather than a second prompt entry point.
- Use `co_agent_open` without a session only to view existing bound-task history.

## Start or resume a council

1. Call `co_agent_bind_current` with the current Codex task's title and objective. Let it open the desktop app unless the user asks for a background-only session.
   - For a named artifact or PDF-only task, pass `evidencePaths` and use `evidenceMode: "sealed"`.
   - For a repository-wide development task, use `evidenceMode: "workspace"`.
   - For a conceptual task that needs no local files, use `evidenceMode: "prompt"`.
2. Retain the returned `sessionId` for every later tool call.
3. Treat the bound Codex task itself as the only Codex seat and moderator.
4. Use `co_agent_open` if an existing bound council needs to be shown again.

If automatic task identity is unavailable, the binding remains valid at the Co-Agent level. Say that explicit host task identity can be supplied later; do not invent an ID.

## Dynamic council

- Always include the current Codex host. Add every terminal Agent and API provider enabled by the user in Settings as its own independent seat; never invent, restore, discover, or guess an unconfigured provider.
- Never dispatch an additional Codex worker or subagent. The current Codex task is both one voting seat and the moderator.
- Call `co_agent_start_council_round` with Codex's own visible position. That tool invokes every external seat and returns immediately.
- Poll `co_agent_get_session` until `roundJob.status` is `completed` or `failed`. Individual results appear in the app as each seat finishes.
- User-configured terminal Agents use the adapter inferred when their `claude`, `cursor-agent`, or `opencode` command was verified. Use their configured executable and default model; do not pass model selectors or enumerate alternatives.
- Every API seat uses its own model, base URL, and token saved and verified by the user in Co-Agent Settings. Do not silently change, merge, add, or omit enabled API models.
- All provider agents run in read-only analysis modes. Do not authorize edits through Co-Agent.
- In sealed mode, local files are copied into an immutable packet with hashes and PDF text extraction. Never direct a seat back to the original workspace path.

## Conduct deliberation

- Start with one `independent` round so each seat reaches a view without seeing Codex's position or any peer output. Wait for its `roundJob` to complete.
- For a material decision, start a `challenge` round with Codex's updated position and a focus that names the strongest disagreements from round one, then wait for that job too.
- Record compact visible outputs. A useful turn contains a conclusion, strongest evidence, a challenge or uncertainty, and one next action.
- Keep explicit `agreements` and `disputes` when publishing the Co-Result. Do not flatten unresolved disagreement into premature consensus.
- Treat `eligibleForConsensus` as the validity boundary. A returned process is not a valid seat unless its evidence access is compliant.
- A full council requires independent quorum: at least three eligible seats including Codex. If quorum is absent, label the result as a partial council rather than consensus.
- Run at least one challenge round for material decisions. Ask agents to address one another's strongest evidence, not merely produce parallel drafts.

## Publish the Co-Result

Use `co_agent_publish_result` after agents have responded to the strongest competing view. Include:

- the outcome and its scope;
- evidence shared across agents;
- unresolved dissent or conditions;
- concrete next actions for the user;
- `finalized: true` only when another round is unnecessary.

Do not treat vote count as truth. Prefer independently supported evidence, reproducible checks, and objections that survive cross-examination. If one agent finds a verifiable defect that others miss, preserve it in the final Co-Result.

## Installation fallback

If Co-Agent tools are missing, ask the user to run `npm install -g co-agent-council` followed by `co-agent setup codex`, then restart Codex and start a new task so the MCP server and Skill are discovered. Do not silently install global packages or replace MCP configuration without the user's authorization.
