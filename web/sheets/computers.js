// Runners (`src/server/runners.ts`): this server and other computers that run sessions' tools. The parts of the
// Access sheet (`access-sheet.js`) about a computer itself, not about who has what there: link one with a one-time
// code, its state and tools, its browser settings (network and downloads; this server's downloads alone), link it
// again, unlink it, and the limits on linking.
// A runner trusts its server after the link: its settings are kept here and sent to it.
import { useState } from "preact/hooks";
import { api, attempt, notify, store } from "../store.js";
import { copyText, html, Icon, Loader, Switch, timeAgo } from "../ui.js";
import { inCharge, keep, THIS_SERVER } from "./access.js";

/** What a computer is doing now, in a few words. */
export function status(runner) {
    // Its linker is a viewer now: connected or not, nothing starts or runs there.
    if (runner.blocked) {
        return runner.online ? "Blocked · connected" : "Blocked";
    }

    if (runner.online) {
        return "Online";
    }

    if (runner.away) {
        return "Offline, its work waits";
    }

    if (!runner.lastSeen) {
        return "Waiting to connect";
    }

    const ago = timeAgo(runner.lastSeen);

    return `Offline · seen ${ago === "now" ? "just now" : `${ago} ago`}`;
}

/** Its system, in words people use: macOS, not darwin. */
export function system(runner) {
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

/** The address and code for the runner on that computer, and how to get a runner there. */
export function LinkSteps({ made, onDone }) {
    const server = location.origin;
    const minutes = Math.max(1, Math.round((made.expiresAt - Date.now()) / 60000));

    return html`<div class="sheet-page runner-link">
        <h3 class="sheet-page-title">Link ${made.name}</h3>
        <${TrustNote} />
        <p class="muted small">Give the runner on ${made.name} this address and code:</p>
        <${Copyable} label="Address" text=${server} />
        <${Copyable} label="Code" text=${made.code} />
        <div class="group-title">No runner there yet?</div>
        <ol class="runner-steps">
            <li>
                <div>
                    ${
                        made.command === "pi-pocket-runner"
                            ? "Install the runner (Node.js 22.19 or newer):"
                            : "Install Pi Pocket (Node.js 22.19 or newer):"
                    }
                </div>
                <${Copyable} text=${`npm install -g ${made.package}`} />
            </li>
            <li>
                <div>Run the runner, choose Link this computer, and enter the address and code:</div>
                <${Copyable} text=${made.command} />
            </li>
        </ol>
        <p class="muted small">
            ${`The code works once and expires in ${minutes} minutes. ${made.name} shows as online here when it connects.`}
        </p>
        ${
            made.fingerprint &&
            html`<p class="muted small">
                This server's key: <code>${made.fingerprint}</code>. <code>${made.command} status</code> on
                ${made.name} shows the same.
            </p>`
        }
        <div class="row">
            <button class="button" onClick=${onDone}>Done</button>
        </div>
    </div>`;
}

/** What linking means for that computer, said where people link: before the code, and with it. */
export function TrustNote() {
    return html`<p class="runner-trust small">
        <strong>The linked computer trusts this server fully.</strong> Sessions there run commands as that computer's
        user, with no sandbox. To limit that, run the runner in a container or VM.
    </p>`;
}

/**
 * Linking paused, for one address or the whole server, and the addresses banned for guessing codes, which the owner can
 * lift (`link-limits.ts`): for the owner, and who manages runners.
 */
export function LinkLocks({ locks, reload }) {
    const intro = html`<h3 class="sheet-page-title">Linking limits</h3>
        <p class="muted small">
            Wrong link codes are limited. An address locked out 3 times in a week is banned.
        </p>`;

    if (!locks) {
        return html`<div class="sheet-page">${intro}<${Loader} /></div>`;
    }

    if (!locks.server && locks.addresses.length === 0 && locks.bans.length === 0) {
        return html`<div class="sheet-page">
            ${intro}
            <p class="muted small">Nothing is locked or banned.</p>
        </div>`;
    }

    const until = (time) =>
        new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const since = (time) =>
        new Date(time).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        });
    const lift = (address) =>
        attempt(async () => {
            await api(`runners/bans?address=${encodeURIComponent(address)}`, undefined, {
                method: "DELETE",
            });
            reload();
        });

    return html`<div class="sheet-page runner-locks">
        ${intro}
        ${
            (locks.server || locks.addresses.length > 0) &&
            html`<div class="runner-trust small" role="status">
                ${
                    locks.server &&
                    html`<p>
                        <strong>Linking is paused until ${until(locks.server)}</strong>: too many wrong link codes.
                        Open codes were voided.
                    </p>`
                }
                ${locks.addresses.map(
                    (lock) => html`<p key=${lock.address}>
                        <strong>${lock.address}</strong> is locked out until ${until(lock.until)}. Lockout
                        ${lock.blocks} of 3 this week.
                    </p>`,
                )}
            </div>`
        }
        ${
            locks.bans.length > 0 &&
            html`<div class="runner-bans">
                <div class="group-title">Banned from linking</div>
                <p class="muted small">
                    Banned for guessing link codes. Lift a ban to let one link again.
                </p>
                ${locks.bans.map(
                    (ban) => html`<div class="runner-ban" key=${ban.address}>
                        <span class="mono">${ban.address}</span>
                        <span class="muted small">since ${since(ban.since)}</span>
                        <button class="button ghost" onClick=${() => lift(ban.address)}>Lift</button>
                    </div>`,
                )}
            </div>`
        }
    </div>`;
}

/** Link a computer: name it, get a one-time code, and run the runner there with this address and code. */
export function LinkComputer({ onDone }) {
    const [name, setName] = useState("");
    const [made, setMade] = useState(null);
    const [busy, setBusy] = useState(false);
    const clean = name.trim();

    const make = () =>
        attempt(async () => {
            setBusy(true);

            try {
                setMade({ ...(await api("runners/code", { name: clean })), name: clean });
            } finally {
                setBusy(false);
            }
        });

    if (made) {
        return html`<${LinkSteps} made=${made} onDone=${onDone} />`;
    }

    return html`<div class="sheet-page runner-link">
        <h3 class="sheet-page-title">Link a computer</h3>
        <${TrustNote} />
        <label class="field">
            <span class="label">Name</span>
            <input
                type="text"
                value=${name}
                placeholder="For example: MacBook, Build server"
                maxlength="60"
                autofocus
                onInput=${(event) => setName(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && clean && !busy && make()}
            />
        </label>
        <div class="row wrap">
            <button class="button primary" disabled=${busy || !clean} onClick=${make}>
                Get a link code
            </button>
        </div>
    </div>`;
}

/** Readiness is a hint, not a requirement: tools and sign-ins can be installed later. */
export function Tools({ runner }) {
    const { tools, os } = runner;

    if (!tools) {
        return null;
    }

    const windows = os === "windows" || os === "win32";
    const git =
        os === "darwin"
            ? "xcode-select --install"
            : windows
              ? "winget install Git.Git"
              : "sudo apt install git";
    const gh = os === "darwin" ? "brew install gh" : windows ? "winget install GitHub.cli" : null;

    return html`<div class="muted small">
        ${tools.git ? "git ✓" : html`git not found: <code>${git}</code>`} · ${
            !tools.gh
                ? gh
                    ? html`GitHub: gh not found: <code>${gh}</code>`
                    : html`GitHub: gh not found: <a href="https://github.com/cli/cli#installation" target="_blank" rel="noopener noreferrer">Install gh</a>`
                : tools.github
                  ? "GitHub ✓"
                  : html`GitHub: sign in with <code>gh auth login</code>`
        }
    </div>`;
}

/**
 * What a runner does for its sessions, kept here and sent to it at once (`runner-settings`): whether their browsers use
 * its network, and where their downloads go there. Plain HTTP was chosen on that computer when it was linked.
 */
export function RunnerSettings({ runner }) {
    if (runner.network === undefined) {
        return null;
    }

    return html`<div class="sheet-pane">
        <${Rule}
            runner=${runner}
            name="network"
            label="Share its network with browsers"
            hint=${`On: sessions' browsers reach what ${runner.name} reaches, such as its local servers and home network.`}
            on=${runner.network}
        />
        <${Downloads} computer=${runner} />
        <div class="muted small">
            ${
                runner.allowHttp
                    ? "Plain HTTP to this server: allowed. Link again to change."
                    : "Plain HTTP: only to this computer or a tailnet device. Link again to change."
            }
        </div>
    </div>`;
}

/**
 * Where the browser downloads of a computer's sessions go (`POST /api/runners/:id/settings`): a runner's folder there,
 * or this server's on this machine; else its temporary folder. The view the server answers is shown at once.
 */
export function Downloads({ computer }) {
    const mine = inCharge(computer);

    const change = () => {
        const typed = prompt(
            computer.id === THIS_SERVER
                ? "Downloads folder on this server, absolute; empty for its temporary folder"
                : "Downloads folder there, absolute; empty for its temporary folder",
            computer.downloads ?? "",
        );

        if (typed !== null) {
            void attempt(async () =>
                keep(
                    await api(`runners/${encodeURIComponent(computer.id)}/settings`, {
                        downloads: typed.trim() === "" ? null : typed.trim(),
                    }),
                ),
            );
        }
    };

    return html`<div class=${`setting wrap ${mine ? "" : "disabled"}`}>
        <div class="grow">
            <div class="small">Downloads</div>
            <div class="muted small">
                ${computer.downloads ?? "Temporary folder, which can be cleared when the computer restarts"}
            </div>
        </div>
        <button class="button small ghost" disabled=${!mine} onClick=${change}>Change</button>
    </div>`;
}

/** One on/off rule of a computer kept on the server (`POST /api/runners/:id/settings`), for its linker and the owner. */
export function Rule({ runner, name, label, hint, on }) {
    const mine = inCharge(runner);
    const change = () =>
        attempt(() => api(`runners/${encodeURIComponent(runner.id)}/settings`, { [name]: !on }));

    return html`<div class=${`setting wrap ${mine ? "" : "disabled"}`}>
        <div class="grow">
            <div class="small">${label}</div>
            <div class="muted small">${hint}</div>
        </div>
        <${Switch} on=${on} disabled=${!mine} label=${`${label}: ${on ? "on" : "off"}`} onChange=${change} />
    </div>`;
}

/** Its version, and its architecture, as a short line under its name. */
export function details(runner) {
    return [
        status(runner),
        [system(runner), runner.arch].filter(Boolean).join(" "),
        runner.version && `runner ${runner.version}`,
    ]
        .filter(Boolean)
        .join(" · ");
}

/** What runners are, for the About page. */
export function AboutRunners() {
    return html`<div class="sheet-page">
        <h3 class="sheet-page-title">About runners</h3>
        <p>
            Run a session's commands and files on another of your computers. Pi and the history stay on this server.
        </p>
        <p class="muted">
            The computer connects out, so it needs no open port. Who may use it is set here.
        </p>
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
