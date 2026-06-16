---
page_type: authored
genesis_lock: true
created: 2026-04-30T00:00:00Z
updated: 2026-04-30T00:00:00Z
tags: [spec, decision]
---

# Architecture v2 — DIEM-paired, TEE-sealed, self-funding

**Status:** ratified 2026-04-30 from the design discussion of the same date. **Supersedes** three "Decisions explicitly confirmed by the user" in `CLAUDE.md` (see §3). Section 5 of the brainstorm is unaffected — identity layer survives the pivot intact.

## 1. The loop in one sentence

`liquid-sdk` deploys a TOKEN/DIEM pair → DIEM-only fees accrue to the agent's own wallet → agent stakes those fees on Venice → sDIEM unlocks $1/DIEM/day inference budget → agent spends within budget on Claude Code, Venice models, and other tooling → trading volume compounds the budget.

No router. No swap step. No platform custody. No human in the loop after deploy.

## 2. The three load-bearing conclusions

### 2.1 Provably autonomous = TEE

"Anyone can run a script with a private key." For the autonomy claim to be defensible, the agent's signing key must be sealed in a TEE with remote attestation (Phala / Marlin Oyster / AWS Nitro Enclaves). The code hash is attested on-chain; only the attested binary can sign with the agent's wallet. Optionally tighten by gating the fee-recipient contract on a valid attestation, so even the operator can't divert funds.

**MVP punt:** skip TEE for v0. Run the agent off a laptop or a normal VM. Ship the funding loop end-to-end first (trades → fees → stake → inference), then swap the substrate for a TEE once the loop is proven. The on-chain shape doesn't change between v0 and v1; only the binary's substrate does.

### 2.2 DIEM-only fees, agent wallet as fee recipient

`liquid-sdk` supports DIEM-paired pools and DIEM-only fee collection. That removes the WETH→DIEM swap, removes the platform `fee-router` as a swap step, and removes the 20/80 deployer-vs-router split. Fee-router shrinks to a stake-trigger watcher: when agent's claimable DIEM ≥ threshold, claim and stake.

The deployer's cut, if any, becomes a separate LP-share decision at deploy time (not a downstream router routing). For v0 the simplest setup is **100% of fees → agent wallet**; revisit if we want a per-deploy "founder reward" line.

### 2.3 Venice credits sDIEM, per-agent staking

Venice's daily inference allocation is proportional to a wallet's share of the staking pool, with a 0.1 DIEM minimum. Allocation refreshes at 00:00 UTC. **Daily credit does not roll over.** Each agent stakes its own DIEM and mints its own Venice API key once (bearer token, no expiry unless we set `expiresAt`). No platform Venice account, no per-agent ledger quota, no commons pool.

Implication: agent should keep a queue of background tasks (research, indexing, content gen, drift-self-evals) it can chew on whenever there's free credit, or accept waste on slow days. The "what fills the headroom" question is a §5 identity-layer question, not a fee-router question.

## 3. Conflicts with `CLAUDE.md` decisions

The following three lines under "Decisions explicitly confirmed by the user" in `CLAUDE.md` are **superseded by this document**. The user re-ratified the new direction in the 2026-04-30 design discussion.

| Was (CLAUDE.md) | Is (this doc) |
|---|---|
| "Pair token: WETH with `LiquidHookDynamicFeeV2`. 20% WETH → deployer; 80% → platform router → swap to DIEM → fund / stake agent." | TOKEN/DIEM pair via `liquid-sdk`. DIEM-only fees. 100% → agent wallet by default; per-deploy split is configurable. |
| "Wallets: Privy smart wallets, Liquid team Safe as recovery across agent wallets, protocol vault, router." | Agent wallet uses **Privy server wallets** for v0 (fully headless, no human in the loop) — superseding the earlier rejection of Privy, which applied only to embedded/user wallets. TEE substrate (Phala/Marlin/Nitro) is v1; callers don't change. Safe stays as recovery for protocol-owned multisigs (vault, deployer fund) only — not for agent wallets. |
| "Venice custody: platform-operated account, per-agent ledger quota, unused daily capacity pooled as a commons." | Each agent owns its own Venice API key, minted once via `personal_sign` over a Venice JWT once it has staked sDIEM ≥ 0.1. No platform account, no quota allocation, no commons. Surplus daily credit is consumed by the agent's own background-task queue or forfeited. |

The remaining `CLAUDE.md` "explicitly confirmed" decisions (self-modification scope, threshold-triggered deployment, public-repo-per-agent, holder-suggestion thresholds, Modal cadence, orchestrator quorum) are **not** affected.

## 4. Service-graph deltas in `platform/STATUS.md`

The fee-router rewrite cascades:

- **`fee-router`** — was: poll → claim → swap WETH→DIEM → stake. Now: poll → claim → stake. Drop the swap module.
- **`signing-proxy`** — was: sole holder of Privy creds; mediator for all on-chain agent signs. Now: **deleted** for agent transactions. Repurpose for end-user wallets if/when those become a thing, otherwise remove from the v1 service list.
- **`venice-router`** — was: sole holder of Venice creds; per-agent quota allocation. Now: **deleted**. Each agent holds its own Venice key inside its (eventual) TEE.
- **`status-api`** — unchanged.
- **`scheduler` / `modal-dispatcher`** — unchanged in shape; the Modal substrate is the v0 substrate to be replaced by a TEE substrate post-MVP.

Service count drops from ~12 to ~9 for v0.

## 5. Still open

| # | Question | Decides |
|---|---|---|
| O-1 | TEE choice — Phala vs. Marlin Oyster vs. AWS Nitro | post-MVP; provability binary substrate; on-chain attestation verification cost |
| O-2 | sDIEM unstake cooldown | drain-in-one-tx exposure on agent wallet vs. principal recovery if winding down |
| O-3 | Venice key `expiresAt` | blast-radius reduction vs. renewal-ceremony frequency |
| O-4 | Per-deploy LP split — 100/0 default vs. configurable founder cut | v0 deploy CLI flow |
| O-5 | What background tasks fill daily inference headroom | identity layer; tool-routing table; §5 dogfooding |
| O-6 | Anthropic-key path if agent uses Claude directly | DIEM → USDC → Anthropic credits is the only known path; collapses some loop elegance |

## 6. v0 (MVP) acceptance test

End-to-end on Base, off-laptop, no TEE:

1. Deploy a TOKEN/DIEM pair via `liquid-sdk` with the agent's Privy server wallet as fee recipient.
2. A few synthetic trades (deployer-funded) on the pool.
3. Agent's claimable DIEM ≥ stake threshold → agent claims and stakes.
4. Agent receives sDIEM ≥ 0.1.
5. Agent runs the Venice mint flow: gets short-lived JWT, `personal_sign`s it, exchanges for a bearer key.
6. Agent calls Venice inference, observes the daily-budget meter tick down.
7. Confirm the loop holds for ≥ 24 hours (covers one daily-allocation refresh).

Provability is a separate v1 milestone — TEE substrate swap, no functional change in the loop above.
