# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck        # tsc --noEmit (strict mode, no emit)
npm run build            # tsc -p .
npm test                 # vitest run (all tests)
npm run lint:identity    # validate identity/ markdown schema + drift
npm run harness:tick     # one-shot agent tick (claim → stake → infer)
npm run bot              # long-running Telegram bot (long-poll)
npm run pair             # list / approve / revoke pending pairing codes
```

Run a single test file:
```bash
npx vitest run harness/safety/__tests__/allowlist.spec.ts
```

Run lint-identity against a different root (e.g. a fixture tree):
```bash
LINT_REPO_ROOT=/path/to/fixture npm run lint:identity
```

## What this repo is

A **GitHub template** (`Liquid-Protocol-Ops/deploy-autonomous`) — each launched agent is a new repo generated from this template. The harness code, identity layer, and safety modules live here and ship into every per-agent repo verbatim. Anything added at the root goes into every agent.

## Product intent

A CLI launchpad that spawns **self-funding, self-evolving Claude Code agents**. Each agent gets:
- Its own GitHub repo (fork of this template)
- A TOKEN/DIEM pool on Base via `liquid-sdk` — DIEM-only fees accrue to the agent's wallet
- Its own wallet (TEE-sealed post-MVP, Privy server wallet for v0)
- Its own Venice API key (minted via sVVV staking; stored in `memory/venice-bearer.json`)
- Its own Telegram bot (v1)

No router, no swap step, no platform custody. Agents run on GitHub Actions (scheduled every hour), state persists via git commits to `memory/`.

## Inference architecture

Claude Code runs through a gateway proxy, not Anthropic directly. No `ANTHROPIC_API_KEY` needed.

Flow: `github.com/musistudio/claude-code-router` local proxy → configured provider → Claude model

Set `gateway.provider` in `aeon.yml`. The workflow installs `@musistudio/claude-code-router`, writes `~/.claude-code-router/config.json`, starts the proxy, and sets `ANTHROPIC_BASE_URL=http://localhost:3456`.

### Gateway options

| `gateway.provider` | Secret required | How it pays | Base URL |
|-------------------|----------------|-------------|----------|
| `venice` | `VENICE_API_KEY` | Staked DIEM (inference credits) | `api.venice.ai/api/v1/chat/completions` |
| `surplus` | `SURPLUS_API_KEY` | USDC pre-funded account | `surplusintelligence.ai/api/inference/v1/chat/completions` |
| `direct` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | Anthropic billing | Anthropic API |

**Venice** — staked DIEM pays per inference call. Fully self-funding once the TOKEN/DIEM pool generates LP fees. Requires `sVVV` to mint the API key (one-time).

**Surplus Intelligence** — model marketplace at `surplusintelligence.ai`. OpenAI-compatible. 150+ models including Claude Sonnet 4.6, Opus 4.7, GPT-5, Gemini. Fund via USDC on Base or fiat. Model IDs use period notation: `claude-sonnet-4.6`, `claude-opus-4.7`, `claude-haiku-4.5`. Get API key at `surplusintelligence.ai/buy`.

Venice inference components:
| Component | Token | Purpose |
|-----------|-------|---------|
| API key gate | sVVV (staked VVV) | One-time — mint key via `scripts/stake-vvv.ts` |
| Inference credits | sDIEM (staked DIEM) | Ongoing — each Claude call draws from stake |

The agent earns DIEM as LP fees from its TOKEN/DIEM pool → stakes on Venice → inference credits. Fully self-funding once the pool generates yield.

## Required GitHub secrets (per-agent repo)

| Secret | How to get it |
|--------|--------------|
| `VENICE_API_KEY` | `memory/venice-bearer.json` after staking sVVV; or `venice.ai/settings/api` |
| `SURPLUS_API_KEY` | `surplusintelligence.ai/buy` — optional; enables `gateway.provider: surplus` |
| `GH_GLOBAL` | `gh auth token` (needs `repo` + `workflow` scopes) |
| `PRIVY_APP_ID` | Privy dashboard |
| `PRIVY_APP_SECRET` | Privy dashboard |
| `PRIVY_WALLET_ID` | Privy dashboard |
| `RPC_URL` | Alchemy/QuickNode Base mainnet |
| `AGENT_WALLET` | Agent's wallet address |
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot` |
| `TELEGRAM_CHAT_ID` | Your channel/group ID |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated numeric Telegram user IDs (from @userinfobot) — **required** security gate; messages from unlisted senders are silently ignored |

Set all secrets in one pass: read from `.env` and use `gh secret set --repo OWNER/REPO`.

## Telegram security gate

`messages.yml` enforces a two-layer check on every inbound Telegram message:
1. **Chat ID** — message must come from the configured `TELEGRAM_CHAT_ID`
2. **Sender allowlist** — `from.id` must be in `TELEGRAM_ALLOWED_USER_IDS`

If `TELEGRAM_ALLOWED_USER_IDS` is not set, **no messages are processed**. Blocked senders are acknowledged (so they don't re-queue) but silently dropped.

## Implemented code

### `harness/` — module map

| Module | Purpose |
|--------|---------|
| `harness/safety/allowlist.ts` | Write-path guard — only `identity/SOUL.md`, `identity/STYLE.md`, `memory/**`, `wiki/**` are mutable. Use `assertAllowed(path)` before any agent write. |
| `harness/safety/wallet.ts` | `Signer` + `TxSender` interfaces; two backends: `loadSignerFromEnv` (dev/fallback) and `loadSignerFromPrivy` (v0 primary). TEE backend is a post-MVP swap with no call-site changes. |
| `harness/providers/venice.ts` | Detect claimable DIEM via `LiquidFeeLocker` → claim → stake → mint Venice key → call inference → log via tool-routing. Bearer cached under allowlist path. |
| `harness/observability/tool-routing.ts` | Appends one JSONL line per provider call: provider, variant, cache_hit, latency, tokens, cost. |
| `harness/tick.ts` | Main entry point — composes wallet + venice + allowlist + tool-routing; checks daily budget; runs agent skill. |
| `harness/git-ops.ts` | Commits agent-mutated paths (gated by allowlist); pre-commit runs `lint-identity.ts`. |
| `harness/memory-io.ts` / `harness/wiki-io.ts` | Schema-conformant reads/writes against `identity/` and `memory/` per `SECTION_5.md` SCHEMA. |
| `harness/queue.ts` | Daily-budget queue — per-tick DIEM headroom calc; FIFO of background tasks; dequeues to fill headroom. |

### `platform/services/`

| Service | Tests | Purpose |
|---------|-------|---------|
| `fee-router/` | 11/11 | HTTP `GET /agents`, `GET /agents/:id`, `GET /health`; polls `LiquidFeeLocker` on-chain; read-only |
| `cli-launcher/` | 24/24 | Provisions a new agent: funding precheck → soul phase → wallet provisioning → token deploy → seed stake → repo fork → registry write |

### `scripts/watchdog.ts` + `.github/workflows/watchdog.yml`

Silent-stall watchdog — alerts the owner (Telegram, same secrets as messages.yml) when the watched cron jobs (`WATCHDOG_JOBS`, default `tick`) have no `last_success` in `memory/cron-state.json` newer than `WATCHDOG_THRESHOLD_HOURS` (default 3). Runs every 2h on its own schedule. One alert per stall via the `memory/watchdog-state.json` latch (committed by the workflow); one recovery message when successes resume. A fresh clone with no cron-state is `no-data`, never an alarm — the watchdog guards running agents that stop, not agents that never started.

### `scripts/lint-identity.ts`

Validates `identity/`, `SECTION_5.md`, and `ARCHITECTURE_v2.md` on every commit. Four checks:

1. **Frontmatter** — all five required keys (`page_type`, `genesis_lock`, `created`, `updated`, `tags`), controlled tag vocabulary, ISO-8601 dates, `sources` iff `page_type: ingested`.
2. **Drift** — Jaccard similarity of `SOUL.md` vs `SOUL.genesis.md` (and STYLE pair) must be ≥ `drift_threshold` (default 0.70). Template-mode pair skips the gate (bodies differ structurally before substitution).
3. **Broken internal links** — `[[path/to/page]]` links must resolve to an existing file.
4. **Quote cap** — any blockquote block must be ≤ 25 words.

### `identity/`

Six files in genesis/mutable pairs: `SOUL.genesis.md` + `SOUL.md`, `STYLE.genesis.md` + `STYLE.md`, `influences.md`. Templates ship with `.template` extension; the deploy-time substitution replaces them with the real files. `SCHEMA.md` is genesis-locked and defines all rules the lint enforces. `identity/index.ts` exports the module. `examples/` holds calibration corpus (good/bad outputs; `promoted/` fills as the agent runs).

### `harness/chat/` — Telegram bot (v1 foundation)

Long-running grammY-based bot, modeled on openclaw's `channels.telegram.*` shape but scoped to one agent / one bot. Lives as a separate process from the tick — the tick is one-shot (cron-friendly, runs on GHA), the bot is always-on (Railway / fly.io / VPS).

- **`config.ts`** — env-driven config (TELEGRAM_BOT_TOKEN, TELEGRAM_DM_POLICY, TELEGRAM_ALLOW_FROM, TELEGRAM_GROUPS, etc.). Mirrors openclaw's `channels.telegram` keys. Required: `TELEGRAM_BOT_TOKEN`. Defaults: `dmPolicy=pairing`, `groupPolicy=allowlist`, `requireMention=true`, `ackReaction=👀`, `errorPolicy=reply`, `textChunkLimit=4000`.
- **`pairing.ts`** — file-backed pairing store under `memory/pairing-pending.json` + `memory/owner-allowlist.json` (both allowlist-permitted paths). 8-char codes from a no-ambiguous-chars alphabet, 1h TTL, 3 pending cap per channel. First approval bootstraps the owner.
- **`policy.ts`** — pure decision function over (config, allowlist, message context). DM policy enforcement, group allowlist, mention gating. **Security boundary**: group sender auth does NOT inherit pairing-store approvals (matches openclaw 2026.2.25+) — DMs and group commands are separate trust surfaces.
- **`formatters.ts`** — `escapeHtml`, paragraph-aware `chunk` (defaults to 4000 chars, hard-caps at 4096), `stripHtml` for parse-mode fallback.
- **`commands/`** — `registry.ts` (registry type), `help.ts`, `status.ts` (on-chain snapshot), `think.ts` (owner-only Venice inference reply in the agent's SOUL.md voice; spends DIEM), `history.ts` (recent memory: prefers `memory/thoughts.jsonl`, falls back to the latest `memory/logs/<date>.md` journal), and the wallet commands `claim.ts` / `stake.ts` / `lp.ts` (owner-only; preview-then-confirm via `approvals.ts`, all sends through the guarded TxSender).
- **`approvals.ts`** — inline `[Confirm]/[Cancel]` gate for wallet-touching commands (openclaw exec-approval pattern): commands park an `execute` thunk in the `ApprovalStore` (30min TTL, 5-pending cap); nothing signs until an allowlisted owner presses Confirm. The `callback_query` handler registers BEFORE the policy middleware (callbacks carry no `ctx.message`) and does its own owner check. `/swap` (no harness swap provider — only `scripts/swap-0x.ts`) and `/tweet` (no X client in the template) are deliberately not chat commands yet.
- **`bot.ts`** — grammY bot factory. Middleware pipeline: policy gate → ack reaction → command dispatch → HTML-with-plaintext-fallback reply. Top-level `bot.catch` logs grammY/HTTP errors without crashing the poll loop.
- **`index.ts`** — entry point (`npm run bot`). Wires Privy or env signer + venice config + pairing/allowlist + command registry + grammY bot. Registers command menu via `setMyCommands` on every start.
- **`scripts/pair.ts`** — CLI for owner approval (`npm run pair`, `npm run pair approve CODE`, `npm run pair revoke CODE`). Reads/writes the same pairing-store files the bot uses.

**Runtime model**: bot needs a long-running host. Ship via Dockerfile / fly.toml in a follow-up; for now `npm run bot` works locally + on any host with env vars set. Webhook mode (openclaw's optional path) deferred to a later PR.

## Skills — two directories, two runtimes

There are intentionally **two** skill directories; they serve different consumers and are not duplicates of one mechanism:

| Directory | Consumer | Format | Frontmatter |
|-----------|----------|--------|-------------|
| `skills/<name>/SKILL.md` | The `aeon.yml` GitHub Actions workflow (`run-name: skill: …`); reads `skills/${skill}/SKILL.md` | `<name>/SKILL.md` dirs | `name`, `description`, `var`, `tags` |
| `.claude/skills/<name>/SKILL.md` | Claude Code interactive skill discovery (`/<name>`) | `<name>/SKILL.md` dirs | `name`, `description` |

A few names (`tick`, `heartbeat`, `lp-monitor`, `on-chain-monitor`) exist in both because the same operation is reachable from the scheduled workflow *and* from an interactive session — keep their intent in sync, but they're separate files with runtime-specific frontmatter/bodies. **Claude Code only discovers skills as `<name>/SKILL.md` directories** — never flat `.claude/skills/<name>.md` files, which are silently ignored.

## Architecture v2 (ratified 2026-04-30)

The three load-bearing conclusions — read `ARCHITECTURE_v2.md` for the full rationale:

1. **Provably autonomous = TEE** — agent key sealed in Phala/Marlin/Nitro. Punted for v0 (Privy server wallet); substrate swaps without changing any call sites.
2. **DIEM-only fees, agent wallet as fee recipient** — removes the WETH→DIEM swap and the platform fee-router as a routing step. `fee-router` becomes a thin stake-trigger watcher.
3. **Per-agent Venice staking** — each agent owns its own Venice key; no platform quota allocation, no commons pool. DIEM contract is its own staking contract — `stake(uint256)` directly, no ERC-20 approve step.

**Superseded (do not implement):** WETH pairing, Privy *embedded* wallets for agent wallets, platform Venice account, bare `.env` private key as primary wallet substrate. See `ARCHITECTURE_v2.md` §3 for the full conflict table.

## MVP status

v0 funding loop complete as of 2026-05-29. All 13 sessions shipped; hourly tick live on GitHub Actions.

When resuming: read this file → `ARCHITECTURE_v2.md` → `SECTION_5.md`.

## Planned infrastructure (post-v2)

Three repos: **this one** (agent template), **`deploy-autonomous-platform`** (~9 services on Hetzner via docker-compose), **`dune-queries`**. Platform services: `api-gateway`, `status-api`, `scheduler`, `modal-dispatcher`, `fee-router` (claim + stake only), `chain-watcher`, `github-app`, `auto-reviewer`, `suggestion-handler`, `lifecycle-engine`, Postgres, Redis, observability. Removed vs. v1 plan: `signing-proxy` and `venice-router`. Off-VM: Modal (v0 ticks), Venice (inference + staking), GitHub + GHCR, Base RPC.

## On-chain transaction rule

**Every transaction must have a dry-run first.** All `scripts/*.ts` that send transactions default to dry-run mode; pass `--live` to execute. Never run `--live` without first reviewing dry-run output and confirming:
1. Correct amounts (match on-chain state)
2. ETH balance above gas reserve (0.003 ETH minimum)
3. Allocation decision makes sense for current mode

**Destination allow-list (signing chokepoint).** `harness/safety/tx-allowlist.ts`
wraps every `TxSender` so a tx whose `to` is not a known protocol contract is
rejected *before* it reaches viem/Privy (fail closed). The allow-list is sourced
from `platform/constants.ts` `ADDRESSES` + the agent's own `selfAddress`. If a
future flow ever needs to sign to a dynamic address (e.g. an approval on the
agent's own freshly-launched token), it will be **blocked** until you either add
the address to `ADDRESSES` or set the `TX_EXTRA_ALLOWED` env var (comma-separated
addresses) — that is the intended escape hatch. Contract-creation (`to: undefined`)
is also rejected; deploys go through a separate, reviewed path.

## `.gitignore` gotcha

Do not exclude `.claude/skills/` — skills are the agent's primary mutation surface. Scope any Claude-local exclusions narrowly (e.g., `.claude/settings.local.json`).

## Linear

- [deploy-autonomous project](https://linear.app/mog-capital/project/deploy-autonomous-fe07e073672d/overview) — MOG-405 epic, 28 children, full decision history.
- [Liquid Inference Vault project](https://linear.app/mog-capital/project/liquid-inference-vault-4a0f0f2c775e) — wstDIEM vault, 13 WP tickets (MOG-480–492). WP-1 done; WP-2 (ERC-4626 contract) is next in `liquid-protocol-v0`.
