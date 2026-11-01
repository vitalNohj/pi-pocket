# Sessions on another computer

A session can run its tools on another computer of yours: files, commands, and git there. Pi, its models, the provider keys, and the session's history stay on the server. That computer runs `pi-pocket runner`, which connects out to the server over a WebSocket, so it needs no open port, no SSH, and no provider key.

Only the owner links computers. A session on a computer belongs to the person who linked it: only they can start one, see it, prompt it, or fork it. Nobody else on the server gets it in their list, and its subagents and forks stay theirs.

## Link a computer

In Pi Pocket: Menu → **Computers** → **Link a computer**, and give it a name.

- **In the Pi Pocket desktop app**, on the computer to link: **Link this computer**. The app gets the code, runs the runner, and keeps it running while the app runs. Nothing to type.
- **Any other computer** (a server, a laptop without the app), with Node.js 22.19 or newer. **Make a link code** shows these, ready to copy:

```sh
npm install -g pi-pocket@latest
pi-pocket runner link https://your-server 7K3M-QX9P-2HWD   # the code works once, for 10 minutes
pi-pocket runner service    # Linux with systemd: keep it running, also after a reboot
pi-pocket runner            # anywhere else: keep it running in a terminal
```

`pi-pocket runner status` shows the link, `pi-pocket runner unlink` forgets it, and `pi-pocket runner service remove` removes the service. The link, with the computer's key, is in `~/.pi-pocket/runner.json` (only its user can read it). To keep a service running while you are logged out: `loginctl enable-linger $USER`.

A server that runs a build npm does not have can name another package to install, for the instructions: set `PI_POCKET_RUNNER_PACKAGE` (for example a tarball URL of a fork).

## Sessions there

Computers → **New session** next to an online computer picks a folder on it. The session's title, its top bar, and Pi's system prompt say which computer it is on. Forks keep the computer.

Pi's own tools run there: `read`, `write`, `edit`, and `bash`, and with them goals, plans, questions, and schedules. Through Earendil's [pi-env](https://www.npmjs.com/package/@earendil-works/pi-env), they act as on the server.

For now these work only for sessions on the server, because they read the server's own disk: background tasks, the browser, artifacts, design, memory, subagents and teams, PR watches, git worktrees, the Files and Changes panels, and the folder's project context and skills. Files people attach stay on the server.

## When the link drops

| What happens                       | The work in progress                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A short drop (up to 2 minutes)     | Nothing is lost. A command goes on, and what it printed meanwhile comes when the runner is back.                                                              |
| A longer one (sleep, the app quit) | A command that ran stops, and Pi gets "was away too long". The next tool call waits for nothing: it fails at once with "is offline" until the runner is back. |
| The server restarts                | As for sessions on the server: a command that ran comes back as interrupted, and the session goes on.                                                         |

Removing a computer in Computers stops its runner and its key. A runner that the server removed exits with code 3, which its service does not restart.
