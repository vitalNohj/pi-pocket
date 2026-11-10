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

**Wrong link codes.** The server counts wrong codes for each client address. Five wrong codes in 10 minutes lock that address out of linking for 10 minutes. The third lockout of an address bans it; its count starts over a week after its last lockout. A banned address gets the same answer as a wrong code. The ban stays until you lift it in **Runners**, under **Banned from linking**. The address of this server's own machine is never banned, because every client of an unnamed proxy shares it.

Above that, a ceiling catches guessing from many changing addresses: 50 wrong codes in 10 minutes from all addresses together pause new linking for 10 minutes and void every open code. Linked computers and their keys are not affected. **Runners** says when an address or the whole server is locked, and why.

The server takes the client address from the connection. It believes a proxy's header only for its own proxy: Cloudflare's `CF-Connecting-IP` behind the Cloudflare tunnel, and Tailscale Serve's `X-Forwarded-For` behind Tailscale Serve, when `tailscale whois` names that address as a device of the tailnet. Both only for requests from this machine. Without a working `tailscale` command, no address counts as a tailnet device.

The computer connects out to the server over a WebSocket. It needs no open port, SSH, or provider key. Pi, its models, the provider keys, and session history stay on the server. Sessions read and write files and run commands, including git, on the linked computer.

## Secure link

The link has its own keys, like SSH, on top of HTTPS (`src/runner/secure-link.ts`):

- The server has one key, made once and kept in its data folder. It does not change when the website certificate renews.
- Each computer makes its own key when it links. Its private key stays on that computer; the server keeps only its public key.
- The link code never travels. The runner proves it knows the code, and the server proves it knows the code too, so someone in the middle at link time cannot put in their own key.
- The runner keeps the server's key. On each connection, each side proves its key, and every message after that is encrypted and signed. A server without the key, even one with a valid certificate, is refused, and the runner stops with: "… did not prove it is the server this computer linked to."
- `pi-pocket runner status` shows both keys' fingerprints. **Runners** shows the server's where it makes the code, and each computer's on its card. They should match.

A computer linked by an older runner shows **Link again** in **Runners**. It makes a code for that computer: link it with that code, and it keeps its sessions and people. Replacing the server's data folder makes a new server key: every computer must link again.

## Commands

Run these commands on the linked computer:

| Command                                                | What it does                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-pocket runner`                                     | In a terminal, opens a menu: start, run as a service, link again, unlink, and help.                                                                                          |
| `pi-pocket runner start`                               | Runs with the saved link in this terminal or a program that runs the runner, such as the desktop app.                                                                        |
| `pi-pocket runner link <server> <code> [--allow-http]` | Saves a link without questions. Use the server address and a one-time code from **Runners**. See [Plain HTTP](#plain-http).                                                  |
| `pi-pocket runner service [remove]`                    | Runs as a systemd user service on Linux, or starts at sign-in with a Windows scheduled task or macOS launch agent. `service remove` stops and removes it and keeps the link. |
| `pi-pocket runner status`                              | Shows the saved link, both keys' fingerprints, and whether git and GitHub are ready. It does not check the connection.                                                       |
| `pi-pocket runner unlink`                              | Deletes the saved link on this computer. Also remove the computer in **Runners** to stop it and cancel its key.                                                              |

The runner asks nothing on the computer. Everything about who may use it, and where, is decided in Pi Pocket ([Who may use a computer](#who-may-use-a-computer)).

### A computer nobody sits at (Linux)

`pi-pocket runner service` keeps the runner running as a systemd user service (`pi-pocket-runner.service`), for a computer such as a build server. Nobody needs to sit at the computer: approvals happen in Pi Pocket.

The service uses the Node.js, Pi Pocket, link file, and `PATH` of the shell that installed it. Install Pi Pocket with npm first (`npm install -g pi-pocket`): a copy in the npx cache is refused, because npm can clear it. Its log is in `journalctl --user -u pi-pocket-runner.service`. To keep it running while you are logged out, run `loginctl enable-linger $USER`. `pi-pocket runner service remove` stops and removes it.

### Start at sign-in (Windows and macOS)

On Windows and macOS, `pi-pocket runner service` starts the runner now and each time you sign in. These are per-user sign-in jobs, not system services: they do not run while you are signed out. A copy of Pi Pocket in the npx cache is refused on all three systems; install with `npm install -g pi-pocket@latest` first.

- **Windows:** installs the **Pi Pocket runner** scheduled task in Task Scheduler. It runs as the current user at log-on, without admin rights or a password. It uses the selected Node.js, Pi Pocket, and link file, and starts in your home folder. The task can run on battery power, has no time limit, and retries failures up to 3 times, 1 minute apart. If Windows refuses registration, the command prints the PowerShell error and fails; it does not try another installation method. To check task history, open Task Scheduler → Task Scheduler Library → **Pi Pocket runner** → **History** (enable task history if needed). This history records task events; it does not save the runner's console output.
- **macOS:** writes `~/Library/LaunchAgents/dev.pi-pocket.runner.plist` and loads it into your signed-in GUI session. It uses the selected Node.js, Pi Pocket, link file, and the current shell's `PATH`. Both output and errors go to `~/Library/Logs/pi-pocket-runner.log`. launchd restarts failures with a 10-second throttle. A runner stopped permanently by the server prints its message and exits with code 0 in macOS service mode so launchd does not restart it. Other modes and platforms keep exit code 3 for this.

`pi-pocket runner status` names a running scheduled task or launch agent. The terminal menu names the same mechanism. `pi-pocket runner service remove` stops and removes the scheduled task or launch agent, but keeps the saved link.

For scripts, use `pi-pocket runner link <server> <code>`, then `pi-pocket runner start`.

The link file is `~/.pi-pocket/runner.json`. It contains this computer's key, and only your user account can read it. Do not share it. Use `--config FILE` or `PI_POCKET_RUNNER_CONFIG` to choose another file; `--config` takes priority. `PI_POCKET_RUNNER_DAEMON` selects a pi-env daemon instead of the packaged one.

Run `pi-pocket runner` again to start, change, or replace a saved link. Deleting the link file alone does not stop a runner that is already running.

If your server uses a build that is not on npm, set `PI_POCKET_RUNNER_PACKAGE` on the server. For example, use the URL of a fork's package tarball. This changes the install command shown in **Runners**.

## Who may use a computer

After the link, the runner trusts its server: the server already sends it every tool call, so a check on the computer would not stop a server that was broken into. Pi Pocket decides, with the same rules for linked computers and for **This server** (`src/server/access.ts`):

- **In charge.** The person who linked a computer is in charge of it; the owner is in charge of **This server**. The owner links runners, and may let a guest link their own (**May link runners** in **People**). The owner can unlink any runner, but sees no folders or sessions on a runner someone else linked unless that person chooses them.
- **The computer.** Who is in charge chooses the people who may use it, in Menu → **Runners** → **Choose people**. Nobody else can see its sessions, browse it, or start anything there.
- **Folders.** Who is in charge gives each chosen person their folders on it, under **Folders** on the computer's card. A given folder covers the folders inside it. Any other folder is refused: the folder picker shows only the given folders, and a person cannot ask for others.
- **Approvals.** Each session has one approval. A person starting a session on a computer they are not in charge of approves it with a code from their own authenticator, which they link to their account (Menu → their name), or waits for **Allow** from who is in charge, in Pi Pocket. Nothing is asked on the computer. Who is in charge is never asked on their own computer.
- **Time.** The approval lasts for the approval time of whoever used the session last, counted from that use: 7 days by default. The owner sets each person's time in **People**: 1, 7, 14, or 30 days, or never ends.
- **Locked.** When the approval ends, the session is locked: new messages, settings, and task changes wait until its starter's code, or **Allow** from who is in charge, renews it. Stopping work never waits.
- **Viewers** read sessions they may see and use the people chat; they never need a code. Steering takes an authenticator and **Let steer** from the owner.

Each person sees the approvals of the sessions they started, and who is in charge sees every one on their computers, with **Revoke** and **Renew**. Removing a person, taking them off a computer, or taking back a folder hands their sessions and tasks there to who is in charge; nothing stops.

Work under way runs to its end, with its subagents and linked sessions; an ended approval only stops what comes next. A copy, a move, or a linked session on the same computer inherits its source's approval. Tasks that run on their own follow their session's approval only when the owner turns on **Tasks expire with the session** (then they run for 7 more days, with reminders, and pause).

### What a session can reach on the computer

Each request from the server names its session and that session's folder. The runner refuses a request that names none, except the folder picker's listings. Each path in a request must be in the session's folder or below it, or in the session's own folders for its attached files, background task logs, browser downloads, and git worktrees (named by its permission id), or in the temporary folders the session made. Pi can also read, not change, its context files (`AGENTS.md`, `CLAUDE.md`) in the folders above, and the skills in `.agents/skills/` there and in your home folder. Commands run in the session's folder.

This is not a sandbox. A command still runs as you, and it can read and change files outside its folder. The runner's check catches a mistake on the server, not a server that was broken into.

## Continue a Pi session

Choose a computer in **New session**, then **Continue a Pi session…**. This lists Pi's terminal sessions on that computer. A continued session is a new Pocket session that runs on the same computer; Pi's original file is never changed.

| Step     | The server gets                                                                 | Who decides                                              |
| -------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| List     | For each Pi session: path, Pi's session id, title, cwd, modified, message count | The server: people who may start sessions there          |
| Search   | A filter on title and cwd only, done on the server over the list                | The server, over the list                                |
| Preview  | That one session's model and last messages, as in a local preview               | The server: people who may start sessions there          |
| Continue | That one session file                                                           | The server: a new session in its folder, approved as any |

The title is Pi's name for the session, or the first line of its first message, up to 80 characters. Only people who may start sessions on that computer get the list or a preview. Continue is a new session in the Pi session's folder: that folder must be one given to them, and it is approved as any new session is (their own code, or whoever is in charge of the computer).

The runner looks in `PI_CODING_AGENT_SESSION_DIR`, then Pi's `sessionDir` setting, then Pi's default session folder. The list has at most 300 sessions, newest first, and is cached for 5 seconds. Preview and continue check Pi's list afresh. The runner opens only a Pi file whose folder is in the new session's folder, and lets only that session read that one file for at most 5 minutes, never write it.

Files that extensions keep beside Pi's file come along too (with companion files, TannerMidd/pi-pocket#262), for example Billion Context's `.acp.json`. With the Pi file, Pocket names the suffixes the extensions here registered. The runner allows the session to read each of those that exists beside the file, the same way, and no other. Pocket reads each one, gives the extension a copy on the server, and removes the copy when the extension is done. A companion that cannot be read stays behind, and the session still opens. Runners from before this change allow only the Pi file, so nothing comes along.

## Programs that run the runner

A program that runs the runner, such as the desktop app, starts it with `pi-pocket runner start --confirm-via stdio`.

The runner says when sessions work on the computer, for a tray icon, keeping the computer awake, or a warning on quit. It writes a line `PI-POCKET-ACTIVITY` and a JSON object, `{ "working": true, "folders": ["/Users/me/project"] }`, each time the state changes. The first line comes when work starts, so a program that saw none can take the runner as idle.

- `working`: sessions use this computer now.
- `folders`: the real folders of those sessions, sorted. Empty when `working` is false.

A file or command request of a session counts from when the runner sends it to the computer's tool process until its result, so a long command counts all the time it runs. Folder listings for the folder picker, file watches, and the browser's network connections do not count. The line says nothing about the commands, tools, or sessions themselves.

The state is smoothed, so short requests do not make it flicker. A folder shows after its work lasted 0.5 s, and stays 5 s after its last request ended, so the requests of one turn show as one stretch of work. When the runner stops, it writes a last line with `working` false if it was working.

## Runner settings in Pi Pocket

Each computer's card in **Runners** has its settings, for the owner:

- **Share the network with browsers** (on by default): see [The browser](#the-browser).
- **Downloads folder**: where browser downloads go on the computer.
- **Plain HTTP**: shown only. It is set on the computer, when it links ([Plain HTTP](#plain-http)).

The server sends a change to the runner at once, and again each time it connects. Nothing is saved on the computer but the link.

## Plain HTTP

The link encrypts every command (see [Secure link](#secure-link)), but the runner still uses HTTPS. It allows plain HTTP only:

- To this computer (`localhost`, `127.x`).
- To a device on your tailnet. The runner asks Tailscale itself (`tailscale whois`), so an address that only looks like a Tailscale address is not enough. Tailscale encrypts the traffic.

To link a server on another plain HTTP address, choose **Allow plain HTTP** when the runner asks, or add `--allow-http` to `pi-pocket runner link`. Do this only on a network you trust. The choice is saved with the link.

## What works in a session

In Menu → **Runners**, choose **New session** next to an online computer, then choose a folder on it. The session's title, top bar, and Pi's system prompt identify the computer. Forks keep the same computer, unless you choose another one in the fork sheet's **Computer** row. A copy can go from this server to a linked computer, back, or from one linked computer to another. A copy on a linked computer runs with that computer's list of extensions; a copy back on this server gets all extensions again. Pi gets a note with the new computer and folder, because paths earlier in the conversation were on the old ones.

Pi's `read`, `write`, `edit`, and `bash` tools run on that computer through Earendil's [pi-env](https://www.npmjs.com/package/@earendil-works/pi-env). They work as they do on the server. Goals, plans, questions, schedules, codemode, memory, PR watches, and [the browser](#the-browser) also work. Subagents and linked sessions that a session on a computer starts run on the same computer. A linked session in another folder needs that folder's approval, as a new session does.

Lessons stay with each project on its own computer; worktrees of that project share them. In **Memory**, **From …** sections offer approved lessons from other copies of the same GitHub repository. Choose **Add** to save one in this project; they never apply here automatically. PR watches read the origin and current branch on the linked computer, but poll GitHub from the server with the server's `gh` sign-in, not the computer's.

The runner checks git, the GitHub CLI (`gh`), and its GitHub sign-in when it starts and reconnects. **Runners** and `pi-pocket runner status` show whether git and GitHub are ready, with an install command or `gh auth login` when needed. A computer without them still works.

These also work, on that computer:

- The **Files** and **Changes** panels, the branch list, and **Show in the file manager** (it opens there).
- **Git worktree** in the new-session and fork sheets. The worktree is made on that computer at `~/.pi-pocket/worktrees/<permission id>/<name>`, with a new branch, uncommitted changes, and up to 50 MiB of new files; ignored files stay out. A worktree keeps its session's permission, and a fork gets its own. Removing the worktree removes its folder there; its branch stays, as on the server. The session's folder must include the repository root, because git writes there.
- The folder's project context files (`AGENTS.md`, `CLAUDE.md`) and the skills there and in that computer's home folder. Project trust is kept for each computer.
- Files mentioned with `@`, read on that computer.
- Attachments: each is copied to `pi-pocket-uploads/<session>/` in that computer's temporary folder when the message is sent, and the message gives that path. `<session>` is the session's permission id on that computer, so a session reaches only its own attached files. The system can clear its temporary folder when the computer restarts: move a file you want to keep out of it.

Artifacts read their `path` and asset files on the session's computer, then keep the published bundle on the server. Automatic design-system attachments are not available there: give their files in `assets`. Images opened from that computer, or written with `write` or `edit`, are kept in the session's uploads for offline viewing (25 MiB per image, 500 MiB per session; the oldest copies are removed above that).

Background tasks run on the computer in the session's folder, on Linux, macOS, and Windows. The runner owns each task through a separate child process, not through the pi-env tool process. A network drop, a server restart, or a tool-process restart does not stop tasks. When the runner stops or crashes, its task processes stop too: on Linux and macOS, the task's process group gets a polite signal, then a forced stop after 5 seconds. On Windows, the host uses `taskkill /T /F`; a Windows Job Object also stops the process tree if the host dies. If the computer cannot set up that Job Object, the task does not start, with an error that says why: without it, a task could outlive the runner.

The shell's exit code is final when the shell ends, even if a descendant redirected its output and keeps running. The task host stays registered while the task's process group or Windows Job Object has processes left. The runner's task list marks that task with `ended: true`, and signals still reach its descendants. Linux and macOS hosts check the group about once a second. If Windows cannot inspect the remaining processes, the host stays until the runner stops. A process that leaves its group with `setsid` on Linux or macOS is outside the runner's reach.

Their logs and exit codes stay in `<temp>/pi-pocket-tasks/<permission id>/` on that computer, reachable only by their session. Running now and the log view read them there, with the same output limits as local tasks. While the computer is offline, its watch waits, then checks again when it reconnects. Completed output and exit codes reach the session when it is back. The runner checks that the command's folder is in the session's folder before it starts a task. On Linux and macOS, commands use Bash, or `sh` if Bash is absent. On Windows, they use an installed Bash (not the Windows WSL launcher), or `cmd.exe` if Bash is absent. Temporary files can disappear when the computer restarts.

A project's own `.pi/settings.json` and prompt templates on that computer are not read.

### Extensions

A session on another computer runs with the built-in extensions that work there, and with the drop-ins that say they do. A drop-in says so with one line in its module:

```ts
export const remoteSessions = true;
```

Other drop-ins load only in sessions on the server. A drop-in that the owner turns on or off, or that changes the line, is added to or taken out of every session on another computer, existing ones too.

The line is a promise by the module's author: its tools reach the session's files and commands only through the session (`api.env`), which is that computer's. What the module itself does with Node (`node:fs`, `node:child_process`) runs on the server, in the server's folders. A module that only works on the conversation (its history, compaction, prompts, models) needs nothing more.

## The browser

The browser tool and the **Browser** panel work in a session on another computer. Chromium runs on the server, but every connection of its pages goes out from the linked computer:

- `localhost:5173` is the linked computer's port 5173. The Browser panel lists the ports that the computer listens on (`lsof` on macOS, `/proc/net/tcp` or `ss` on Linux, `netstat` on Windows).
- Names resolve with the computer's DNS, and pages use its routes, VPN, and local network. Sites see the computer's IP address.
- Pi's model calls do not change: they go out from the server.
- File paths and `file://` addresses do not open, because the browser would read the server's disk. Serve the files instead, for example with `python3 -m http.server`.

How it works: these pages use a second Chromium on the server, with a proxy built into Pi Pocket. Each session's pages have their own proxy credentials, which name the computer. The proxy sends each connection to the runner over its link, and the runner opens the TCP connection on the computer. Chromium's own background traffic and anything without valid credentials go to a proxy that refuses everything. WebRTC sends no UDP outside the proxy, and QUIC is off. If the computer is offline, the page fails with "<name> is offline". Nothing goes out from the server.

To stop sharing the network, turn off **Share the network with browsers** on the computer's card in **Runners**. The runner then refuses every connection, and pages show "<name> does not share its network". The change takes effect at once.

The risk: pages in the browser of a session on a computer can reach that computer's network (its `localhost`, the home network, a tailnet, a VPN) like any program on it. This is part of the risk of a runner. Pi and anyone who can steer the session's Browser panel can open such pages. Link only a server you trust, and turn off network sharing if the computer must not do this. Other programs on the server cannot use the proxy, because they do not have the credentials.

**Downloads.** A file that a page downloads goes to the computer's temporary folder, in `pi-pocket-downloads/<session>/` (on macOS, the per-user `$TMPDIR`, not `/tmp`). `<session>` is the session's permission id on that computer: each session has its own folder, and the runner lets a session reach only its own, never another session's. The system can clear its temporary folder when the computer restarts, so move a file you want to keep out of it. To use another folder, set **Downloads folder** on the computer's card in **Runners**. The files then go to `<folder>/<session>/`, and a session reaches only its own `<session>` folder there: the chosen folder itself, and anything else in it, stays out of reach. Clearing it returns to the temporary folder. The tool result gives the full path and the size. If the name is already used, the file gets a number, such as `report (2).pdf`. The bytes pass through the server: Chromium saves the file in the server's private temporary folder, Pi Pocket sends it over the runner link to the computer in parts, and then the server deletes its copy at once, also when the copy fails. Downloads larger than 2 GiB fail. In a session on the server, downloads go to `pi-pocket-downloads-<uid>/<session id>/` in the server's temporary folder. Only the server's user can open this folder (mode 0700). Pi Pocket refuses the folder if another user owns it or if it is a link.

**macOS desktop app.** On macOS 15 and later, connections to devices on the local network (not `localhost`) can need the **Local Network** permission. The desktop app runs the runner as a child process, so macOS can ask for this permission on behalf of the app. The app's `Info.plist` does not have an `NSLocalNetworkUsageDescription` yet, so the system prompt has no explanation. If pages on the local network fail with "No route to host", allow Pi Pocket in System Settings → Privacy & Security → Local Network. This was not tested on a Mac.

## Sharing

The people chosen in Menu → **Runners** can start sessions on it, in their given folders, including forks. Their sessions run as the computer's user, with the same access to its files and commands. Who is in charge of it alone changes its settings and who may use it. Sharing does not change this rule.

By default, a session on a linked computer is private to its creator. Other people cannot see it in their session list, open it, prompt it, or fork it. Who is in charge of the computer sees every session on it. These access rules also protect a private session's forks and subagents.

The session's starter, or who is in charge, shares it one person at a time, with people who may use its computer. People it is shared with can prompt it, and its commands run on the linked computer for them too. Taking someone off the share list closes the session in their tabs at once.

**Share new sessions with these people** (off by default), under each computer in Menu → **Runners**, starts every new session there shared with the people chosen for it. It changes no session that already exists.

This server follows the same rules, as **This server** in Menu → **Runners** (`src/server/access.ts` holds the one policy for both).

## When the computer is offline

Offline is offline. While a linked computer is offline, its sessions are offline too: there is no grace period, and nothing fails because the computer is away. The server keeps the link's work and waits. The session shows "<computer> offline, reconnecting…", and its mark in the session list is dimmed.

| What happens                                             | What happens to the work                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The connection drops, for any length of time             | Nothing is lost. Commands keep running on the computer. Their output arrives when the runner reconnects, and the session continues where it stopped.                |
| A tool call, or a message, while the computer is offline | It waits for the computer. Attached files are copied there when it is back. **Stop** ends the wait.                                                                 |
| The runner quits, or the computer restarts               | Commands and runner-owned background tasks stop. Commands come back as interrupted; task logs and exit codes remain. The session continues when the runner is back. |
| The server restarts                                      | Running commands return as interrupted. Background tasks keep running on the computer, and the session picks up their output when the runner reconnects.            |

Panels that show the computer's files (Files, Changes, the folder picker) say that the computer is offline instead of waiting. A new session, a fork, or a move to another folder on an offline computer cannot start.

Removing a computer in **Runners** stops its runner and cancels its key. A runner that the server removed exits with code 3, except in macOS service mode, where it exits with code 0 so launchd does not restart it. The desktop app does not restart it.

## Later

- **Passkeys** as another way to approve, besides authenticator codes (`src/server/approval-methods.ts`).
