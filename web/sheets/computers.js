// Runners (`src/server/runners.ts`): this server and other computers of the owner's that run sessions' tools. Link one
// with a one-time code, see which are online, start a session on one, remove one, and choose for each (this server
// too) who may use it, the folders each person may use, and whether new sessions start shared (`src/server/access.ts`).
// A runner trusts its server after the link: its settings are kept here and sent to it.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, canLink, closeSheet, notify, openSheet, store } from "../store.js";
import { copyText, html, Icon, Loader, Sheet, Switch, timeAgo } from "../ui.js";
import { ApprovalsList } from "./approvals.js";

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

    return html`<div class="runner-page runner-link">
        <h3 class="runner-page-title">Link ${made.name}</h3>
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
            ${`The code works once and expires in ${minutes} minutes. ${made.name} shows as online here when it connects.`}
        </p>
        ${
            made.fingerprint &&
            html`<p class="muted small">
                This server's key, which ${made.name} keeps to know this server: <code>${made.fingerprint}</code>.
                <code>pi-pocket runner status</code> there shows the same.
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
        <strong>The linked computer trusts this server fully.</strong> Sessions you start there run commands and change
        files as that computer's user, with everything that user can reach. Nothing runs in a sandbox.
    </p>`;
}

/**
 * Linking paused, for one address or the whole server, and the addresses banned for guessing codes, which the owner can
 * lift (`link-limits.ts`). Only the owner opens Runners.
 */
function LinkLocks({ locks, reload }) {
    const intro = html`<h3 class="runner-page-title">Linking limits</h3>
        <p class="muted small">
            Redeeming a link code is the one thing anyone can try without signing in. Wrong codes are limited for each
            address, and in total; an address locked out 3 times in a week is banned.
        </p>`;

    if (!locks) {
        return html`<div class="runner-page">${intro}<${Loader} /></div>`;
    }

    if (!locks.server && locks.addresses.length === 0 && locks.bans.length === 0) {
        return html`<div class="runner-page">
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

    return html`<div class="runner-page runner-locks">
        ${intro}
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

/** Whether I am in charge of a computer: its linker, or for this server the owner (`access.ts` `inCharge`). */
function inCharge(computer) {
    return computer.id === "this-server"
        ? store.state.me?.role === "owner"
        : computer.createdBy === store.state.me?.id;
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

    return html`<div class="runner-page runner-link">
        <h3 class="runner-page-title">Link a computer</h3>
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

/**
 * What a runner does for its sessions, kept here and sent to it at once (`runner-settings`): whether their browsers use
 * its network, and where their downloads go there. Plain HTTP was chosen on that computer when it was linked.
 */
function RunnerSettings({ runner }) {
    const mine = inCharge(runner);

    if (runner.network === undefined) {
        return null;
    }

    const changeDownloads = () => {
        const typed = prompt(
            "Downloads folder there, absolute; empty for its temporary folder",
            runner.downloads ?? "",
        );

        if (typed !== null) {
            void attempt(() =>
                api(`runners/${encodeURIComponent(runner.id)}/settings`, {
                    downloads: typed.trim() === "" ? null : typed.trim(),
                }),
            );
        }
    };

    return html`<div class="runner-pane">
        <${Rule}
            runner=${runner}
            name="network"
            label="Share its network with browsers"
            hint=${`On: sessions' browsers reach what ${runner.name} reaches, such as its local servers and home network.`}
            on=${runner.network}
        />
        <div class=${`setting wrap ${mine ? "" : "disabled"}`}>
            <div class="grow">
                <div class="small">Downloads</div>
                <div class="muted small">
                    ${runner.downloads ?? "Temporary folder, which can be cleared when the computer restarts"}
                </div>
            </div>
            <button class="button small ghost" disabled=${!mine} onClick=${changeDownloads}>Change</button>
        </div>
        <div class="muted small">
            ${
                runner.allowHttp
                    ? "Plain HTTP to this server is allowed there, as chosen when it was linked."
                    : "Plain HTTP only to this computer itself or a tailnet device, as chosen when it was linked."
            }
        </div>
    </div>`;
}

/**
 * The people a computer's linker chooses (`access.ts`): they may use it, and viewers among them only see. The same list
 * as the People sheet, for this server and runners alike; people invited to one session keep only that session. Who is
 * in charge has it anyway: the owner here, the linker of a runner (where the owner is chosen as anyone is).
 */
function ChoosePeople({ runner, note }) {
    const people = store.state.users.filter(
        (person) =>
            !person.sessions &&
            (runner.id === "this-server"
                ? person.role !== "owner"
                : person.id !== runner.createdBy),
    );
    const [choosing, setChoosing] = useState(false);
    const [selected, setSelected] = useState([]);
    const [busy, setBusy] = useState(false);
    const mine = inCharge(runner);
    const roleOf = (id) => store.state.users.find((person) => person.id === id)?.role;

    // Who may use it is the business of who is in charge: nobody else gets its list.
    if (!mine) {
        return null;
    }

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

const SHARE_HINT =
    "Off: a new session is private to whoever started it, until they share it. On: it starts shared with the people chosen here.";

/**
 * The folders given to each chosen person on a computer (`access.ts`): each covers the folders in it. A person given
 * none may not start sessions there. Only who is in charge (the owner here, a runner's linker there) sees and changes
 * them.
 */
function GivenFolders({ computer }) {
    const given = computer.given ?? {};
    const people = (computer.users ?? []).filter((person) => person.role !== "viewer");
    const [adding, setAdding] = useState({});

    if (!inCharge(computer) || people.length === 0) {
        return null;
    }

    const save = (person, folders) =>
        attempt(() => api(`runners/${encodeURIComponent(computer.id)}/given`, { person, folders }));

    return html`<div class="group">
        <div class="group-title">Folders</div>
        <div class="muted small">
            Each person works only in the folders you give them here, and the folders inside them.
        </div>
        ${people.map((person) => {
            const folders = given[person.id] ?? [];
            const draft = adding[person.id] ?? "";

            const add = () => {
                const folder = draft.trim();

                if (folder !== "") {
                    void save(person.id, [...folders, folder]).then(() =>
                        setAdding({ ...adding, [person.id]: "" }),
                    );
                }
            };

            return html`<div class="given-folders" key=${person.id}>
                <div class="small"><strong>${person.name}</strong></div>
                ${folders.length === 0 && html`<div class="muted small">No folders yet.</div>`}
                ${folders.map(
                    (folder) => html`<div class="runner-permission-row" key=${folder}>
                        <code>${folder}</code>
                        <button
                            class="button small ghost"
                            onClick=${() =>
                                save(
                                    person.id,
                                    folders.filter((each) => each !== folder),
                                )}
                        >
                            Remove
                        </button>
                    </div>`,
                )}
                <div class="row">
                    <input
                        type="text"
                        placeholder="Add a folder, as ~/projects/app"
                        aria-label=${`Add a folder for ${person.name}`}
                        value=${draft}
                        onInput=${(event) =>
                            setAdding({ ...adding, [person.id]: event.currentTarget.value })}
                        onKeyDown=${(event) => event.key === "Enter" && add()}
                    />
                    <button class="button small" disabled=${draft.trim() === ""} onClick=${add}>
                        Add
                    </button>
                </div>
            </div>`;
        })}
    </div>`;
}

/**

/** Sharing on a computer: whether new sessions there start shared with its people. */
function Sharing({ computer }) {
    if (!inCharge(computer)) {
        return null;
    }

    return html`<${Rule}
        runner=${computer}
        name="shareNew"
        label="Share new sessions with these people"
        hint=${SHARE_HINT}
        on=${computer.shareNew === true}
    />`;
}

/** Its version, and its architecture, as a short line under its name. */
function details(runner) {
    return [
        status(runner),
        [system(runner), runner.arch].filter(Boolean).join(" "),
        runner.version && `runner ${runner.version}`,
    ]
        .filter(Boolean)
        .join(" · ");
}

/** Counts for the Overview: who may use it, their folders, and its sessions' approvals. */
function Overview({ computer }) {
    const server = computer.id === "this-server";
    const people = computer.users?.length ?? 0;
    const given = Object.values(computer.given ?? {}).reduce((sum, each) => sum + each.length, 0);
    const approvals = (store.state.folderApprovals ?? []).filter(
        (each) => each.computer === computer.id,
    ).length;
    const rows = [
        inCharge(computer) && ["People who may use it", people === 0 ? "none" : String(people)],
        inCharge(computer) && ["Folders given", String(given)],
        ["Session approvals", String(approvals)],
    ].filter(Boolean);

    return html`<div class="runner-pane">
        ${
            !server &&
            !computer.online &&
            html`<div class="runner-note">
                <div>
                    ${
                        computer.away
                            ? `${computer.name} is offline. Its sessions wait, and continue when it is back.`
                            : `${computer.name} is not connected. Start its runner: pi-pocket runner.`
                    }
                </div>
            </div>`
        }
        ${
            computer.relink &&
            html`<div class="runner-relink small" role="alert">
                Linked by an older runner: link it again to connect. It keeps its sessions and people.
            </div>`
        }
        ${!server && html`<div class="group-title">Tools on this computer</div>`}
        ${!server && html`<${Tools} runner=${computer} />`}
        ${computer.fingerprint && html`<div class="muted small runner-key">Key: <code>${computer.fingerprint}</code></div>`}
        <div class="group-title">At a glance</div>
        <div class="runner-rows">
            ${rows.map(
                ([label, value]) => html`<div class="runner-glance" key=${label}>
                    <span class="grow">${label}</span>
                    <span class="muted">${value}</span>
                </div>`,
            )}
        </div>
    </div>`;
}

/** The parts of a computer, as tabs: the people and folders tabs are who is in charge's alone. */
function tabsFor(computer) {
    const mine = inCharge(computer);
    const server = computer.id === "this-server";

    return [
        ["overview", "Overview"],
        mine && ["people", "People"],
        ["approvals", "Approvals"],
        (mine || !server) && ["settings", "Settings"],
    ].filter(Boolean);
}

/** One computer, this server or a linked one: its state and actions, then its parts in tabs. */
function ComputerPage({ computer }) {
    const [tab, setTab] = useState("overview");
    const [again, setAgain] = useState(null);
    const server = computer.id === "this-server";
    const tabs = tabsFor(computer);
    const shown = tabs.some(([id]) => id === tab) ? tab : "overview";
    const count = (store.state.folderApprovals ?? []).filter(
        (each) => each.computer === computer.id,
    ).length;
    const mine = computer.createdBy === store.state.me?.id;
    const owner = store.state.me?.role === "owner";
    // A computer linked before the secure link: a code for it links its runner again, with the same sessions.
    const relink = () =>
        attempt(async () =>
            setAgain({
                ...(await api("runners/code", { runner: computer.id })),
                name: computer.name,
            }),
        );
    const remove = () =>
        confirm(
            `${mine ? "Remove" : "Unlink"} ${computer.name}? Its runner disconnects and its sessions stop working. It can be linked again later.`,
        ) &&
        attempt(() =>
            api(`runners/${encodeURIComponent(computer.id)}`, undefined, { method: "DELETE" }),
        );

    if (again) {
        return html`<${LinkSteps} made=${again} onDone=${() => setAgain(null)} />`;
    }

    return html`<div class="runner-page">
        <div class="runner-page-head">
            <span
                class=${`runner-dot ${server || computer.online ? "on" : computer.away ? "away" : ""}`}
                aria-hidden="true"
            ></span>
            <h3 class="runner-page-title">${computer.name}</h3>
            <div class="runner-page-actions">
                ${
                    computer.mayStart !== false &&
                    html`<button
                        class="button small primary"
                        disabled=${!server && !computer.online}
                        title=${server || computer.online ? "Pick a folder there" : `${computer.name} is not connected`}
                        onClick=${() =>
                            openSheet(
                                server
                                    ? { type: "cwd", mode: "new" }
                                    : { type: "cwd", mode: "new", runner: computer.id },
                            )}
                    >
                        New session
                    </button>`
                }
                ${
                    !server &&
                    computer.relink &&
                    inCharge(computer) &&
                    html`<button class="button small" onClick=${relink}>Link again</button>`
                }
                ${
                    !server &&
                    (mine || owner) &&
                    html`<button class="button small ghost danger" onClick=${remove}>
                        ${mine ? "Remove" : "Unlink"}
                    </button>`
                }
            </div>
        </div>
        <div class="muted small">
            ${server ? "Pi Pocket itself · always here, and cannot be removed" : details(computer)}
        </div>
        <div class="segmented runner-tabs" role="tablist" aria-label=${`${computer.name}: parts`}>
            ${tabs.map(
                ([id, label]) => html`<button
                    key=${id}
                    role="tab"
                    class=${shown === id ? "on" : ""}
                    aria-selected=${shown === id}
                    onClick=${() => setTab(id)}
                >
                    ${label}${id === "approvals" && count > 0 ? html` <span class="muted">${count}</span>` : ""}
                </button>`,
            )}
        </div>
        ${shown === "overview" && html`<${Overview} computer=${computer} />`}
        ${
            shown === "people" &&
            html`<div class="runner-pane">
                <${ChoosePeople}
                    runner=${computer}
                    note=${
                        server
                            ? "They see their own sessions and the ones shared with them, and those who steer start sessions in the folders you give them. Sessions run as this server's user, like yours."
                            : "Those who steer start sessions in the folders you give them. Their sessions run as this computer's user, like yours."
                    }
                />
                <${GivenFolders} computer=${computer} />
            </div>`
        }
        ${
            shown === "approvals" &&
            html`<div class="runner-pane"><${ApprovalsList} computer=${computer.id} /></div>`
        }
        ${
            shown === "settings" &&
            html`<div class="runner-pane">
                <${Sharing} computer=${computer} />
                ${!server && html`<${RunnerSettings} runner=${computer} />`}
            </div>`
        }
    </div>`;
}

/** What runners are, for the About page. */
function AboutRunners() {
    return html`<div class="runner-page">
        <h3 class="runner-page-title">About runners</h3>
        <p>
            Run a session's tools on another of your computers: its files and commands are used there, while Pi,
            your models, and the history stay on this server.
        </p>
        <p class="muted">
            The computer connects out to this server, so it needs no open port. It trusts this server after the link:
            who may use it, in which folders, and for how long are decided here. On each computer, this server too,
            only the people its linker chooses get in. See <code>docs/runners.md</code> for everything else.
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

/** A row in the list on the left: a computer, or a page about this server. */
function ListItem({ selected, onSelect, lead, title, detail, badge }) {
    return html`<button
        class=${`runner-item ${selected ? "on" : ""}`}
        aria-current=${selected ? "page" : undefined}
        onClick=${onSelect}
    >
        ${lead}
        <span class="runner-item-text">
            <span class="runner-item-title">${title}</span>
            ${detail && html`<span class="muted small">${detail}</span>`}
        </span>
        ${badge && html`<span class="runner-badge">${badge}</span>`}
    </button>`;
}

export function ComputersSheet() {
    const { runners, thisServer } = store.state;
    const owner = store.state.me?.role === "owner";
    const [loaded, setLoaded] = useState(false);
    const [view, setView] = useState(null);
    const [locks, setLocks] = useState(null);
    const loadLocks = () => attempt(async () => setLocks(await api("runners/locks")));

    useEffect(() => {
        attempt(async () => {
            // This server's record is the owner's business alone (who is in charge of it).
            const [list, server] = await Promise.all([
                api("runners"),
                owner ? api("runners/this-server") : null,
            ]);

            store.set({ runners: list, thisServer: server });
            setLoaded(true);
        });
    }, []);
    useEffect(() => {
        if (owner) {
            loadLocks();
        }
    }, [store.state.runners, view]);

    const computers = [...(thisServer ? [thisServer] : []), ...runners];
    // The first computer, or linking when there is none; a removed computer's page falls back the same way.
    const shown =
        view &&
        (view.startsWith("computer:")
            ? computers.some((each) => `computer:${each.id}` === view)
            : true)
            ? view
            : computers.length > 0
              ? `computer:${computers[0].id}`
              : loaded
                ? canLink()
                    ? "link"
                    : "about"
                : null;
    const lockCount = locks
        ? locks.addresses.length + locks.bans.length + (locks.server ? 1 : 0)
        : 0;
    const current = shown?.startsWith("computer:")
        ? computers.find((each) => `computer:${each.id}` === shown)
        : undefined;

    return html`<${Sheet} title="Runners" onClose=${closeSheet} className="runners-sheet">
        <div class="runners-split">
            <nav class="runners-list" aria-label="Runners">
                <div class="group-title">Computers</div>
                ${!loaded && computers.length === 0 && html`<${Loader} />`}
                ${loaded && computers.length === 0 && html`<p class="muted small runner-none">No computers linked yet.</p>`}
                ${
                    thisServer &&
                    html`<${ListItem}
                        selected=${shown === `computer:${thisServer.id}`}
                        onSelect=${() => setView(`computer:${thisServer.id}`)}
                        lead=${html`<span class="runner-dot on" aria-hidden="true"></span>`}
                        title=${thisServer.name}
                        detail="This server"
                    />`
                }
                ${runners.map(
                    (runner) => html`<${ListItem}
                        key=${runner.id}
                        selected=${shown === `computer:${runner.id}`}
                        onSelect=${() => setView(`computer:${runner.id}`)}
                        lead=${html`<span
                            class=${`runner-dot ${runner.online ? "on" : runner.away ? "away" : ""}`}
                            aria-hidden="true"
                        ></span>`}
                        title=${runner.name}
                        detail=${[
                            runner.relink
                                ? "Link again"
                                : runner.online
                                  ? "Online"
                                  : runner.away
                                    ? "Offline"
                                    : "Not connected",
                            system(runner),
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    />`,
                )}
                <div class="group-title">Linking</div>
                ${
                    canLink() &&
                    html`<${ListItem}
                        selected=${shown === "link"}
                        onSelect=${() => setView("link")}
                        lead=${html`<${Icon} name="plus" size=${16} />`}
                        title="Link a computer"
                    />`
                }
                ${
                    owner &&
                    html`<${ListItem}
                        selected=${shown === "limits"}
                        onSelect=${() => setView("limits")}
                        lead=${html`<${Icon} name="shield" size=${16} />`}
                        title="Linking limits"
                        badge=${lockCount > 0 ? String(lockCount) : null}
                    />`
                }
                <${ListItem}
                    selected=${shown === "about"}
                    onSelect=${() => setView("about")}
                    lead=${html`<${Icon} name="monitor" size=${16} />`}
                    title="About runners"
                />
            </nav>
            <div class="runners-detail">
                ${current && html`<${ComputerPage} key=${current.id} computer=${current} />`}
                ${shown === "link" && canLink() && html`<${LinkComputer} onDone=${() => setView(null)} />`}
                ${shown === "limits" && owner && html`<${LinkLocks} locks=${locks} reload=${loadLocks} />`}
                ${shown === "about" && html`<${AboutRunners} />`}
            </div>
        </div>
    <//>`;
}
