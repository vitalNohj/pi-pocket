#!/bin/bash
# Copy the trace before running this: it removes the entire isolated run directory.
set -euo pipefail
if [[ "$#" == 1 && "$1" == --help ]]; then
    echo 'Usage: mac-stop.sh RUN_DIRECTORY (printed by mac-runner.sh)'
    exit 0
fi
if [[ "$#" != 1 || ! -d "$1" || -L "$1" ]]; then
    echo 'Usage: mac-stop.sh RUN_DIRECTORY (printed by mac-runner.sh)' >&2
    exit 2
fi
dir=$(cd "$1" && pwd -P)
if [[ ${dir##*/} != pi-pocket-perf.* || ! -O "$dir" || ! -f "$dir/.perf-runner-owned" || -L "$dir/.perf-runner-owned" ]]; then
    echo 'Not a run directory made by mac-runner.sh; nothing stopped or removed.' >&2
    exit 2
fi

if [[ -f "$dir/runner.pid" ]]; then
    read -r pid < "$dir/runner.pid"
    if [[ ! $pid =~ ^[1-9][0-9]+$ ]]; then
        echo 'Invalid runner PID; nothing stopped or removed.' >&2
        exit 2
    fi
    runner_alive() {
        local command
        command=$(ps -ww -o command= -p "$pid" 2>/dev/null) || return 1
        [[ $command == *"$dir/checkout/bin/pi-pocket.js runner start" ]]
    }
    if runner_alive; then
        kill -TERM "$pid"
        for _ in {1..25}; do
            runner_alive || break
            sleep 0.2
        done
        if runner_alive; then
            echo 'Runner still running. Stop it in its terminal, then retry.' >&2
            exit 1
        fi
    fi
fi
rm -rf -- "$dir"
printf 'removed: %s\n' "$dir"
