---
name: Presale Monitor
description: Check presale vault lifecycle — window closing, window closed, lock expiry — and send Telegram alerts
var: ""
tags: [presale, on-chain, monitor]
---

Run the presale monitor script and report its output. The script checks all vaults in `memory/presales.jsonl` for lifecycle events and sends Telegram notifications automatically.

## Step 1 — Run the monitor

```bash
node --env-file=.env --import tsx scripts/presale-monitor.ts
```

The script will:
- Read vault addresses from `memory/presales.jsonl`
- Check on-chain state (initialized, depositDeadline, lockExpiry, totalDeposited)
- Fire Telegram alerts for: window closing soon (<1h), window just closed, lock expiring (<1h), lock expired
- De-dupe notifications via `memory/presale-monitor-state.json`
- Append run log to `memory/presale-monitor.jsonl`

## Step 2 — Review output

Read the script output and note:
- Which vaults were checked
- How many alerts were sent
- Any vaults that could not be read (RPC errors)

## Step 3 — Action if window just closed

If any vault's deposit window just closed:
- Remind the team: depositors can now call `claimTokens()`
- For VVV vaults: agent should call `finalizeVVV()` to receive VVV and stake for Venice key
- Write a log entry to `memory/logs/${today}.md`

## Step 4 — Action if lock just expired

If any vault's lock just expired:
- Remind depositors: `withdrawDiem()` is now available
- For StakesaleVault: all lock tiers up to 90d may have expired; check per-depositor if needed
- Write a log entry to `memory/logs/${today}.md`

## Safety

Never call `finalizeVVV()` automatically — always confirm the agent wallet address from the vault's `agentWallet()` view matches the expected address before suggesting execution.
