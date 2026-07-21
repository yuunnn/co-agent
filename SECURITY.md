# Security policy

## Supported versions

Security fixes are applied to the latest published Co-Agent release. The project is currently pre-1.0, so users should review release notes before upgrading.

## Report a vulnerability

Please do not open a public issue for a vulnerability that could expose local files, API tokens, daemon authentication, provider credentials, or executable invocation boundaries.

Use GitHub's **Report a vulnerability** flow in the Security tab of this repository. Include the affected version, platform, reproduction steps, expected boundary, observed behavior, and the smallest non-sensitive proof of concept you can provide.

## Operational boundaries

- The daemon binds to `127.0.0.1` and uses a random per-launch bearer token for API and WebSocket access.
- `runtime.json`, `config.json`, and `secrets.json` are written with mode `0600` on supported filesystems.
- API tokens are never returned by the Settings API or written into council events.
- Terminal Agent commands are restricted to supported executable basenames or absolute executable paths. Shell fragments are not accepted.
- Provider Agents are invoked in read-only analysis modes. That is a product boundary, not a guarantee against defects in third-party CLIs.
- A sealed packet narrows evidence available to Co-Agent, but users remain responsible for the content they submit to external model providers.
- Co-Results are model-generated analysis. Treat them as evidence to inspect, not authorization for destructive or high-stakes action.

When reporting a problem, remove tokens, private gateway URLs, paper contents, and local paths from logs or screenshots.
