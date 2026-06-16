import { describe, expect, it } from 'vitest';
import {
  assessLiveness,
  decideAction,
  type CronState,
  type Assessment,
} from '../watchdog.js';

const H = 3_600_000;
const NOW = Date.parse('2026-06-09T20:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function state(entries: Record<string, string | undefined>): CronState {
  return Object.fromEntries(
    Object.entries(entries).map(([job, last_success]) => [job, last_success ? { last_success } : {}]),
  );
}

describe('assessLiveness', () => {
  it('healthy when the newest watched success is within threshold', () => {
    const s = state({ tick: iso(1 * H) });
    expect(assessLiveness(s, ['tick'], 3 * H, NOW).status).toBe('healthy');
  });

  it('stale when the newest watched success exceeds threshold', () => {
    const s = state({ tick: iso(4 * H) });
    const a = assessLiveness(s, ['tick'], 3 * H, NOW);
    expect(a.status).toBe('stale');
    expect(a.newestSuccessMs).toBe(NOW - 4 * H);
  });

  it('exactly-at-threshold reads healthy (strictly-older alarms)', () => {
    const s = state({ tick: iso(3 * H) });
    expect(assessLiveness(s, ['tick'], 3 * H, NOW).status).toBe('healthy');
  });

  it('newest success across multiple watched jobs wins', () => {
    const s = state({ tick: iso(5 * H), 'lp-monitor': iso(1 * H) });
    const a = assessLiveness(s, ['tick', 'lp-monitor'], 3 * H, NOW);
    expect(a.status).toBe('healthy');
    expect(a.newestSuccessMs).toBe(NOW - 1 * H);
  });

  it('no-data on missing state file, absent jobs, or unparseable timestamps', () => {
    expect(assessLiveness(null, ['tick'], 3 * H, NOW).status).toBe('no-data');
    expect(assessLiveness(state({ other: iso(1 * H) }), ['tick'], 3 * H, NOW).status).toBe('no-data');
    expect(assessLiveness(state({ tick: undefined }), ['tick'], 3 * H, NOW).status).toBe('no-data');
    expect(
      assessLiveness({ tick: { last_success: 'not-a-date' } }, ['tick'], 3 * H, NOW).status,
    ).toBe('no-data');
  });

  it('ignores a missing job when another watched job has data', () => {
    const s = state({ tick: iso(1 * H) });
    const a = assessLiveness(s, ['tick', 'ghost-job'], 3 * H, NOW);
    expect(a.status).toBe('healthy');
    expect(a.perJob).toEqual([
      { job: 'tick', lastSuccessMs: NOW - 1 * H },
      { job: 'ghost-job', lastSuccessMs: null },
    ]);
  });
});

describe('decideAction (the one-alert-per-stall latch)', () => {
  const staleAt = (ms: number): Assessment => ({ status: 'stale', newestSuccessMs: ms, perJob: [] });
  const healthy: Assessment = { status: 'healthy', newestSuccessMs: NOW, perJob: [] };
  const noData: Assessment = { status: 'no-data', newestSuccessMs: null, perJob: [] };

  it('alerts on a fresh stall', () => {
    expect(decideAction(staleAt(NOW - 4 * H), { alertedForMs: null })).toBe('alert');
  });

  it('stays silent while the SAME stall persists', () => {
    expect(decideAction(staleAt(NOW - 4 * H), { alertedForMs: NOW - 4 * H })).toBe('already-alerted');
  });

  it('re-alerts on a NEW stall (agent recovered briefly, then stalled again)', () => {
    // newest success moved forward, then went stale again — different stall key.
    expect(decideAction(staleAt(NOW - 4 * H), { alertedForMs: NOW - 10 * H })).toBe('alert');
  });

  it('emits one recovery when healthy clears an open latch', () => {
    expect(decideAction(healthy, { alertedForMs: NOW - 10 * H })).toBe('recovered');
    expect(decideAction(healthy, { alertedForMs: null })).toBe('none');
  });

  it('stays quiet on no-data even with an open latch (state file vanished ≠ recovery)', () => {
    expect(decideAction(noData, { alertedForMs: NOW - 10 * H })).toBe('none');
  });
});
