#!/bin/sh
# Runs the plugin's tests with plain Node (24 or newer, for --experimental-transform-types), no Orca app.
# Tests that mount the worker are reported as skipped; run `orca plugin test .` for those.
set -e
cd "$(dirname "$0")/../.."
exec node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./tools/ci/register.mjs --test --test-concurrency=1 src/*.test.ts
