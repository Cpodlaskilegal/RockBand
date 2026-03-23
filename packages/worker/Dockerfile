FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/worker/package.json packages/worker/package.json

RUN npm ci

COPY packages packages

RUN npm run build --workspace @rockband/shared \
  && npm run build --workspace @rockband/worker

FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y git bash && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/worker/package.json ./packages/worker/package.json
COPY --from=build /app/packages/worker/dist ./packages/worker/dist

CMD ["node", "packages/worker/dist/cli.js"]
