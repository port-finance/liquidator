# Builder
FROM node:alpine3.14 as builder
RUN npm install -g pnpm ts-node

RUN mkdir -p /app
WORKDIR /app

COPY . .
RUN pnpm install

# Runner
FROM node:alpine3.14

USER node

COPY --from=builder /app /app

WORKDIR /app

ENTRYPOINT [ "pnpm", "liquidator" ]
