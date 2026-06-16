/**
 * scripts/analyze-profitability.ts
 *
 * The profitability-feedback loop (G8 / LQ-046). Executes the agent's Dune query
 * (a versioned, agent-owned query template), parses the rows into a structured
 * profitability signal sliced by time, and appends it to
 * memory/profitability-signal.jsonl. goal-review reads that signal to adjust
 * strategy — closing the loop: measure → signal → strategy → (the agent refines
 * the query + skill) → measure again.
 *
 * Honest by construction: it reports REALIZED fee income (≈ $0 today for most
 * agents). It never invents an APY or projects yield.
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/analyze-profitability.ts            # dry-run (default)
 *   node --env-file=.env --import tsx scripts/analyze-profitability.ts --live     # execute + write signal
 *   node --env-file=.env --import tsx scripts/analyze-profitability.ts --write-query  # push scripts/dune/profitability.sql to Dune
 *   ... --period=daily|weekly  --window=<days>  --force
 *
 * Env: DUNE_API_KEY (required for --live/--write-query),
 *      DUNE_PROFITABILITY_QUERY_ID (the saved Dune query to execute),
 *      AGENT_WALLET (the fee claimer, substituted into the query on --write-query).
 *
 * Cost cap: free-tier Dune execution only; one run per period (the period guard
 * skips a re-run inside the window unless --force).
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";

// ── Constants ────────────────────────────────────────────────────────
const DUNE_API = "https://api.dune.com/api/v1";
const SIGNAL_PATH = "memory/profitability-signal.jsonl";
const QUERY_SQL_PATH = "scripts/dune/profitability.sql";
const DAY_MS = 86_400_000;

export type Period = "daily" | "weekly";
export const PERIOD_MS: Record<Period, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};

export type Recommendation =
  | "hold"
  | "reposition"
  | "increase_liquidity"
  | "reduce_exposure"
  | "insufficient_data";

/** A raw Dune row — shape varies by query, so we read fields defensively. */
export type RawRow = Record<string, unknown>;

export interface ProfitabilitySignal {
  date: string; // YYYY-MM-DD (UTC)
  timestamp: string; // ISO-8601 UTC
  period: Period;
  windowDays: number;
  positions: { total: number; active: number; closed: number };
  feesUsd: number;
  ilUsd: number;
  netPnlUsd: number; // fees − IL
  feeAprPct: number | null; // null when the query doesn't expose it
  inRangePct: number | null;
  recommendation: Recommendation;
  rationale: string;
  source: { duneQueryId: number | null; rowCount: number; shape: RowShape };
}

// ── Pure helpers ─────────────────────────────────────────────────────

/** Coerce a Dune cell to a finite number, else null. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export type RowShape = "portfolio" | "timeslice" | "unknown";

/**
 * The starter query returns one row per day (timeslice). A richer per-position
 * query (e.g. the master-portfolio query) returns position rows with IL/range.
 * We support both so an operator can point DUNE_PROFITABILITY_QUERY_ID at either.
 */
export function detectShape(rows: RawRow[]): RowShape {
  const r = rows[0];
  if (!r) return "unknown";
  if ("fee_usd" in r && ("range_status" in r || "il_usd" in r || "net_pnl_usd" in r)) {
    return "portfolio";
  }
  if (("day" in r || "date" in r) && ("fee_usd" in r || "fee_token" in r || "daily_usd_claimed" in r)) {
    return "timeslice";
  }
  return "unknown";
}

interface Aggregate {
  feesUsd: number;
  ilUsd: number;
  netPnlUsd: number;
  feeAprPct: number | null;
  inRangePct: number | null;
  positions: { total: number; active: number; closed: number };
  rowCount: number;
  shape: RowShape;
}

export function aggregate(rows: RawRow[]): Aggregate {
  const shape = detectShape(rows);
  const base: Aggregate = {
    feesUsd: 0,
    ilUsd: 0,
    netPnlUsd: 0,
    feeAprPct: null,
    inRangePct: null,
    positions: { total: 0, active: 0, closed: 0 },
    rowCount: rows.length,
    shape,
  };

  if (shape === "portfolio") {
    const active = rows.filter((r) => r["is_active"] === true || str(r["status"]) === "Active");
    const feesUsd = rows.reduce((s, r) => s + (num(r["fee_usd"]) ?? 0), 0);
    const ilUsd = active.reduce((s, r) => s + (num(r["il_usd"]) ?? 0), 0);
    const netPnlUsd = rows.reduce(
      (s, r) => s + (num(r["net_pnl_usd"]) ?? 0),
      0,
    );
    const aprs = active.map((r) => num(r["fee_apr_pct"])).filter((n): n is number => n !== null);
    const inRange = active.filter((r) => str(r["range_status"]) === "in_range").length;
    return {
      ...base,
      feesUsd,
      ilUsd,
      netPnlUsd: netPnlUsd || feesUsd - ilUsd,
      feeAprPct: aprs.length ? aprs.reduce((a, b) => a + b, 0) / aprs.length : null,
      inRangePct: active.length ? (inRange / active.length) * 100 : null,
      positions: {
        total: rows.length,
        active: active.length,
        closed: rows.length - active.length,
      },
    };
  }

  if (shape === "timeslice") {
    const feesUsd = rows.reduce(
      (s, r) => s + (num(r["fee_usd"]) ?? num(r["daily_usd_claimed"]) ?? 0),
      0,
    );
    return { ...base, feesUsd, netPnlUsd: feesUsd };
  }

  return base;
}

/** Deterministic, explainable strategy recommendation from the aggregate. */
export function recommend(agg: Aggregate): { recommendation: Recommendation; rationale: string } {
  if (agg.shape === "unknown" || agg.rowCount === 0) {
    return { recommendation: "insufficient_data", rationale: "no rows returned by the query" };
  }
  if (agg.shape === "portfolio") {
    if (agg.inRangePct !== null && agg.inRangePct < 100) {
      return {
        recommendation: "reposition",
        rationale: `only ${agg.inRangePct.toFixed(0)}% of active positions are in range`,
      };
    }
    if (agg.netPnlUsd < 0) {
      return {
        recommendation: "reduce_exposure",
        rationale: `net PnL negative ($${agg.netPnlUsd.toFixed(2)}) — IL is outrunning fees`,
      };
    }
    if (agg.feeAprPct !== null && agg.feeAprPct >= 20) {
      return {
        recommendation: "increase_liquidity",
        rationale: `healthy fee APR (${agg.feeAprPct.toFixed(0)}%) and all positions in range`,
      };
    }
    return { recommendation: "hold", rationale: "positions in range; net PnL positive but modest" };
  }
  // timeslice
  if (agg.feesUsd <= 0) {
    return {
      recommendation: "insufficient_data",
      rationale: "no realized fee income yet — nothing to optimize against",
    };
  }
  return {
    recommendation: "hold",
    rationale: `realized $${agg.feesUsd.toFixed(2)} in fees over the window`,
  };
}

export function buildSignal(
  rows: RawRow[],
  opts: { period: Period; windowDays: number; queryId: number | null; now: Date },
): ProfitabilitySignal {
  const agg = aggregate(rows);
  const { recommendation, rationale } = recommend(agg);
  return {
    date: opts.now.toISOString().slice(0, 10),
    timestamp: opts.now.toISOString(),
    period: opts.period,
    windowDays: opts.windowDays,
    positions: agg.positions,
    feesUsd: round2(agg.feesUsd),
    ilUsd: round2(agg.ilUsd),
    netPnlUsd: round2(agg.netPnlUsd),
    feeAprPct: agg.feeAprPct === null ? null : round2(agg.feeAprPct),
    inRangePct: agg.inRangePct === null ? null : round2(agg.inRangePct),
    recommendation,
    rationale,
    source: { duneQueryId: opts.queryId, rowCount: agg.rowCount, shape: agg.shape },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function signalToLine(signal: ProfitabilitySignal): string {
  return JSON.stringify(signal);
}

/** Period guard: should we run, given the last signal? (cost cap) */
export function shouldRunNow(
  last: ProfitabilitySignal | null,
  period: Period,
  now: Date,
): boolean {
  if (!last) return true;
  const elapsed = now.getTime() - Date.parse(last.timestamp);
  return elapsed >= PERIOD_MS[period];
}

/** Substitute placeholders into the agent-owned query template. */
export function buildProfitabilityQuerySql(
  template: string,
  params: { agentWallet: string; windowDays: number },
): string {
  return template
    .replaceAll("{{agent_wallet}}", params.agentWallet.toLowerCase())
    .replaceAll("{{window_days}}", String(params.windowDays));
}

// ── Dune client (injectable for tests) ───────────────────────────────

export interface DuneClient {
  /** Execute a saved query and poll for rows. */
  execute(queryId: number): Promise<RawRow[]>;
  /** Overwrite a saved query's SQL — the "write a Dune query" path. */
  updateQuerySql(queryId: number, sql: string): Promise<void>;
}

export function makeDuneClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): DuneClient {
  const headers = { "X-Dune-API-Key": apiKey, "Content-Type": "application/json" };
  return {
    async execute(queryId) {
      const exec = await fetchImpl(`${DUNE_API}/query/${queryId}/execute`, {
        method: "POST",
        headers,
        body: JSON.stringify({ performance: "free" }),
      });
      if (!exec.ok) throw new Error(`Dune execute failed: ${exec.status}`);
      const { execution_id } = (await exec.json()) as { execution_id: string };
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await fetchImpl(`${DUNE_API}/execution/${execution_id}/results`, { headers });
        if (!res.ok) continue;
        const body = (await res.json()) as { state: string; result?: { rows: RawRow[] } };
        if (body.state === "QUERY_STATE_COMPLETED" && body.result) return body.result.rows;
        if (body.state === "QUERY_STATE_FAILED") throw new Error(`Dune query failed: ${JSON.stringify(body)}`);
      }
      throw new Error("Dune query timed out after 90s");
    },
    async updateQuerySql(queryId, sql) {
      const resp = await fetchImpl(`${DUNE_API}/query/${queryId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ query_sql: sql }),
      });
      if (!resp.ok) throw new Error(`Dune query update failed: ${resp.status} — ${await resp.text()}`);
    },
  };
}

// ── Signal I/O ───────────────────────────────────────────────────────

export function readLastSignal(path = SIGNAL_PATH): ProfitabilitySignal | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last) as ProfitabilitySignal;
  } catch {
    return null;
  }
}

export function appendSignal(signal: ProfitabilitySignal, path = SIGNAL_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, signalToLine(signal) + "\n");
}

// ── Orchestrator (injectable deps → fully testable, no network/fs) ───

export interface RunOpts {
  live: boolean;
  writeQuery: boolean;
  period: Period;
  windowDays: number;
  force: boolean;
  queryId: number | null;
  agentWallet: string | null;
  querySql: string; // contents of scripts/dune/profitability.sql
}

export interface RunDeps {
  client: DuneClient | null;
  now: Date;
  readLast: () => ProfitabilitySignal | null;
  append: (s: ProfitabilitySignal) => void;
  log: (msg: string) => void;
}

export interface RunResult {
  action:
    | "skipped-recent"
    | "wrote-query"
    | "dry-run"
    | "no-query"
    | "written";
  signal?: ProfitabilitySignal;
}

export async function run(opts: RunOpts, deps: RunDeps): Promise<RunResult> {
  const last = deps.readLast();

  if (!opts.force && !opts.writeQuery && !shouldRunNow(last, opts.period, deps.now)) {
    deps.log(`[profitability] skipped — last signal is within the ${opts.period} window (use --force to override)`);
    return { action: "skipped-recent" };
  }

  if (opts.writeQuery) {
    if (!deps.client || opts.queryId === null || !opts.agentWallet) {
      deps.log("[profitability] --write-query needs DUNE_API_KEY, DUNE_PROFITABILITY_QUERY_ID, and AGENT_WALLET");
      return { action: "no-query" };
    }
    const sql = buildProfitabilityQuerySql(opts.querySql, {
      agentWallet: opts.agentWallet,
      windowDays: opts.windowDays,
    });
    await deps.client.updateQuerySql(opts.queryId, sql);
    deps.log(`[profitability] pushed scripts/dune/profitability.sql → Dune query ${opts.queryId}`);
    return { action: "wrote-query" };
  }

  if (!opts.live) {
    deps.log(
      `[profitability] dry-run — would execute Dune query ${opts.queryId ?? "(unset)"} ` +
        `and append a ${opts.period} signal to ${SIGNAL_PATH}. Pass --live to execute.`,
    );
    return { action: "dry-run" };
  }

  if (!deps.client || opts.queryId === null) {
    deps.log("[profitability] --live needs DUNE_API_KEY and DUNE_PROFITABILITY_QUERY_ID");
    return { action: "no-query" };
  }

  const rows = await deps.client.execute(opts.queryId);
  const signal = buildSignal(rows, {
    period: opts.period,
    windowDays: opts.windowDays,
    queryId: opts.queryId,
    now: deps.now,
  });
  deps.append(signal);
  deps.log(
    `[profitability] ${signal.period} signal: fees $${signal.feesUsd} | net $${signal.netPnlUsd} | ` +
      `rec=${signal.recommendation} (${signal.rationale})`,
  );
  return { action: "written", signal };
}

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { live: boolean; writeQuery: boolean; period: Period; windowDays: number; force: boolean } {
  const has = (f: string) => argv.includes(f);
  const val = (f: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`${f}=`));
    return hit ? hit.slice(f.length + 1) : undefined;
  };
  const period = (val("--period") === "daily" ? "daily" : "weekly") as Period;
  const windowDays = Number(val("--window") ?? 30);
  return {
    live: has("--live"),
    writeQuery: has("--write-query"),
    period,
    windowDays: Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30,
    force: has("--force"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env["DUNE_API_KEY"] ?? null;
  const queryId = process.env["DUNE_PROFITABILITY_QUERY_ID"]
    ? Number(process.env["DUNE_PROFITABILITY_QUERY_ID"])
    : null;
  const agentWallet = process.env["AGENT_WALLET"] ?? null;
  const querySql = existsSync(QUERY_SQL_PATH) ? readFileSync(QUERY_SQL_PATH, "utf8") : "";

  const result = await run(
    {
      live: args.live,
      writeQuery: args.writeQuery,
      period: args.period,
      windowDays: args.windowDays,
      force: args.force,
      queryId: queryId !== null && Number.isFinite(queryId) ? queryId : null,
      agentWallet,
      querySql,
    },
    {
      client: apiKey ? makeDuneClient(apiKey) : null,
      now: new Date(),
      readLast: () => readLastSignal(),
      append: (s) => appendSignal(s),
      log: (m) => console.log(m),
    },
  );

  if (result.action === "no-query") process.exitCode = 1;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err: unknown) => {
    console.error("[analyze-profitability] fatal:", err);
    process.exit(1);
  });
}
