#!/bin/sh
# Start both the AntSeed provider and the settle loop.
# All secrets injected via env vars — never baked into the image.

set -e

# Validate required env vars
: "${KEEPER_PRIVATE_KEY:?KEEPER_PRIVATE_KEY is required}"
: "${VENICE_API_KEY:?VENICE_API_KEY is required}"
: "${BASE_RPC_URL:?BASE_RPC_URL is required}"

# Write live AntSeed config (inject RPC URL at runtime)
mkdir -p /root/.antseed
node -e "
const tmpl = require('/root/.antseed-template/config.json');
tmpl.payments.crypto.rpcUrl = process.env.BASE_RPC_URL;
require('fs').writeFileSync('/root/.antseed/config.json', JSON.stringify(tmpl, null, 2));
console.log('AntSeed config written');
"

echo "Starting AntSeed seller node..."
ANTSEED_IDENTITY_HEX="$KEEPER_PRIVATE_KEY" \
OPENAI_API_KEY="$VENICE_API_KEY" \
antseed seller start &
ANTSEED_PID=$!

echo "Starting settle loop..."
KEEPER_PRIVATE_KEY="$KEEPER_PRIVATE_KEY" \
BASE_RPC_URL="$BASE_RPC_URL" \
CHANNEL_ID="${CHANNEL_ID:-0}" \
MIN_SETTLE_USDC="${MIN_SETTLE_USDC:-1.0}" \
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-120000}" \
node /app/dist/keeper/settle.js &
SETTLE_PID=$!

echo "Both processes running — AntSeed PID $ANTSEED_PID, settle PID $SETTLE_PID"

# Exit if either process dies (Railway will restart the container)
wait -n
echo "A process exited — container will restart"
exit 1
