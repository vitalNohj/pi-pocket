# Native desktop updates

`desktop-builds.yml` uploads the full installers and two smaller, desktop-only installers. The
updater checks the latest successful `desktop-native` push run in `vitalNohj/pi-pocket`, not pull
request or manually dispatched builds. `0.30.1-desktop.N` identifies workflow run number `N`. It is
not the version floor for the server; that floor comes from the last full install.

GitHub requires sign-in to download Actions artifacts. Open the artifact link in the system browser
and select the downloaded `.exe` or `.pkg` in a native file picker. The app does not ask for or store a
GitHub token. It checks the selected file against the digest and size from GitHub before it stages
the installer. This is an integrity check from the fork's workflow, not a code signature. These
unsigned test-build artifacts expire after 14 days.

The updater keeps a pending record and the installer in the desktop install's `desktop-update-cache`
folder. Before a new app instance starts its own server, it checks for a staged update. A detached
helper waits for the old desktop process to exit, verifies the installer again, installs it for the
same user, then opens the app. A failed install records the result and opens the app without retrying
on every start. On Windows the update runs Inno Setup silently; on macOS it uses the home-directory
package target. Neither updater replaces Node, the server package, or its runner files.

Desktop Settings can use `check` to get the version and download URL, `stage` with the path selected
by the native picker, and `state` for the staged version or the last install result. For Apply now,
the host must let `handoff` take over only if it can quit without stopping a server. While the
app owns a server that quits with the app, keep the update staged for its next start. An app update
must not call Restart Server or stop a server to install the update.

The desktop workflow installs version N, checks and stages version N+1 from a loopback fixture, and
checks the restarted app, the existing console server, and the files kept across the update. The
fixture cannot change the update URL in a shipped app.
