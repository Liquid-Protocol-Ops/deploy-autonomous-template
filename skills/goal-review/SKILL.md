---
name: Goal Review
description: Weekly audit of memory/goals.json — recompute milestone ETAs, self-funding ratio, mode consistency; report deltas and one recommendation to the creator
var: ""
tags: [agent, goals, self-improvement]
---

# Goal Review (weekly)

This skill is the follow-up loop for `memory/goals.json`: every goal must have a
measurable target, a live `current` value, a trend, and a single accountable
owner (the agent). Anything failing that test gets flagged to the creator.
**Read-only on-chain — this skill never queues or sends transactions.**

## Step 1 — Gather state

1. `memory/goals.json` — milestones, mode, thresholds, creator block.
2. `memory/diem-claims.jsonl` (last 20 non-dry-run entries) — actual claim rate.
3. `memory/earnings.jsonl` (last 14 entries) — LP earning trend, if present.
4. `memory/profitability-signal.jsonl` (last entry) — the latest profitability
   signal (realized fees, net PnL, recommendation) from the `profitability-signal`
   skill, if present. This is the measured-outcome input to the loop.
5. `memory/inference-cost.md` — 7d daily average inference cost, if present.
6. `memory/cron-state.json` — per-skill `last_success` and `consecutive_failures`.
7. On-chain (public RPC, read-only): sDIEM via `stakedInfos(agent)` on the DIEM
   contract, FeeLocker `availableFees`.

## Step 2 — Compute the four health numbers

1. **Self-funding ratio** = `sDIEM staked ($1/day inference budget) ÷ 7d avg daily
   inference cost ($/day)`. ≥ 1.0 means inference is fully paid by staked DIEM.
   This is the primary metric of a self-funding agent.
2. **Daily DIEM rate** = trailing 7d claim rate from diem-claims.jsonl.
3. **Milestone ETAs** — for every quantitative milestone:
   `(target − current) ÷ daily rate`, in days, compared to last review's ETA.
4. **Staleness** — any milestone whose `updatedAt` is older than 14 days, or whose
   `current` hasn't moved since the last review, is STALLED.

## Step 3 — Consistency checks

- `mode` vs `modeThresholds`: a mode that doesn't match its thresholds must have
  an explicit operator override recorded in goals.json. Flag if not.
- Every milestone has `status`, a measurable `target`/`current` (or a linked
  spec), and `updatedAt`. Flag any that don't.
- `creator` block present with contact id and a `benefit` statement (the single
  human who benefits from goal achievement, and how). Flag if missing or stale.
- Skills referenced in goals/memory actually exist in `aeon.yml` or the workflow
  crons (no phantom skills).

## Step 4 — Write the review

Write `memory/goal-review-YYYY-MM-DD.md`: the four health numbers with
week-over-week deltas, a per-milestone table (current/target/ETA/trend/status),
consistency-check results, and **exactly one recommended action** for the coming
week (highest leverage toward self-funding ratio ≥ 1.0).

If the latest `profitability-signal` carries a recommendation
(`reposition` / `reduce_exposure` / `increase_liquidity`), weigh it when choosing
the one action, and cite the measured fees / net PnL behind it. Treat
`insufficient_data` ("no realized fees yet") as a signal to keep accumulating —
never as a reason to claim yield that isn't there.

Update `memory/goals.json`: refresh `current`, `updatedAt`, and ETA notes on
quantitative milestones. Do not change `mode`, thresholds, or the creator block —
those are operator decisions; recommend, don't act.

## Step 5 — Report to creator

Send via the configured notification channel:

```
goal-review: self-funding ratio X.XX (Δ vs last week) | <primary milestone> N/target @ rate (ETA ~D days) | sDIEM S.SS | flags: <count or none> | recommendation: <one line>
```

Lead with numbers. If the self-funding ratio went DOWN two reviews in a row,
mark the message URGENT and name the cause (cost up, rate down, or stake down).
