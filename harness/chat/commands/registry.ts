// Command registry — a small map from `/cmd` → handler.
//
// Commands receive (grammY Context, ChatDeps, args[]). Handlers send
// their own replies via `ctx.reply()` or `bot.api.*` so they can choose
// HTML / plaintext / inline keyboard as appropriate. The registry only
// dispatches; permission checking happens upstream in the bot's
// middleware chain.

import type { Context } from 'grammy';
import type { loadConfig, makePublicClient } from '../../providers/venice.js';
import type { Signer, TxSender } from '../../safety/wallet.js';
import type { AllowlistStore } from '../pairing.js';
import type { ApprovalStore } from '../approvals.js';

export type VeniceConfig = ReturnType<typeof loadConfig>;

// Match venice.ts's BasePublicClient pattern — the chain-specific
// PublicClient inferred from `chain: base` carries narrower types than
// viem's generic `PublicClient`, so the imports have to align.
export type BasePublicClient = ReturnType<typeof makePublicClient>;

export interface ChatDeps {
  signer: Signer;
  publicClient: BasePublicClient;
  config: VeniceConfig;
  allowlist: AllowlistStore;
  /** Guarded sender (destination allow-list + value cap, fail closed). */
  txSender: TxSender;
  /** Pending [Confirm]/[Cancel] approvals for wallet-touching commands. */
  approvals: ApprovalStore;
}

export interface Command {
  /** Without leading slash, lowercase, [a-z0-9_]{1,32}. */
  name: string;
  /** One-line description for /help + setMyCommands. */
  description: string;
  /** True if reply-only-to-owner; the bot middleware enforces. */
  ownerOnly?: boolean;
  handler: (ctx: Context, deps: ChatDeps, args: string[]) => Promise<void>;
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(cmd: Command): void {
    if (this.commands.has(cmd.name)) {
      throw new Error(`Command "${cmd.name}" already registered`);
    }
    if (!/^[a-z0-9_]{1,32}$/.test(cmd.name)) {
      throw new Error(`Command "${cmd.name}" must match [a-z0-9_]{1,32}`);
    }
    this.commands.set(cmd.name, cmd);
  }

  get(name: string): Command | undefined {
    return this.commands.get(name.toLowerCase());
  }

  /** All registered commands in insertion order. */
  all(): Command[] {
    return Array.from(this.commands.values());
  }
}
