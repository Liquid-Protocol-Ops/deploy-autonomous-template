# Resolved decisions

Architecture decisions for this template, with rationale. The full conflict
table and superseded directions live in [`ARCHITECTURE_v2.md`](ARCHITECTURE_v2.md).

### Wallet substrate — Privy server wallets (2026-05-06)

The earlier rejection of Privy applied to **embedded wallets** (which require a
human session). **Privy server wallets** are fully headless and support
`personal_sign`, `eth_signTypedData_v4`, and `eth_sendTransaction` with no human
interaction.

v0 uses Privy server wallets via `loadSignerFromPrivy` / `makeTxSenderFromPrivy`
in `harness/safety/wallet.ts`. The `TxSender` abstraction makes v1 (TEE) a
drop-in swap with no call-site changes in `venice.ts` or the tick loop.

### DIEM staking contract (2026-05-06)

The DIEM contract `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` is **both** the
ERC-20 token and the staking contract. Call `stake(uint256 amount)` directly —
no ERC-20 approve step. Recorded in `platform/constants.ts` as `ADDRESSES.DIEM`.

### Platform service location (2026-05-10)

Platform services stage under `platform/services/` in this repo for the MVP;
they migrate to a dedicated `deploy-autonomous-platform` repo post-MVP once the
loop is proven.
