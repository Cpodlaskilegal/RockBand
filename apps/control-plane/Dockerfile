FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json

RUN npm ci

COPY packages packages
COPY apps/control-plane apps/control-plane

RUN npm run build --workspace @rockband/shared \
  && npm run build --workspace @rockband/worker \
  && npm run build --workspace @rockband/control-plane

FROM node:22-bookworm-slim
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/worker/package.json ./packages/worker/package.json
COPY --from=build /app/packages/worker/dist ./packages/worker/dist
COPY --from=build /app/apps/control-plane/package.json ./apps/control-plane/package.json
COPY --from=build /app/apps/control-plane/dist ./apps/control-plane/dist
COPY infra/postgres/schema.sql ./infra/postgres/schema.sql

CMD ["node", "apps/control-plane/dist/server.js"]
