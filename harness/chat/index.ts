// Bot entry point — `npm run bot`.
//
// Wires:
//   loadTelegramConfig (env)
//   loadConfig (venice / chain env)
//   loadSignerFromPrivy or loadSignerFromEnv
//   makePublicClient
//   PairingStore + AllowlistStore (file-backed under memory/)
//   CommandRegistry + commands (/help, /status, ...)
//   createBot (grammY long-poll)
//
// Long-polling runs until SIGINT / SIGTERM. The process is meant to
// live on Railway / fly.io / a VPS — NOT inside the GHA tick workflow
// (which is short-lived per-invocation).

import { mkdirSync } from 'node:fs';
import { loadConfig, makePublicClient } from '../providers/venice.js';
import {
  loadPrivyConfig,
  loadSignerFromPrivy,
  loadSignerFromEnv,
  makeTxSenderFromPrivy,
  makeTxSenderFromEnv,
  type Signer,
  type TxSender,
} from '../safety/wallet.js';
import { loadTelegramConfig } from './config.js';
import { createBot, registerCommandMenu } from './bot.js';
import { AllowlistStore, PairingStore } from './pairing.js';
import { ApprovalStore } from './approvals.js';
import { CommandRegistry } from './commands/registry.js';
import { makeHelpCommand } from './commands/help.js';
import { statusCommand } from './commands/status.js';
import { thinkCommand } from './commands/think.js';
import { historyCommand } from './commands/history.js';
import { claimCommand } from './commands/claim.js';
import { stakeCommand } from './commands/stake.js';
import { lpCommand } from './commands/lp.js';

async function loadSigner(): Promise<Signer> {
  if (process.env['PRIVY_APP_ID']) {
    return loadSignerFromPrivy(loadPrivyConfig());
  }
  return loadSignerFromEnv();
}

// Both substrates return a GUARDED sender — destination allow-list +
// optional value cap are enforced inside make* (fail closed), so every
// chat-initiated wallet write passes the same chokepoint as the tick.
function loadTxSender(rpcUrl: string, selfAddress: Signer['address']): TxSender {
  if (process.env['PRIVY_APP_ID']) {
    return makeTxSenderFromPrivy(loadPrivyConfig(), fetch, selfAddress);
  }
  return makeTxSenderFromEnv(rpcUrl);
}

async function main(): Promise<void> {
  // memory/ must exist for pairing-pending.json + owner-allowlist.json writes.
  mkdirSync('memory', { recursive: true });

  const tgConfig = loadTelegramConfig();
  const veniceConfig = loadConfig();
  const signer = await loadSigner();
  const publicClient = makePublicClient(veniceConfig.rpcUrl);

  const pairing = new PairingStore();
  const allowlist = new AllowlistStore();
  const approvals = new ApprovalStore();
  const txSender = loadTxSender(veniceConfig.rpcUrl, signer.address);

  const registry = new CommandRegistry();
  registry.register(statusCommand);
  registry.register(thinkCommand);
  registry.register(historyCommand);
  registry.register(claimCommand);
  registry.register(stakeCommand);
  registry.register(lpCommand);
  registry.register(makeHelpCommand(registry)); // /help reads the registry, register last

  const bot = createBot({
    config: tgConfig,
    deps: { signer, publicClient, config: veniceConfig, allowlist, txSender, approvals },
    registry,
    pairing,
    allowlist,
  });

  // setMyCommands is idempotent + cheap; register on every start so a
  // new agent doesn't need a separate provisioning step before the menu
  // appears in clients.
  await registerCommandMenu(bot, registry);

  // Greet on startup — sanity check both that Telegram is reachable and
  // that the bot token is valid.
  const me = await bot.api.getMe();
  console.log(`[bot] @${me.username} (${me.id}) online; ${registry.all().length} commands registered`);
  if (tgConfig.dmPolicy === 'pairing' && allowlist.ownerId() === null) {
    console.log('[bot] no owner set yet — first user to DM will receive a pairing code');
  } else if (allowlist.ownerId() !== null) {
    console.log(`[bot] owner: ${allowlist.ownerId()}`);
  }

  // Graceful shutdown on SIGINT/SIGTERM so long-poll can drain the
  // in-flight getUpdates request and Telegram releases the lock.
  const stop = (signal: string) => () => {
    console.log(`[bot] ${signal} received, stopping...`);
    bot.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', stop('SIGINT'));
  process.once('SIGTERM', stop('SIGTERM'));

  await bot.start();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err: unknown) => {
    console.error('[bot] fatal:', err);
    process.exit(1);
  });
}
