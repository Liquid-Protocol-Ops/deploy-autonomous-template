import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PairingStore, AllowlistStore, PairingCapacityError } from '../pairing.js';

function tmpPaths() {
  const dir = mkdtempSync(path.join(tmpdir(), 'da-pair-'));
  return {
    dir,
    paths: {
      pendingPath: path.join(dir, 'pending.json'),
      allowlistPath: path.join(dir, 'allow.json'),
    },
  };
}

describe('PairingStore', () => {
  let dir: string;
  let store: PairingStore;
  let allowlist: AllowlistStore;
  let now: number;

  beforeEach(() => {
    const t = tmpPaths();
    dir = t.dir;
    now = 1_700_000_000_000;
    store = new PairingStore(t.paths, () => now);
    allowlist = new AllowlistStore(t.paths.allowlistPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mints an 8-char code from the unambiguous alphabet', () => {
    const req = store.request(123);
    expect(req.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(req.telegramId).toBe(123);
  });

  it('returns the existing live code on duplicate request from the same user', () => {
    const a = store.request(123);
    const b = store.request(123);
    expect(b.code).toBe(a.code);
  });

  it('lists only non-expired pending requests', () => {
    const a = store.request(100);
    now += 30 * 60 * 1000; // 30 min
    const b = store.request(200);
    now += 31 * 60 * 1000; // total 61 min; a expired, b still live
    const pending = store.listPending();
    expect(pending.map((r) => r.code)).toEqual([b.code]);
    expect(pending.find((r) => r.code === a.code)).toBeUndefined();
  });

  it('caps pending at 3', () => {
    store.request(1);
    store.request(2);
    store.request(3);
    expect(() => store.request(4)).toThrow(PairingCapacityError);
  });

  it('approve adds to allowlist and bootstraps owner on first approval', () => {
    const req = store.request(123);
    const result = store.approve(req.code);
    expect(result?.telegramId).toBe(123);
    expect(allowlist.isAllowed(123)).toBe(true);
    expect(allowlist.isOwner(123)).toBe(true);
    expect(allowlist.ownerId()).toBe(123);
  });

  it('second approval adds to allowlist but does NOT replace owner', () => {
    const a = store.request(111);
    const b = store.request(222);
    store.approve(a.code);
    store.approve(b.code);
    expect(allowlist.ownerId()).toBe(111);
    expect(allowlist.isAllowed(111)).toBe(true);
    expect(allowlist.isAllowed(222)).toBe(true);
    expect(allowlist.isOwner(222)).toBe(false);
  });

  it('approve is case-insensitive', () => {
    const req = store.request(99);
    const lower = req.code.toLowerCase();
    expect(store.approve(lower)?.telegramId).toBe(99);
  });

  it('approve consumes the pending request', () => {
    const req = store.request(99);
    expect(store.approve(req.code)).not.toBeNull();
    expect(store.listPending()).toHaveLength(0);
    // Second approval of the same code returns null.
    expect(store.approve(req.code)).toBeNull();
  });

  it('returns null on expired or unknown code', () => {
    const req = store.request(99);
    now += 61 * 60 * 1000; // past TTL
    expect(store.approve(req.code)).toBeNull();
    expect(allowlist.isAllowed(99)).toBe(false);
    expect(store.approve('NEVEREXIST')).toBeNull();
  });

  it('revoke removes a pending without adding to allowlist', () => {
    const req = store.request(99);
    expect(store.revoke(req.code)).toBe(true);
    expect(store.listPending()).toHaveLength(0);
    expect(allowlist.isAllowed(99)).toBe(false);
    expect(store.revoke(req.code)).toBe(false);
  });
});

