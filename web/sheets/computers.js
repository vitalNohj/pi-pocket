// Runners (`src/server/runners.ts`): other computers of the owner's that run sessions' tools. Link one with a
// one-time code, see which are online, start a session on one, remove one, and choose whether others may use those
// sessions. The owner's alone.
import { useEffect, useState } from "preact/hooks";
import { callHost, hostCan } from "../host.js";
import { api, attempt, closeSheet, notify, openSheet, store } from "../store.js";
import { copyText, html, Icon, Loader, Sheet, Switch, timeAgo } from "../ui.js";

/** What a computer is doing now, in a few words. */
function status(runner) {
    if (runner.online) {
        return "Online";
    }

    if (runner.away) {
        return "Reconnecting";
    }

    if (!runner.lastSeen) {
        return "Waiting to connect";
    }

    const ago = timeAgo(runner.lastSeen);

    return `Offline · seen ${ago === "now" ? "just now" : `${ago} ago`}`;
}

/** Its system, in words people use: macOS, not darwin. */
function system(runner) {
    const name = { macos: "macOS", darwin: "macOS", linux: "Linux", windows: "Windows" }[runner.os];

    return name ?? runner.os ?? "";
}

/** A line to copy: a command, the address, or the code, with its copy button. */
function Copyable({ text, label }) {
    return html`<div class="runner-copy">
        ${label && html`<span class="runner-copy-label">${label}</span>`}
        <code class="runner-copy-text">${text}</code>
        <button
            class="icon-button"
            aria-label=${`Copy ${label ?? "command"}`}
            title="Copy"
            onClick=${() => copyText(text).then(() => notify("info", "Copied."))}
        >
            <${Icon} name="copy" size=${16} />
        </button>
    </div>`;
}

/** The steps on another computer, once the code is made. */
function LinkSteps({ made, onDone }) {
    const server = location.origin;
    const minutes = Math.max(1, Math.round((made.expiresAt - Date.now()) / 60000));

    return html`<div class="runner-link">
        <div class="group-title">Link ${made.name}</div>
        <ol class="runner-steps">
            <li>
                <div>On ${made.name}, install Pi Pocket (Node.js 22.19 or newer):</div>
                <${Copyable} text=${`npm install -g ${made.package ?? "pi-pocket@latest"}`} />
            </li>
            <li>
                <div>Run the runner, choose Link this computer, then enter this address and code:</div>
                <${Copyable} text="pi-pocket runner" />
                <${Copyable} label="Address" text=${server} />
                <${Copyable} label="Code" text=${made.code} />
            </li>
        </ol>
        <p class="muted small">
            ${`The code works once and expires in ${minutes} minutes. ${made.name} shows as online here when it connects. Before a session starts there, it asks the person at ${made.name}.`}
        </p>
        <div class="row">
            <button class="button" onClick=${onDone}>Done</button>
        </div>
    </div>`;
}

/**
 * Link a computer. In the desktop app, the computer it runs on links in one step: the app makes the link and keeps
 * the runner running. Any other computer gets a code and two commands.
 */
function LinkComputer({ onDone }) {
    const app = hostCan("runner");
    const [name, setName] = useState(() => (app ? (callHost("computerName") ?? "") : ""));
    const [made, setMade] = useState(null);
    const [busy, setBusy] = useState(false);
    const clean = name.trim();

    const make = (here) =>
        attempt(async () => {
            setBusy(true);

            try {
                const code = await api("runners/code", { name: clean });

                if (!here) {
                    setMade({ ...code, name: clean });

                    return;
                }

                const answer = await callHost("linkRunner", {
                    server: location.origin,
                    code: code.code,
                    name: clean,
                });

                if (answer?.ok === false) {
                    throw new Error(
                        answer.error ?? "The desktop app could not link this computer.",
                    );
                }

                notify("info", `Linking ${clean}. It shows as online in a moment.`);
                onDone();
            } finally {
                setBusy(false);
            }
        });

    if (made) {
        return html`<${LinkSteps} made=${made} onDone=${onDone} />`;
    }

    return html`<div class="runner-link">
        <div class="group-title">Link a computer</div>
        <label class="field">
            <span class="label">Name</span>
            <input
                type="text"
                value=${name}
                placeholder="For example: MacBook, Build server"
                maxlength="60"
                autofocus
                onInput=${(event) => setName(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && clean && !busy && make(app)}
            />
        </label>
        ${
            app &&
            html`<p class="muted small">
                Link this computer and the desktop app runs the runner for you while it is open. For any other
                computer, such as a server, you get a code and two commands to run there.
            </p>`
        }
        <div class="row wrap">
            ${
                app &&
                html`<button
                    class="button primary"
                    disabled=${busy || !clean}
                    onClick=${() => make(true)}
                >
                    Link this computer
                </button>`
            }
            <button
                class=${`button ${app ? "" : "primary"}`}
                disabled=${busy || !clean}
                onClick=${() => make(false)}
            >
                ${app ? "Link another computer" : "Get a link code"}
            </button>
            <button class="button ghost" onClick=${onDone}>Cancel</button>
        </div>
    </div>`;
}

/** One linked computer: its state, and what can be done with it. */
function ComputerRow({ runner }) {
    const remove = () =>
        confirm(
            `Remove ${runner.name}? Its runner disconnects and its sessions stop working. You can link it again later.`,
        ) &&
        attempt(() =>
            api(`runners/${encodeURIComponent(runner.id)}`, undefined, { method: "DELETE" }),
        );

    return html`<div class="person-row runner-row">
        <span
            class=${`runner-dot ${runner.online ? "on" : runner.away ? "away" : ""}`}
            aria-hidden="true"
        ></span>
        <div class="person-main">
            <div class="runner-title">${runner.name}</div>
            <div class="muted small">
                ${[status(runner), system(runner)].filter(Boolean).join(" · ")}
            </div>
        </div>
        <div class="person-actions">
            <button
                class="button small"
                disabled=${!runner.online}
                title=${runner.online ? "Pick a folder there" : `${runner.name} is not connected`}
                onClick=${() => openSheet({ type: "cwd", mode: "new", runner: runner.id })}
            >
                New session
            </button>
            <button class="button small ghost" onClick=${remove}>Remove</button>
        </div>
    </div>`;
}

/**
 * Who may use sessions on linked computers (`sharedRunnerSessions`): each its creator's alone (the default), or the
 * usual sharing rules. Starting one stays the linker's either way.
 */
function SharedSessions() {
    const shared = store.state.server?.sharedRunnerSessions === true;
    const change = () => attempt(() => api("settings", { sharedRunnerSessions: !shared }));

    return html`<div class="group">
        <div class="group-title">Sharing</div>
        <div class="setting wrap">
            <div class="grow">
                <div class="small">Let others use these sessions</div>
                <div class="muted small">
                    Off: only the person who started a session can see or prompt it. On: sessions on linked
                    computers are shared like any other, and their commands run on that computer for whoever
                    prompts them.
                </div>
            </div>
            <${Switch}
                on=${shared}
                label=${`Let others use these sessions: ${shared ? "on" : "off"}`}
                onChange=${change}
            />
        </div>
    </div>`;
}

/** The Runners item's hint in the menu: how many linked computers are online. */
export function runnersHint() {
    const { runners } = store.state;

    if (runners.length === 0) {
        return "link a computer";
    }

    const online = runners.filter((runner) => runner.online).length;

    return `${online} of ${runners.length} online`;
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

    return html`<${Sheet} title="Runners" onClose=${closeSheet}>
        <p class="muted small">
            Run a session's tools on another of your computers: its files and commands are used there, while Pi,
            your models, and the history stay on this server. The computer connects out to this server, so it
            needs no open port. Only you can start sessions on computers you link.
        </p>
        ${
            runners.length > 0 &&
            html`<div class="sheet-list">
                ${runners.map((runner) => html`<${ComputerRow} key=${runner.id} runner=${runner} />`)}
            </div>`
        }
        ${!loaded && runners.length === 0 && html`<${Loader} />`}
        ${
            loaded &&
            runners.length === 0 &&
            !linking &&
            html`<p class="muted small runner-none">No computers linked yet.</p>`
        }
        ${
            linking
                ? html`<${LinkComputer} onDone=${() => setLinking(false)} />`
                : html`<button class="button primary wide" onClick=${() => setLinking(true)}>
                      <${Icon} name="plus" size=${16} /> Link a computer
                  </button>`
        }
        <${SharedSessions} />
    <//>`;
}
