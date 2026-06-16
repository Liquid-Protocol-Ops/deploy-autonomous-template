import { describe, it, expect, vi } from 'vitest';
import { calcTickBudget, TaskQueue, type Task } from '../queue.js';

// ── calcTickBudget ────────────────────────────────────────────────────

describe('calcTickBudget', () => {
  it('returns $1/day ÷ 24 for 1 staked DIEM at default tick rate', () => {
    const budget = calcTickBudget(1n * 10n ** 18n);
    expect(budget).toBeCloseTo(1 / 24, 10);
  });

  it('scales linearly with staked amount', () => {
    const b10 = calcTickBudget(10n * 10n ** 18n);
    const b1 = calcTickBudget(1n * 10n ** 18n);
    expect(b10).toBeCloseTo(b1 * 10, 10);
  });

  it('divides by ticksPerDay correctly', () => {
    const budget = calcTickBudget(24n * 10n ** 18n, 24);
    expect(budget).toBeCloseTo(1.0, 10); // $24/day ÷ 24 = $1/tick
  });

  it('supports a custom ticksPerDay', () => {
    const budget = calcTickBudget(1n * 10n ** 18n, 1);
    expect(budget).toBeCloseTo(1.0, 10); // 1 tick/day → full daily budget
  });

  it('returns 0 for zero staked DIEM', () => {
    expect(calcTickBudget(0n)).toBe(0);
  });

  it('throws for non-positive ticksPerDay', () => {
    expect(() => calcTickBudget(1n * 10n ** 18n, 0)).toThrow(RangeError);
    expect(() => calcTickBudget(1n * 10n ** 18n, -1)).toThrow(RangeError);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeTask(id: string, costUsd: number): Task {
  return { id, costUsd, run: vi.fn().mockResolvedValue(undefined) };
}

// ── TaskQueue — empty queue ───────────────────────────────────────────

describe('TaskQueue — empty queue', () => {
  it('dequeue returns empty scheduled and forfeited', () => {
    const q = new TaskQueue();
    const result = q.dequeue(1.0);
    expect(result.scheduled).toHaveLength(0);
    expect(result.forfeited).toHaveLength(0);
    expect(result.budgetUsed).toBe(0);
    expect(result.budgetRemaining).toBe(1.0);
  });

  it('size is 0 on a fresh queue', () => {
    expect(new TaskQueue().size).toBe(0);
  });
});

// ── TaskQueue — full queue (all fit) ─────────────────────────────────

describe('TaskQueue — full queue, all tasks within budget', () => {
  it('schedules all tasks and empties the queue', () => {
    const q = new TaskQueue();
    const t1 = makeTask('t1', 0.01);
    const t2 = makeTask('t2', 0.02);
    q.enqueue(t1);
    q.enqueue(t2);

    const result = q.dequeue(1.0);

    expect(result.scheduled).toEqual([t1, t2]);
    expect(result.forfeited).toHaveLength(0);
    expect(result.budgetUsed).toBeCloseTo(0.03);
    expect(result.budgetRemaining).toBeCloseTo(0.97);
    expect(q.size).toBe(0);
  });

  it('preserves FIFO order in scheduled', () => {
    const q = new TaskQueue();
    const tasks = ['a', 'b', 'c'].map(id => makeTask(id, 0.01));
    tasks.forEach(t => q.enqueue(t));

    const { scheduled } = q.dequeue(1.0);
    expect(scheduled.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });
});

// ── TaskQueue — over-budget task ──────────────────────────────────────

describe('TaskQueue — over-budget task', () => {
  it('forfeits a task that exceeds the remaining budget', () => {
    const q = new TaskQueue();
    const cheap = makeTask('cheap', 0.01);
    const expensive = makeTask('expensive', 10.0);
    q.enqueue(cheap);
    q.enqueue(expensive);

    const result = q.dequeue(0.05);

    expect(result.scheduled).toEqual([cheap]);
    expect(result.forfeited).toEqual([expensive]);
    expect(result.budgetUsed).toBeCloseTo(0.01);
  });

  it('forfeited task remains in the queue for the next tick', () => {
    const q = new TaskQueue();
    const expensive = makeTask('expensive', 10.0);
    q.enqueue(expensive);

    q.dequeue(0.05); // too small — forfeited

    expect(q.size).toBe(1);
  });

  it('schedules cheap tasks after an over-budget one (greedy best-effort)', () => {
    const q = new TaskQueue();
    q.enqueue(makeTask('expensive', 5.0));
    const cheap1 = makeTask('cheap1', 0.01);
    const cheap2 = makeTask('cheap2', 0.01);
    q.enqueue(cheap1);
    q.enqueue(cheap2);

    const result = q.dequeue(0.05);

    expect(result.scheduled.map(t => t.id)).toEqual(['cheap1', 'cheap2']);
    expect(result.forfeited.map(t => t.id)).toEqual(['expensive']);
  });

  it('logs a warning when tasks are forfeited', () => {
    const logs: string[] = [];
    const q = new TaskQueue(msg => logs.push(msg));
    q.enqueue(makeTask('big', 100.0));

    q.dequeue(0.01);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/forfeited/);
    expect(logs[0]).toMatch(/big/i);
  });

  it('does not log when no tasks are forfeited', () => {
    const logs: string[] = [];
    const q = new TaskQueue(msg => logs.push(msg));
    q.enqueue(makeTask('small', 0.001));
    q.dequeue(1.0);
    expect(logs).toHaveLength(0);
  });
});

// ── TaskQueue — 2-task integration ───────────────────────────────────

describe('TaskQueue — 2-task tick simulation', () => {
  it('runs both tasks when budget allows', async () => {
    const stakedDiemWei = 24n * 10n ** 18n; // 24 DIEM → $1/tick at 24 ticks/day
    const budget = calcTickBudget(stakedDiemWei, 24);

    const q = new TaskQueue();
    const run1 = vi.fn().mockResolvedValue(undefined);
    const run2 = vi.fn().mockResolvedValue(undefined);
    q.enqueue({ id: 'inference-1', costUsd: 0.10, run: run1 });
    q.enqueue({ id: 'inference-2', costUsd: 0.20, run: run2 });

    const { scheduled } = q.dequeue(budget); // budget ≈ $1
    await Promise.all(scheduled.map(t => t.run()));

    expect(run1).toHaveBeenCalledTimes(1);
    expect(run2).toHaveBeenCalledTimes(1);
    expect(q.size).toBe(0);
  });

  it('runs only the first task when combined cost exceeds budget', async () => {
    const budget = 0.15; // only enough for the first task

    const q = new TaskQueue();
    const run1 = vi.fn().mockResolvedValue(undefined);
    const run2 = vi.fn().mockResolvedValue(undefined);
    q.enqueue({ id: 'task-a', costUsd: 0.10, run: run1 });
    q.enqueue({ id: 'task-b', costUsd: 0.10, run: run2 });

    const { scheduled, forfeited } = q.dequeue(budget);
    await Promise.all(scheduled.map(t => t.run()));

    expect(run1).toHaveBeenCalledTimes(1);
    expect(run2).not.toHaveBeenCalled();
    expect(forfeited).toHaveLength(1);
    expect(q.size).toBe(1); // task-b stays for next tick
  });
});
