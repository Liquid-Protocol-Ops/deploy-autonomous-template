# settle-only image — no AntSeed, no native deps.
# AntSeed provider runs separately (launchd on Mac, or a VPS with UDP 6881 open).
# This container just polls keeper USDC balance and calls FeeRouter.settleAndHarvest.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY keeper/settle.ts ./keeper/

# tsx runs TypeScript directly — no separate compile step needed
CMD ["npx", "tsx", "keeper/settle.ts"]
