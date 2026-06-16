---
page_type: authored
genesis_lock: true
created: 2026-04-30T00:00:00Z
updated: 2026-04-30T00:00:00Z
tags: [identity, schema, spec]
---

# SCHEMA — manual of style for every markdown page

This document defines the shape of every `.md` file in the agent's repo. **`genesis_lock: true`** — this file does not change for the lifetime of the agent once deployed. The drift lint ([[scripts/lint-identity]]) enforces conformance on every commit.

The schema is small on purpose. Three page types, one frontmatter shape, one quote cap, one link form, one controlled tag list. If a constraint requires more than a sentence to explain, it does not belong here.

## Frontmatter

Every page begins with YAML frontmatter delimited by `---`. Required keys:

- **`page_type`** — one of `ingested | authored | derived`. See [[#page-types]].
- **`genesis_lock`** — `true | false`. `true` means "this file is immutable for the agent's lifetime"; the lint flags any commit that mutates a genesis-locked file.
- **`created`** — ISO-8601 UTC timestamp of first write.
- **`updated`** — ISO-8601 UTC timestamp of last write. For `genesis_lock: true` pages, equals `created`.
- **`tags`** — non-empty list, drawn only from the controlled vocabulary in [[#controlled-tags]].

Conditionally required:

- **`sources`** — list of `{ url, cite }` objects. **Required iff** `page_type: ingested`. `cite` is the human-readable citation (e.g., `"Author. Year. Title."`).
- **`drift_threshold`** — number in `[0, 1]`. **Required iff** the file is `*.genesis.md`. Default 0.70. The mutable working copy must score ≥ `drift_threshold` against the genesis on every commit.

Unknown frontmatter keys are a lint error. If a new key is needed, this schema must be amended at the population level via death-and-redeploy — see [[ARCHITECTURE_v2]] §3 for why genesis is hard-locked.

## Page types

- **`ingested`** — copied from an external source. Requires `sources`. Long-form excerpts must be summarized in the agent's voice; raw quotes are bounded by the 25-word cap (see [[#quote-cap]]). The page exists to bring outside knowledge into the wiki without polluting the agent's voice.
- **`authored`** — original prose by the deployer (for genesis files) or the agent (for mutable working copies). No `sources` required, though linking to inputs is encouraged.
- **`derived`** — computed by the agent from other pages or tick results (e.g., a memory page summarizing a span of activity). Must reference its inputs via internal links so the lineage is auditable.

## Internal links

Use `[[path/to/page]]` form. The path is repo-root-relative, no `.md` extension. Examples:

- `[[identity/SCHEMA]]` resolves to `identity/SCHEMA.md`.
- `[[ARCHITECTURE_v2]]` resolves to `ARCHITECTURE_v2.md`.

Every `[[...]]` link must resolve to an existing file in the repo. Broken links are a lint error. Section anchors are written as `[[page#section-slug]]` and the slug must exist as a heading in the target page.

## Quote cap

Any markdown blockquote (`>`) line, joined into one block, must contain ≤ 25 words. Longer quotes are a lint error. Paraphrase, summarize, or split across multiple bounded quotes with attribution. The cap exists so `ingested` pages can't smuggle large blocks of foreign voice into the agent's wiki.

## Controlled tags

The full vocabulary for v1. Adding a tag requires amending this schema (death-and-redeploy):

- **`identity`** — anything inside `identity/`.
- **`schema`** — this file and any future style-guide pages.
- **`soul`** — SOUL-related (genesis or working copy).
- **`style`** — STYLE-related.
- **`influence`** — lineage and influences pages.
- **`calibration`** — examples corpus (good / bad / promoted).
- **`spec`** — specification documents (e.g., [[SECTION_5]], [[ARCHITECTURE_v2]]).
- **`decision`** — decision records.
- **`memory`** — reserved for the agent's mutable memory pages.
- **`observation`** — reserved for `derived` pages computed from ticks.

Tags are lowercase. A page may carry multiple tags; the union is what governs categorization, not any single tag's primacy.

## What this schema does not specify

- Heading depth or section structure beyond what individual page types want.
- File naming beyond the `.genesis.md` convention for locked-pair files.
- Markdown flavor beyond CommonMark + GFM tables. No HTML embeds; no math; no diagrams (yet).

The lint contract is the source of truth — see [[scripts/lint-identity]] for what is mechanically enforced versus what is style guidance.
