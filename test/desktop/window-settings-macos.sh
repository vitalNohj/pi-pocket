#!/bin/bash
# Sourced by the installed-window fixture. Drive the shipped Settings UI, not a test bridge.
index="$(dirname "$MANIFEST")/web/index.html"
bmp="$RUNNER_TEMP/window-backdrop.bmp"
wallpaper="$RUNNER_TEMP/window-backdrop.png"
cp "$index" "$index.evidence-original"
# The following installer checks reuse the per-user login item. Restore the original registration.
if [ -f "$AGENT" ]; then cp -p "$AGENT" "$RUNNER_TEMP/window-agent-original.plist"; fi

saved() { [ "$(plutil -extract "preferences.$1.$2" raw "$PI_POCKET_DESKTOP_STATE/desktop.json" 2>/dev/null)" = "$3" ]; }
# Settings uses a system title bar independent of the session window (28 points on these runners).
settings_click() { drive click "$1" "$(( $2 + 28 ))"; }
settings_select() { settings_click 450 "$1"; drive key "$2"; drive key 36; }
settings_open() { drive key 43 command; wait_for 'open Desktop Settings' 15 has_windows 2; sleep 2; }
quit_fixture_app() {
    bounded 5 "$app" --quit
    wait_for 'quit' 30 stopped
    wait "$pid"
    pid=""
}

bounded 10 node "$here/window-evidence.mjs" wallpaper "$bmp"
sips -s format png "$bmp" --out "$wallpaper" >/dev/null
bounded 10 "$driver" 0 wallpaper "$wallpaper"
# The download test reveals its file in Finder. Get it out of the wallpaper captures.
bounded 10 "$driver" 0 hide-finder
# Leave margins around the session window so the wallpaper is visible in the same capture.
defaults write io.github.tannermidd.pi-pocket.launcher 'NSWindow Frame Pi Pocket' '68 52 840 600 0 0 1024 768 '

for mode in light dark; do
    chrome="seamless-see-through-$mode"
    bounded 10 node "$here/window-evidence.mjs" theme "$index" "$mode"
    if [ -f "$LOG" ]; then mv "$LOG" "$RUNNER_TEMP/settings-before-$mode.log"; fi
    "$app" &
    pid=$!
    wait_for 'open the real Pi Pocket page' 60 signed_in
    if [ "$mode" = light ]; then
        settings_open
        settings_click 75 290 # Window
        settings_click 266 202
        wait_for 'save Close to tray off' 10 saved window closeToTray false
        settings_click 266 202
        wait_for 'save Close to tray on' 10 saved window closeToTray true
        if [ -f "$AGENT" ]; then
            settings_click 266 235
            wait_for 'remove the pre-existing Launch at login entry' 10 test ! -e "$AGENT"
        fi
        settings_click 266 235
        wait_for 'register Launch at login with macOS' 10 test -f "$AGENT"
        [ "$(plutil -extract ProgramArguments.5 raw "$AGENT")" = --login ]
        settings_click 266 267
        wait_for 'save Start hidden' 10 saved window startHidden true
        # WKWebView uses shorter Aqua selects than WebView2.
        settings_select 360 125 # System
        wait_for 'save System title bar' 10 saved window titleBar system
        settings_select 360 126 # Seamless
        wait_for 'save Seamless title bar' 10 saved window titleBar seamless
        settings_select 424 125 # Browser
        wait_for 'save browser link routing' 10 saved window links browser
        settings_select 424 126 # App
        wait_for 'save app link routing' 10 saved window links app
        settings_click 266 458
        wait_for 'register the global shortcut' 10 saved window shortcutEnabled true
        shot desktop-settings-window

        settings_click 75 327 # Appearance
        settings_click 266 253
        wait_for 'enable the see-through background' 10 saved appearance transparent true
        settings_click 350 323
        drive key 0 command
        drive key 19
        drive key 28
        drive key 48
        wait_for 'save opacity' 10 saved appearance opacity 28
        settings_select 390 125 # Sidebar
        wait_for 'save Sidebar material' 10 saved appearance material sidebar
        settings_select 390 126 # Window
        wait_for 'save Window material' 10 saved appearance material window
        shot desktop-settings-appearance
        drive escape
        wait_for 'return to Pi Pocket' 15 has_windows 1
        drive key 35 command shift
        wait_for 'hide Pi Pocket with the global shortcut' 10 has_windows 0
        drive hotkey 35 command shift
        wait_for 'show Pi Pocket with the global shortcut' 10 has_windows 1
    fi
    sleep 2
    shot "$chrome"
    quit_fixture_app
done

"$app" --login &
pid=$!
wait_for 'start the local server at login' 60 test -f "$PI_POCKET_DIR/launcher-running.json"
sleep 2
has_windows 0
drive hotkey 35 command shift
wait_for 'restore the saved global shortcut after login' 20 has_windows 1
drive key 13 command
wait_for 'hide instead of closing the app' 10 has_windows 0
! stopped
drive hotkey 35 command shift
wait_for 'restore the closed window with the global shortcut' 10 has_windows 1
settings_open
settings_click 75 290
settings_click 266 235
wait_for 'remove Launch at login' 10 test ! -e "$AGENT"
settings_click 266 267
wait_for 'save Start hidden off' 10 saved window startHidden false
settings_click 266 202
wait_for 'save Close to tray off' 10 saved window closeToTray false
quit_fixture_app
"$app" --login &
pid=$!
wait_for 'show the window at login with Start hidden off' 60 has_windows 1
drive key 13 command
wait_for 'quit on close with Close to tray off' 30 stopped
wait "$pid"
pid=""
mv -f "$index.evidence-original" "$index"
printf '%s\n' 'Changes made through installed Settings survived Quit. The LaunchAgent, title bar choices, and the global shortcut applied in the installed app.' > "$out/settings-assertions.txt"
