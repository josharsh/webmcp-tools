# Security Policy

## Supported versions

The latest published minor of each package receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Email engineering@spotlyte.live with details (affected package, version,
reproduction). You'll get an acknowledgment within 72 hours and a fix or
mitigation plan within 14 days for confirmed issues.

Areas of particular interest given what these packages do:

- Prompt-injection paths that bypass the taint guard or confirm gates
  (`webmcp-tools`, `@josharsh/webmcp-agent`)
- Origin-validation bypasses in the postMessage transports
  (`@josharsh/webmcp-bridge`) or `createAgentHandler` CORS/relay hardening
  (`@josharsh/webmcp-agent/server`)
- `exposedTo` visibility leaks in the ponyfill
- API-key exposure paths in the agent providers
