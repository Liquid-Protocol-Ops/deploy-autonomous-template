-- agent-fleet-overview.sql
--
-- Powers the compute-denominated agent harness dashboard.
--
-- Joins on-chain `TokenCreated` events from the Liquid factory against the
-- platform's off-chain agent registry (uploaded to Dune as a CSV/Sim source
-- named `agent_registry`) to surface, per agent:
--
--   - Liquid token address & symbol
--   - Live market cap in USD (using the most recent swap as a price proxy)
--   - Staked DIEM balance (provided by status-api in the registry feed)
--   - dailyComputeUsd = staked_diem * $1 (Venice's $1/day-per-staked-DIEM rule)
--   - Lifetime DIEM claimed by the fee-router (also from registry)
--
-- The two valuations side-by-side are the headline number for the dashboard:
-- agent tokens with similar market caps but very different `daily_compute_usd`
-- are economically very different things.
--
-- TODO once status-api is live: replace the `agent_registry` join with a
-- query against the platform's REST endpoint via dune.fetch (see Sims docs).

WITH liquid_tokens AS (
  SELECT
    evt_block_time           AS deployed_at,
    "tokenAddress"           AS token_address,
    "tokenSymbol"            AS token_symbol,
    "tokenName"              AS token_name,
    "pairedToken"            AS paired_token,
    "poolId"                 AS pool_id,
    "msgSender"              AS deployer
  FROM liquid_protocol_base.LiquidFactory_evt_TokenCreated
  -- Filter to agent-mode (DIEM-paired) tokens only.
  -- 0xf4d9...a024 = DIEM on Base.
  WHERE LOWER("pairedToken") = LOWER('0xf4d97f2da56e8c3098f3a8d538db630a2606a024')
),
latest_price AS (
  -- Use the most recent V4 pool swap as a current price proxy.
  -- For a real dashboard, replace with a TWAP over the last 30m of swaps.
  SELECT
    pool_id,
    LAST_VALUE(price_diem_per_liquid) OVER (
      PARTITION BY pool_id ORDER BY block_time
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS last_price
  FROM (
    -- TODO(dune): swap this CTE for the canonical Uniswap V4 swap decoder
    -- table on Base once the team confirms the schema name.
    SELECT
      "poolId" AS pool_id,
      evt_block_time AS block_time,
      -- placeholder price; real schema will give amount0/amount1 deltas
      1.0 AS price_diem_per_liquid
    FROM liquid_protocol_base.LiquidHookStaticFeeV2_evt_Swap
  )
  GROUP BY pool_id, last_price
),
registry AS (
  -- Off-chain feed from the platform fee-router. Columns:
  --   agent_id, token_address, claim_wallet, staked_diem_wei,
  --   total_claimed_diem_wei, last_claimed_at, diem_usd
  SELECT
    agent_id,
    LOWER(token_address)             AS token_address,
    claim_wallet,
    CAST(staked_diem_wei AS DOUBLE) / 1e18  AS staked_diem,
    CAST(total_claimed_diem_wei AS DOUBLE) / 1e18 AS total_claimed_diem,
    last_claimed_at,
    diem_usd
  FROM dune.<your_team>.dataset_agent_registry  -- replace with your Dune Sim source
)
SELECT
  r.agent_id,
  l.token_symbol,
  l.token_name,
  l.token_address,
  l.deployed_at,
  l.deployer,
  -- Market valuation (best-effort from latest swap price)
  100000000000.0 * lp.last_price * r.diem_usd  AS market_cap_usd,
  -- Compute valuation: this is the headline number
  r.staked_diem,
  r.staked_diem * 1.0                          AS daily_compute_usd,
  r.staked_diem * 365.0                        AS annual_compute_usd,
  r.total_claimed_diem,
  r.last_claimed_at,
  -- Health signals
  CASE
    WHEN r.staked_diem >= 1.0 THEN 'healthy'
    WHEN r.staked_diem >= 0.1 THEN 'low'
    ELSE 'starved'
  END                                          AS compute_health
FROM registry r
JOIN liquid_tokens l ON LOWER(l.token_address) = r.token_address
LEFT JOIN latest_price lp ON lp.pool_id = l.pool_id
ORDER BY daily_compute_usd DESC
