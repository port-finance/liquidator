# Builder
ARG VARIANT=18-bullseye
FROM mcr.microsoft.com/vscode/devcontainers/javascript-node:0-${VARIANT} as builder
WORKDIR /liquidator
RUN su node -c "npm install -g pnpm ts-node" && \
    pnpm config set store-dir /tmp/.pnpm-store
COPY . .
RUN pnpm install && pnpm build

ARG VARIANT=18-bullseye
FROM node:${VARIANT}-slim as production
COPY --from=builder /liquidator/dist /liquidator/dist
WORKDIR /liquidator/
CMD [ "/liquidator/dist/liquidator.cjs" ]
