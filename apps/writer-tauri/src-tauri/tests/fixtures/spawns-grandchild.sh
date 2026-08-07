#!/bin/sh
# Stand-in for the sidecar in process-group teardown tests.
#
# The real sidecar (node) spawns the `claude` CLI as its own child, so from
# the Rust client's point of view that CLI is a *grandchild*. `kill_on_drop`
# only reaps the direct child, which is why the grandchild is the thing that
# leaks. This fixture reproduces that shape with no token and no network:
# `sleep` plays the CLI's part.
#
#   $1 — path to write the grandchild's pid to
sleep 300 &
echo $! > "$1"

# Block like a real sidecar waiting on its stdin, so the fixture stays alive
# until the client tears it down rather than exiting on its own.
cat
