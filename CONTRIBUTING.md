# Contributing to Co-Agent

Thank you for helping make multi-agent work more inspectable.

## Development setup

Requirements: Node.js 20+, Rust stable, the Tauri 2 platform prerequisites, and `pdftotext` for PDF evidence tests or manual PDF flows.

```bash
npm ci
npm run build
npm test
npm run tauri:build
npm run check:install-size
```

The desktop verification is part of the product. A browser-only run does not replace `npm run tauri:build` and a native launch check.

## Product invariants

Changes should preserve these boundaries:

- Codex is the first-class task entry point and the only Codex council seat.
- Providers are user-configured; Co-Agent does not invent or silently substitute seats.
- Independent-round prompts do not reveal Codex or peer positions.
- Provider success, evidence compliance, and consensus eligibility remain separate.
- Missing quorum produces a partial council, not synthetic consensus.
- Agreements and unresolved disputes remain visible in the Co-Result.
- Co-Agent stores visible conclusions and evidence references, not private chain-of-thought.
- The clean installed npm package stays below 50 MiB.

## Pull requests

Keep changes focused. Add or update tests for behavioral changes, include real UI screenshots for visible design changes, and explain any migration that affects `~/.co-agent/` state. Do not commit provider tokens, private gateway URLs, council evidence, compiler caches, or generated dependency trees.

By contributing, you agree that your contributions are licensed under Apache-2.0 and to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
