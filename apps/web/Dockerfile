# syntax=docker/dockerfile:1
FROM node:22.12-alpine@sha256:51eff88af6dff26f59316b6e356188ffa2c422bd3c3b76f2556a2e7e89d080bd AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/connectors/package.json packages/connectors/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
COPY services/executor/package.json services/executor/
COPY apps/web/package.json apps/web/
RUN npm install --workspaces --include-workspace-root

FROM deps AS dev
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npm", "run", "dev"]
