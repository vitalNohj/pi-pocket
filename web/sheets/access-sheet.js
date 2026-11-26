// The Access sheet: who has what, and where. One sheet in three views, chosen in its head:
// - By person: the people on the left, the chosen person's page beside it (`people.js` `PersonPage`), with their
//   folders and sessions on each computer as a tree.
// - By computer: the computers on the left, the chosen computer's grid beside it (`access-grid.js` `ComputerGrid`):
//   every project, folder, or session there in rows, a column for each person, and under it the people who may use it.
//   Only for who is offered runners (`store.js` `runnersOffered`) or is in charge of this server.
// - Settings: what holds for everyone (for who manages Pi Pocket), Notifications on this device, and for each computer
//   I am in charge of its own settings: how long each person's approvals last, its rules, tools, link again,
//   unlink (`computers.js`).
// `openSheet({ type: "access", view, person, part, computer, page })` opens it at one view, and there at one page:
// `page` is a page of Settings ("notifications", "settings", "limits").
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { NotificationsPage } from "../notify.js";
import {
    api,
    attempt,
    canInviteNew,
    canLink,
    closeSheet,
    hasRight,
    managesPeople,
    managesThisServer,
    managesServer,
    openSheet,
    runnersOffered,
    store,
} from "../store.js";
import { html, Icon, Loader, Sheet, Switch, useMinute } from "../ui.js";
import { keeps, wordsOf } from "./access-tree.js";
import {
    AccessKey,
    ComputerGrid,
    GroupBy,
    gridOf,
    PeopleFilter,
    Pick,
    roleWord,
    SearchField,
    TIMES,
    ACCESS,
    useFind,
} from "./access-grid.js";
import {
    chosenFor,
    choosable,
    computers as allComputers,
    inCharge,
    loadComputers,
    loadProjects,
    projectsOf,
    sessionsOf,
    standing,
    THIS_SERVER,
    toggleUse,
    unchooseReason,
} from "./access.js";
import { ApprovalTime } from "./approvals.js";
import {
    AboutRunners,
    details,
    Downloads,
    LinkComputer,
    LinkLocks,
    LinkSteps,
    RunnerSettings,
    status,
    system,
    Tools,
} from "./computers.js";
import { PageItem, Pages } from "./pages.js";
import { Face, lastSeen, ordered, PersonPage, roleText, SettingsPage } from "./people.js";
import { isOwner, isViewer } from "../roles.js";

/** Who sees By computer: who is offered runners, or is in charge of this server. */
const byComputer = () =>
    runnersOffered() || (store.state.thisServer !== null && inCharge(store.state.thisServer));

/** The views of the sheet this person has, in the order of its switch. */
function viewsOf() {
    return [
        ["person", "By person"],
        byComputer() && ["computer", "By computer"],
        ["settings", "Settings"],
    ].filter(Boolean);
}

/**
 * Load the computers and the people when the sheet opens, and the projects of the computers I am in charge of: again
 * a second after the sessions change while it is open, since a new session can start a new project.
 */
function useLoad() {
    const [loaded, setLoaded] = useState(false);
    const sessions = store.state.sessions;
    const stamp = useMemo(
        () => sessions.map((each) => `${each.id}:${each.cwd}:${each.archived ? 1 : 0}`).join(","),
        [sessions],
    );
    const first = useRef(true);

    useEffect(() => {
        attempt(async () => {
            const [list] = await Promise.all([api("users"), loadComputers()]);

            store.set({ users: list });
            setLoaded(true);
            await loadProjects();
        });
    }, []);

    useEffect(() => {
        if (first.current) {
            first.current = false;

            return undefined;
        }

        const timer = setTimeout(() => void loadProjects(), 1000);

        return () => clearTimeout(timer);
    }, [stamp]);

    return loaded;
}

/** By person: everyone on the left, and the chosen person's page. */
function ByPerson({ sheet }) {
    const { me, users } = store.state;
    const [view, setView] = useState(sheet?.person ? `person:${sheet.person}` : null);
    // The part of a person's page shown: it stays from one person to the next, to do one thing for several people.
    const [part, setPart] = useState(sheet?.part ?? "access");
    // A viewer has no list of the people here: their own page, and the people they may chat with (`access.ts`
    // `mayMessage`).
    const people = ordered(
        me?.seesEveryone === false
            ? users.filter((each) => each.id === me.id || each.mayMessage)
            : users,
    );

    // Asked again while open: a notice of a new message goes to that chat.
    useEffect(() => {
        if (sheet?.person) {
            setView(`person:${sheet.person}`);
        }

        if (sheet?.part) {
            setPart(sheet.part);
        }
    }, [sheet]);

    // One's own page first, for everyone: what is theirs to change is there. A removed person's page falls back the same
    // way.
    const fallback = (people.find((each) => each.id === me?.id) ?? people[0])?.id;
    const shown = people.some((each) => `person:${each.id}` === view)
        ? view
        : fallback === undefined
          ? null
          : `person:${fallback}`;
    const current = people.find((each) => `person:${each.id}` === shown);

    const list = html`<div class="group-title">People</div>
        ${people.map(
            (person) => html`<${PageItem}
                key=${person.id}
                selected=${shown === `person:${person.id}`}
                onSelect=${() => setView(`person:${person.id}`)}
                lead=${html`<${Face} person=${person} />`}
                title=${person.id === me?.id ? `${person.name} (you)` : person.name}
                detail=${[roleText(person), lastSeen(person)].filter(Boolean).join(" · ")}
                badge=${
                    managesPeople() && person.request
                        ? "Request"
                        : person.id === me?.id && person.paused
                          ? // Their own row: their authenticator was removed (their page says so in red).
                            "Relink"
                          : (store.state.directUnread[person.id] ?? 0) > 0
                            ? store.state.directUnread[person.id]
                            : null
                }
                alert=${
                    (managesPeople() && Boolean(person.request)) ||
                    (person.id === me?.id && Boolean(person.paused))
                }
            />`,
        )}
        ${
            canInviteNew() &&
            html`<${PageItem}
                onSelect=${() => openSheet({ type: "invite" })}
                lead=${html`<${Icon} name="plus" size=${16} />`}
                title="Invite someone"
            />`
        }`;

    return html`<${Pages} label="People" list=${list}>
        ${
            current &&
            html`<${PersonPage} key=${current.id} person=${current} part=${part} onPart=${setPart} />`
        }
    <//>`;
}

/** A computer's row in a list on the left: its state, and who uses it. */
function ComputerItem({ computer, selected, onSelect, detail }) {
    const server = computer.id === THIS_SERVER;

    return html`<${PageItem}
        selected=${selected}
        onSelect=${onSelect}
        lead=${html`<span
            class=${`runner-dot ${server || computer.online ? "on" : computer.away ? "away" : ""}`}
            aria-hidden="true"
        ></span>`}
        title=${computer.name}
        detail=${detail}
    />`;
}

/**
 * The people of a computer in my charge, as By computer lists them under its grid: anyone who may be chosen for it
 * (`choosable`: not who has it anyway, so the owner too on a runner someone else linked), and someone invited to
 * sessions only while they have one there.
 */
function peopleHere(computer) {
    return store.state.users.filter(
        (person) =>
            choosable(computer, person) &&
            (!person.sessions || sessionsOf(computer, person).length > 0),
    );
}

/**
 * The people who have a column in a computer's grid: of `peopleHere`, those chosen for it, and those invited to a
 * session there. The list on the left and the People filter both count these.
 */
function columnPeople(computer) {
    return inCharge(computer)
        ? peopleHere(computer).filter((person) => chosenFor(computer, person) || person.sessions)
        : [];
}

/** What a computer's row says in By computer: its state, and how many people have a column in its grid. */
function computerLine(computer) {
    const state =
        computer.id === THIS_SERVER
            ? "Online"
            : computer.blocked
              ? "Blocked"
              : computer.relink
                ? "Link again"
                : computer.online
                  ? "Online"
                  : computer.away
                    ? "Offline"
                    : "Not connected";
    const people = inCharge(computer) ? columnPeople(computer).length : undefined;
    const owner = !inCharge(computer)
        ? store.state.users.find((each) => each.id === computer.createdBy)?.name
        : undefined;

    return [
        state,
        computer.id !== THIS_SERVER && system(computer),
        people !== undefined &&
            (people === 0 ? "no one else" : `${people} ${people === 1 ? "person" : "people"}`),
        owner,
    ]
        .filter(Boolean)
        .join(" · ");
}

/** Who is in charge of a computer, by name: "you" for me. */
function inChargeName(computer) {
    const { me, users } = store.state;
    const id =
        computer.id === THIS_SERVER ? users.find((each) => isOwner(each))?.id : computer.createdBy;

    if (computer.id !== THIS_SERVER && computer.managers?.includes(me?.id) && id !== me?.id) {
        return "You are";
    }

    return id === me?.id
        ? "You are"
        : `${users.find((each) => each.id === id)?.name ?? "Someone"} is`;
}

/**
 * By computer: the computers on the left, and the chosen one's page: one line of what it is, the tool row, the key,
 * the grid of who has what there, then its people with the switch that lets each use it.
 */
function ByComputer({ sheet }) {
    const loaded = store.state.runners !== undefined;
    const [view, setView] = useState(sheet?.computer ? `computer:${sheet.computer}` : null);
    const computers = allComputers();
    const shown =
        view === "link" && canLink()
            ? view
            : view === "about"
              ? view
              : computers.some((each) => `computer:${each.id}` === view)
                ? view
                : computers.length > 0
                  ? `computer:${computers[0].id}`
                  : canLink()
                    ? "link"
                    : "about";
    const current = computers.find((each) => `computer:${each.id}` === shown);

    const list = html`<div class="group-title">Computers</div>
        ${loaded && computers.length === 0 && html`<p class="muted small runner-none">No computers linked yet.</p>`}
        ${computers.map(
            (computer) => html`<${ComputerItem}
                key=${computer.id}
                computer=${computer}
                selected=${shown === `computer:${computer.id}`}
                onSelect=${() => setView(`computer:${computer.id}`)}
                detail=${computerLine(computer)}
            />`,
        )}
        ${
            canLink() &&
            html`<${PageItem}
                selected=${shown === "link"}
                onSelect=${() => setView("link")}
                lead=${html`<${Icon} name="plus" size=${16} />`}
                title="Link a computer"
            />`
        }`;

    return html`<${Pages} label="Computers" list=${list}>
        ${current && html`<${ComputerView} key=${current.id} computer=${current} />`}
        ${shown === "link" && html`<${LinkComputer} onDone=${() => setView(null)} />`}
        ${shown === "about" && html`<${AboutRunners} />`}
    <//>`;
}

/** Unlink a runner, once asked: its runner disconnects, and its sessions stay, running nowhere. */
function unlink(computer) {
    return (
        confirm(
            `Unlink ${computer.name}? Its runner disconnects and its sessions stop working. It can be linked again later.`,
        ) &&
        attempt(() =>
            api(`runners/${encodeURIComponent(computer.id)}`, undefined, { method: "DELETE" }),
        )
    );
}

/**
 * What a computer's page says above its grid: that it is blocked, or someone else's to change, with what I may do
 * about it; and that it is not connected, or linked by an older runner.
 */
function ComputerNotes({ computer }) {
    const { me, users } = store.state;
    const mine = inCharge(computer);
    const server = computer.id === THIS_SERVER;
    const linker = users.find((each) => each.id === computer.createdBy)?.name;
    const unlinks = computer.mayUnlink === true;
    const remedy = [
        managesPeople() && computer.createdBy !== me?.id && "make them a user in By person",
        unlinks && "unlink it",
    ].filter(Boolean);

    return html`${
        computer.blocked &&
        html`<div class="runner-note warning" role="alert" data-part="blocked">
            ${
                computer.createdBy === me?.id
                    ? `${computer.name} is blocked: you linked it, and you are a viewer now. Nothing starts or runs there until you are made a user again.`
                    : `${computer.name} is blocked: ${linker ?? "the person who linked it"}, who linked it, is a viewer now. Nothing starts or runs there until they are made a user.`
            }${remedy.length > 0 ? ` You can ${remedy.join(", or ")}.` : ""}
        </div>`
    }
        ${
            !mine &&
            !computer.blocked &&
            html`<div class="runner-note" data-part="read-only">
                Linked by ${linker ?? "someone else"}, who is in charge of it: only they choose its people and change
                its settings.${
                    hasRight("reshares", computer.id) === true
                        ? " They give folders there, and you give the folders given to you, in By person."
                        : " They give folders there, and so does anyone they let share what they were given."
                }${unlinks ? " You can unlink it." : ""}
            </div>`
        }
        ${
            !server &&
            !computer.online &&
            !computer.blocked &&
            html`<div class="runner-note">
                ${
                    computer.away
                        ? `${computer.name} is offline. Its sessions wait, and continue when it is back.`
                        : mine
                          ? `${computer.name} is not connected. Start its runner there (pi-pocket-runner, or pi-pocket runner).`
                          : `${computer.name} is not connected.`
                }
            </div>`
        }
        ${
            computer.relink &&
            html`<div class="runner-relink small" role="alert">
                ${
                    mine
                        ? "Linked by an older runner: link it again in Settings to connect. It keeps its sessions and people."
                        : "Linked by an older runner: who linked it links it again to connect."
                }
            </div>`
        }`;
}

/** The people of a computer, each with whether they may use it: under its grid. */
function UseSwitches({ computer, people }) {
    const [busy, setBusy] = useState(null);

    if (people.length === 0) {
        return html`<p class="muted small">No one else yet. Invite people in By person.</p>`;
    }

    const flip = async (person) => {
        setBusy(person.id);

        try {
            await toggleUse(computer, person);
        } finally {
            setBusy(null);
        }
    };

    return html`<div class="ag-people">
        <div class="group-title">People</div>
        ${people.map((person) => {
            const { chosen } = standing(computer, person);
            const reason = unchooseReason(computer, person);
            const has = chosen ? sessionsOf(computer, person).length : 0;
            const folders = chosen ? (computer.given?.[person.id] ?? []).length : 0;

            return html`<div class="setting wrap" key=${person.id}>
                <${Face} person=${person} />
                <div class="grow">
                    <div class="small"><strong>${person.name}</strong> <span class="muted">${roleWord(person)}</span></div>
                    <div class="muted small">
                        ${
                            person.sessions
                                ? "Invited to one session only: not chosen for a computer."
                                : chosen
                                  ? `${folders} ${folders === 1 ? "folder" : "folders"} · ${has} ${has === 1 ? "session" : "sessions"}`
                                  : "Off: they have only the sessions shared with them here."
                        }
                    </div>
                </div>
                <${Switch}
                    on=${chosen}
                    disabled=${busy === person.id || Boolean(person.sessions) || reason !== undefined}
                    title=${reason}
                    label=${`${person.name} may use ${computer.name}: ${chosen ? "on" : "off"}`}
                    onChange=${() => flip(person)}
                />
            </div>`;
        })}
    </div>`;
}

/** One computer in By computer. Who is not in charge of it reads what it is, and nothing of who has what there. */
function ComputerView({ computer }) {
    const mine = inCharge(computer);
    const server = computer.id === THIS_SERVER;
    // A person who may unlink it and is not in charge does it here, not in Settings.
    const unlinks = !mine && computer.mayUnlink === true;
    const state = useFind();
    const [hidden, setHidden] = useState(() => new Set());
    const count = store.state.sessions.filter(
        (each) => (each.runner ?? THIS_SERVER) === computer.id && !each.archived,
    ).length;
    const head = [
        server ? "Pi Pocket itself" : computer.blocked ? "Blocked" : status(computer),
        `${count} ${count === 1 ? "session" : "sessions"}`,
        !computer.blocked && `${inChargeName(computer)} in charge`,
    ]
        .filter(Boolean)
        .join(" · ");

    useMinute();

    const everyone = mine ? peopleHere(computer) : [];
    const chosen = columnPeople(computer);
    const people = chosen.filter((person) => !hidden.has(person.id));
    const projects = mine ? projectsOf(computer) : undefined;
    const group =
        state.group === "projects" && projects === undefined
            ? "folders"
            : (state.group ?? (projects === undefined ? "folders" : "projects"));
    const grid = gridOf(computer, people, { group, projects: projects?.projects });
    const words = wordsOf(state.query);
    const { filters } = state;
    const active = words.length > 0 || filters.access !== "" || filters.time !== "";
    const find = {
        words,
        access: filters.access,
        time: filters.time,
        by: "",
        active,
        kept: state.kept,
        group,
        now: Date.now(),
        stamp: JSON.stringify([words, filters.access, filters.time, group]),
        keep: state.keep,
        clear: state.clear,
    };
    const found = grid.rows.filter((each) => keeps(find, each)).length;

    return html`<div class="sheet-page ac-computer">
        <div class="sheet-page-head ac-head">
            <span class="ac-icon"><${Icon} name="monitor" size=${18} /></span>
            <div class="grow">
                <h3 class="sheet-page-title">${computer.name}</h3>
                <div class="muted small">${head}</div>
            </div>
            ${
                mine &&
                html`<${GroupBy}
                    value=${group}
                    projects=${projects !== undefined}
                    onChange=${state.setGroup}
                />`
            }
            ${
                (computer.mayStart !== false || unlinks) &&
                html`<div class="sheet-page-actions">
                    ${
                        unlinks &&
                        html`<button class="button small ghost danger" onClick=${() => unlink(computer)}>
                            Unlink
                        </button>`
                    }
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
                </div>`
            }
        </div>
        <${ComputerNotes} computer=${computer} />
        ${
            mine &&
            html`<div class="ak-tools" role="search" aria-label=${`Find on ${computer.name}`}>
                    <${SearchField}
                        state=${state}
                        active=${active}
                        found=${found}
                        total=${grid.rows.length}
                        placeholder="Search folders and sessions"
                    />
                    <div class="ak-tools-row">
                        <div class="access-picks">
                            <${Pick}
                                name="Access"
                                value=${filters.access}
                                choices=${ACCESS}
                                onChange=${(value) => state.filter("access", value)}
                            />
                            <${Pick}
                                name="Last used by you"
                                value=${filters.time}
                                choices=${TIMES}
                                onChange=${(value) => state.filter("time", value)}
                            />
                            ${
                                chosen.length > 0 &&
                                html`<${PeopleFilter}
                                    people=${chosen}
                                    hidden=${hidden}
                                    onChange=${setHidden}
                                />`
                            }
                        </div>
                    </div>
                </div>
                <${AccessKey} />
                ${
                    chosen.length === 0
                        ? html`<p class="muted small">No one else may use ${computer.name}. Turn someone on below.</p>`
                        : people.length === 0
                          ? html`<p class="muted small">No one is shown. Choose people in the filter.</p>`
                          : null
                }
                <${ComputerGrid}
                    computer=${computer}
                    people=${people}
                    grid=${grid}
                    find=${find}
                    trustColumn=${group !== "sessions" && projects !== undefined}
                    fallback=${projects?.defaultProjectTrust}
                    after=${html`<${UseSwitches} computer=${computer} people=${everyone} />`}
                />`
        }
    </div>`;
}

/**
 * Settings: what holds for everyone, Notifications here, and each computer I am in charge of. It opens on the page asked
 * for (`page`, or a computer), when it is this person's, else on Settings for who manages Pi Pocket, else on
 * Notifications.
 */
function SettingsView({ sheet }) {
    const settings = managesServer();
    const own = allComputers().filter(inCharge);
    const asked = () => (sheet?.computer ? `computer:${sheet.computer}` : (sheet?.page ?? null));
    const [view, setView] = useState(asked);
    const [locks, setLocks] = useState(null);
    const limits = managesThisServer();
    const loadLocks = () => attempt(async () => setLocks(await api("runners/locks")));

    useEffect(() => {
        if (limits) {
            loadLocks();
        }
    }, [store.state.runners]);

    // Asked again while open, at another page.
    useEffect(() => {
        if (sheet?.computer || sheet?.page) {
            setView(asked());
        }
    }, [sheet]);

    const shown =
        (view === "settings" && settings) ||
        view === "notifications" ||
        (view === "limits" && limits) ||
        own.some((each) => `computer:${each.id}` === view)
            ? view
            : settings
              ? "settings"
              : "notifications";
    const current = own.find((each) => `computer:${each.id}` === shown);
    const lockCount = locks
        ? locks.addresses.length + locks.bans.length + (locks.server ? 1 : 0)
        : 0;

    const list = html`<div class="group-title">Settings</div>
        ${
            settings &&
            html`<${PageItem}
                selected=${shown === "settings"}
                onSelect=${() => setView("settings")}
                lead=${html`<${Icon} name="shield" size=${16} />`}
                title="Settings"
                detail="For everyone"
            />`
        }
        <${PageItem}
            selected=${shown === "notifications"}
            onSelect=${() => setView("notifications")}
            lead=${html`<${Icon} name="phone" size=${16} />`}
            title="Notifications"
            detail="On this device"
        />
        ${
            limits &&
            html`<${PageItem}
                selected=${shown === "limits"}
                onSelect=${() => setView("limits")}
                lead=${html`<${Icon} name="shield" size=${16} />`}
                title="Linking limits"
                detail="For runners"
                badge=${lockCount > 0 ? String(lockCount) : null}
            />`
        }
        ${own.length > 0 && html`<div class="group-title">Computers</div>`}
        ${own.map(
            (computer) => html`<${ComputerItem}
                key=${computer.id}
                computer=${computer}
                selected=${shown === `computer:${computer.id}`}
                onSelect=${() => setView(`computer:${computer.id}`)}
                detail=${computer.id === THIS_SERVER ? "Pi Pocket itself" : status(computer)}
            />`,
        )}`;

    return html`<${Pages} label="Settings" list=${list}>
        ${shown === "settings" && html`<${SettingsPage} />`}
        ${
            shown === "notifications" &&
            html`<div class="sheet-page notifications-page">
                <h3 class="sheet-page-title">Notifications</h3>
                <${NotificationsPage} />
            </div>`
        }
        ${shown === "limits" && html`<${LinkLocks} locks=${locks} reload=${loadLocks} />`}
        ${current && html`<${ComputerSettings} key=${current.id} computer=${current} />`}
    <//>`;
}

/**
 * A computer's own settings, for who is in charge of it: how long each person's approvals last, its rules, its tools,
 * link it again, unlink it. This server has its downloads folder and its tools, which it is asked for when the page
 * shows; its network is its own machine's, and it is never linked, so it has no network rule, key, or link.
 */
function ComputerSettings({ computer }) {
    const [again, setAgain] = useState(null);
    const server = computer.id === THIS_SERVER;
    const [tools, setTools] = useState(null);

    // A failed answer draws nothing: the tools are a hint, and the page is whole without them.
    useEffect(() => {
        if (!server) {
            return undefined;
        }

        let shown = true;

        api("runners/this-server/tools").then(
            ({ os, ...ready }) => shown && setTools({ tools: ready, os }),
            () => {},
        );

        return () => {
            shown = false;
        };
    }, [server]);
    const { me } = store.state;
    // Who sets a person's approval time (`app.ts` `setApprovalDays`): who manages them.
    const people = store.state.users.filter(
        (person) =>
            !isOwner(person) && chosenFor(computer, person) && person.approvalDays !== undefined,
    );
    const relink = () =>
        attempt(async () =>
            setAgain({
                ...(await api("runners/code", { runner: computer.id })),
                name: computer.name,
            }),
        );
    const remove = () => unlink(computer);

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
            ${
                !server &&
                (computer.relink || computer.mayUnlink) &&
                html`<div class="sheet-page-actions">
                    ${computer.relink && html`<button class="button small" onClick=${relink}>Link again</button>`}
                    ${computer.mayUnlink && html`<button class="button small ghost danger" onClick=${remove}>Unlink</button>`}
                </div>`
            }
        </div>
        <div class="muted small">
            ${server ? `Pi Pocket itself · ${inChargeName(computer)} in charge` : details(computer)}
        </div>
        ${
            computer.relink &&
            html`<div class="runner-relink small" role="alert">
                Linked by an older runner: link it again to connect. It keeps its sessions and people.
            </div>`
        }
        <div class="group-title">Approvals last</div>
        ${
            people.some((person) => !isViewer(person)) &&
            html`<p class="muted small approvals-note">
                A session of theirs locks this long after they last used it. The same on every computer.
            </p>`
        }
        ${
            people.length === 0
                ? html`<p class="muted small">No one else may use ${computer.name}.</p>`
                : html`<div class="sheet-rows">
                      ${people.map((person) => {
                          const viewer = isViewer(person);
                          const mayChange =
                              managesPeople() &&
                              (isOwner(me) || person.rights?.includes("managesUsers") !== true);

                          return html`<div class="setting wrap" key=${person.id}>
                              <${Face} person=${person} />
                              <div class="grow">
                                  <div class="small"><strong>${person.name}</strong> <span class="muted">${roleWord(person)}</span></div>
                                  ${
                                      viewer &&
                                      html`<div class="muted small">
                                          A viewer reads only: nothing to approve.
                                      </div>`
                                  }
                              </div>
                              ${
                                  !viewer &&
                                  mayChange &&
                                  html`<${ApprovalTime} person=${person} plain=${true} />`
                              }
                          </div>`;
                      })}
                  </div>`
        }
        ${
            server
                ? html`<div class="sheet-pane">
                      <${Downloads} computer=${computer} />
                      <div class="muted small">Browsers of its sessions use this server's own network.</div>
                  </div>`
                : html`<${RunnerSettings} runner=${computer} />`
        }
        ${(server ? tools?.tools : computer.tools) && html`<div class="group-title">Tools on this computer</div>`}
        <${Tools} runner=${server ? (tools ?? {}) : computer} />
        ${computer.fingerprint && html`<div class="muted small runner-key">Key: <code>${computer.fingerprint}</code></div>`}
    </div>`;
}

/** The Access sheet: its head's switch of views, then the view chosen. */
export function AccessSheet() {
    const { sheet } = store.state;
    const loaded = useLoad();
    const views = viewsOf();
    const [view, setView] = useState(sheet?.view ?? "person");

    // Asked again while open, at another view: a notice of a new message opens a chat in By person.
    useEffect(() => {
        if (sheet?.view) {
            setView(sheet.view);
        }
    }, [sheet]);

    const shown = views.some(([key]) => key === view) ? view : views[0][0];
    // The sheet is as wide as the widest grid of By computer needs (`style.css` `.sheet.access-sheet`): the most people
    // with a column on one computer. One width for every view and every computer, so nothing moves under the pointer.
    const columns = Math.max(0, ...allComputers().map((each) => columnPeople(each).length));
    const pick = html`<div class="segmented ac-views" role="tablist" aria-label="Access views">
        ${views.map(
            ([key, label]) => html`<button
                key=${key}
                type="button"
                role="tab"
                class=${shown === key ? "on" : ""}
                aria-selected=${shown === key}
                onClick=${() => setView(key)}
            >
                ${label}
            </button>`,
        )}
    </div>`;

    return html`<${Sheet}
        title="Access"
        onClose=${closeSheet}
        className=${`pages-sheet access-sheet view-${shown}`}
        style=${`--columns:${columns}`}
        actions=${views.length > 1 ? pick : null}
    >
        ${!loaded && store.state.users.length === 0 && html`<${Loader} />`}
        ${shown === "person" && html`<${ByPerson} sheet=${sheet} />`}
        ${shown === "computer" && html`<${ByComputer} sheet=${sheet} />`}
        ${shown === "settings" && html`<${SettingsView} sheet=${sheet} />`}
    <//>`;
}
