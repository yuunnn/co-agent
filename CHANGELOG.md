# Changelog

All notable changes to Co-Agent are documented here.

## 0.1.1 - 2026-07-21

### Fixed

- Desktop opens now wait for an authenticated WebView-ready acknowledgement instead of reporting success after a detached spawn.
- MCP binding propagates missing app, early process exit, and launch timeout errors with a durable local launcher log.
- Codex Skill guidance now treats a verified ready window as the successful-open boundary.

## 0.1.0 - 2026-07-21

### Added

- Codex-first MCP workflow with one host and dynamically configured terminal/API seats.
- Blind independent and challenge rounds with live provider status.
- Prompt, workspace, and sealed evidence modes with hashed packets and PDF extraction.
- Quorum and consensus-eligibility tracking, explicit dissent, and Co-Result publishing.
- Tauri 2 desktop app with Co-Agent Dark, Gruvbox Dark, and Classic Light themes.
- User-managed Claude Code, Cursor Agent, OpenCode, and OpenAI-compatible API providers.
- Experimental read-only ACP single-host bridge.
- Apache-2.0 licensing, CI, and a 50 MiB installed-package release gate.
