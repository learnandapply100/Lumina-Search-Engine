# Build from the REPO ROOT: docker build -f backend/agent/Dockerfile .
# The agent and the indexer worker ship from this one image and run as two Fly process
# groups, which is how they stay separate processes without a second build.
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json backend/agent/
COPY backend/gateway/package.json backend/gateway/
COPY web/package.json web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/contract packages/contract
COPY backend/agent backend/agent
RUN npm run build -w @lumina/contract && npm run build -w @lumina/agent

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json backend/agent/
COPY backend/gateway/package.json backend/gateway/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/contract/dist packages/contract/dist
COPY --from=build /app/backend/agent/dist backend/agent/dist

# env.ts resolves the run-log directory relative to cwd as ../../runs, so the working
# directory has to be the package, not the repo root.
WORKDIR /app/backend/agent
RUN mkdir -p /app/runs

EXPOSE 8000
CMD ["node", "dist/index.js"]
