import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLatestLpPosition } from '../liquidity.js';

// LP_POSITIONS_PATH is read on every call via the lpPositionsPath()
// helper, so per-test env overrides take effect without juggling module
// caches.

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lp-positions-'));
  logPath = join(dir, 'lp-positions.jsonl');
  process.env['LP_POSITIONS_PATH'] = logPath;
});

afterEach(() => {
  rmSync(dir, { recursive: true });
  delete process.env['LP_POSITIONS_PATH'];
});

describe('loadLatestLpPosition', () => {
  it('returns null when the log file does not exist', () => {
    expect(loadLatestLpPosition()).toBeNull();
  });

  it('returns null when the log is empty', () => {
    writeFileSync(logPath, '', 'utf8');
    expect(loadLatestLpPosition()).toBeNull();
  });

  it('returns the last appended position', () => {
    const earlier = {
      tokenId: '111',
      liquidity: '1000000000000000000',
      tickLower: -400,
      tickUpper: -200,
      amount1Wei: '500000000000000000',
      mintTxHash: '0xaaaa',
      mintedAt: '2026-05-15T00:00:00.000Z',
    };
    const latest = {
      tokenId: '222',
      liquidity: '2000000000000000000',
      tickLower: -500,
      tickUpper: -300,
      amount1Wei: '1000000000000000000',
      mintTxHash: '0xbbbb',
      mintedAt: '2026-05-15T01:00:00.000Z',
    };
    writeFileSync(
      logPath,
      JSON.stringify(earlier) + '\n' + JSON.stringify(latest) + '\n',
      'utf8',
    );
    const got = loadLatestLpPosition();
    expect(got?.tokenId).toBe('222');
    expect(got?.tickLower).toBe(-500);
    expect(got?.tickUpper).toBe(-300);
  });

  it('returns null when the final line is corrupt', () => {
    // Captures current behavior: if the tail line is unparseable,
    // returns null rather than fall back to the previous valid line.
    // If we want fall-back semantics later, this test will flag it.
    writeFileSync(
      logPath,
      JSON.stringify({
        tokenId: '999',
        liquidity: '0',
        tickLower: 0,
        tickUpper: 0,
        amount1Wei: '0',
        mintTxHash: '0xcccc',
        mintedAt: '2026-05-15T02:00:00.000Z',
      }) + '\nnot-json\n',
      'utf8',
    );
    expect(loadLatestLpPosition()).toBeNull();
  });

  it('ignores blank trailing lines', () => {
    const position = {
      tokenId: '777',
      liquidity: '500',
      tickLower: -100,
      tickUpper: -50,
      amount1Wei: '0',
      mintTxHash: '0xdddd',
      mintedAt: '2026-05-15T03:00:00.000Z',
    };
    writeFileSync(logPath, JSON.stringify(position) + '\n\n\n', 'utf8');
    expect(loadLatestLpPosition()?.tokenId).toBe('777');
  });
});
