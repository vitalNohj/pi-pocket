// Other computers that run sessions' tools (`src/server/runners.ts`): link one with a one-time code, see which are
// online, start a session on one, or remove one. The owner's alone.
import { useEffect, useState } from "preact/hooks";
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

function LinkCode({ onDone }) {
    const [name, setName] = useState("");
    const [made, setMade] = useState(null);
    const [busy, setBusy] = useState(false);

    const make = () =>
        attempt(async () => {
            setBusy(true);

            try {
                setMade(await api("runners/code", { name }));
            } finally {
                setBusy(false);
            }
        });

    if (made) {
        const command = `npx pi-pocket runner link ${serverAddress()} ${made.code}`;

        return html`<div class="field">
            <p class="muted small">
                On that computer, with Node.js 22.19 or newer, run this, then
                <span class="mono">npx pi-pocket runner</span> to keep it connected. The code works once, for
                ${Math.max(1, Math.round((made.expiresAt - Date.now()) / 60000))} minutes.
            </p>
            <pre class="mono runner-command">${command}</pre>
            <div class="row">
                <button class="button" onClick=${() => copyText(command).then(() => notify("info", "Copied."))}>
                    <${Icon} name="copy" size=${16} /> Copy
                </button>
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
            onKeyDown=${(event) => event.key === "Enter" && name.trim() && make()}
        />
        <div class="row">
            <button class="button primary" disabled=${busy || !name.trim()} onClick=${make}>
                Make a link code
            </button>
            <button class="button ghost" onClick=${onDone}>Cancel</button>
        </div>
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
            Anyone who can prompt such a session can do there what you can.
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
                ? html`<${LinkCode} onDone=${() => setLinking(false)} />`
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
