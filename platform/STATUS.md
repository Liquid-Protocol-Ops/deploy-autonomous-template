# Platform foundation — status (post-v2)

This directory will hold the off-chain services that watch fees, stake DIEM on the agent's behalf (claim only — agent stakes itself), expose the status API, launch new agents, and post to social channels. These off-chain services may run separately from the agent template. **Read `../ARCHITECTURE_v2.md` first** — this status doc reflects the v2 service graph (no swap step).

## What's done

- [x] **Step 1** — DIEM-paired Liquid token deploy script with $1K→$10B 7-position MC layout (`liquid-protocol-ops/sdk` PR #11, merged)
- [x] Foundation scaffold (this PR sequence) with resolved-decisions record, status doc, first Dune query stub
- [x] **Architecture v2** ratified (2026-04-30) — DIEM-only fees direct to agent wallet; per-agent Venice key; TEE substrate post-MVP

## What's planned for the next PR

- [ ] **§5 identity bundle** — 13 files including `SECTION_5.md`, identity templates, drift lint.
- [ ] **Step 2** — `platform/services/fee-router/` (real code, ~80 LOC after v2 simplification)
  - Polls `LiquidFeeLocker.availableFees(agentWallet, DIEM)` per agent
  - Triggers a stake-call notification when ≥ stake threshold; the **agent itself** executes claim + Venice stake (the platform never holds the agent's key)
  - HTTP API: `GET /agents`, `GET /agents/:id`, `GET /health`
  - Read-only by default (no platform-side keys for agent funds)
- [ ] **Step 3** — Agent-template additions: `harness/providers/venice.ts`, `harness/safety/allowlist.ts`, `harness/observability/tool-routing.jsonl` emitter, `harness/tick.ts` rewrite.
- [ ] **Step 4** — `platform/services/status-api/` (Hono read-only proxy on top of `fee-router`; joins Liquid pool data; feeds Dune)
- [ ] **Step 5** — `platform/services/cli-launcher/` (TS CLI; creates per-agent GitHub repo + agent wallet keypair (`.env` for v0; TEE-sealed for v1) + token + 5-DIEM seed deposit + registry entry + soul phase)
- [ ] **Step 6** — Auth-gated creator-terminal web UI (deferred to its own PR)
- [ ] **Step 7** — `platform/services/posters/` with X / email / Fiverr adapters; agent-side keys (no signing-proxy in v2)
- [ ] Second Dune query (`agent-compute-vs-mc.sql`) — time series

## Removed in v2

- ~~`signing-proxy`~~ — a centralized hot-path mediator is unnecessary. Agent wallets call Privy server wallet REST API directly; no proxy in the critical path. If end-user-wallet flows arrive later, that logic lives in the platform's user-facing API.
- ~~`venice-router`~~ — each agent holds its own Venice bearer key, minted by the agent itself after staking. No platform-side Venice creds, no per-agent quota allocation, no commons pool.
- ~~Swap module inside `fee-router`~~ — DIEM-only fees mean nothing to swap.

## Compute-denominated dashboard (per user request)

The Dune dashboard built on `dune/agent-fleet-overview.sql` shows each agent's market cap **alongside** their `dailyComputeUsd = stakedDiem × $1`. The agent token's intelligence-backed valuation is `dailyComputeUsd × 365 × multiple`, which is the *real* unit for comparing agent tokens — a $1M-MC agent with 100 DIEM staked is meaningfully different from a $1M-MC agent with 1 DIEM staked.

## Resume recipe

When the next session starts:

1. Read `../ARCHITECTURE_v2.md`.
2. Land §5 bundle (Batch 1) — unblocks every harness sub-ticket.
3. Push `platform/services/fee-router/` (the simplified v2 watcher). Run end-to-end in read-only mode against the agent token from PR #11.
4. Push `platform/services/status-api/`, then point Dune at it.
5. Push `platform/services/cli-launcher/` — provisions a Privy server wallet per agent and writes PRIVY_* env vars to the agent's deploy config.
6. Push agent-template additions (skills + harness rewrite per Batch 4).

## Open blockers

| # | Blocker | Owner | Notes |
|---|---------|-------|-------|
| ~~1~~ | ~~Venice staking contract address on Base~~ | ~~user~~ | **RESOLVED 2026-05-06** — DIEM contract `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` is token AND staking contract. Added to `platform/constants.ts` as `ADDRESSES.DIEM`. `stakeDiem()` now calls `stake()` directly with no approve step. |
| 2 | DIEM `decimals()` confirmed = 18 | user | PR #11's tick math assumes 18; on-chain check guards |
| 3 | sDIEM unstake cooldown (if any) | user | drives security model in §8 |
| 4 | Per-deploy LP split decision (100/0 default vs. configurable founder cut) | user | drives `cli-launcher` deploy step |
| 5 | GitHub App token (with template-fork scope) | user | `cli-launcher` step 1 |
| 6 | X/Twitter API bearer (for posters) | user | deferred from v0 per CLAUDE.md template-v1 capability list |
| 7 | Email provider account (Resend/Postmark) | user | deferred from v0 |
| ~~8~~ | ~~Decision: split platform services into a separate repo?~~ | ~~user~~ | **RESOLVED 2026-05-10** — stage all platform services under `platform/services/` in this repo for MVP; off-chain services may move to a separate repo post-MVP once the loop is proven. |
| 9 | TEE choice (Phala / Marlin Oyster / AWS Nitro) | user | post-MVP; v0 runs off Privy server wallet |
| 10 | Privy server wallet provisioning — PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID | user | needed to run the agent's tick against mainnet for the first time |
