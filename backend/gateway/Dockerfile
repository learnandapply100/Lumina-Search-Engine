# Build from the REPO ROOT: docker build -f backend/gateway/Dockerfile .
# No provider key is ever read in this image. It holds the edge and the evals report.
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
COPY backend/gateway backend/gateway
RUN npm run build -w @lumina/contract && npm run build -w @lumina/gateway

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
COPY --from=build /app/backend/gateway/dist backend/gateway/dist

# The evaluation the /evals page renders. Baked in, so redeploying is what publishes a new
# one — there is no writable path here that could quietly disagree with what was measured.
COPY reports/report.jso[n] /app/reports/

WORKDIR /app/backend/gateway
EXPOSE 8787
CMD ["node", "dist/index.js"]
