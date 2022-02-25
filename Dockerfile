# Builder
FROM node:alpine3.14 as builder

RUN mkdir -p /app
WORKDIR /app

COPY . ./
RUN yarn install

# Runner
FROM node:alpine3.14

USER node

COPY --from=builder /app /app

WORKDIR /app

ENTRYPOINT [ "yarn", "liquidator" ]
