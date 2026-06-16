// Pairing + owner allowlist persistence.
//
// Matches openclaw's DM pairing model:
//  - Unknown sender DMs the bot → pending pairing request created
//  - 8-char uppercase code (no ambiguous chars 0/O/1/I)
//  - Pending requests expire after 1 hour
//  - Cap of 3 pending requests per channel
//  - Owner approves out-of-band via `npm run pair approve <CODE>`
//  - First approved pairing also bootstraps the owner allowlist
//
// State lives in two JSON files under memory/ (allowlist-permitted):
//   memory/pairing-pending.json   — { [code]: { telegramId, requestedAt } }
//   memory/owner-allowlist.json   — { allowFrom: number[], owner: number | null }

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import path from 'node:path';

export interface PendingRequest {
  /** Pairing code shown to the user; 8 unambiguous uppercase chars. */
  code: string;
  /** Numeric Telegram user ID of the requester. */
  telegramId: number;
  /** ISO timestamp the request was created. */
  requestedAt: string;
}

interface PairingFile {
  pending: Record<string, { telegramId: number; requestedAt: string }>;
}

interface AllowlistFile {
  /** Telegram user IDs allowed to DM the bot (via pairing approval). */
  allowFrom: number[];
  /** First approved sender; doubles as the command owner. Null until bootstrapped. */
  owner: number | null;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_LEN = 8;
const PAIRING_TTL_MS = 60 * 60 * 1000; // 1h, matches openclaw
const MAX_PENDING = 3;

export interface PairingStorePaths {
  pendingPath: string;
  allowlistPath: string;
}

export const DEFAULT_PATHS: PairingStorePaths = {
  pendingPath: 'memory/pairing-pending.json',
  allowlistPath: 'memory/owner-allowlist.json',
};

// ── File I/O ─────────────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    // Corrupt file — treat as empty rather than crash. Caller's next
    // write will overwrite. Log so it's not silent.
    console.warn(`[pairing] failed to parse ${filePath}, treating as empty`);
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ── Code generation ──────────────────────────────────────────────────

function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

// ── Pending request store ────────────────────────────────────────────

export class PairingStore {
  private readonly paths: PairingStorePaths;
  private readonly now: () => number;

  constructor(paths: PairingStorePaths = DEFAULT_PATHS, now: () => number = Date.now) {
    this.paths = paths;
    this.now = now;
  }

  /**
   * Create a new pending pairing request, returning the code to show the user.
   * If the user already has a non-expired pending request, returns the
   * existing code instead of creating a duplicate (matches openclaw's
   * "roughly once per hour per sender" behavior).
   *
   * Throws if the per-channel pending cap (3) would be exceeded.
   */
  request(telegramId: number): PendingRequest {
    const file = readJson<PairingFile>(this.paths.pendingPath, { pending: {} });
    const nowMs = this.now();
    const fresh: PairingFile['pending'] = {};

    // First sweep: drop expired entries; surface any existing live request for this user.
    let existingForUser: PendingRequest | null = null;
    for (const [code, entry] of Object.entries(file.pending)) {
      const ageMs = nowMs - new Date(entry.requestedAt).getTime();
      if (ageMs > PAIRING_TTL_MS) continue;
      fresh[code] = entry;
      if (entry.telegramId === telegramId) {
        existingForUser = { code, ...entry };
      }
    }

    if (existingForUser) {
      // Persist the cleaned set (the expired-sweep is the only side effect).
      writeJson(this.paths.pendingPath, { pending: fresh });
      return existingForUser;
    }

    if (Object.keys(fresh).length >= MAX_PENDING) {
      writeJson(this.paths.pendingPath, { pending: fresh });
      throw new PairingCapacityError(
        `Pairing capacity reached (${MAX_PENDING} pending). Wait for expiry or have the owner approve one.`,
      );
    }

    // Generate a unique code (loop in the unlikely event of collision).
    let code = generateCode();
    while (code in fresh) code = generateCode();

    const req: PendingRequest = {
      code,
      telegramId,
      requestedAt: new Date(nowMs).toISOString(),
    };
    fresh[code] = { telegramId, requestedAt: req.requestedAt };
    writeJson(this.paths.pendingPath, { pending: fresh });
    return req;
  }

  /** List currently non-expired pending requests. */
  listPending(): PendingRequest[] {
    const file = readJson<PairingFile>(this.paths.pendingPath, { pending: {} });
    const nowMs = this.now();
    const out: PendingRequest[] = [];
    for (const [code, entry] of Object.entries(file.pending)) {
      const ageMs = nowMs - new Date(entry.requestedAt).getTime();
      if (ageMs > PAIRING_TTL_MS) continue;
      out.push({ code, ...entry });
    }
    return out;
  }

  /**
   * Approve a pending pairing code. Adds the user to the owner allowlist
   * and, if no owner is set yet, bootstraps them as the command owner
   * (matches openclaw's first-pairing-bootstraps-owner behavior).
   *
   * Returns the approved request, or null if the code doesn't exist or
   * has expired.
   */
  approve(code: string): PendingRequest | null {
    const normalized = code.trim().toUpperCase();
    const file = readJson<PairingFile>(this.paths.pendingPath, { pending: {} });
    const entry = file.pending[normalized];
    if (!entry) return null;

    const ageMs = this.now() - new Date(entry.requestedAt).getTime();
    if (ageMs > PAIRING_TTL_MS) {
      delete file.pending[normalized];
      writeJson(this.paths.pendingPath, file);
      return null;
    }

    // Remove from pending, add to allowlist, bootstrap owner if unset.
    delete file.pending[normalized];
    writeJson(this.paths.pendingPath, file);

    const allowlist = readJson<AllowlistFile>(this.paths.allowlistPath, {
      allowFrom: [],
      owner: null,
    });
    if (!allowlist.allowFrom.includes(entry.telegramId)) {
      allowlist.allowFrom.push(entry.telegramId);
    }
    if (allowlist.owner === null) {
      allowlist.owner = entry.telegramId;
    }
    writeJson(this.paths.allowlistPath, allowlist);

    return { code: normalized, ...entry };
  }

  /** Remove a pending request without approving it. Returns true if found + removed. */
  revoke(code: string): boolean {
    const normalized = code.trim().toUpperCase();
    const file = readJson<PairingFile>(this.paths.pendingPath, { pending: {} });
    if (!(normalized in file.pending)) return false;
    delete file.pending[normalized];
    writeJson(this.paths.pendingPath, file);
    return true;
  }
}

// ── Owner allowlist ──────────────────────────────────────────────────

export class AllowlistStore {
  private readonly path: string;

  constructor(filePath: string = DEFAULT_PATHS.allowlistPath) {
    this.path = filePath;
  }

  /** True if the user is permitted to DM the bot. */
  isAllowed(telegramId: number): boolean {
    return this.read().allowFrom.includes(telegramId);
  }

  /** True if the user is the bootstrapped command owner. */
  isOwner(telegramId: number): boolean {
    return this.read().owner === telegramId;
  }

  /** Returns the current owner ID, or null if none set. */
  ownerId(): number | null {
    return this.read().owner;
  }

  /** Returns a snapshot of all allowed user IDs. */
  allowFrom(): number[] {
    return [...this.read().allowFrom];
  }

  private read(): AllowlistFile {
    return readJson<AllowlistFile>(this.path, { allowFrom: [], owner: null });
  }
}

export class PairingCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingCapacityError';
  }
}
