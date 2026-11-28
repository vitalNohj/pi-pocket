# Native runner controller

The desktop controller owns one `RunnerController` per desktop instance. Construct it with `installedRunner({ stateDir })`, `runnerPolicy(stateDir)` and a `publish(snapshot)` callback. Use a separate `runner` directory inside the desktop state directory. Call `boot()` at startup, even when the window is hidden, and await `close()` before the desktop controller exits. Do not tie it to the Home connection or stop it when a window closes.

The native `runner-host` reads only named runner operations. It starts the install's Node and workspace `pi-pocket-runner` in the user's home. It uses an owned Windows job or macOS process group. Closing its private input pipe stops that command, also when the desktop controller crashes. A one-time code goes through that pipe and the CLI's required argument, not in the helper's arguments, logs or state. The desktop never opens `link.json` or starts a service.

## Settings seam

- The card displays `label`. The tray model reduces connection states to Off, Connecting and Connected, with Working now taking precedence. `workingFolders` is a count, not a list. `log` has at most 40 display-safe lines.
- Call `link({ server, code, allowHttp, trusted, confirmed })`, `setEnabled(enabled, confirmed)`, `reconnect(confirmed)` and `unlink(confirmed)` from registered `runner.*` actions in the private Settings view. Do not expose the actions to a server page. The enabled switch is saved by the action, not by a generic preference patch.
- Show the trust warning before accepting a code. A server can run commands as the current OS user, without a sandbox. Prefill an editable full address from Home, not a sign-in link. Keep plain HTTP off by default. Clear the code and plain HTTP switch after each submitted attempt.
- Ask before submitting an action that stops work. The controller also rejects an unconfirmed action with `runner.confirm` if the state changed. Never retry a link request with the same code. A failed link keeps the old link.
- `running` means that the controller owns a child. Warn before Quit if a child is running, even if `working` is false. Closing the window to the tray is not Quit.

The single build source setting is `DESKTOP_RUNNER_SOURCE` in `source.mjs`. Full installers pack that checkout’s workspace runner. The card shows the source, not an update channel.

Run the Linux fixtures with `node --test test/desktop/runner*.test.mjs`. Windows and macOS installer jobs run `test/desktop/runner-installed.mjs` for the process adapter and `test/desktop/runner-app.mjs` for the installed GUI, with npm blocked. The server and the link belong only to those tests.
