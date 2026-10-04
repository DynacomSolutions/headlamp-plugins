# Ships the agent-memory Headlamp plugin's already-built dist/ output. This
# image is never run as a long-lived workload: Headlamp's Deployment uses it
# purely as an initContainer that copies /plugin into the shared
# headlamp-plugins volume, then exits. The JS is built by the CI workflow on
# the runner (see .github/workflows/image.yml), not inside this docker build.
FROM alpine:3.20
RUN addgroup -g 101 headlamp && adduser -D -u 100 -G headlamp headlamp
COPY --chown=100:101 dist /plugin
COPY --chown=100:101 package.json /plugin/
USER 100:101
