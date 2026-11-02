# Sessions on another computer

As the server owner, you can link a computer in 2 ways:

- **Pi Pocket desktop app:** open your server in the app on the computer you want to link. Go to Menu → **Runners** → **Link a computer**, enter a name, and choose **Link this computer**. The app links it with one click and keeps the runner running while the app is open. There is nothing to type in a terminal.
- **Any other computer:** install Node.js 22.19 or newer, then run these commands on that computer:

    ```sh
    npm install -g pi-pocket@latest
    pi-pocket runner
    ```

    In Pi Pocket, go to Menu → **Runners** → **Link a computer**. Enter a name, then choose **Get a link code** in a browser, or **Link another computer** in the desktop app. The screen shows the commands above and a code. The code works once and expires after 10 minutes.

    `pi-pocket runner` opens a menu: use the arrow keys and Enter. Choose **Link this computer**, enter the server address, such as `https://pocket.example.com`, then paste the code. The runner checks that Pi Pocket answers at that address and saves the link. Then choose **Start**, and leave the terminal open. On Linux with systemd, **Run as a service** keeps it running after the terminal closes. Press Ctrl+C to stop the runner and its commands.

Only the server owner can link computers. Only link a server you trust: its session commands run as your user account on the linked computer.

The computer connects out to the server over a WebSocket. It needs no open port, SSH, or provider key. Pi, its models, the provider keys, and session history stay on the server. Sessions read and write files and run commands, including git, on the linked computer.

## Commands

Run these commands on the linked computer:

| Command                                 | What it does                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pi-pocket runner`                      | In a terminal, opens a menu: link, start, settings, service, unlink, and help. Without a terminal, it starts.   |
| `pi-pocket runner start`                | Runs with the saved link, without questions. The service and the desktop app use this command.                  |
| `pi-pocket runner link <server> <code>` | Saves a link without questions. Use the server address and a one-time code from **Runners**.                    |
| `pi-pocket runner settings`             | Shows the settings. `settings confirm on\|off` and `settings http allow\|refuse` change them.                   |
| `pi-pocket runner status`               | Shows the saved link and whether the systemd service is running. It does not check the connection.              |
| `pi-pocket runner unlink`               | Deletes the saved link on this computer. Also remove the computer in **Runners** to stop it and cancel its key. |
| `pi-pocket runner service`              | On Linux with systemd, starts a user service that keeps the runner running after you close the terminal.        |
| `pi-pocket runner service remove`       | Stops and removes the service. Keeps the saved link.                                                            |

For scripts, use `pi-pocket runner link <server> <code>`, then `pi-pocket runner start` or `pi-pocket runner service`.

The link file is `~/.pi-pocket/runner.json`. It contains this computer's key, and only your user account can read it. Do not share it. Use `--config FILE` or `PI_POCKET_RUNNER_CONFIG` to choose another file; `--config` takes priority. `PI_POCKET_RUNNER_DAEMON` selects a pi-env daemon instead of the packaged one.

The systemd user service starts with your user session. To keep it running while you are logged out, run:

```sh
loginctl enable-linger $USER
```

Run `pi-pocket runner` again to start, change, or replace a saved link. If the service is already running, the menu offers to stop it instead of starting a second runner. To delete the link as well as the service, run `pi-pocket runner service remove`, then `pi-pocket runner unlink`. Deleting the link file alone does not stop a runner that is already running.

If your server uses a build that is not on npm, set `PI_POCKET_RUNNER_PACKAGE` on the server. For example, use the URL of a fork's package tarball. This changes the install command shown in **Runners**.

## Asking before a session starts

By default, the runner asks on the linked computer before a session starts there, including forks. It shows who asks, the server, and the folder. **Deny** is the default answer. If nobody answers within 2 minutes, the session does not start.

- In a terminal, the runner asks with a menu and a bell.
- In the desktop app, a dialog asks.
- A systemd service cannot ask. With asking on, it refuses new sessions.

To turn asking off, choose **Settings** in the `pi-pocket runner` menu, run `pi-pocket runner settings confirm off`, or turn off **Ask before new sessions** in the desktop app. Sessions that already run are not asked again.

## Plain HTTP

The runner sends this computer's key and every command to the server, so it uses HTTPS. It allows plain HTTP only:

- To this computer (`localhost`, `127.x`).
- To a device on your tailnet. The runner asks Tailscale itself (`tailscale whois`), so an address that only looks like a Tailscale address is not enough. Tailscale encrypts the traffic.

To link a server on another plain HTTP address, choose **Allow plain HTTP** when the runner asks, or run `pi-pocket runner settings http allow`. Do this only on a network you trust.

## What works in a session

In Menu → **Runners**, choose **New session** next to an online computer, then choose a folder on it. The session's title, top bar, and Pi's system prompt identify the computer. Forks keep the same computer.

Pi's `read`, `write`, `edit`, and `bash` tools run on that computer through Earendil's [pi-env](https://www.npmjs.com/package/@earendil-works/pi-env). They work as they do on the server. Goals, plans, questions, and schedules also work.

These features are not available yet in sessions on another computer, because they use the server's disk:

- Background tasks, the browser, artifacts, design, and memory.
- Subagents and teams, PR watches, and git worktrees.
- The **Files** and **Changes** panels, and the folder's project context and skills.

Files that people attach stay on the server. They are not copied to the linked computer.

## Sharing

Only the person who linked a computer can start sessions on it, including forks. Sharing does not change this rule.

By default, a session on a linked computer is private to its creator. Other people cannot see it in their session list, open it, prompt it, or fork it. This includes other server owners. These access rules also protect a private session's forks and subagents.

The owner can turn on **Let others use these sessions** in Menu → **Runners** (`sharedRunnerSessions` in the server's `config.json`). These sessions then follow the usual sharing rules. People who can see a session can prompt it, and its commands run on the linked computer for them too. Turning sharing off closes those sessions in everyone else's tabs at once.

This setting applies to the whole server. In the future, sharing could be chosen per session: who can see it, who can prompt it, and whether tool calls need the linker's approval when someone else requested them.

## When the connection drops

| What happens                             | What happens to the work                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A short drop, up to 2 minutes            | Nothing is lost. Commands keep running. Their output arrives when the runner reconnects.                                                                   |
| A longer drop, such as sleep or app exit | Running commands stop, and Pi is told the computer "was disconnected too long". New tool calls fail at once with "is offline" until the runner reconnects. |
| The server restarts                      | As with sessions on the server, running commands return as interrupted. The session continues.                                                             |

Removing a computer in **Runners** stops its runner and cancels its key. A runner that the server removed exits with code 3. Its systemd service does not restart it.
