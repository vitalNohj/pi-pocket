// Other computers that run sessions' tools (`src/server/runners.ts`): link one with a one-time code, see which are
// online, start a session on one, or remove one. The owner's alone.
import { useEffect, useState } from "preact/hooks";
import { callHost, hostCan } from "../host.js";
import { actions, api, attempt, closeSheet, notify, openSheet, store } from "../store.js";
import { copyText, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

/** What a computer is doing now, in a few words. */
function status(runner) {
    if (runner.online) {
        return "online";
    }

    if (runner.away) {
        return "reconnecting, its work waits";
    }

    if (!runner.lastSeen) {
        return "never connected";
    }

    const ago = timeAgo(runner.lastSeen);

    return `offline, seen ${ago === "now" ? "just now" : `${ago} ago`}`;
}

/** The server's address as another computer reaches it: the address this page came from. */
const serverAddress = () => location.origin;

/** A command, with a button that copies it. */
function Command({ text }) {
    return html`<div class="runner-command-box">
        <pre class="mono runner-command">${text}</pre>
        <button
            class="icon-button"
            aria-label="Copy"
            title="Copy"
            onClick=${() => copyText(text).then(() => notify("info", "Copied."))}
        >
            <${Icon} name="copy" size=${16} />
        </button>
    </div>`;
}

/** How to link another computer with a code: the steps for a server, or any computer with Node.js. */
function LinkSteps({ made }) {
    const server = serverAddress();
    const minutes = Math.max(1, Math.round((made.expiresAt - Date.now()) / 60000));

    return html`<div class="runner-steps">
        <p class="muted small">
            ${`On that computer, with Node.js 22.19 or newer. The code works once, for ${minutes} minutes.`}
        </p>
        <ol class="runner-list">
            <li>
                Install Pi Pocket there:
                <${Command} text=${`npm install -g ${made.package ?? "pi-pocket@latest"}`} />
            </li>
            <li>
                Link it:
                <${Command} text=${`pi-pocket runner link ${server} ${made.code}`} />
            </li>
            <li>
                Keep it running. On Linux with systemd, as a service that starts with the computer:
                <${Command} text="pi-pocket runner service" />
                Anywhere else, in a terminal that stays open:
                <${Command} text="pi-pocket runner" />
            </li>
        </ol>
        <p class="muted small">
            ${"With the Pi Pocket desktop app on that computer, there is nothing to type: open this server in it, then Menu → Computers → "}
            <strong>Link this computer</strong>.
        </p>
    </div>`;
}

/**
 * Link a computer. In the desktop app, the computer it runs on links with one click: the app gets the code, starts
 * the runner, and keeps it running. Any other: a code and the commands to run there.
 */
function LinkComputer({ onDone }) {
    const app = hostCan("runner");
    const [name, setName] = useState(() => (app ? (callHost("computerName") ?? "") : ""));
    const [made, setMade] = useState(null);
    const [busy, setBusy] = useState(false);

    const make = (here) =>
        attempt(async () => {
            setBusy(true);

            try {
                const code = await api("runners/code", { name });

                if (here) {
                    const answer = await callHost("linkRunner", {
                        server: serverAddress(),
                        code: code.code,
                        name: name.trim(),
                    });

                    if (answer?.ok === false) {
                        throw new Error(
                            answer.error ?? "The desktop app could not link this computer.",
                        );
                    }

                    notify("info", `${name.trim()} is linking. It shows as online in a moment.`);
                    onDone();
                } else {
                    setMade(code);
                }
            } finally {
                setBusy(false);
            }
        });

    if (made) {
        return html`<div class="field">
            <${LinkSteps} made=${made} />
            <div class="row">
                <button class="button ghost" onClick=${onDone}>Done</button>
            </div>
        </div>`;
    }

    return html`<div class="field">
        <div class="label">Name it</div>
        <input
            type="text"
            value=${name}
            placeholder="Laptop"
            maxlength="60"
            onInput=${(event) => setName(event.currentTarget.value)}
            onKeyDown=${(event) => event.key === "Enter" && name.trim() && make(app)}
        />
        <div class="row wrap">
            ${
                app &&
                html`<button class="button primary" disabled=${busy || !name.trim()} onClick=${() => make(true)}>
                    Link this computer
                </button>`
            }
            <button
                class=${`button ${app ? "" : "primary"}`}
                disabled=${busy || !name.trim()}
                onClick=${() => make(false)}
            >
                ${app ? "Link another computer" : "Make a link code"}
            </button>
            <button class="button ghost" onClick=${onDone}>Cancel</button>
        </div>
        ${
            app &&
            html`<p class="muted small">
                Link this computer: the desktop app runs the runner for you while it is open. Another computer, such
                as a server: you get a code and two commands to run there.
            </p>`
        }
    </div>`;
}

export function ComputersSheet() {
    const { runners } = store.state;
    const [loaded, setLoaded] = useState(false);
    const [linking, setLinking] = useState(false);

    useEffect(() => {
        attempt(async () => {
            store.set({ runners: await api("runners") });
            setLoaded(true);
        });
    }, []);

    const remove = (runner) => {
        if (
            !confirm(
                `Remove ${runner.name}? Its runner stops, its key stops working, and its sessions cannot run until you link it again.`,
            )
        ) {
            return;
        }

        attempt(() =>
            api(`runners/${encodeURIComponent(runner.id)}`, undefined, { method: "DELETE" }),
        );
    };

    return html`<${Sheet} title="Computers" onClose=${closeSheet}>
        <p class="muted small">
            A session can run its tools on another computer of yours: files, commands, and git there, with Pi, its
            models, and its history here. That computer connects out to this server, so it needs no open port.
            Only you can start, see, and prompt your sessions on a computer you linked; nobody else on this server can.
        </p>
        ${!loaded && runners.length === 0 && html`<${Loader} />`}
        ${runners.map(
            (runner) => html`<div class="runner-row">
                <div class="runner-name">
                    <span class=${`runner-dot ${runner.online ? "on" : runner.away ? "away" : ""}`}></span>
                    <span>${runner.name}</span>
                    <span class="muted small">
                        ${status(runner)}${runner.os ? ` · ${runner.os} ${runner.arch ?? ""}` : ""}
                    </span>
                </div>
                <div class="row">
                    <button
                        class="button"
                        disabled=${!runner.online}
                        onClick=${() => openSheet({ type: "cwd", mode: "new", runner: runner.id })}
                    >
                        New session
                    </button>
                    <button class="button ghost" onClick=${() => remove(runner)}>Remove</button>
                </div>
            </div>`,
        )}
        ${
            linking
                ? html`<${LinkComputer} onDone=${() => setLinking(false)} />`
                : html`<button class="button primary wide" onClick=${() => setLinking(true)}>
                      <${Icon} name="plus" size=${16} /> Link a computer
                  </button>`
        }
    <//>`;
}

/** Start a session on computer `runner` in `cwd`, and open it. */
export async function startOn(runner, cwd) {
    return actions.createSession(cwd, { runner });
}
