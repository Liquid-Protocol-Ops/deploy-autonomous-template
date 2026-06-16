-- ============================================================
-- AGENT PROFITABILITY — fee revenue in time slices
-- ============================================================
-- This is the agent's OWN query. It is version-controlled here and the
-- profitability-signal skill can push it to Dune (`analyze-profitability.ts
-- --write-query`). As the agent learns, it refines THIS file — that is the
-- "write a better query" half of the profitability loop.
--
-- Measures the agent's realized fee income, per day, over a rolling window:
-- one row per day → "profitability in slices of time". The skill parses these
-- rows into a structured signal in memory/profitability-signal.jsonl, which
-- goal-review then reads to adjust strategy.
--
-- Placeholders are substituted by buildProfitabilityQuerySql() before the query
-- is written to Dune:
--   {{agent_wallet}} — the agent's wallet (the fee claimer), lowercase 0x…
--   {{window_days}}  — lookback window in days (integer)
--
-- Fee Locker:  0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF
-- claim() sig: 0x21c0b342  (claim(address,address))
-- DIEM-paired agents accrue DIEM fees; this starter tracks WETH-denominated
-- claims (the proven path) — graduate it to your DIEM pool as you learn.
-- ============================================================

WITH fee_claims AS (
  SELECT
    t.hash       AS tx_hash,
    t.block_time AS block_time,
    t."from"     AS claimer
  FROM base.transactions t
  WHERE t."to" = 0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF
    AND SUBSTR(t.data, 1, 4) = 0x21c0b342           -- claim(address,address)
    AND t."from" = {{agent_wallet}}                  -- THIS agent only
    AND t.success = true
    AND t.block_time >= NOW() - INTERVAL '{{window_days}}' DAY
),

claim_amounts AS (
  SELECT
    fc.tx_hash,
    fc.block_time,
    SUM(tr.value / 1e18) AS fee_token
  FROM fee_claims fc
  INNER JOIN erc20_base.evt_Transfer tr
    ON tr.evt_tx_hash = fc.tx_hash
    AND tr.contract_address = 0x4200000000000000000000000000000000000006  -- WETH
    AND tr."to" = CAST(fc.claimer AS VARBINARY)
  GROUP BY fc.tx_hash, fc.block_time
)

-- One row per day: the time slice the skill aggregates into a signal.
SELECT
  DATE_TRUNC('day', ca.block_time)                    AS day,
  COUNT(*)                                            AS claim_count,
  SUM(ca.fee_token)                                   AS fee_token,
  SUM(ca.fee_token) * p.price                         AS fee_usd,
  SUM(SUM(ca.fee_token)) OVER (ORDER BY DATE_TRUNC('day', ca.block_time)) AS cumulative_fee_token
FROM claim_amounts ca
CROSS JOIN (
  SELECT price FROM prices.usd_latest
  WHERE blockchain = 'base'
    AND contract_address = 0x4200000000000000000000000000000000000006
) p
GROUP BY DATE_TRUNC('day', ca.block_time), p.price
ORDER BY day DESC
