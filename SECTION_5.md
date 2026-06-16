---
page_type: authored
genesis_lock: true
created: 2026-04-30T00:00:00Z
updated: 2026-04-30T00:00:00Z
tags: [spec, identity, decision]
---

# §5 — Agent template + identity layer

This document is the spec for the per-agent repo's identity layer. It is **dogfooded in the schema it defines**: the file's own frontmatter, internal links, quote handling, and tag set conform to [[identity/SCHEMA]]. If the spec is unworkable, this file breaks under [[scripts/lint-identity]] before any agent ships.

§5 is locked as of 2026-04-30. See Linear epic [MOG-405](https://linear.app/mog-capital/issue/MOG-405) and [[CLAUDE]] §"Decisions explicitly confirmed by the user" for the locked decisions enumerated. Sections 6–9 are unblocked by this lock.

## What §5 settles

The agent template's identity layer adapts [[identity/influences#aaron-j-mars-soul-md]] (the upstream `soul.md` convention) with three deliberate inversions for autonomous economic agents:

1. **Genesis vs. mutable split.** The upstream convention says "update SOUL regularly." For an agent that rewrites its own files every tick, that is the failure mode — over thousands of ticks the SOUL sands itself into a generic engagement-optimizer. We split into `*.genesis.md` (deploy-time, hard-locked) plus `*.md` (mutable working copy, drift-bounded by lint).
2. **Examples become lint corpus, not inspiration.** The upstream convention treats `examples/` as material the agent draws on. Here, `examples/` is a calibration target the lint scores against. Deployer-seeded `good-outputs.md` and `bad-outputs.md` plus an auto-promoted `promoted/` folder fed by economic ground truth (DIEM/hour wins).
3. **Holders propose, genesis decides.** Holder-weighted suggestions can influence the mutable working copy, but they cannot amend the genesis. The amendment path at the population level is death-and-redeploy.

## File layout

The §5 bundle ships these files into every per-agent repo:

```
identity/
  README.md              # operator explainer
  SCHEMA.md              # this directory's manual of style
  SOUL.genesis.md        # deploy-time, hard-locked
  SOUL.md                # mutable working copy of SOUL.genesis
  STYLE.genesis.md       # deploy-time, hard-locked
  STYLE.md               # mutable working copy of STYLE.genesis
  influences.md          # lineage record, hard-locked at deploy
  examples/
    good-outputs.md      # deployer-seeded positive corpus
    bad-outputs.md       # deployer-seeded anti-pattern corpus
    promoted/
      .gitkeep           # placeholder; lifecycle-engine writes here
scripts/
  lint-identity.ts       # CI hook; reads SCHEMA + SOUL + STYLE
```

In this template repo the genesis and mutable files ship with `.template` suffixes; the deploy CLI substitutes deployer answers and drops the suffixes when forking the per-agent repo. See [[CLAUDE]] for the substitution flow and Linear MOG-425 for the CLI soul phase.

## Mutation surface (allowlist)

The agent can write only to two paths:

1. `identity/SOUL.md` and `identity/STYLE.md` — the mutable working copies.
2. `memory/**` and `wiki/**` — the agent's working notebook.

Every other path — `harness/`, `scripts/`, `identity/SCHEMA.md`, `identity/SOUL.genesis.md`, `identity/STYLE.genesis.md`, `identity/influences.md`, `package.json`, the README — is off-limits to the agent's self-modification path. Enforced by `harness/safety/allowlist.ts` (Linear MOG-448) and again by the pre-commit lint hook.

## Drift threshold

Every `*.genesis.md` carries `drift_threshold` in its frontmatter (default 0.70). On every commit, [[scripts/lint-identity]] computes a similarity score between the mutable working copy and its genesis and exits non-zero if either pair scores below threshold.

The initial similarity function is token-set Jaccard (see Linear MOG-421). The eventual implementation is embedding cosine learned from the calibration corpus (Linear MOG-430). The contract — input shape, exit codes, threshold semantics — does not change between implementations; only the score function does. Lint test fixtures (Linear MOG-435) pin the Jaccard contract before any scorer swap.

## Auto-promote pipeline

`identity/examples/promoted/` is initialized empty (just a `.gitkeep`) and is **the only directory inside `identity/` the agent itself cannot write to**. Promoted examples flow from outside the agent — the platform's lifecycle-engine watches DIEM/hour wins and promotes the tick output that produced each win. Economic ground truth flows in; it does not flow out from the agent's self-perception.

This is a deliberate inversion of the agent's normal mutation path: the calibration corpus must reflect what the market rewarded, not what the agent thinks looks good.

## Open per-agent questions (deploy-time)

These ship to the deployer at deploy time via the CLI soul phase (Linear MOG-425):

- Drift threshold value — accept default 0.70 or override.
- Six SOUL fields — who the agent is, what it believes, what it cares about, what it will not do, what makes it particular, how it handles disagreement.
- STYLE register — voice, format constraints, anti-patterns.
- Influences — parent agent (if forking) plus seed sources for the calibration corpus.

The CLI's confirmation screen forces a typed-out "yes lock genesis" rather than y/N — speed bumps where founders are forced to read what they are committing to.

## Out of scope for §5

- Any harness behavior (covered by Linear MOG-424 and its sub-tickets MOG-437..451).
- Memory/wiki content shape beyond what [[identity/SCHEMA]] specifies.
- §6 (compute marketplace), §7 (lifecycle economics), §8 (security), §9 (Dune queries).
- The deploy CLI itself (Linear MOG-425).

## Source

Working session 2026-04-30 with Claude on `Liquid-Protocol-Ops/deploy-autonomous`. Locked decisions enumerated in [[CLAUDE#decisions-explicitly-confirmed-by-the-user]]; v2 funding-loop conclusions in [[ARCHITECTURE_v2]]; full ticket-level decision history in Linear MOG-405..433 and the Drive session summary linked from the epic.
