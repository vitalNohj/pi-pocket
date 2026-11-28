# Native desktop updates

`desktop-builds.yml` uploads the full installers and two smaller, desktop-only installers. The
updater checks the latest successful `desktop-native` push run in `vitalNohj/pi-pocket`, not pull
request or manually dispatched builds. `0.30.1-desktop.N` identifies workflow run number `N`. It is
not the version floor for the server; that floor comes from the last full install.

In **Desktop Settings → Updates**, see the current app version and the newest build. **Check now**
checks the fork. GitHub requires sign-in to download Actions artifacts, so **Download** opens
GitHub in the system browser. The app does not handle GitHub credentials. Use **Select installer…**
to pick the downloaded `.exe` or `.pkg`. The app checks its size and SHA-256 against GitHub's metadata.
This checks the file from the fork's workflow; it is not a code signature. These unsigned test
builds expire after 14 days.

When Settings shows **Ready to apply**, **Apply** stages the verified installer for the next
start. It does not close the app, restart a server, or update the server or runner. The Windows
tray and the macOS **π** menu show **Update ready - restart to apply** only after staging.

The updater keeps a pending record and the installer in the desktop install's `desktop-update-cache`
folder. Before a new app instance starts its own server, it checks for a staged update. A detached
helper waits for the old desktop process to exit, verifies the installer again, installs it for the
same user, then opens the app. A failed install records the result and opens the app without retrying
on every start. On Windows the update runs Inno Setup silently; on macOS it uses the home-directory
package target. Neither updater replaces Node, the server package, or its runner files.

The desktop workflow uses the installed Settings window to check and stage a fixture update on
Windows, Apple silicon, and Intel. It captures the Updates states and checks that the next app
start runs the new build. It also checks that the existing console server keeps running with the
same runtime, settings and data. A shipping app has no fixture feed override.
