import { describe, it, expect, vi } from 'vitest';
import {
  stageFile,
  stageFiles,
  commitStaged,
  stageAndCommit,
  type GitRunner,
} from '../git-ops.js';
import { AllowlistViolation } from '../safety/allowlist.js';

// ── Helpers ──────────────────────────────────────────────────────────

function okRunner(): GitRunner {
  return vi.fn().mockReturnValue({ exitCode: 0, stdout: '', stderr: '' });
}

function failRunner(stderr = 'git error'): GitRunner {
  return vi.fn().mockReturnValue({ exitCode: 1, stdout: '', stderr });
}

// ── stageFile ────────────────────────────────────────────────────────

describe('stageFile', () => {
  it('calls git add for an allowed memory path', () => {
    const run = okRunner();
    stageFile('memory/notes.md', run);
    expect(run).toHaveBeenCalledWith(['add', '--', 'memory/notes.md']);
  });

  it('calls git add for an allowed wiki path', () => {
    const run = okRunner();
    stageFile('wiki/research.md', run);
    expect(run).toHaveBeenCalledWith(['add', '--', 'wiki/research.md']);
  });

  it('calls git add for identity/SOUL.md', () => {
    const run = okRunner();
    stageFile('identity/SOUL.md', run);
    expect(run).toHaveBeenCalledWith(['add', '--', 'identity/SOUL.md']);
  });

  it('rejects harness paths without invoking git', () => {
    const run = okRunner();
    expect(() => stageFile('harness/tick.ts', run)).toThrow(AllowlistViolation);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects package.json without invoking git', () => {
    const run = okRunner();
    expect(() => stageFile('package.json', run)).toThrow(AllowlistViolation);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects traversal paths without invoking git', () => {
    const run = okRunner();
    expect(() => stageFile('memory/../harness/tick.ts', run)).toThrow(AllowlistViolation);
    expect(run).not.toHaveBeenCalled();
  });

  it('throws a descriptive error on non-zero git exit code', () => {
    const run = failRunner('not a git repository');
    expect(() => stageFile('memory/notes.md', run)).toThrow('git add failed');
    expect(() => stageFile('memory/notes.md', run)).toThrow('memory/notes.md');
  });
});

// ── stageFiles ───────────────────────────────────────────────────────

describe('stageFiles', () => {
  it('stages each path in order', () => {
    const run = okRunner();
    stageFiles(['memory/a.md', 'wiki/b.md'], run);
    expect(run).toHaveBeenNthCalledWith(1, ['add', '--', 'memory/a.md']);
    expect(run).toHaveBeenNthCalledWith(2, ['add', '--', 'wiki/b.md']);
  });

  it('aborts at the first disallowed path', () => {
    const run = okRunner();
    expect(() =>
      stageFiles(['memory/ok.md', 'harness/tick.ts', 'wiki/also-ok.md'], run),
    ).toThrow(AllowlistViolation);
    expect(run).toHaveBeenCalledTimes(1); // only the first path was staged
  });
});

// ── commitStaged ─────────────────────────────────────────────────────

describe('commitStaged', () => {
  it('calls git commit with the provided message', () => {
    const run = okRunner();
    commitStaged('feat: update soul', run);
    expect(run).toHaveBeenCalledWith(['commit', '-m', 'feat: update soul']);
  });

  it('throws when message is empty', () => {
    const run = okRunner();
    expect(() => commitStaged('', run)).toThrow('commit message must not be empty');
    expect(run).not.toHaveBeenCalled();
  });

  it('throws when message is whitespace-only', () => {
    const run = okRunner();
    expect(() => commitStaged('   ', run)).toThrow('commit message must not be empty');
    expect(run).not.toHaveBeenCalled();
  });

  it('throws a descriptive error on non-zero git exit code', () => {
    const run = failRunner('nothing to commit');
    expect(() => commitStaged('feat: update soul', run)).toThrow('git commit failed');
  });
});

// ── stageAndCommit ───────────────────────────────────────────────────

describe('stageAndCommit', () => {
  it('stages all paths then commits', () => {
    const run = okRunner();
    stageAndCommit(['memory/notes.md', 'wiki/log.md'], 'chore: agent update', run);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenNthCalledWith(1, ['add', '--', 'memory/notes.md']);
    expect(run).toHaveBeenNthCalledWith(2, ['add', '--', 'wiki/log.md']);
    expect(run).toHaveBeenNthCalledWith(3, ['commit', '-m', 'chore: agent update']);
  });

  it('does not commit when a path is rejected', () => {
    const run = okRunner();
    expect(() =>
      stageAndCommit(['harness/tick.ts'], 'should not commit', run),
    ).toThrow(AllowlistViolation);
    const commitCall = (run as ReturnType<typeof vi.fn>).mock.calls.find(
      c => c[0][0] === 'commit',
    );
    expect(commitCall).toBeUndefined();
  });
});
