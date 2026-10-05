#!/bin/bash
# runloop.sh RUN PASS TIMES [every] — the pass in closed loop: plan a batch from
# the painting as it actually is, paint it, and plan the next from the result
set -e
for i in $(seq 1 $3); do "$(dirname "$0")/runpass.sh" $1 $2 ${4:-60} 2>&1 | grep -v "Warning\|xyz\|^  "; done
