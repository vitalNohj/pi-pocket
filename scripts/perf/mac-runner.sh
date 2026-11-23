#!/bin/bash
# Run in the foreground. Only sessions in the generated fixture are auto-approved.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 || "$1" == --help ]]; then
    echo "Usage: mac-runner.sh LINK_CODE [COPY_SERVER_URL]"
    [[ "$#" == 1 && "$1" == --help ]]
    exit
fi
server=${2:-http://100.102.233.84:8898}

node_bin=
for candidate in "$HOME/Library/Application Support/pi-pocket-gui/server/runtimes/"*/bin/node; do
    if [[ -x "$candidate" ]]; then
        node_bin=$candidate
        break
    fi
done
if [[ -z "$node_bin" ]]; then
    echo 'Pi Pocket desktop Node not found. Install the app and start its server once.' >&2
    exit 1
fi
export PATH="${node_bin%/*}:$PATH"
npm_cli=${node_bin%/bin/node}/lib/node_modules/npm/bin/npm-cli.js
if [[ ! -f "$npm_cli" ]]; then
    npm_cli=$(command -v npm) || { echo 'Install npm for this Node runtime.' >&2; exit 1; }
fi

umask 077
dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-pocket-perf.XXXXXXXX")
dir=$(cd "$dir" && pwd -P)
work=$dir/work
: > "$dir/.perf-runner-owned"
echo "Run directory (for mac-stop.sh): $dir"
mkdir -p "$dir/tmp" "$work/child/nested" "$work/second"
export TMPDIR="$dir/tmp" PI_POCKET_RUNNER_CONFIG="$dir/runner.json"
unset PI_POCKET_RUNNER_DAEMON PI_POCKET_PERF PI_POCKET_PERF_FILE

git clone --quiet --depth 1 --single-branch --branch perf/upstream https://github.com/vitalNohj/pi-pocket.git "$dir/checkout"
cd "$dir/checkout"
"$node_bin" "$npm_cli" ci --cache "$dir/npm-cache" --no-audit --no-fund

printf 'small fixture: original\n' > "$work/small.txt"
"$node_bin" -e 'require("node:fs").writeFileSync(process.argv[1], ("A".repeat(511) + "\n").repeat(100))' "$work/large.txt"
printf 'nested fixture\n' > "$work/child/nested/leaf.txt"
ln -s child "$work/alias"
git -C "$work" init -q
printf '\n.runner-perf.jsonl\n' >> "$work/.git/info/exclude"
git -C "$work" add small.txt large.txt child/nested/leaf.txt alias
git -C "$work" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name='Pocket Perf' -c user.email='perf@example.invalid' commit -qm fixture

cli=$dir/checkout/bin/pi-pocket.js
"$node_bin" "$cli" runner link "$server" "$1"
# Leave the app's own runner, link, and approvals alone. Approve only the new fixture for this test link.
"$node_bin" - "$PI_POCKET_RUNNER_CONFIG" "$work" <<'NODE'
const fs = require('node:fs');
const [, , file, folder] = process.argv;
const link = JSON.parse(fs.readFileSync(file, 'utf8'));
link.settings = { ...link.settings, confirm: false, folders: [folder], network: false };
fs.writeFileSync(file, JSON.stringify(link));
NODE

export PI_POCKET_PERF=1 PI_POCKET_PERF_FILE="$work/.runner-perf.jsonl"
printf '%s\n' "$$" > "$dir/runner.pid"
printf 'Fixture folder: %s\nRunner timings: %s\n' "$work" "$PI_POCKET_PERF_FILE"
exec "$node_bin" "$cli" runner start
