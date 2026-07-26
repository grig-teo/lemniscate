# Test-runner image for the e2e smoke suite. The smoke tests execute INSIDE
# the compose network (docker run --network <project>_default) so the suite
# does not depend on published host ports — it works identically on a dev
# machine, in CI, and in sandboxed environments where the daemon's loopback
# is not the shell's loopback.
#
# Build context is tests/e2e (see run.sh); the test file is COPYed in rather
# than bind-mounted so the runner works even when the daemon cannot see the
# client's filesystem.
FROM node:24.18.0-alpine
# git: the suite asserts the pushed branch by cloning the fixture repo.
# bash/curl: run.sh's health-wait probes.
RUN apk add --no-cache git bash curl
WORKDIR /work
COPY smoke.test.mjs /work/tests/e2e/smoke.test.mjs
CMD ["node", "--test", "tests/e2e/smoke.test.mjs"]
