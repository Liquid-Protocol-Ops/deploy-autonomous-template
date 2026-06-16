import { describe, expect, it, vi } from "vitest";
import {
  aggregate,
  buildProfitabilityQuerySql,
  buildSignal,
  detectShape,
  num,
  recommend,
  run,
  shouldRunNow,
  signalToLine,
  type DuneClient,
  type ProfitabilitySignal,
  type RawRow,
  type RunDeps,
  type RunOpts,
} from "../analyze-profitability.js";

const NOW = new Date("2026-06-14T08:00:00Z");

// ── shape detection ──────────────────────────────────────────────────
describe("detectShape", () => {
  it("detects portfolio rows", () => {
    expect(detectShape([{ fee_usd: 1, range_status: "in_range" }])).toBe("portfolio");
  });
  it("detects timeslice rows", () => {
    expect(detectShape([{ day: "2026-06-13", fee_usd: 2 }])).toBe("timeslice");
  });
  it("unknown for empty / foreign", () => {
    expect(detectShape([])).toBe("unknown");
    expect(detectShape([{ foo: 1 }])).toBe("unknown");
  });
});

// ── num coercion ─────────────────────────────────────────────────────
describe("num", () => {
  it("coerces numbers and numeric strings, rejects junk", () => {
    expect(num(3.5)).toBe(3.5);
    expect(num("12.25")).toBe(12.25);
    expect(num("")).toBeNull();
    expect(num("abc")).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(NaN)).toBeNull();
  });
});

// ── aggregate ────────────────────────────────────────────────────────
describe("aggregate", () => {
  it("sums fee revenue over timeslice rows", () => {
    const rows: RawRow[] = [
      { day: "2026-06-13", fee_usd: 1.5 },
      { day: "2026-06-12", fee_usd: 2.0 },
      { day: "2026-06-11", fee_usd: 0 },
    ];
    const a = aggregate(rows);
    expect(a.shape).toBe("timeslice");
    expect(a.feesUsd).toBeCloseTo(3.5);
    expect(a.netPnlUsd).toBeCloseTo(3.5);
  });

  it("computes portfolio totals + in-range %", () => {
    const rows: RawRow[] = [
      { is_active: true, fee_usd: 10, il_usd: 4, net_pnl_usd: 6, fee_apr_pct: 30, range_status: "in_range" },
      { is_active: true, fee_usd: 5, il_usd: 2, net_pnl_usd: 3, fee_apr_pct: 10, range_status: "out_of_range" },
      { is_active: false, fee_usd: 1, il_usd: 0, net_pnl_usd: 1, fee_apr_pct: 0, range_status: "in_range" },
    ];
    const a = aggregate(rows);
    expect(a.shape).toBe("portfolio");
    expect(a.feesUsd).toBe(16);
    expect(a.ilUsd).toBe(6); // active only
    expect(a.netPnlUsd).toBe(10);
    expect(a.positions).toEqual({ total: 3, active: 2, closed: 1 });
    expect(a.inRangePct).toBe(50); // 1 of 2 active in range
    expect(a.feeAprPct).toBe(20); // (30 + 10) / 2
  });
});

// ── recommend ────────────────────────────────────────────────────────
describe("recommend", () => {
  it("insufficient_data on empty", () => {
    expect(recommend(aggregate([])).recommendation).toBe("insufficient_data");
  });
  it("no realized fees → insufficient_data (honest, nothing to optimize)", () => {
    expect(recommend(aggregate([{ day: "x", fee_usd: 0 }])).recommendation).toBe("insufficient_data");
  });
  it("reposition when a position is out of range", () => {
    const a = aggregate([{ is_active: true, fee_usd: 1, il_usd: 0, net_pnl_usd: 1, fee_apr_pct: 5, range_status: "out_of_range" }]);
    expect(recommend(a).recommendation).toBe("reposition");
  });
  it("reduce_exposure when net PnL is negative", () => {
    const a = aggregate([{ is_active: true, fee_usd: 1, il_usd: 9, net_pnl_usd: -8, fee_apr_pct: 5, range_status: "in_range" }]);
    expect(recommend(a).recommendation).toBe("reduce_exposure");
  });
  it("increase_liquidity on high APR fully in range", () => {
    const a = aggregate([{ is_active: true, fee_usd: 50, il_usd: 1, net_pnl_usd: 49, fee_apr_pct: 40, range_status: "in_range" }]);
    expect(recommend(a).recommendation).toBe("increase_liquidity");
  });
  it("hold on healthy timeslice fees", () => {
    expect(recommend(aggregate([{ day: "x", fee_usd: 12 }])).recommendation).toBe("hold");
  });
});

// ── buildSignal + serialization ──────────────────────────────────────
describe("buildSignal / signalToLine", () => {
  it("produces a complete, JSON-round-trippable signal", () => {
    const signal = buildSignal([{ day: "2026-06-13", fee_usd: 2.345 }], {
      period: "weekly",
      windowDays: 30,
      queryId: 123,
      now: NOW,
    });
    expect(signal.date).toBe("2026-06-14");
    expect(signal.period).toBe("weekly");
    expect(signal.feesUsd).toBe(2.35); // rounded
    expect(signal.feeAprPct).toBeNull(); // timeslice has no APR
    expect(signal.source).toEqual({ duneQueryId: 123, rowCount: 1, shape: "timeslice" });
    const parsed = JSON.parse(signalToLine(signal)) as ProfitabilitySignal;
    expect(parsed).toEqual(signal);
  });
});

// ── shouldRunNow (cost-cap period guard) ─────────────────────────────
describe("shouldRunNow", () => {
  const sig = (ts: string): ProfitabilitySignal =>
    ({ timestamp: ts } as ProfitabilitySignal);
  it("runs when there is no prior signal", () => {
    expect(shouldRunNow(null, "weekly", NOW)).toBe(true);
  });
  it("skips inside the weekly window", () => {
    expect(shouldRunNow(sig("2026-06-10T08:00:00Z"), "weekly", NOW)).toBe(false);
  });
  it("runs once the weekly window has elapsed", () => {
    expect(shouldRunNow(sig("2026-06-01T08:00:00Z"), "weekly", NOW)).toBe(true);
  });
  it("daily window is shorter", () => {
    expect(shouldRunNow(sig("2026-06-13T20:00:00Z"), "daily", NOW)).toBe(false);
    expect(shouldRunNow(sig("2026-06-12T20:00:00Z"), "daily", NOW)).toBe(true);
  });
});

// ── query template substitution (the "write a query" half) ───────────
describe("buildProfitabilityQuerySql", () => {
  it("substitutes wallet (lowercased) and window", () => {
    const sql = buildProfitabilityQuerySql(
      "WHERE claimer = {{agent_wallet}} AND t >= NOW() - INTERVAL '{{window_days}}' DAY",
      { agentWallet: "0xABCDef", windowDays: 14 },
    );
    expect(sql).toContain("0xabcdef");
    expect(sql).toContain("'14'");
    expect(sql).not.toContain("{{");
  });
});

// ── run() orchestrator (injected deps; no network / fs) ──────────────
function deps(overrides: Partial<RunDeps> = {}): RunDeps & { logs: string[]; appended: ProfitabilitySignal[] } {
  const logs: string[] = [];
  const appended: ProfitabilitySignal[] = [];
  return {
    client: null,
    now: NOW,
    readLast: () => null,
    append: (s) => appended.push(s),
    log: (m) => logs.push(m),
    logs,
    appended,
    ...overrides,
  };
}

const OPTS: RunOpts = {
  live: false,
  writeQuery: false,
  period: "weekly",
  windowDays: 30,
  force: false,
  queryId: 7591697,
  agentWallet: "0xabc",
  querySql: "WHERE claimer = {{agent_wallet}} window {{window_days}}",
};

describe("run", () => {
  it("dry-run does not call Dune or write a signal", async () => {
    const client: DuneClient = { execute: vi.fn(), updateQuerySql: vi.fn() };
    const d = deps({ client });
    const res = await run({ ...OPTS, live: false }, d);
    expect(res.action).toBe("dry-run");
    expect(client.execute).not.toHaveBeenCalled();
    expect(d.appended).toHaveLength(0);
  });

  it("live executes the query and appends a signal", async () => {
    const client: DuneClient = {
      execute: vi.fn(async () => [{ day: "2026-06-13", fee_usd: 4 }] as RawRow[]),
      updateQuerySql: vi.fn(),
    };
    const d = deps({ client });
    const res = await run({ ...OPTS, live: true }, d);
    expect(res.action).toBe("written");
    expect(client.execute).toHaveBeenCalledWith(7591697);
    expect(d.appended).toHaveLength(1);
    expect(d.appended[0]!.feesUsd).toBe(4);
  });

  it("write-query pushes substituted SQL to Dune", async () => {
    const updateQuerySql = vi.fn<(queryId: number, sql: string) => Promise<void>>(async () => {});
    const client: DuneClient = { execute: vi.fn(), updateQuerySql };
    const d = deps({ client });
    const res = await run({ ...OPTS, writeQuery: true }, d);
    expect(res.action).toBe("wrote-query");
    const sql = updateQuerySql.mock.calls[0]![1];
    expect(sql).toContain("0xabc");
    expect(sql).not.toContain("{{");
  });

  it("skips a re-run inside the period unless --force", async () => {
    const client: DuneClient = { execute: vi.fn(async () => []), updateQuerySql: vi.fn() };
    const recent = { timestamp: "2026-06-12T08:00:00Z" } as ProfitabilitySignal;
    const d = deps({ client, readLast: () => recent });
    expect((await run({ ...OPTS, live: true }, d)).action).toBe("skipped-recent");
    expect(client.execute).not.toHaveBeenCalled();
    // --force overrides
    const res = await run({ ...OPTS, live: true, force: true }, d);
    expect(res.action).toBe("written");
  });

  it("live without a query id reports no-query", async () => {
    const d = deps({ client: { execute: vi.fn(), updateQuerySql: vi.fn() } });
    const res = await run({ ...OPTS, live: true, queryId: null }, d);
    expect(res.action).toBe("no-query");
  });
});
