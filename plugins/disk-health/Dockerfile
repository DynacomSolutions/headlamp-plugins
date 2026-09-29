# Ships the disk-health Headlamp plugin's already-built dist/ output. This
# image is never run as a long-lived workload: Headlamp's Deployment uses it
# purely as an initContainer that copies /plugin into the shared
# headlamp-plugins volume, then exits.
#
# The JS is built by the CI workflow on the runner itself (setup-node + `npm
# ci`/`npm run build`), not inside this docker build: the runner's DinD
# daemon's default MTU (1500) is larger than this cluster's pod network MTU,
# and large packets get silently dropped, which makes `npm ci`'s HTTPS
# fetches hang and crash when run inside `docker build`. Doing the
# network-heavy install on the runner instead of inside DinD avoids that.
# See .github/workflows/image.yml.
FROM alpine:3.20
RUN addgroup -g 101 headlamp && adduser -D -u 100 -G headlamp headlamp
COPY --chown=100:101 dist /plugin
COPY --chown=100:101 package.json /plugin/
USER 100:101
