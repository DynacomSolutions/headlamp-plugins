# Builds the disk-health Headlamp plugin (TypeScript/React, built with the
# official @kinvolk/headlamp-plugin tooling) and ships only its compiled
# dist/ output. This image is never run as a long-lived workload: Headlamp's
# Deployment uses it purely as an initContainer that
# copies /plugin into the shared headlamp-plugins volume, then exits.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx headlamp-plugin tsc && npx headlamp-plugin build

# Minimal runtime: nothing but the built plugin, owned by a non-root user so
# the initContainer's own securityContext (runAsUser 100/runAsGroup 101,
# read-only root filesystem) can read and copy it without any privilege.
FROM alpine:3.20 AS runtime
RUN addgroup -g 101 headlamp && adduser -D -u 100 -G headlamp headlamp
COPY --from=build --chown=100:101 /src/dist /plugin
COPY --from=build --chown=100:101 /src/package.json /plugin/
USER 100:101
