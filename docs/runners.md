# Sessions on another computer

As the server owner, you link a computer with a one-time code:

1. In Pi Pocket, go to Menu → **Runners** → **Link a computer**. Enter a name, then choose **Get a link code**. The screen shows the server address and the code. The code works once and expires after 10 minutes.
2. Give them to the runner on that computer:
    - **With the Pi Pocket desktop app:** the app has the runner built in. In its settings, under **Runner**, enter the address and code, then choose **Link**. The app keeps the runner running while it is open.
    - **Any other computer:** install Node.js 22.19 or newer, then run:

        ```sh
        npm install -g pi-pocket@latest
        pi-pocket runner
        ```

        `pi-pocket runner` opens a menu: use the arrow keys and Enter. Choose **Link this computer**, enter the server address, such as `https://pocket.example.com`, then paste the code. The runner checks that Pi Pocket answers at that address and saves the link. Then choose **Start**, and leave the terminal open. Press Ctrl+C to stop the runner and its commands.

Only the server owner can link computers. Only link a server you trust: its session commands run as your user account on the linked computer.

The computer connects out to the server over a WebSocket. It needs no open port, SSH, or provider key. Pi, its models, the provider keys, and session history stay on the server. Sessions read and write files and run commands, including git, on the linked computer.

## Commands

Run these commands on the linked computer:

| Command                                    | What it does                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pi-pocket runner`                         | In a terminal, opens a menu: link, start, settings, allowed folders, unlink, and help.                                                                                   |
| `pi-pocket runner start`                   | Runs with the saved link in this terminal or the desktop app.                                                                                                            |
| `pi-pocket runner link <server> <code>`    | Saves a link without questions. Use the server address and a one-time code from **Runners**.                                                                             |
| `pi-pocket runner settings`                | Shows the settings. `settings confirm on\|off`, `settings http allow\|refuse`, `settings network allow\|refuse`, and `settings downloads <folder>\|default` change them. |
| `pi-pocket runner folders`                 | Lists allowed folders, one per line, or "No allowed folders yet.". Add `--json` for a JSON array.                                                                        |
| `pi-pocket runner folders remove <folder>` | Removes an allowed folder. Unknown folders are an error. Running sessions keep running.                                                                                  |
| `pi-pocket runner status`                  | Shows the saved link, settings, and whether git and GitHub are ready. It does not check the connection.                                                                  |
| `pi-pocket runner unlink`                  | Deletes the saved link on this computer. Also remove the computer in **Runners** to stop it and cancel its key.                                                          |

The runner runs while its terminal or the desktop app is open, so that it can ask before a session starts.

For scripts, use `pi-pocket runner link <server> <code>`, then `pi-pocket runner start`.

The link file is `~/.pi-pocket/runner.json`. It contains this computer's key, and only your user account can read it. Do not share it. Use `--config FILE` or `PI_POCKET_RUNNER_CONFIG` to choose another file; `--config` takes priority. `PI_POCKET_RUNNER_DAEMON` selects a pi-env daemon instead of the packaged one.

Run `pi-pocket runner` again to start, change, or replace a saved link. Deleting the link file alone does not stop a runner that is already running.

If your server uses a build that is not on npm, set `PI_POCKET_RUNNER_PACKAGE` on the server. For example, use the URL of a fork's package tarball. This changes the install command shown in **Runners**.

## Asking before a session starts

By default, the runner asks on the linked computer before the first session in a folder, including forks and moving a session to another folder. It shows who asks, the server, and the folder. **Deny** is the default answer. If nobody answers within 2 minutes, the session does not start.

- In a terminal, the runner asks with a menu and a bell.
- In the desktop app, a dialog asks.

**Allow** also saves that folder on this computer. Later sessions in it or a folder inside it start without a question. The list stays in the runner settings in its link file, not on the server, and the runner reads it again for each question. Existing folders are compared by their real paths (including symlinks); macOS and Windows comparisons ignore case. A deleted allowed folder grants nothing.

For a file system root, a drive root, your home folder, or a folder that contains your home, the warning offers **Allow this session only**. It saves nothing. **Deny**, cancellation, and no answer save nothing. Sessions can still read and change files outside their starting folder: the list is permission to start, not a sandbox.

Use **Allowed folders** in the terminal menu or desktop app to see the list and remove an entry. The commands `pi-pocket runner folders [--json]` and `pi-pocket runner folders remove <folder>` also take `--config FILE`. Removing an entry makes future sessions ask again unless another allowed parent covers them; sessions that already run keep running. There is no command to add a folder: answer a question on the computer.

While the computer asks, the page shows a waiting dialog with the computer, folder, and time left. A quick answer skips the dialog. **Cancel** stops the request and withdraws the question on a runner that supports cancellation; no session starts. Older runners can keep their question open, but their late answer does not start the cancelled session.

To turn asking off, choose **Settings** in the `pi-pocket runner` menu, run `pi-pocket runner settings confirm off`, or turn off **Ask before new sessions** in the desktop app. Sessions that already run are not asked again.

## Plain HTTP

The runner sends this computer's key and every command to the server, so it uses HTTPS. It allows plain HTTP only:

- To this computer (`localhost`, `127.x`).
- To a device on your tailnet. The runner asks Tailscale itself (`tailscale whois`), so an address that only looks like a Tailscale address is not enough. Tailscale encrypts the traffic.

To link a server on another plain HTTP address, choose **Allow plain HTTP** when the runner asks, or run `pi-pocket runner settings http allow`. Do this only on a network you trust.

## What works in a session

In Menu → **Runners**, choose **New session** next to an online computer, then choose a folder on it. The session's title, top bar, and Pi's system prompt identify the computer. Forks keep the same computer, unless you choose another one in the fork sheet's **Computer** row. A copy can go from this server to a linked computer, back, or from one linked computer to another. A copy on a linked computer runs with that computer's list of extensions; a copy back on this server gets all extensions again. Pi gets a note with the new computer and folder, because paths earlier in the conversation were on the old ones.

Pi's `read`, `write`, `edit`, and `bash` tools run on that computer through Earendil's [pi-env](https://www.npmjs.com/package/@earendil-works/pi-env). They work as they do on the server. Goals, plans, questions, schedules, codemode, memory, PR watches, and [the browser](#the-browser) also work. Subagents and linked sessions that a session on a computer starts run on the same computer, and a linked session in the same folder starts without another question. A linked session in another folder follows the allowed-folders check. Subagents and reconnects do not ask.

Lessons stay with each project on its own computer; worktrees of that project share them. In **Memory**, **From …** sections offer approved lessons from other copies of the same GitHub repository. Choose **Add** to save one in this project; they never apply here automatically. PR watches read the origin and current branch on the linked computer, but poll GitHub from the server with the server's `gh` sign-in, not the computer's.

The runner checks git, the GitHub CLI (`gh`), and its GitHub sign-in when it starts and reconnects. **Runners** and `pi-pocket runner status` show whether git and GitHub are ready, with an install command or `gh auth login` when needed. A computer without them still works.

These also work, on that computer:

- The **Files** and **Changes** panels, the branch list, and **Show in the file manager** (it opens there).
- The folder's project context files (`AGENTS.md`, `CLAUDE.md`) and the skills there and in that computer's home folder. Project trust is kept for each computer.
- Files mentioned with `@`, read on that computer.
- Attachments: each is copied to `pi-pocket-uploads/<session>/` in that computer's temporary folder when the message is sent, and the message gives that path.

These are not available yet in sessions on another computer, because they use the server's disk: background tasks, artifacts, design, git worktrees, and drop-in extensions. A project's own `.pi/settings.json` and prompt templates on that computer are not read.

## The browser

The browser tool and the **Browser** panel work in a session on another computer. Chromium runs on the server, but every connection of its pages goes out from the linked computer:

- `localhost:5173` is the linked computer's port 5173. The Browser panel lists the ports that the computer listens on (`lsof` on macOS, `/proc/net/tcp` or `ss` on Linux, `netstat` on Windows).
- Names resolve with the computer's DNS, and pages use its routes, VPN, and local network. Sites see the computer's IP address.
- Pi's model calls do not change: they go out from the server.
- File paths and `file://` addresses do not open, because the browser would read the server's disk. Serve the files instead, for example with `python3 -m http.server`.

How it works: these pages use a second Chromium on the server, with a proxy built into Pi Pocket. Each session's pages have their own proxy credentials, which name the computer. The proxy sends each connection to the runner over its link, and the runner opens the TCP connection on the computer. Chromium's own background traffic and anything without valid credentials go to a proxy that refuses everything. WebRTC sends no UDP outside the proxy, and QUIC is off. If the computer is offline, the page fails with "<name> is offline". Nothing goes out from the server. A runner older than this feature gets the message "update its runner".

To stop sharing the network, choose **Settings** → **Share the network with browsers** in the `pi-pocket runner` menu, or run `pi-pocket runner settings network refuse`. The runner then refuses every connection, and pages show "<name> does not share its network". The change takes effect without a restart.

The risk: pages in the browser of a session on a computer can reach that computer's network (its `localhost`, the home network, a tailnet, a VPN) like any program on it. This is part of the risk of a runner. Pi and anyone who can steer the session's Browser panel can open such pages. Link only a server you trust, and turn off network sharing if the computer must not do this. Other programs on the server cannot use the proxy, because they do not have the credentials.

**Downloads.** A file that a page downloads goes to the computer's temporary folder, in `pi-pocket-downloads/<session id>/` (on macOS, the per-user `$TMPDIR`, not `/tmp`). To use another folder, run `pi-pocket runner settings downloads <folder>`. The files then go to `<folder>/<session id>/`. `pi-pocket runner settings downloads default` returns to the temporary folder. The runner tells the server about the folder when it connects, so a running runner uses a new folder after its next reconnect. The tool result gives the full path and the size. If the name is already used, the file gets a number, such as `report (2).pdf`. The bytes pass through the server: Chromium saves the file in the server's private temporary folder, Pi Pocket sends it over the runner link to the computer in parts, and then the server deletes its copy at once, also when the copy fails. Downloads larger than 2 GiB fail. In a session on the server, downloads go to `pi-pocket-downloads-<uid>/<session id>/` in the server's temporary folder. Only the server's user can open this folder (mode 0700). Pi Pocket refuses the folder if another user owns it or if it is a link.

**macOS desktop app.** On macOS 15 and later, connections to devices on the local network (not `localhost`) can need the **Local Network** permission. The desktop app runs the runner as a child process, so macOS can ask for this permission on behalf of the app. The app's `Info.plist` does not have an `NSLocalNetworkUsageDescription` yet, so the system prompt has no explanation. If pages on the local network fail with "No route to host", allow Pi Pocket in System Settings → Privacy & Security → Local Network. This was not tested on a Mac.

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

Removing a computer in **Runners** stops its runner and cancels its key. A runner that the server removed exits with code 3. The desktop app does not restart it.
