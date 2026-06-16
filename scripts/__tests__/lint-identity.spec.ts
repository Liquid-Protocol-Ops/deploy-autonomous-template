import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Spawn the lint script as a child process with LINT_REPO_ROOT pointing at a
// fixture directory. Assert exit code AND specific diagnostic-rule names so
// future scorer swaps (Jaccard → embedding cosine) can't silently
// change error messages.

const HERE = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT = resolve(HERE, '..', 'lint-identity.ts');
const FIXTURES_DIR = resolve(HERE, '__fixtures__');

type LintResult = { exitCode: number; stderr: string };

function runLint(fixture: string): LintResult {
  const result = spawnSync(
    'node',
    ['--import', 'tsx', LINT_SCRIPT],
    {
      env: { ...process.env, LINT_REPO_ROOT: resolve(FIXTURES_DIR, fixture) },
      encoding: 'utf8',
    },
  );
  return { exitCode: result.status ?? -1, stderr: result.stderr };
}

describe('lint-identity drift contract', () => {
  it('passes when SOUL similarity is well above threshold (identity-095)', () => {
    const r = runLint('identity-095');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/drift: SOUL similarity 0\.\d+ >= 0\.7 OK/);
    expect(r.stderr).toMatch(/drift: STYLE similarity 0\.\d+ >= 0\.7 OK/);
  });

  it('passes when SOUL similarity is at the edge but above threshold (identity-071)', () => {
    const r = runLint('identity-071');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/drift: SOUL similarity 0\.\d+ >= 0\.7 OK/);
  });

  it('fails when SOUL similarity is below threshold (identity-040)', () => {
    const r = runLint('identity-040');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('[drift.threshold]');
    expect(r.stderr).toMatch(/SOUL similarity 0\.\d+ < threshold 0\.7/);
  });
});

describe('lint-identity SCHEMA contract', () => {
  it('fails when frontmatter is missing a required key (schema-bad-frontmatter)', () => {
    const r = runLint('schema-bad-frontmatter');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('[frontmatter.required]');
    expect(r.stderr).toContain('missing required key: tags');
  });

  it('fails when a blockquote exceeds the 25-word cap (schema-bad-content)', () => {
    const r = runLint('schema-bad-content');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('[body.quote_cap]');
    expect(r.stderr).toMatch(/blockquote has \d+ words \(>25\)/);
  });
});

describe('lint-identity exit code contract', () => {
  it('exits 0 on full pass with no diagnostics', () => {
    const r = runLint('identity-095');
    expect(r.exitCode).toBe(0);
  });

  it('exits 1 on any diagnostic', () => {
    const r = runLint('schema-bad-frontmatter');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/lint-identity: \d+ diagnostic\(s\)/);
  });
});
