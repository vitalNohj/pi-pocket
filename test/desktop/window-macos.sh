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
mkdir -p "$out" "$PI_POCKET_DESKTOP_STATE" "$HOME/Downloads"
swiftc "$here/window-macos.swift" -o "$driver"
printf 'Keep the existing file\n' > "$existing"
cp "$page" "$page.saved"
pid=""

cleanup() {
    if [ "$?" != 0 ]; then
        screencapture -x "$out/failure.png" || true
        grep -E 'download|window is signed in' "$LOG" || true
        ls -l "$HOME/Downloads/"window-fixture* || true
    fi
    if [ -n "$pid" ]; then
        "$app" --quit || true
        wait "$pid" || true
    fi
    mv -f "$page.saved" "$page"
    rm -f "$existing" "$completed"
}
trap cleanup EXIT
node "$here/window-fixture.mjs" "$MANIFEST" "$RUNNER_TEMP/window-files"

for chrome in system seamless; do
    printf '{"titleBar":"%s"}\n' "$chrome" > "$PI_POCKET_DESKTOP_STATE/window.json"
    # The launcher rotates its log on each start. Wait only for this fixture's sign-in.
    if [ -f "$LOG" ]; then mv "$LOG" "$RUNNER_TEMP/window-before-$chrome.log"; fi
    "$app" &
    pid=$!
    for _ in $(seq 1 60); do
        if grep -q 'The window is signed in.' "$LOG" 2>/dev/null && [ "$("$driver" "$pid" count)" = 1 ]; then break; fi
        sleep 1
    done
    grep -q 'The window is signed in.' "$LOG"
    [ "$("$driver" "$pid" count)" = 1 ]
    sleep 2
    screencapture -x "$out/$chrome-light.png"

    offset=0
    if [ "$chrome" = system ]; then offset=24; fi
    if [ "$chrome" = seamless ]; then
        "$driver" "$pid" click 616 212
        for _ in $(seq 1 20); do
            [ ! -f "$completed" ] || break
            sleep 1
        done
        grep -qx 'Keep the existing file' "$existing"
        grep -qx 'Pi Pocket desktop download fixture' "$completed"
        screencapture -x "$out/download.png"
        "$driver" "$pid" click 752 212
        sleep 2
        screencapture -x "$out/save-dialog.png"
        "$driver" "$pid" escape
        [ ! -e "$HOME/Downloads/window-dialog.txt" ]
    fi

    "$driver" "$pid" click 344 "$((212 + offset))"
    sleep 2
    screencapture -x "$out/$chrome-dark.png"
    "$driver" "$pid" click 480 "$((212 + offset))"
    for _ in $(seq 1 20); do
        [ "$("$driver" "$pid" count)" != 2 ] || break
        sleep 1
    done
    [ "$("$driver" "$pid" count)" = 2 ]
    sleep 2
    screencapture -x "$out/$chrome-two-windows.png"
    "$app" --quit
    wait "$pid"
    pid=""
done
printf '%s\n' 'System and Seamless; light and dark; a second window; existing name kept; Save dialog cancelled.' > "$out/assertions.txt"
