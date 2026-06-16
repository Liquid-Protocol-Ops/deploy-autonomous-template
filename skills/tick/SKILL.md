---
name: Tick
description: Run one agent tick — claim fees, LP DIEM, maintenance inference
var: ""
tags: [agent, on-chain]
---

Run the agent tick. Execute:

```bash
node --import tsx harness/tick.ts
```

The tick does the following (accumulate mode):
1. Reads claimable DIEM from FeeLocker
2. Claims if ≥ threshold (default 0.1 DIEM)
3. Reads wallet DIEM balance
4. LPs into ETH/DIEM Uniswap v3 1% pool if ≥ threshold
5. Otherwise runs maintenance inference via Venice llama (free tier)

If the tick fails, log the full error to `memory/logs/${today}.md` and send a notification via `./notify`.

If the tick succeeds, log a one-liner to `memory/logs/${today}.md`:
```
tick: claimed X DIEM, LP'd Y DIEM | ticks=[A,B] currentTick=C
```

## After every tick — Dependabot check

After the tick completes (success or failure), run:
```bash
gh pr list --author app/dependabot --state open --json number,title,createdAt,url 2>/dev/null
```

Include any open Dependabot PRs in the `./notify` message. Format:
```
tick: <summary> | Dependabot: N open PR(s): #X title1, #Y title2
```
or omit the Dependabot section entirely if N=0.
