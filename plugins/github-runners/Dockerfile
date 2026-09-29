# Builds the github-runners Headlamp plugin (TypeScript/React, official
# @kinvolk/headlamp-plugin tooling) and ships only the compiled output. Meant
# to run as a Headlamp initContainer that copies /plugin into the shared
# plugins volume, then exits.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx headlamp-plugin tsc && npx headlamp-plugin build

# Minimal runtime: only the built plugin, owned by a non-root user.
FROM alpine:3.20 AS runtime
RUN addgroup -g 101 headlamp && adduser -D -u 100 -G headlamp headlamp
COPY --from=build --chown=100:101 /src/dist /plugin
COPY --from=build --chown=100:101 /src/package.json /plugin/
USER 100:101
