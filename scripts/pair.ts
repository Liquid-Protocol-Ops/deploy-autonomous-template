// CLI for approving pending Telegram pairing requests.
//
// Mirrors openclaw's `openclaw pairing list telegram` and
// `openclaw pairing approve telegram <CODE>` — but as a local script
// against the file-backed pairing store under memory/.
//
// Usage:
//   npm run pair               # list pending
//   npm run pair list          # alias
//   npm run pair approve CODE  # approve + add to allowlist + bootstrap owner
//   npm run pair revoke CODE   # delete without approving

import { PairingStore, AllowlistStore } from '../harness/chat/pairing.js';

function usage(): never {
  console.error('Usage:');
  console.error('  npm run pair                # list pending');
  console.error('  npm run pair approve CODE   # approve a pairing request');
  console.error('  npm run pair revoke  CODE   # delete a pending request');
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  const pairing = new PairingStore();
  const allowlist = new AllowlistStore();
  const sub = (args[0] ?? 'list').toLowerCase();

  if (sub === 'list') {
    const pending = pairing.listPending();
    if (pending.length === 0) {
      console.log('No pending pairing requests.');
      const owner = allowlist.ownerId();
      if (owner) console.log(`Current owner: ${owner}`);
      const others = allowlist.allowFrom().filter((id) => id !== owner);
      if (others.length > 0) console.log(`Additional allow-listed: ${others.join(', ')}`);
      return;
    }
    console.log(`${pending.length} pending request(s):`);
    for (const req of pending) {
      console.log(`  ${req.code}  tg:${req.telegramId}  requested ${req.requestedAt}`);
    }
    console.log('');
    console.log('Approve with:  npm run pair approve <CODE>');
    return;
  }

  if (sub === 'approve') {
    const code = args[1];
    if (!code) usage();
    const result = pairing.approve(code);
    if (!result) {
      console.error(`No pending request with code ${code.toUpperCase()} (or it expired).`);
      process.exit(2);
    }
    const isFirstOwner = allowlist.ownerId() === result.telegramId;
    console.log(`Approved tg:${result.telegramId}`);
    if (isFirstOwner) {
      console.log(`Bootstrapped as command owner.`);
    } else {
      console.log(`Added to allow-list (owner is tg:${allowlist.ownerId()}).`);
    }
    return;
  }

  if (sub === 'revoke') {
    const code = args[1];
    if (!code) usage();
    if (pairing.revoke(code)) {
      console.log(`Revoked ${code.toUpperCase()}`);
      return;
    }
    console.error(`No pending request with code ${code.toUpperCase()}`);
    process.exit(2);
  }

  usage();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}
