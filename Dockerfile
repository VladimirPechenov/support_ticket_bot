FROM node:22-bookworm-slim AS build
WORKDIR /bot
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /bot
ENV NODE_ENV=production
COPY --from=build --chown=node:node /bot/node_modules ./node_modules
COPY --from=build --chown=node:node /bot/build ./build
COPY --chown=node:node package.json package-lock.json ./
RUN mkdir -p config logs && chown -R node:node /bot
USER node
CMD ["node", "build/index.js"]
