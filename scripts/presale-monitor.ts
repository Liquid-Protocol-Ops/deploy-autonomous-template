/**
 * scripts/presale-monitor.ts
 *
 * Monitors LiquidPresaleVault state on-chain and sends Telegram notifications at
 * key lifecycle transitions:
 *
 *   • Deposit window closing soon (< 1 hour)
 *   • Deposit window just closed → depositors can claimTokens()
 *   • STAKE lock expiry approaching (< 1 hour), per configured tier
 *   • STAKE lock expired → depositors can withdrawDiem() / withdrawDepositToken()
 *   • CONTRIBUTE window closed → agent can finalizeVVV()
 *
 * The canonical contract is `LiquidPresaleVault` (one audited contract for both
 * modes — see liquid-website contracts/presale/src/LiquidPresaleVault.sol). It
 * replaces the superseded MintDiemPresaleVault / ComputePresaleVault /
 * StakesaleVault ABIs. Behaviour is driven entirely off on-chain reads
 * (`mode()`, `lockTiers()`), NOT the `contract` label in presales.jsonl, so the
 * monitor is correct regardless of how a record was tagged.
 *
 * Lock-expiry note: a multi-tier STAKE vault has NO single global `lockExpiry()`
 * — expiry is per-depositor (`lockExpiryOf(address)`), and the global
 * `lockExpiry()` view is a shim that returns 0 unless there is exactly one tier.
 * The monitor doesn't enumerate depositors, so it alerts per *configured* tier
 * using `expiry = depositDeadline + tierDuration` (the exact gate `_withdraw()`
 * uses). The single-tier case falls out naturally (one tier == the old shim).
 *
 * Vaults are sourced from memory/presales.jsonl (written by deploy scripts) plus
 * any --vault 0x... flags passed directly.
 *
 * Notification de-dupe: memory/presale-monitor-state.json tracks which events
 * have already fired per vault so cron runs don't spam.
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/presale-monitor.ts [--vault 0x...]
 *
 * Required env:
 *   RPC_URL              Base mainnet RPC (defaults to https://mainnet.base.org)
 *   TELEGRAM_BOT_TOKEN   Telegram bot token (optional — skips Telegram if absent)
 *   TELEGRAM_CHAT_ID     Chat ID for notifications
 */

import { createPublicClient, http, type Address, isAddress } from 'viem';
import { base } from 'viem/chains';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..');
const MEMORY_DIR = join(REPO_ROOT, 'memory');

// ── LiquidPresaleVault ABI fragments (view functions only) ─────────────────

const VAULT_ABI = [
  { name: 'initialized',     type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'mode',            type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'depositDeadline', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalDeposited',  type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalWeight',     type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    name: 'lockTiers', type: 'function', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'durations', type: 'uint256[]' }, { name: 'multipliers', type: 'uint256[]' }],
  },
] as const;

// LiquidPresaleVault.Mode enum: 0 = Contribute, 1 = Stake.
export enum VaultMode {
  Contribute = 0,
  Stake = 1,
}

// ── Types ──────────────────────────────────────────────────────────────────

interface PresaleRecord {
  timestamp:   string;
  contract:    string;
  vaultAddress: Address;
  [key: string]: unknown;
}

export interface VaultOnChain {
  address:          Address;
  contract:         string;   // label from presales.jsonl (informational only)
  initialized:      boolean;
  mode:             VaultMode;
  depositDeadline:  bigint;    // 0 if not initialized
  totalDeposited:   bigint;    // Σ depositToken received
  totalWeight:      bigint;    // Σ stake weight (STAKE only; 0 for CONTRIBUTE)
  lockTiers:        bigint[];  // STAKE tier durations (seconds); empty for CONTRIBUTE
}

// Per-tier dedup timestamps, keyed by tier-duration string (e.g. "2592000").
interface TierNotifyState {
  expiringSentAt: number | null; // unix ms, null = not sent
  expiredSentAt:  number | null;
}

// Per-vault persisted notification state.
export interface VaultNotifyState {
  windowClosingSentAt: number | null;
  windowClosedSentAt:  number | null;
  // STAKE per-tier alerts, keyed by tier duration in seconds.
  tiers: Record<string, TierNotifyState>;
}

type MonitorState = Record<string, VaultNotifyState>; // key = lowercase vault address

const WARN_HORIZON_SEC = 3600n;                  // warn 1 hour before a deadline
const RESEND_INTERVAL_MS = 6 * 60 * 60 * 1000;   // re-notify closed/expired every 6h (until actioned)

// ── RPC client ────────────────────────────────────────────────────────────

const rpcUrl = process.env['RPC_URL'] ?? 'https://mainnet.base.org';
const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

// ── Load vault records from presales.jsonl ────────────────────────────────

function loadPresaleRecords(): PresaleRecord[] {
  const path = join(MEMORY_DIR, 'presales.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) as PresaleRecord; }
      catch { return null; }
    })
    .filter((r): r is PresaleRecord => r !== null && isAddress(r.vaultAddress ?? ''));
}

// ── Load / save monitor state ─────────────────────────────────────────────

function loadMonitorState(): MonitorState {
  const path = join(MEMORY_DIR, 'presale-monitor-state.json');
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')) as MonitorState; }
  catch { return {}; }
}

function saveMonitorState(state: MonitorState): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(join(MEMORY_DIR, 'presale-monitor-state.json'), JSON.stringify(state, null, 2));
}

export function emptyVaultState(): VaultNotifyState {
  return { windowClosingSentAt: null, windowClosedSentAt: null, tiers: {} };
}

// Defensively normalise persisted state (older state files have no `tiers`).
function normalizeVaultState(s: VaultNotifyState | undefined): VaultNotifyState {
  if (!s) return emptyVaultState();
  return {
    windowClosingSentAt: s.windowClosingSentAt ?? null,
    windowClosedSentAt:  s.windowClosedSentAt ?? null,
    tiers:               s.tiers ?? {},
  };
}

// ── On-chain reads ────────────────────────────────────────────────────────

async function readVaultState(address: Address, contractName: string): Promise<VaultOnChain | null> {
  const rc = <N extends typeof VAULT_ABI[number]['name']>(
    functionName: N,
  ) => client.readContract({ address, abi: VAULT_ABI, functionName }).catch(() => null);

  try {
    const [init, modeRaw, deadline, totalDep, totalWt] = await Promise.all([
      rc('initialized'),
      rc('mode'),
      rc('depositDeadline'),
      rc('totalDeposited'),
      rc('totalWeight'),
    ]);

    const initialized     = (init     ?? false) as boolean;
    const depositDeadline = (deadline  ?? 0n) as bigint;
    const totalDeposited  = (totalDep  ?? 0n) as bigint;
    const totalWeight     = (totalWt   ?? 0n) as bigint;
    const mode            = Number(modeRaw ?? 0) === VaultMode.Stake ? VaultMode.Stake : VaultMode.Contribute;

    // STAKE tier durations come straight from lockTiers() — never hardcoded.
    // A multi-tier vault has no usable global lockExpiry(); expiry is computed
    // per tier as depositDeadline + duration (the gate _withdraw() enforces).
    let lockTiers: bigint[] = [];
    if (mode === VaultMode.Stake) {
      const tiers = await rc('lockTiers') as readonly [readonly bigint[], readonly bigint[]] | null;
      if (tiers && Array.isArray(tiers[0])) {
        lockTiers = [...tiers[0]];
      }
    }

    return { address, contract: contractName, initialized, mode, depositDeadline, totalDeposited, totalWeight, lockTiers };
  } catch (err) {
    console.error(`[monitor] Error reading vault ${address}:`, err);
    return null;
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────

async function sendTelegram(text: string): Promise<void> {
  const token  = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CHAT_ID'];
  if (!token || !chatId) {
    console.log('[telegram] (not configured — would send):', text.replace(/\n/g, ' '));
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('[telegram] Send failed:', res.status, await res.text());
  } catch (err) {
    console.error('[telegram] Fetch error:', err);
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────

function fmtAddr(addr: Address): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtTime(secs: bigint): string {
  if (secs === 0n) return 'N/A';
  return new Date(Number(secs) * 1000).toUTCString();
}

function fmtDiem(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac  = (wei % 10n ** 18n) / 10n ** 14n; // 4 decimal places
  return `${whole}.${frac.toString().padStart(4, '0')} DIEM`;
}

function modeLabel(mode: VaultMode): string {
  return mode === VaultMode.Stake ? 'STAKE' : 'CONTRIBUTE';
}

// Human label for a tier duration in seconds (e.g. 2592000 → "30-day").
function tierLabel(durationSec: bigint): string {
  const days = Number(durationSec) / 86400;
  // Whole-day tiers render as "N-day"; otherwise fall back to seconds.
  return Number.isInteger(days) ? `${days}-day` : `${durationSec.toString()}s`;
}

// ── Check a single vault ──────────────────────────────────────────────────

export function checkVault(
  vault: VaultOnChain,
  state: VaultNotifyState,
  nowMs: number,
): { state: VaultNotifyState; alerts: string[] } {
  const alerts: string[] = [];
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  let next = state;

  if (!vault.initialized) {
    // Not yet initialized — nothing to monitor.
    return { state: next, alerts };
  }

  const deadlineSec  = vault.depositDeadline;
  const secsToDeadline = deadlineSec - nowSec;
  const windowOpen   = secsToDeadline > 0n;
  const isStake      = vault.mode === VaultMode.Stake;

  // ── Window closing soon ──
  if (windowOpen && secsToDeadline <= WARN_HORIZON_SEC) {
    const lastSentMs = next.windowClosingSentAt;
    if (lastSentMs === null || nowMs - lastSentMs >= RESEND_INTERVAL_MS) {
      const minutesLeft = Number(secsToDeadline) / 60;
      const msg =
        `⏰ <b>Presale window closing soon</b>\n` +
        `Vault: <code>${vault.address}</code> (${modeLabel(vault.mode)})\n` +
        `Deposited: ${fmtDiem(vault.totalDeposited)}\n` +
        `Closes: ${fmtTime(deadlineSec)} (~${minutesLeft.toFixed(0)}m)`;
      alerts.push(msg);
      next = { ...next, windowClosingSentAt: nowMs };
    }
  }

  // ── Window closed ──
  if (!windowOpen) {
    const lastSentMs = next.windowClosedSentAt;
    if (lastSentMs === null || nowMs - lastSentMs >= RESEND_INTERVAL_MS) {
      const minsAgo = Number(nowSec - deadlineSec) / 60;
      const nextStep = isStake
        ? `→ Depositors can now call <b>claimTokens()</b>; STAKE deposits unlock per tier.`
        : `→ Depositors can now call <b>claimTokens()</b>; agent can call <b>finalizeVVV()</b>.`;
      const msg =
        `🔒 <b>Presale window closed</b>\n` +
        `Vault: <code>${vault.address}</code> (${modeLabel(vault.mode)})\n` +
        `Total deposited: ${fmtDiem(vault.totalDeposited)}\n` +
        `Closed: ${fmtTime(deadlineSec)} (${minsAgo.toFixed(0)}m ago)\n` +
        nextStep;
      alerts.push(msg);
      next = { ...next, windowClosedSentAt: nowMs };
    }
  }

  // ── STAKE lock expiry: one alert per configured tier ──
  // Skip entirely on CONTRIBUTE (no locks) or when nobody staked (totalWeight 0):
  // per-tier expiry is depositDeadline + tierDuration, the exact gate _withdraw()
  // enforces (no grace window — the +14d grace applies only to sweepDust()).
  if (isStake && vault.totalWeight > 0n && deadlineSec > 0n) {
    const tiersState: Record<string, TierNotifyState> = { ...next.tiers };

    for (const duration of vault.lockTiers) {
      const key      = duration.toString();
      const label    = tierLabel(duration);
      const expirySec = deadlineSec + duration;
      const secsToExpiry = expirySec - nowSec;
      const lockActive   = secsToExpiry > 0n;
      const tState: TierNotifyState = tiersState[key] ?? { expiringSentAt: null, expiredSentAt: null };

      if (lockActive && secsToExpiry <= WARN_HORIZON_SEC) {
        const lastSentMs = tState.expiringSentAt;
        if (lastSentMs === null || nowMs - lastSentMs >= RESEND_INTERVAL_MS) {
          const minutesLeft = Number(secsToExpiry) / 60;
          const msg =
            `⏳ <b>STAKE ${label} lock expiring</b>\n` +
            `Vault: <code>${vault.address}</code>\n` +
            `Expires: ${fmtTime(expirySec)} (~${minutesLeft.toFixed(0)}m)\n` +
            `→ ${label} depositors can soon call <b>withdrawDiem()</b> / <b>withdrawDepositToken()</b>`;
          alerts.push(msg);
          tiersState[key] = { ...tState, expiringSentAt: nowMs };
        }
      } else if (!lockActive) {
        const lastSentMs = tState.expiredSentAt;
        if (lastSentMs === null || nowMs - lastSentMs >= RESEND_INTERVAL_MS) {
          const hoursAgo = Number(nowSec - expirySec) / 3600;
          const msg =
            `✅ <b>STAKE ${label} lock expired — deposit unlocked</b>\n` +
            `Vault: <code>${vault.address}</code>\n` +
            `Expired: ${fmtTime(expirySec)} (${hoursAgo.toFixed(1)}h ago)\n` +
            `→ ${label} depositors can now call <b>withdrawDiem()</b> / <b>withdrawDepositToken()</b>`;
          alerts.push(msg);
          tiersState[key] = { ...tState, expiredSentAt: nowMs };
        }
      } else if (!(key in tiersState)) {
        // Ensure the tier appears in state even before its first alert.
        tiersState[key] = tState;
      }
    }

    next = { ...next, tiers: tiersState };
  }

  return { state: next, alerts };
}

// ── Log run to JSONL ──────────────────────────────────────────────────────

function logRun(vaults: VaultOnChain[], alertCount: number): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  appendFileSync(
    join(MEMORY_DIR, 'presale-monitor.jsonl'),
    JSON.stringify({
      timestamp:  new Date().toISOString(),
      vaultsRead: vaults.length,
      alertsSent: alertCount,
      vaults: vaults.map(v => ({
        address:         v.address,
        contract:        v.contract,
        initialized:     v.initialized,
        mode:            modeLabel(v.mode),
        depositDeadline: v.depositDeadline.toString(),
        totalDeposited:  v.totalDeposited.toString(),
        totalWeight:     v.totalWeight.toString(),
        lockTiers:       v.lockTiers.map(t => t.toString()),
      })),
    }) + '\n',
  );
}

// ── CLI args ──────────────────────────────────────────────────────────────

function parseArgs(): { extraVaults: Address[] } {
  const extraVaults: Address[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--vault' && args[i + 1]) {
      const addr = args[++i] as string;
      if (isAddress(addr)) extraVaults.push(addr as Address);
      else console.warn(`[monitor] Invalid vault address: ${addr}`);
    }
  }
  return { extraVaults };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const nowMs = Date.now();
  const { extraVaults } = parseArgs();

  // Collect vault addresses from presales.jsonl + CLI args (deduplicated)
  const records = loadPresaleRecords();
  const seen = new Set<string>();
  const vaultSpecs: Array<{ address: Address; contract: string }> = [];

  for (const r of records) {
    const key = r.vaultAddress.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      vaultSpecs.push({ address: r.vaultAddress, contract: r.contract ?? 'Unknown' });
    }
  }
  for (const addr of extraVaults) {
    const key = addr.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      vaultSpecs.push({ address: addr, contract: 'Unknown' });
    }
  }

  if (vaultSpecs.length === 0) {
    console.log('[monitor] No vaults to check. Deploy a vault first or pass --vault 0x...');
    return;
  }

  console.log(`[monitor] Checking ${vaultSpecs.length} vault(s)...`);

  // Read on-chain state in parallel
  const states = await Promise.all(
    vaultSpecs.map(s => readVaultState(s.address, s.contract))
  );
  const liveVaults = states.filter((v): v is VaultOnChain => v !== null);

  // Load persisted notify state
  const monitorState = loadMonitorState();

  let alertCount = 0;

  for (const vault of liveVaults) {
    const key     = vault.address.toLowerCase();
    const vState  = normalizeVaultState(monitorState[key]);
    const { state: newVState, alerts } = checkVault(vault, vState, nowMs);

    if (alerts.length > 0) {
      for (const alert of alerts) {
        // Strip HTML tags for the console line. Loop until stable —
        // defensive hardening against crafted markup (CodeQL: incomplete
        // multi-character sanitization).
        let plain = alert;
        let prevPlain: string;
        do {
          prevPlain = plain;
          plain = plain.replace(/<[^>]+>/g, '');
        } while (plain !== prevPlain);
        console.log('[alert]', plain);
        await sendTelegram(alert);
        alertCount++;
      }
    } else {
      console.log(
        `[monitor] ${fmtAddr(vault.address)} (${modeLabel(vault.mode)}) — ok` +
        (vault.lockTiers.length > 0 ? ` [tiers: ${vault.lockTiers.map(t => tierLabel(t)).join(', ')}]` : ''),
      );
    }

    monitorState[key] = newVState;
  }

  saveMonitorState(monitorState);
  logRun(liveVaults, alertCount);

  console.log(`[monitor] Done. ${alertCount} alert(s) sent.`);
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[monitor] Fatal:', err);
    process.exit(1);
  });
}
