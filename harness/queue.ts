// Per-tick task budget queue.
//
// Budget is denominated in USD, which is numerically equal to DIEM since
// 1 sDIEM staked = $1/day Venice compute (ARCHITECTURE_v2.md §4).
//
// The queue is greedy best-effort: tasks are tried in FIFO order and scheduled
// if they fit within the remaining budget. Tasks that don't fit are forfeited for
// this tick but remain in the queue so they can be retried next tick.

// ── Types ─────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  costUsd: number;
  run: () => Promise<void>;
}

export interface DequeueResult {
  scheduled: Task[];
  forfeited: Task[];
  budgetUsed: number;
  budgetRemaining: number;
}

export type Logger = (message: string) => void;

// ── Budget ────────────────────────────────────────────────────────────

// Returns the per-tick USD budget given the current staked DIEM balance (in wei)
// and the number of ticks expected per day. Defaults to 24 (one tick per hour).
export function calcTickBudget(stakedDiemWei: bigint, ticksPerDay = 24): number {
  if (ticksPerDay <= 0) throw new RangeError('ticksPerDay must be > 0');
  const stakedDiem = Number(stakedDiemWei) / 1e18;
  // 1 DIEM staked = $1/day; divide evenly across ticks
  return stakedDiem / ticksPerDay;
}

// ── Queue ─────────────────────────────────────────────────────────────

export class TaskQueue {
  private tasks: Task[];
  private readonly log: Logger;

  constructor(logger: Logger = () => {}) {
    this.tasks = [];
    this.log = logger;
  }

  enqueue(task: Task): void {
    this.tasks.push(task);
  }

  // Dequeues tasks greedily in FIFO order up to budgetUsd.
  // Forfeited tasks remain in the queue for the next tick.
  dequeue(budgetUsd: number): DequeueResult {
    const scheduled: Task[] = [];
    const forfeited: Task[] = [];
    let budgetUsed = 0;

    for (const task of this.tasks) {
      if (budgetUsed + task.costUsd <= budgetUsd) {
        scheduled.push(task);
        budgetUsed += task.costUsd;
      } else {
        forfeited.push(task);
      }
    }

    if (forfeited.length > 0) {
      const forfeitedUsd = forfeited.reduce((s, t) => s + t.costUsd, 0);
      const ids = forfeited.map(t => t.id).join(', ');
      this.log(
        `queue: forfeited ${forfeited.length} task(s) [${ids}] ($${forfeitedUsd.toFixed(6)} USD) ` +
          `— budget exhausted at $${budgetUsed.toFixed(6)}/$${budgetUsd.toFixed(6)}`,
      );
    }

    this.tasks = forfeited;
    return { scheduled, forfeited, budgetUsed, budgetRemaining: budgetUsd - budgetUsed };
  }

  get size(): number {
    return this.tasks.length;
  }
}
