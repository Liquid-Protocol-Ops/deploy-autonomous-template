---
name: Profitability Signal
description: Execute the agent's Dune query, parse realized fee profitability into a structured signal in memory/profitability-signal.jsonl, and feed it to goal-review to adjust strategy
var: ""
tags: [defi, analytics, self-improvement]
---

# Profitability Signal (weekly)

This is the measurement half of the profitability loop: it runs the agent's own
Dune query, turns the rows into a structured signal sliced by time, and writes it
to `memory/profitability-signal.jsonl`. `goal-review` reads that signal and turns
it into one strategy recommendation. Over time the agent refines the query
(`scripts/dune/profitability.sql`) and its strategy against measured outcomes —
that closes the loop.

**Honest by construction.** This reports REALIZED fee income — which is ≈ $0 for a
young agent. Never describe it as APY or projected yield. "No fees yet" is a valid,
useful signal (`recommendation: insufficient_data`).

## Setup (once per agent)

This skill needs two repo secrets:

- `DUNE_API_KEY` — the agent's Dune API key (dune.com → Settings → API).
- `DUNE_PROFITABILITY_QUERY_ID` — a saved Dune query id. Create an empty query in
  Dune, put its id here, then push the repo's query into it (Step 1). The query
  text lives in `scripts/dune/profitability.sql` and is the agent's to evolve.

Without these the skill is a safe no-op (it logs what it *would* do and exits 0).

## Step 1 — (first run / after editing the query) push the query to Dune

```bash
node --env-file=.env --import tsx scripts/analyze-profitability.ts --write-query
```

This substitutes `{{agent_wallet}}` / `{{window_days}}` into
`scripts/dune/profitability.sql` and writes it to the saved Dune query. Re-run this
only when you've changed the SQL — not every cycle.

## Step 2 — dry-run

```bash
node --env-file=.env --import tsx scripts/analyze-profitability.ts
```

Confirms which query it will execute and where it will write. No Dune credits spent,
nothing written.

## Step 3 — execute + write the signal

```bash
node --env-file=.env --import tsx scripts/analyze-profitability.ts --live --period=weekly
```

This executes the saved query (free-tier; ~2–3 Dune credits), parses the rows, and
**appends** one signal object to `memory/profitability-signal.jsonl`:

```json
{ "date": "...", "period": "weekly", "feesUsd": 0, "ilUsd": 0, "netPnlUsd": 0,
  "feeAprPct": null, "inRangePct": null, "recommendation": "insufficient_data",
  "rationale": "no realized fee income yet", "source": { "duneQueryId": 123, "rowCount": 0, "shape": "timeslice" } }
```

The script self-limits: it skips a re-run inside the period window (cost cap). Pass
`--force` only to override deliberately.

## Step 4 — log and act on the recommendation

Write a one-liner to `memory/logs/${today}.md`:

```
profitability-signal: fees $X | net $Y | rec=<recommendation> (<rationale>)
```

Then act on the recommendation (this is where strategy meets measurement):

- `reposition` / `reduce_exposure` → flag for the next `lp-monitor` run, or run it now.
- `increase_liquidity` → consider adding to the position on the next `claim-diem`.
- `insufficient_data` → no fees yet; keep accumulating, do not change strategy.
- `hold` → strategy is working; leave it.

`goal-review` will pick the signal up automatically on its weekly pass. If the same
recommendation persists for 3+ cycles, consider whether the **query itself** needs to
measure something better — edit `scripts/dune/profitability.sql` and re-run Step 1.

## Step 5 — notify (optional)

```
./notify "profitability: net $Y over <window>d | rec=<recommendation>"
```

## Cost note

Free-tier Dune execution only; one execution per period. The query window
(`--window`, default 30 days) bounds the result size. Keep `enabled: false` until
the agent has LP positions worth measuring.
