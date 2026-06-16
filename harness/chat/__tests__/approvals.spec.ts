import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Context } from 'grammy';
import {
  ApprovalStore,
  ApprovalCapacityError,
  APPROVAL_TTL_MS,
  callbackData,
  parseCallbackData,
  handleApprovalCallback,
} from '../approvals.js';
import type { AllowlistStore } from '../pairing.js';

const OWNER = 111;
const STRANGER = 222;

function makeStore(nowRef: { t: number }) {
  return new ApprovalStore(APPROVAL_TTL_MS, () => nowRef.t);
}

const allowlist = { isOwner: (id: number) => id === OWNER } as unknown as AllowlistStore;

function makeCallbackCtx(data: string, fromId: number) {
  const edits: string[] = [];
  const toasts: string[] = [];
  const ctx = {
    callbackQuery: { data, from: { id: fromId } },
    answerCallbackQuery: vi.fn(async (opts?: { text?: string }) => {
      toasts.push(opts?.text ?? '');
      return true as never;
    }),
    editMessageText: vi.fn(async (text: string) => {
      edits.push(text);
      return {} as never;
    }),
  } as unknown as Context;
  return { ctx, edits, toasts };
}

describe('ApprovalStore', () => {
  let nowRef: { t: number };
  let store: ApprovalStore;

  beforeEach(() => {
    nowRef = { t: 1_700_000_000_000 };
    store = makeStore(nowRef);
  });

  it('creates entries with 12-char hex ids and takes them once', () => {
    const entry = store.create({ title: 'Stake 1 DIEM', createdBy: OWNER, execute: async () => 'ok' });
    expect(entry.id).toMatch(/^[0-9a-f]{12}$/);
    expect(store.take(entry.id)?.title).toBe('Stake 1 DIEM');
    expect(store.take(entry.id)).toBeNull(); // consumed
  });

  it('expires entries after the TTL', () => {
    const entry = store.create({ title: 't', createdBy: OWNER, execute: async () => 'ok' });
    nowRef.t += APPROVAL_TTL_MS + 1;
    expect(store.take(entry.id)).toBeNull();
  });

  it('caps pending approvals at 5', () => {
    for (let i = 0; i < 5; i++) {
      store.create({ title: `t${i}`, createdBy: OWNER, execute: async () => 'ok' });
    }
    expect(() =>
      store.create({ title: 'overflow', createdBy: OWNER, execute: async () => 'ok' }),
    ).toThrow(ApprovalCapacityError);
  });
});

describe('callback data round-trip', () => {
  it('encodes and parses', () => {
    expect(parseCallbackData(callbackData('a1b2c3d4e5f6', 'confirm'))).toEqual({
      id: 'a1b2c3d4e5f6',
      action: 'confirm',
    });
    expect(parseCallbackData(callbackData('a1b2c3d4e5f6', 'cancel'))?.action).toBe('cancel');
  });

  it('rejects foreign callback data', () => {
    expect(parseCallbackData('something:else')).toBeNull();
    expect(parseCallbackData('appr:short:confirm')).toBeNull();
    expect(parseCallbackData('appr:a1b2c3d4e5f6:nuke')).toBeNull();
  });
});

describe('handleApprovalCallback', () => {
  let nowRef: { t: number };
  let store: ApprovalStore;

  beforeEach(() => {
    nowRef = { t: 1_700_000_000_000 };
    store = makeStore(nowRef);
  });

  it('executes on owner confirm and edits in the result', async () => {
    const execute = vi.fn(async () => 'tx 0xabc');
    const entry = store.create({ title: 'Claim 5 DIEM', createdBy: OWNER, execute });
    const { ctx, edits } = makeCallbackCtx(callbackData(entry.id, 'confirm'), OWNER);

    await handleApprovalCallback(ctx, store, allowlist);

    expect(execute).toHaveBeenCalledOnce();
    expect(edits.at(-1)).toContain('Done');
    expect(edits.at(-1)).toContain('tx 0xabc');
    expect(store.pendingCount()).toBe(0);
  });

  it('cancels without executing', async () => {
    const execute = vi.fn(async () => 'never');
    const entry = store.create({ title: 'Stake', createdBy: OWNER, execute });
    const { ctx, edits } = makeCallbackCtx(callbackData(entry.id, 'cancel'), OWNER);

    await handleApprovalCallback(ctx, store, allowlist);

    expect(execute).not.toHaveBeenCalled();
    expect(edits.at(-1)).toContain('Cancelled');
  });

  it("rejects a non-owner's press without consuming the approval", async () => {
    const execute = vi.fn(async () => 'never');
    const entry = store.create({ title: 'Stake', createdBy: OWNER, execute });
    const { ctx, toasts } = makeCallbackCtx(callbackData(entry.id, 'confirm'), STRANGER);

    await handleApprovalCallback(ctx, store, allowlist);

    expect(execute).not.toHaveBeenCalled();
    expect(toasts.at(0)).toBe('Owner only.');
    expect(store.pendingCount()).toBe(1); // still pending for the real owner
  });

  it('reports expired/unknown approvals', async () => {
    const { ctx, edits } = makeCallbackCtx(callbackData('a1b2c3d4e5f6', 'confirm'), OWNER);
    await handleApprovalCallback(ctx, store, allowlist);
    expect(edits.at(-1)).toContain('expired');
  });

  it('edits in the error when execute throws', async () => {
    const entry = store.create({
      title: 'Claim',
      createdBy: OWNER,
      execute: async () => {
        throw new Error('tx not allowed: destination not on allow-list');
      },
    });
    const { ctx, edits } = makeCallbackCtx(callbackData(entry.id, 'confirm'), OWNER);

    await handleApprovalCallback(ctx, store, allowlist);

    expect(edits.at(-1)).toContain('Failed');
    expect(edits.at(-1)).toContain('allow-list');
  });

  it('ignores callback data that is not ours', async () => {
    const { ctx, edits, toasts } = makeCallbackCtx('other:plugin:data', OWNER);
    await handleApprovalCallback(ctx, store, allowlist);
    expect(edits).toHaveLength(0);
    expect(toasts).toHaveLength(0);
  });
});
