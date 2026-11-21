// Runners (`src/server/runners.ts`): this server and other computers of the owner's that run sessions' tools. Link one
// with a one-time code, see which are online, start a session on one, remove one, and choose for each (this server
// too) who may use it, each person's folders and sessions there, and whether new sessions start shared
// (`src/server/access.ts`).
// A runner trusts its server after the link: its settings are kept here and sent to it.
import { useEffect, useState } from "preact/hooks";
import {
    api,
    attempt,
    canLink,
    closeSheet,
    managesRunners,
    notify,
    openSheet,
    store,
} from "../store.js";
import { copyText, html, Icon, Loader, Sheet, Switch, timeAgo } from "../ui.js";
import { Avatar } from "../avatar.js";
import {
    AccessRow,
    choosable,
    computers as allComputers,
    inCharge,
    loadComputers,
    sessionsOf,
} from "./access.js";
import { PageItem, Pages, PageTabs } from "./pages.js";

/** What a computer is doing now, in a few words. */
function status(runner) {
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

    return html`<div class="sheet-page runner-link">
        <h3 class="sheet-page-title">Link ${made.name}</h3>
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
                This server's key: <code>${made.fingerprint}</code>. <code>pi-pocket runner status</code> on
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
function LinkLocks({ locks, reload }) {
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

    return html`<div class="sheet-pane">
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
                    ? "Plain HTTP to this server: allowed. Link again to change."
                    : "Plain HTTP: only to this computer or a tailnet device. Link again to change."
            }
        </div>
    </div>`;
}

/**
 * The people of a computer, for who is in charge of it (the owner here, a runner's linker there): each person a row
 * with whether they may use it, and under each the folders given to them there and the sessions they have there, as
 * two lists, each taken back alone (`access.js` `AccessRow`). The same record as People shows by person. Who is in
 * charge has it anyway, and is not listed; someone invited to one session shows only where that session is.
 */
function ComputerPeople({ computer, note }) {
    const people = store.state.users.filter(
        (person) =>
            choosable(computer, person) &&
            (!person.sessions || sessionsOf(computer, person).length > 0),
    );

    // Who may use it is the business of who is in charge: nobody else gets its list.
    if (!inCharge(computer)) {
        return null;
    }

    return html`<div class="group">
        <div class="group-title">People</div>
        <div class="muted small">${note}</div>
        ${people.length === 0 && html`<p class="muted small">No one else yet. Invite people in People.</p>`}
        ${people.map(
            (person) => html`<${AccessRow}
                key=${person.id}
                computer=${computer}
                person=${person}
                title=${person.name}
                lead=${html`<span class="people-here">
                    <${Avatar} person=${person} size=${28} />
                    <span class=${`online-mark ${person.online ? "" : "away"}`} aria-hidden="true"></span>
                </span>`}
            />`,
        )}
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
    "On: new sessions start shared with the people chosen here. Off: they start private.";

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

/** Counts for the Overview: who may use it, and their folders. */
function Overview({ computer }) {
    const server = computer.id === "this-server";
    const people = computer.users?.length ?? 0;
    const given = Object.values(computer.given ?? {}).reduce((sum, each) => sum + each.length, 0);
    const mine = inCharge(computer);
    const linker = store.state.users.find((each) => each.id === computer.createdBy)?.name;
    const rows = [
        mine && ["People who may use it", people === 0 ? "none" : String(people)],
        mine && ["Folders given", String(given)],
    ].filter(Boolean);

    return html`<div class="sheet-pane">
        ${
            computer.blocked &&
            html`<div class="runner-note warning" role="alert" data-part="blocked">
                ${
                    computer.createdBy === store.state.me?.id
                        ? `${computer.name} is blocked: you linked it, and you are a viewer now. Nothing starts or runs there until the owner makes you a user.`
                        : `${computer.name} is blocked: ${linker ?? "the person who linked it"}, who linked it, is a viewer now. Nothing starts or runs there until they are made a user.`
                }${
                    store.state.me?.role === "owner"
                        ? " As the owner, you can make them a user in People, or unlink it."
                        : ""
                }
            </div>`
        }
        ${
            !mine &&
            !computer.blocked &&
            html`<div class="runner-note" data-part="read-only">
                Linked by ${linker ?? "someone else"}, who is in charge of it: only they choose its people, give
                folders there, and change its settings.${
                    store.state.me?.role === "owner"
                        ? " As the owner, you can unlink it."
                        : managesRunners()
                          ? " You manage runners, so you can unlink it."
                          : ""
                }
            </div>`
        }
        ${
            !server &&
            !computer.online &&
            html`<div class="runner-note">
                <div>
                    ${
                        computer.away
                            ? `${computer.name} is offline. Its sessions wait, and continue when it is back.`
                            : mine
                              ? `${computer.name} is not connected. Start its runner: pi-pocket runner.`
                              : `${computer.name} is not connected.`
                    }
                </div>
            </div>`
        }
        ${
            computer.relink &&
            html`<div class="runner-relink small" role="alert">
                ${
                    mine
                        ? "Linked by an older runner: link it again to connect. It keeps its sessions and people."
                        : "Linked by an older runner: who linked it links it again to connect."
                }
            </div>`
        }
        ${!server && computer.tools && html`<div class="group-title">Tools on this computer</div>`}
        ${!server && html`<${Tools} runner=${computer} />`}
        ${computer.fingerprint && html`<div class="muted small runner-key">Key: <code>${computer.fingerprint}</code></div>`}
        ${rows.length > 0 && html`<div class="group-title">At a glance</div>`}
        <div class="sheet-rows">
            ${rows.map(
                ([label, value]) => html`<div class="sheet-glance" key=${label}>
                    <span class="grow">${label}</span>
                    <span class="muted">${value}</span>
                </div>`,
            )}
        </div>
    </div>`;
}

/**
 * The parts of a computer, as tabs. Its people (with their folders and sessions there) and its settings are who is in
 * charge's alone, to see and to change. Anyone else reads its overview only.
 */
function tabsFor(computer) {
    const mine = inCharge(computer);

    return [
        ["overview", "Overview"],
        mine && ["people", "People"],
        mine && ["settings", "Settings"],
    ].filter(Boolean);
}

/** One computer, this server or a linked one: its state and actions, then its parts in tabs. */
function ComputerPage({ computer }) {
    const [tab, setTab] = useState("overview");
    const [again, setAgain] = useState(null);
    const server = computer.id === "this-server";
    const tabs = tabsFor(computer);
    const shown = tabs.some(([id]) => id === tab) ? tab : "overview";
    // Not its linker while it is blocked: only the owner, and who manages runners, unlink it then.
    const mine = inCharge(computer);
    const owner = managesRunners();
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

    return html`<div class="sheet-page">
        <div class="sheet-page-head">
            <span
                class=${`runner-dot ${server || computer.online ? "on" : computer.away ? "away" : ""}`}
                aria-hidden="true"
            ></span>
            <h3 class="sheet-page-title">${computer.name}</h3>
            <div class="sheet-page-actions">
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
        <${PageTabs}
            label=${`${computer.name}: parts`}
            tabs=${tabs}
            shown=${shown}
            onShow=${setTab}
        />
        ${shown === "overview" && html`<${Overview} computer=${computer} />`}
        ${
            shown === "people" &&
            html`<div class="sheet-pane">
                <${ComputerPeople}
                    computer=${computer}
                    note=${
                        server
                            ? "Turn on who may use this server."
                            : `Turn on who may use ${computer.name}.`
                    }
                />
            </div>`
        }
        ${
            shown === "settings" &&
            html`<div class="sheet-pane">
                <${Sharing} computer=${computer} />
                ${!server && html`<${RunnerSettings} runner=${computer} />`}
            </div>`
        }
    </div>`;
}

/** What runners are, for the About page. */
function AboutRunners() {
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

export function ComputersSheet() {
    const { runners, thisServer } = store.state;
    // What guards linking is the owner's to see and lift, and of who manages runners.
    const owner = managesRunners();
    const [loaded, setLoaded] = useState(false);
    const [view, setView] = useState(null);
    const [locks, setLocks] = useState(null);
    const loadLocks = () => attempt(async () => setLocks(await api("runners/locks")));

    useEffect(() => {
        attempt(async () => {
            await loadComputers();
            setLoaded(true);
        });
    }, []);
    useEffect(() => {
        if (owner) {
            loadLocks();
        }
    }, [store.state.runners, view]);

    const computers = allComputers();
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

    const list = html`<div class="group-title">Computers</div>
                ${!loaded && computers.length === 0 && html`<${Loader} />`}
                ${loaded && computers.length === 0 && html`<p class="muted small runner-none">No computers linked yet.</p>`}
                ${
                    thisServer &&
                    html`<${PageItem}
                        selected=${shown === `computer:${thisServer.id}`}
                        onSelect=${() => setView(`computer:${thisServer.id}`)}
                        lead=${html`<span class="runner-dot on" aria-hidden="true"></span>`}
                        title=${thisServer.name}
                        detail="This server"
                    />`
                }
                ${runners.map(
                    (runner) => html`<${PageItem}
                        key=${runner.id}
                        selected=${shown === `computer:${runner.id}`}
                        onSelect=${() => setView(`computer:${runner.id}`)}
                        lead=${html`<span
                            class=${`runner-dot ${runner.online ? "on" : runner.away ? "away" : ""}`}
                            aria-hidden="true"
                        ></span>`}
                        title=${runner.name}
                        detail=${[
                            runner.blocked
                                ? "Blocked"
                                : runner.relink
                                  ? "Link again"
                                  : runner.online
                                    ? "Online"
                                    : runner.away
                                      ? "Offline"
                                      : "Not connected",
                            system(runner),
                            // Whose it is, when it is not mine to change.
                            !inCharge(runner) &&
                                store.state.users.find((each) => each.id === runner.createdBy)
                                    ?.name,
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    />`,
                )}
                <div class="group-title">Linking</div>
                ${
                    canLink() &&
                    html`<${PageItem}
                        selected=${shown === "link"}
                        onSelect=${() => setView("link")}
                        lead=${html`<${Icon} name="plus" size=${16} />`}
                        title="Link a computer"
                    />`
                }
                ${
                    owner &&
                    html`<${PageItem}
                        selected=${shown === "limits"}
                        onSelect=${() => setView("limits")}
                        lead=${html`<${Icon} name="shield" size=${16} />`}
                        title="Linking limits"
                        badge=${lockCount > 0 ? String(lockCount) : null}
                    />`
                }
                <${PageItem}
                    selected=${shown === "about"}
                    onSelect=${() => setView("about")}
                    lead=${html`<${Icon} name="monitor" size=${16} />`}
                    title="About runners"
                />`;

    return html`<${Sheet} title="Runners" onClose=${closeSheet} className="pages-sheet">
        <${Pages} label="Runners" list=${list}>
            ${current && html`<${ComputerPage} key=${current.id} computer=${current} />`}
            ${shown === "link" && canLink() && html`<${LinkComputer} onDone=${() => setView(null)} />`}
            ${shown === "limits" && owner && html`<${LinkLocks} locks=${locks} reload=${loadLocks} />`}
            ${shown === "about" && html`<${AboutRunners} />`}
        <//>
    <//>`;
}
