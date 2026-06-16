FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src ./src
COPY tsconfig.json ./

EXPOSE 3001
ENV NODE_ENV=production

CMD ["node", "--import", "tsx", "src/index.ts"]
