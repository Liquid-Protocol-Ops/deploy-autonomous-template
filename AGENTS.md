# Agent Guidelines

This repo is a GitHub template for autonomous Claude Code agent instances
deployed by the Liquid Protocol deploy-autonomous launchpad. Each fork becomes
one agent's self-evolving codebase.

**`CLAUDE.md` is the canonical guide** — commands, module map, architecture, and
the on-chain transaction rule all live there. Read it first. `README.md` covers
deploy steps and env vars.

## Conventions

- All on-chain work targets **Base mainnet** (chain ID 8453).
- Never hardcode addresses — import from `platform/constants.ts`.
- Harness ticks must be idempotent; side effects go through the allowlist guard
  (`harness/safety/allowlist.ts`).
- Secrets are injected at runtime via environment variables — never committed.
- Every transaction script defaults to dry-run; pass `--live` to execute.
