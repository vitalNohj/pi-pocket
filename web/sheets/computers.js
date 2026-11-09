// Runners (`src/server/runners.ts`): this server and other computers of the owner's that run sessions' tools. Link one
// with a one-time code, see which are online, start a session on one, remove one, and choose for each (this server
// too) who may use it, its saved folders, and whether new sessions start shared (`src/server/access.ts`).
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, openSheet, store } from "../store.js";
import { copyText, html, Icon, Loader, Sheet, Switch, timeAgo } from "../ui.js";

/** What a computer is doing now, in a few words. */
function status(runner) {
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

/** The address and code for the runner on that computer, and how to get a runner there. */
function LinkSteps({ made, onDone }) {
    const server = location.origin;
    const minutes = Math.max(1, Math.round((made.expiresAt - Date.now()) / 60000));

    return html`<div class="runner-link">
        <div class="group-title">Link ${made.name}</div>
        <${TrustNote} />
        <p class="muted small">Give the runner on ${made.name} this address and code:</p>
        <${Copyable} label="Address" text=${server} />
        <${Copyable} label="Code" text=${made.code} />
        <div class="group-title">No runner there yet?</div>
        <ol class="runner-steps">
            <li>
                <div>Install Pi Pocket (Node.js 22.19 or newer):</div>
                <${Copyable} text=${`npm install -g ${made.package ?? "pi-pocket@latest"}`} />
            </li>
            <li>
                <div>Run the runner, choose Link this computer, and enter the address and code:</div>
                <${Copyable} text="pi-pocket runner" />
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

/** What linking means for that computer, said where people link: before the code, and with it. */
export function TrustNote() {
    return html`<p class="runner-trust small">
        <strong>The linked computer trusts this server fully.</strong> Sessions you start there run commands and change
        files as that computer's user, with everything that user can reach. Nothing runs in a sandbox.
    </p>`;
}

/**
 * Linking paused, for one address or the whole server, and the addresses banned for guessing codes, which the owner can
 * lift (`link-limits.ts`). Only the owner opens Runners.
 */
function LinkLocks() {
    const [locks, setLocks] = useState(null);
    const load = () => attempt(async () => setLocks(await api("runners/locks")));

    useEffect(() => {
        load();
    }, [store.state.runners]);

    if (!locks || (!locks.server && locks.addresses.length === 0 && locks.bans.length === 0)) {
        return null;
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
            load();
        });

    return html`<div class="runner-locks">
        ${
            (locks.server || locks.addresses.length > 0) &&
            html`<div class="runner-trust small" role="status">
                ${
                    locks.server &&
                    html`<p>
                        <strong>New linking is paused until ${until(locks.server)}.</strong> Too many wrong link codes
                        reached this server from many addresses, so every open code was voided. Get a new one after
                        that. Linked computers keep working.
                    </p>`
                }
                ${locks.addresses.map(
                    (lock) => html`<p key=${lock.address}>
                        <strong>${lock.address}</strong> is locked out of linking until ${until(lock.until)}: it sent
                        too many wrong link codes. Lockout ${lock.blocks} of 3 this week; the third bans it.
                    </p>`,
                )}
            </div>`
        }
        ${
            locks.bans.length > 0 &&
            html`<div class="runner-bans">
                <div class="group-title">Banned from linking</div>
                <p class="muted small">
                    These addresses were locked out 3 times for guessing link codes. They get the same answer as a
                    wrong code. Lift a ban to let one link again.
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
function LinkComputer({ onDone }) {
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

    return html`<div class="runner-link">
        <div class="group-title">Link a computer</div>
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
            <button class="button ghost" onClick=${onDone}>Cancel</button>
        </div>
    </div>`;
}

/** Readiness is a hint, not a requirement: tools and sign-ins can be installed later. */
function Tools({ runner }) {
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

/** One setting change: one code. Cancel leaves the control where it was. */
function CodeModal({ runner, change, onDone }) {
    const [code, setCode] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    const submit = async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");

        try {
            await api(`runners/${encodeURIComponent(runner.id)}/permissions`, {
                request: { action: "settings", code, change },
            });
            onDone();
        } catch (failure) {
            setError(failure.message);
            setCode("");
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="overlay runner-wait-overlay runner-code-modal">
        <section class="runner-wait" role="dialog" aria-modal="true" aria-labelledby="runner-code-title">
            <h2 id="runner-code-title">Enter the code from your authenticator for ${runner.name}</h2>
            <form onSubmit=${submit}>
                <input
                    type="text"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxlength="6"
                    autofocus
                    aria-label="6-digit code"
                    value=${code}
                    onInput=${(event) => setCode(event.currentTarget.value.replace(/\D/g, ""))}
                />
                ${error && html`<p class="runner-code-error" role="alert">${error}</p>`}
                <div class="row">
                    <button type="button" class="button ghost" onClick=${onDone}>Cancel</button>
                    <button class="button primary" disabled=${busy || code.length !== 6}>Confirm</button>
                </div>
            </form>
        </section>
    </div>`;
}

const APPROVED_BY = {
    computer: "approved at the computer",
    automatic: "approved without a question",
    totp: "approved with a code",
};

/** When an approved session's permission expires, as its row says it. */
function expiry(session) {
    if (session.inUse) {
        return "in use";
    }

    return session.expiresAt === null
        ? "does not expire"
        : `expires ${new Date(session.expiresAt).toLocaleString()}`;
}

/** Settings, saved folders, and approved sessions, from this runner only. */
function Permissions({ runner }) {
    const [change, setChange] = useState(null);
    const state = runner.approvals;

    if (!state) {
        return runner.online
            ? html`<p class="muted small">Update the runner on ${runner.name} to manage approvals here.</p>`
            : null;
    }

    const mine = runner.createdBy === store.state.me?.id;
    const active = state.totp && mine && runner.online;
    const ask = (next) => active && setChange(next);
    const action = (request) =>
        attempt(() => api(`runners/${encodeURIComponent(runner.id)}/permissions`, { request }));
    const settings = state.settings;
    const toggle = (
        key,
        label,
        on,
    ) => html`<div class=${`setting wrap ${active ? "" : "disabled"}`}>
        <div class="grow small">${label}</div>
        <${Switch}
            on=${on}
            disabled=${!active}
            label=${`${label}: ${on ? "on" : "off"}`}
            onChange=${() => ask({ [key]: !on })}
        />
    </div>`;

    return html`<div class="runner-permissions">
        <div class="muted small">
            ${
                state.totp
                    ? "Authenticator set up"
                    : html`No authenticator set up. Set it up on this computer: <code>pi-pocket runner totp setup</code>`
            }
        </div>
        ${!state.totp && html`<div class="muted small">Set up an authenticator for this runner to change its settings.</div>`}
        ${toggle("stopAsking", "Stop asking on new sessions", settings.stopAsking)}
        <label class=${`setting wrap ${active ? "" : "disabled"}`}>
            <span class="grow small">Session expiry with a code</span>
            <select
                disabled=${!active}
                value=${settings.totpDays === null ? "never" : String(settings.totpDays)}
                onChange=${(event) => {
                    const value = event.currentTarget.value;

                    event.currentTarget.value =
                        settings.totpDays === null ? "never" : String(settings.totpDays);
                    ask({ totpDays: value === "never" ? null : Number(value) });
                }}
            >
                <option value="1">1 day</option>
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
                <option value="never">No expiry</option>
            </select>
        </label>
        ${toggle("allowHttp", "Allow plain HTTP", settings.allowHttp)}
        ${toggle("network", "Share the network with browsers", settings.network)}
        <div class=${`setting wrap ${active ? "" : "disabled"}`}>
            <div class="grow small">Downloads: <code>${settings.downloads ?? "temporary folder"}</code></div>
            <button
                class="button small ghost"
                disabled=${!active}
                onClick=${() => {
                    const typed = prompt(
                        "Downloads folder, absolute; empty for the temporary folder",
                        settings.downloads ?? "",
                    );

                    if (typed !== null) {
                        ask({ downloads: typed.trim() === "" ? null : typed.trim() });
                    }
                }}
            >
                Change
            </button>
        </div>
        <div class="group-title">Saved folders</div>
        ${state.folders.length === 0 && html`<div class="muted small">No saved folders.</div>`}
        ${state.folders.map(
            (folder) => html`<div class="runner-permission-row">
                <code>${folder}</code>
                <button class="button small ghost" onClick=${() => action({ action: "remove-folder", folder })}>Remove</button>
            </div>`,
        )}
        <div class="group-title">Approved sessions</div>
        ${state.sessions.length === 0 && html`<div class="muted small">No approved sessions.</div>`}
        ${state.sessions.map(
            (session) => html`<div class="runner-permission-row">
                <div class="small">
                    <code>${session.folder}</code><br />
                    ${session.person}, ${APPROVED_BY[session.approvedBy] ?? session.approvedBy}; ${expiry(session)}
                </div>
                <button class="button small ghost" onClick=${() => action({ action: "revoke", session: session.id })}>Revoke</button>
            </div>`,
        )}
        ${
            state.sessions.length > 0 &&
            html`<button class="button small ghost" onClick=${() => confirm(`Revoke all sessions on ${runner.name}?`) && action({ action: "revoke", session: "all" })}>Revoke all</button>`
        }
        ${change && html`<${CodeModal} runner=${runner} change=${change} onDone=${() => setChange(null)} />`}
    </div>`;
}

/**
 * The people a computer's linker chooses (`access.ts`): they may use it, and viewers among them only see. The same list
 * as the People sheet, for this server and runners alike; people invited to one session keep only that session.
 */
function ChoosePeople({ runner, note }) {
    const people = store.state.users.filter(
        (person) => person.role !== "owner" && !person.sessions,
    );
    const [choosing, setChoosing] = useState(false);
    const [selected, setSelected] = useState([]);
    const [busy, setBusy] = useState(false);
    const mine = runner.createdBy === store.state.me?.id;
    const roleOf = (id) => store.state.users.find((person) => person.id === id)?.role;

    const choose = () => {
        setSelected((runner.users ?? []).map((person) => person.id));
        setChoosing(true);
    };

    const save = () =>
        attempt(async () => {
            setBusy(true);

            try {
                await api(`runners/${encodeURIComponent(runner.id)}/users`, { users: selected });
                setChoosing(false);
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="group">
        <div class="group-title">People</div>
        <div class="row wrap">
            <span class="small">
                ${
                    runner.users
                        ?.map((person) =>
                            roleOf(person.id) === "viewer"
                                ? `${person.name} (view only)`
                                : person.name,
                        )
                        .join(", ") || "No people chosen"
                }
            </span>
            ${
                mine &&
                !choosing &&
                html`<button class="button small ghost" onClick=${choose}>
                    Choose people
                </button>`
            }
        </div>
        ${
            choosing &&
            html`<div role="group" aria-label=${`People who may use ${runner.name}`}>
                ${people.length === 0 && html`<p class="muted small">No one else yet. Invite people in the People sheet.</p>`}
                ${people.map(
                    (person) => html`<label class="check" key=${person.id}>
                        <input
                            type="checkbox"
                            checked=${selected.includes(person.id)}
                            disabled=${busy}
                            onChange=${(event) =>
                                setSelected(
                                    event.currentTarget.checked
                                        ? [...selected, person.id]
                                        : selected.filter((id) => id !== person.id),
                                )}
                        />
                        ${person.name}${person.role === "viewer" ? html` <span class="muted small">(view only)</span>` : ""}
                    </label>`,
                )}
                <div class="row">
                    <button class="button small primary" disabled=${busy} onClick=${save}>
                        Save
                    </button>
                    <button
                        class="button small ghost"
                        disabled=${busy}
                        onClick=${() => setChoosing(false)}
                    >
                        Cancel
                    </button>
                </div>
            </div>`
        }
        <p class="muted small">${note}</p>
    </div>`;
}

/** One on/off rule of a computer kept on the server (`POST /api/runners/:id/settings`), for its linker and the owner. */
function Rule({ runner, name, label, hint, on }) {
    const mine = runner.createdBy === store.state.me?.id;
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

const SHARE_HINT =
    "Off: a new session is private to whoever started it, until they share it. On: it starts shared with the people chosen here.";

/**
 * This server, as a computer (`access.ts` `THIS_SERVER`): the owner is its linker, and it cannot be removed. The owner
 * chooses who may use it, its saved folders, and its rules, as for a runner.
 */
function ServerRow({ server }) {
    const forget = (folder) =>
        attempt(() =>
            api(`runners/this-server/folders?folder=${encodeURIComponent(folder)}`, undefined, {
                method: "DELETE",
            }),
        );

    return html`<div class="person-row runner-row this-server">
        <span class="runner-dot on" aria-hidden="true"></span>
        <div class="person-main">
            <div class="runner-title">${server.name}</div>
            <div class="muted small">Pi Pocket itself · always here, and cannot be removed</div>
            <${ChoosePeople}
                runner=${server}
                note="They can see their own sessions and the ones shared with them, and those who steer can start sessions here. Sessions run as this server's user, like yours."
            />
            <div class="group">
                <div class="group-title">Folder approval</div>
                <${Rule}
                    runner=${server}
                    name="stopAsking"
                    label="Stop asking for saved folders"
                    hint="On: a session in a saved folder starts at once. Any other folder still needs a code from the person's authenticator, or your approval. You never need one here."
                    on=${server.stopAsking}
                />
                <div class="group-title">Saved folders</div>
                ${server.folders.length === 0 && html`<div class="muted small">No saved folders. A folder is saved when its first session is approved.</div>`}
                ${server.folders.map(
                    (folder) => html`<div class="runner-permission-row" key=${folder}>
                        <code>${folder}</code>
                        <button class="button small ghost" onClick=${() => forget(folder)}>Remove</button>
                    </div>`,
                )}
            </div>
            <div class="group">
                <div class="group-title">Sharing</div>
                <${Rule}
                    runner=${server}
                    name="shareNew"
                    label="Share new sessions with these people"
                    hint=${SHARE_HINT}
                    on=${server.shareNew}
                />
            </div>
        </div>
        <div class="person-actions">
            <button class="button small" onClick=${() => openSheet({ type: "cwd", mode: "new" })}>
                New session
            </button>
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
            <${Tools} runner=${runner} />
            <${ChoosePeople}
                runner=${runner}
                note="They can start sessions on this computer. Their sessions run as this computer's user, like yours."
            />
            <div class="group">
                <div class="group-title">Sharing</div>
                <${Rule}
                    runner=${runner}
                    name="shareNew"
                    label="Share new sessions with these people"
                    hint=${SHARE_HINT}
                    on=${runner.shareNew === true}
                />
            </div>
            <${Permissions} runner=${runner} />
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
    const { runners, thisServer } = store.state;
    const [loaded, setLoaded] = useState(false);
    const [linking, setLinking] = useState(false);

    useEffect(() => {
        attempt(async () => {
            const [list, server] = await Promise.all([api("runners"), api("runners/this-server")]);

            store.set({ runners: list, thisServer: server });
            setLoaded(true);
        });
    }, []);

    return html`<${Sheet} title="Runners" onClose=${closeSheet}>
        <p class="muted small">
            Run a session's tools on another of your computers: its files and commands are used there, while Pi,
            your models, and the history stay on this server. The computer connects out to this server, so it
            needs no open port. On each computer, this server too, only the people you choose get in.
        </p>
        ${
            (thisServer || runners.length > 0) &&
            html`<div class="sheet-list">
                ${thisServer && html`<${ServerRow} server=${thisServer} />`}
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
        <${LinkLocks} />
    <//>`;
}
