#!/bin/bash
# Run after the normal installer smoke quits. All server state here is disposable.
set -euo pipefail
here="$(dirname "$0")"
out="$RUNNER_TEMP/window-evidence"
export PI_POCKET_DESKTOP_STATE="$RUNNER_TEMP/window-state"
export PI_POCKET_DIR="$RUNNER_TEMP/window-data"
app="$BUNDLE/Contents/MacOS/Pi Pocket"
page="$(dirname "$MANIFEST")/web/app.js"
driver="$RUNNER_TEMP/native-window-fixture"
existing="$HOME/Downloads/window-fixture.txt"
completed="$HOME/Downloads/window-fixture (2).txt"
pid=""
mkdir -p "$out" "$PI_POCKET_DESKTOP_STATE" "$HOME/Downloads"

# macOS does not ship a timeout command. Bound external calls as well as the polling loops so an
# unresponsive native driver or quit command still reaches the failure screenshot handler.
bounded() {
    node -e '
        const { spawnSync } = require("node:child_process");
        const [seconds, file, ...args] = process.argv.slice(1);
        const child = spawnSync(file, args, {
            stdio: "inherit", timeout: Number(seconds) * 1000, killSignal: "SIGKILL",
        });
        if (child.error) console.error(file + ": " + child.error.message);
        process.exit(child.status ?? 1);
    ' "$@"
}

drive() { bounded 5 "$driver" "$pid" "$@"; }
shot() { bounded 10 screencapture -x "$out/$1.png"; }
stopped() { ! kill -0 "$pid" 2>/dev/null; }

wait_until() {
    local deadline=$((SECONDS + $1))
    shift
    until "$@"; do
        if (( SECONDS >= deadline )); then return 1; fi
        sleep 1
    done
}

wait_for() {
    local stage="$1"
    shift
    if wait_until "$@"; then return; fi
    echo "The $chrome window did not $stage." >&2
    return 1
}

cleanup() {
    local status=$?
    if [ "$status" != 0 ]; then
        shot failure || true
        grep -E 'download|window is signed in' "$LOG" || true
        ls -l "$HOME/Downloads/"window-fixture* || true
    fi
    if [ -n "$pid" ]; then
        # Stop only the fixture's own child. Do not wait indefinitely in the failure handler.
        if ! stopped; then kill -TERM "$pid" 2>/dev/null || true; fi
        if wait_until 3 stopped; then wait "$pid" || true; fi
    fi
    if [ -f "$page.saved" ]; then
        mv -f "$page.saved" "$page"
        rm -f "$existing" "$completed"
    fi
}
trap cleanup EXIT
trap 'exit 124' INT TERM

bounded 60 swiftc "$here/window-macos.swift" -o "$driver"
cp "$page" "$page.saved"
printf 'Keep the existing file\n' > "$existing"
bounded 10 node "$here/window-fixture.mjs" "$MANIFEST" "$RUNNER_TEMP/window-files"
# Select local Home only in the fixture. A real fresh install must show both choices.
printf '%s\n' '{"schemaVersion":1,"preferences":{"home":{"mode":"local"}}}' > "$PI_POCKET_DESKTOP_STATE/desktop.json"

has_windows() { [ "$(drive count)" = "$1" ]; }
signed_in() { grep -q 'The window is signed in.' "$LOG" 2>/dev/null && has_windows 1; }

for chrome in system seamless; do
    printf '{"titleBar":"%s"}\n' "$chrome" > "$PI_POCKET_DESKTOP_STATE/window.json"
    # The launcher rotates its log on each start. Wait only for this fixture's sign-in.
    if [ -f "$LOG" ]; then mv "$LOG" "$RUNNER_TEMP/window-before-$chrome.log"; fi
    "$app" &
    pid=$!
    wait_for 'sign in' 45 signed_in
    sleep 2
    shot "$chrome-light"

    offset=0
    if [ "$chrome" = system ]; then offset=24; fi
    if [ "$chrome" = seamless ]; then
        drive click 616 212
        wait_for 'save the session file without replacing the existing file' 30 test -f "$completed"
        grep -qx 'Keep the existing file' "$existing"
        grep -qx 'Pi Pocket desktop download fixture' "$completed"
        sleep 2
        shot download

        before_save="$(drive window-ids)"
        drive click 752 212
        wait_for 'open the Save sheet' 12 drive save-open "$before_save"
        shot save-dialog
        if ! drive escape || ! wait_until 4 drive save-closed "$before_save"; then
            drive cancel-save "$before_save"
        fi
        wait_for 'close the Save sheet' 12 drive save-closed "$before_save"
        [ ! -e "$HOME/Downloads/window-dialog.txt" ]
    fi

    # WindowServer's Save sheet can disappear before WebKit receives input again.
    bounded 12 "$driver" "$pid" click-verified 344 "$((212 + offset))" 'Dark theme'
    sleep 2
    shot "$chrome-dark"
    bounded 12 "$driver" "$pid" click-verified 480 "$((212 + offset))" 'Extra window'
    wait_for 'open a second window' 20 has_windows 2
    sleep 2
    shot "$chrome-two-windows"
    bounded 5 "$app" --quit
    wait_for 'quit' 30 stopped
    wait "$pid"
    pid=""
done
printf '%s\n' 'System and Seamless; light and dark; a second window; existing name kept; Save dialog cancelled.' > "$out/assertions.txt"
