# Contributing

## Workflow

1. Fork or branch from `main`.
2. Make your changes; keep commits focused.
3. Run `npm run typecheck && npm test` locally before pushing.
4. Open a pull request against `main` — the PR template will guide you.

## Commit style

Use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.

## Code standards

- TypeScript strict mode — no `any` without a comment explaining why.
- All new harness behaviour must have a corresponding vitest test.
- Run `npm run lint:identity` to validate agent identity files before pushing.
