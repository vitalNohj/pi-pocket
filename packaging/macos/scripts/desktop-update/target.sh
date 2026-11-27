#!/bin/bash
# Both package phases check the same per-user location. Do not send any quit notices.
desktop_target() {
    local support="$HOME/Library/Application Support/Pi Pocket" target id
    if [ "$(id -u)" = 0 ] || [ "$1" != "$support/desktop-update-payload" ] ||
        [ ! -f "$support/runtime-floor.txt" ]; then
        echo 'A desktop update needs a full per-user Pi Pocket install.' >&2
        return 1
    fi

    if pgrep -q -U "$(id -u)" -f '/Pi Pocket[.]app/Contents/MacOS/Pi Pocket([[:space:]]|$)'; then
        echo 'Pi Pocket.app must close before the desktop update.' >&2
        return 1
    fi

    for target in "$HOME/Applications/Pi Pocket.app" "$support/Pi Pocket.app"; do
        id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$target/Contents/Info.plist" 2>/dev/null) || continue
        if [ "$id" = io.github.tannermidd.pi-pocket.launcher ] && [ ! -L "$target" ]; then
            printf '%s\n' "$target"
            return 0
        fi
    done

    echo 'No installed Pi Pocket.app was found to update.' >&2
    return 1
}
