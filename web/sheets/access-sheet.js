// Access has three views: People shows a person's computers and permissions. Computer shows one grid of what the
// reader can give or take, with trust, All folders and use switches for who is in charge. Settings holds the common
// settings, notifications, and the settings of the computers in the reader's charge.
// openSheet({ type: "access", view, person, part, computer, only, page }) opens a view and page; `only` starts the
// Computer grid with just that person shown.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
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
    store,
} from "../store.js";
import { html, Icon, Loader, Sheet, Switch, useMinute } from "../ui.js";
import { keeps, wordsOf } from "./access-tree.js";
import {
    AccessKey,
    answerPeople,
    answerSource,
    ComputerGrid,
    GroupBy,
    gridOf,
    PeopleFilter,
    Pick,
    recordSource,
    roleWord,
    SearchField,
    TIMES,
    ACCESS,
    useFind,
} from "./access-grid.js";
import {
    chosenFor,
    choosable,
    ComputerDot,
    computers as allComputers,
    inCharge,
    loadComputers,
    loadProjects,
    loadSharings,
    projectsOf,
    sessionsOf,
    sharingOf,
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
import { SelectButton, useSelect } from "./session-select.js";
import { isOwner, isViewer, prompts } from "../roles.js";

/** The views of the sheet this person has, in the order of its switch. */
function viewsOf() {
    const { me } = store.state;
    const computer =
        !isViewer(me) && ((prompts(me) && !me.sessions && allComputers().length > 0) || canLink());

    return [
        ["person", "People"],
        computer && ["computer", "Computer"],
        ["settings", "Settings"],
    ].filter(Boolean);
}

/** Load the people and computers on open. The grids' answers follow the list of computers and sessions. */
function useLoad() {
    const [loaded, setLoaded] = useState(false);
    const { sessions, runners, thisServer, me } = store.state;
    const stamp = useMemo(
        () =>
            JSON.stringify(
                sessions.map((each) => [
                    each.id,
                    each.cwd,
                    each.sharedWith,
                    each.archived,
                    each.mayShare,
                ]),
            ),
        [sessions],
    );
    const first = useRef(true);

    useEffect(() => {
        attempt(async () => {
            const [list] = await Promise.all([api("users"), loadComputers()]);

            store.set({ users: list });
            setLoaded(true);
        });
    }, []);

    useEffect(() => {
        if (!loaded) {
            return undefined;
        }

        const refresh = () => Promise.all([loadProjects(), loadSharings()]);

        if (first.current) {
            first.current = false;
            void refresh();

            return undefined;
        }

        const timer = setTimeout(refresh, 1000);

        return () => clearTimeout(timer);
    }, [loaded, stamp, runners, thisServer, me?.mayStart]);

    return loaded;
}

/** People: everyone on the left, and the chosen person's page. */
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
    return html`<${PageItem}
        selected=${selected}
        onSelect=${onSelect}
        lead=${html`<${ComputerDot} computer=${computer} />`}
        title=${computer.name}
        detail=${detail}
    />`;
}

/**
 * The people of a computer in my charge, as Computer lists them under its grid: anyone who may be chosen for it
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

/** Of `peopleHere`, the people who have something on the computer: chosen for it, or invited to a session there. */
function usersHere(computer) {
    return peopleHere(computer).filter((person) => chosenFor(computer, person) || person.sessions);
}

/**
 * The people who have a column in a computer's grid: each one the reader can give something to there, or take
 * something from. In my charge, `usersHere` without its managers: every session there is theirs, so no cell of
 * theirs can be changed. Else the people the server names (`commands.ts` `sharingOn`).
 */
function columnPeople(computer) {
    if (computer.mayUse === false) {
        return [];
    }

    return inCharge(computer)
        ? usersHere(computer).filter((person) => !standing(computer, person).manager)
        : answerPeople(sharingOf(computer));
}

/** What a computer's row says in Computer: its state, and how many other people have something on it. */
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
    const people = inCharge(computer) ? usersHere(computer).length : undefined;
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
 * Computer: the computers on the left, and the chosen one's page: one line of what it is, the tool row, the key,
 * the grid of who has what there, then its people with the switch that lets each use it.
 */
function ByComputer({ sheet }) {
    const loaded = store.state.runners !== undefined;
    const [view, setView] = useState(sheet?.computer ? `computer:${sheet.computer}` : null);
    const computers = allComputers();

    useEffect(() => {
        if (sheet?.computer) {
            setView(`computer:${sheet.computer}`);
        }
    }, [sheet]);

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
    const only = current?.id === sheet?.computer ? sheet?.only : undefined;

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
        ${current && html`<${ComputerView} key=${JSON.stringify([current.id, only])} computer=${current} only=${only} />`}
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
    const owner = users.find(isOwner)?.name ?? "The owner";
    const linked = `Linked by ${linker ?? "someone else"}, who is in charge of it`;

    if (computer.mayUse === false && !computer.blocked) {
        return html`<div class="runner-note" data-part="read-only">
            ${linked}. You do not use it, and see nothing on it. You can unlink it.
        </div>`;
    }

    const remedy = [
        managesPeople() && computer.createdBy !== me?.id && "make them a user in People",
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
                ${server ? `${owner} is in charge of This server` : linked}: only they choose its people and change its settings.${
                    hasRight("reshares", computer.id) === true
                        ? " You share your sessions here, and give the folders given to you."
                        : " You share the sessions you started here."
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

/**
 * The people of a computer, each with whether they may use it: under its grid. Only the switches the reader can
 * flip: not someone invited to one session only, who is chosen for no computer, and not a manager the reader may not
 * take off it (`unchooseReason`).
 */
function UseSwitches({ computer, people: everyone }) {
    const [busy, setBusy] = useState(null);
    const people = everyone.filter(
        (person) => !person.sessions && unchooseReason(computer, person) === undefined,
    );

    if (everyone.length === 0) {
        return html`<p class="muted small">No one else yet. Invite people in People.</p>`;
    }

    if (people.length === 0) {
        return null;
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
            const { chosen, manager } = standing(computer, person);
            const has = chosen ? sessionsOf(computer, person).length : 0;
            const folders = chosen ? (computer.given?.[person.id] ?? []).length : 0;

            return html`<div class="setting wrap" key=${person.id}>
                <${Face} person=${person} />
                <div class="grow">
                    <div class="small"><strong>${person.name}</strong> <span class="muted">${roleWord(person)}</span></div>
                    <div class="muted small">
                        ${
                            manager
                                ? "In charge here: every session there is theirs."
                                : chosen
                                  ? `${folders} ${folders === 1 ? "folder" : "folders"} · ${has} ${has === 1 ? "session" : "sessions"}`
                                  : "Off: they have only the sessions shared with them here."
                        }
                    </div>
                </div>
                <${Switch}
                    on=${chosen}
                    disabled=${busy === person.id}
                    label=${`${person.name} may use ${computer.name}: ${chosen ? "on" : "off"}`}
                    onChange=${() => flip(person)}
                />
            </div>`;
        })}
    </div>`;
}

/** One computer: what it is, and what the reader can give or take there. */
function ComputerView({ computer, only }) {
    const mine = inCharge(computer);
    const usable = computer.mayUse !== false && !computer.blocked;
    const server = computer.id === THIS_SERVER;
    // A person who may unlink it and is not in charge does it here, not in Settings.
    const unlinks = !mine && computer.mayUnlink === true;
    const state = useFind();
    const page = useRef(null);
    const [picked, setHidden] = useState(null);
    const count = usable
        ? store.state.sessions.filter(
              (each) => (each.runner ?? THIS_SERVER) === computer.id && !each.archived,
          ).length
        : 0;
    const head = [
        server ? "Pi Pocket itself" : computer.blocked ? "Blocked" : status(computer),
        `${count} ${count === 1 ? "session" : "sessions"}`,
        !computer.blocked && `${inChargeName(computer)} in charge`,
    ]
        .filter(Boolean)
        .join(" · ");

    useMinute();

    useLayoutEffect(() => {
        if (only !== undefined && matchMedia("(max-width: 719px)").matches) {
            page.current.scrollIntoView({ block: "start" });
        }
    }, [only]);

    const everyone = mine ? peopleHere(computer) : [];
    const chosen = columnPeople(computer);
    // Asked for someone who has no column because they may not use it yet: said, with where to turn them on.
    const onlyOff = chosen.some((each) => each.id === only)
        ? undefined
        : everyone.find((each) => each.id === only && !each.sessions && !chosenFor(computer, each));
    const target = onlyOff || chosen.some((each) => each.id === only) ? only : undefined;
    const hidden =
        picked ??
        new Set(
            target === undefined
                ? []
                : chosen.filter((each) => each.id !== target).map((each) => each.id),
        );
    const people = chosen.filter((person) => !hidden.has(person.id));
    const select = useSelect(JSON.stringify([computer.id, people.map((each) => each.id)]));
    const projects = mine ? projectsOf(computer) : undefined;
    const group =
        state.group === "projects" && projects === undefined
            ? "folders"
            : (state.group ?? (projects === undefined ? "folders" : "projects"));
    const answer = usable ? sharingOf(computer) : undefined;
    const source = mine
        ? recordSource(computer, people)
        : answerSource(computer, {
              people: answer?.people.filter((each) => !hidden.has(each.id)) ?? [],
          });
    const grid = gridOf(source, { group, projects: projects?.projects });
    const starters = new Set(grid.rows.map((each) => each.starter));
    const by = ordered(store.state.users.filter((each) => starters.has(each.id)));
    const words = wordsOf(state.query);
    const { filters } = state;
    const start = by.length > 1 ? filters.by : "";
    const active = words.length > 0 || filters.access !== "" || filters.time !== "" || start !== "";
    const find = {
        words,
        query: state.query.trim(),
        access: filters.access,
        time: filters.time,
        by: start,
        active,
        kept: state.kept,
        group,
        now: Date.now(),
        stamp: JSON.stringify([words, filters.access, filters.time, start, group]),
        keep: state.keep,
        clear: state.clear,
    };
    const found = grid.rows.filter((each) => keeps(find, each)).length;
    const hasGrid = usable && (mine || chosen.length > 0);
    const mayStart = usable && computer.mayStart !== false;

    return html`<div class="sheet-page ac-computer" ref=${page}>
        <div class="sheet-page-head ac-head">
            <span class="ac-icon"><${Icon} name="monitor" size=${18} /></span>
            <div class="grow">
                <h3 class="sheet-page-title">${computer.name}</h3>
                <div class="muted small">${head}</div>
            </div>
            ${
                usable &&
                html`<${GroupBy}
                    value=${group}
                    projects=${projects !== undefined}
                    onChange=${state.setGroup}
                />`
            }
            ${
                (mayStart || unlinks) &&
                html`<div class="sheet-page-actions">
                    ${
                        unlinks &&
                        html`<button class="button small ghost danger" onClick=${() => unlink(computer)}>
                            Unlink
                        </button>`
                    }
                    ${
                        mayStart &&
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
        ${usable && !mine && answer === undefined && html`<${Loader} />`}
        ${
            usable &&
            answer &&
            !answer.failed &&
            answer.people.length === 0 &&
            html`<p
            class="muted small"
            data-part="nothing-to-share"
        >
            Nothing of yours to share on ${computer.name} yet. A session you start here can be shared with the people who use it.
        </p>`
        }
        ${
            hasGrid &&
            html`<div class="ak-tools" role="search" aria-label=${`Find on ${computer.name}`}>
                    ${
                        (mine || grid.rows.length > 1 || source.folders.length > 1 || active) &&
                        html`<${SearchField}
                        state=${state}
                        active=${active}
                        found=${found}
                        total=${grid.rows.length}
                        placeholder="Search folders and sessions"
                    />`
                    }
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
                                by.length > 1 &&
                                html`<${Pick}
                                name="Started by"
                                value=${start}
                                choices=${[["", "Anyone"], ...by.map((each) => [each.id, each.name, `Started by ${each.name}`])]}
                                onChange=${(value) => state.filter("by", value)}
                            />`
                            }
                            ${
                                chosen.length > 0 &&
                                html`<${PeopleFilter}
                                people=${chosen}
                                hidden=${hidden}
                                onChange=${setHidden}
                            />`
                            }
                            ${people.length === 1 && html`<${SelectButton} select=${select} />`}
                        </div>
                    </div>
                </div>
                ${(mine || source.folders.length > 0) && html`<${AccessKey} />`}
                ${
                    onlyOff
                        ? html`<p class="muted small" data-part="only-off">
                    ${onlyOff.name} may not use ${computer.name} yet. Turn them on under People, below.
                </p>`
                        : chosen.length === 0
                          ? html`<p class="muted small">
                                ${
                                    mine && usersHere(computer).length > 0
                                        ? `Everyone else on ${computer.name} is in charge of it: there is nothing to give them.`
                                        : `No one else may use ${computer.name}. Turn someone on below.`
                                }
                            </p>`
                          : people.length === 0
                            ? html`<p class="muted small">No one is shown. Choose people in the filter.</p>`
                            : null
                }
                <${ComputerGrid}
                    source=${source}
                    grid=${grid}
                    find=${find}
                    select=${select}
                    ...${
                        mine
                            ? {
                                  trustColumn: group !== "sessions" && projects !== undefined,
                                  fallback: projects?.defaultProjectTrust,
                                  after: html`<${UseSwitches} computer=${computer} people=${everyone} />`,
                                  allFolders: true,
                              }
                            : {}
                    }
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

    // Asked again while open, at another view: a notice of a new message opens a chat in People.
    useEffect(() => {
        if (sheet?.view) {
            setView(sheet.view);
        }
    }, [sheet]);

    const shown = views.some(([key]) => key === view) ? view : views[0][0];
    // The sheet is as wide as the widest grid of Computer needs (`style.css` `.sheet.access-sheet`): the most people
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
