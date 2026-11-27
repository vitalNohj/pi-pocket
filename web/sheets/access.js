// The Access sheet's shared rules and menus: who may use a computer, what a folder gives them, and who may
// change it. Computer reads its own record or a sharing answer, and gives and takes access over the same routes.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, attempt, managesThisServer, store } from "../store.js";
import { html, Icon, Switch } from "../ui.js";
import {
    browseRows,
    inFolder as inFolderOf,
    leaving,
    levelOf,
    orderOf,
    ranked,
    seenBy,
    topFolders,
} from "./access-tree.js";
import { folderListings, showsHidden } from "../folder-listings.js";
import { isOwner, isViewer, prompts } from "../roles.js";

export const THIS_SERVER = "this-server";

/** Whether I am in charge of a computer, as its record says. */
export function inCharge(computer) {
    return (
        computer.inCharge ??
        (computer.id === THIS_SERVER
            ? isOwner(store.state.me)
            : computer.createdBy === store.state.me?.id && !computer.blocked)
    );
}

// Someone chosen for This server can use it without being told its record or who else uses it.
const USING_THIS_SERVER = { id: THIS_SERVER, name: "This server", inCharge: false, online: true };

/** The computers this person knows of: This server first, then the linked ones. */
export function computers() {
    const { runners, thisServer, me } = store.state;
    const server = thisServer ?? (me?.mayStart === true ? USING_THIS_SERVER : undefined);

    return [...(server ? [server] : []), ...runners];
}

/** The dot beside a computer in a list: on, away, or not connected. */
export function ComputerDot({ computer }) {
    const state =
        computer.online || computer.id === THIS_SERVER ? "on" : computer.away ? "away" : "";

    return html`<span class=${`runner-dot ${state}`} aria-hidden="true"></span>`;
}

/** Read the computers again: a sheet that opens shows them as they are now. */
export async function loadComputers() {
    // This server's record is the business of who is in charge of it.
    const [list, server] = await Promise.all([
        api("runners"),
        managesThisServer() ? api("runners/this-server") : null,
    ]);

    store.set({ runners: list, thisServer: server });
}

/** Whether `person` can be chosen for `computer`: not who is in charge of it, who has it anyway. */
export function choosable(computer, person) {
    return computer.id === THIS_SERVER ? !isOwner(person) : person.id !== computer.createdBy;
}

/** Whether `person` is among the people chosen for `computer`. */
export function chosenFor(computer, person) {
    return (computer.users ?? []).some((each) => each.id === person.id);
}

/** Who receives the sessions taken from someone: the linker, or the owner for this server. */
export function heir(computer) {
    return computer.createdBy === store.state.me?.id
        ? "you"
        : (store.state.users.find((each) => each.id === computer.createdBy)?.name ?? "the owner");
}

/** A computer as the server answered it after a change: shown at once, before its event arrives. */
export function keep(view) {
    if (!view) {
        return;
    }

    if (view.id === THIS_SERVER) {
        store.set({ thisServer: view });
    } else {
        store.set({
            runners: store.state.runners.map((each) => (each.id === view.id ? view : each)),
        });
    }
}

const route = (computer, part) => `runners/${encodeURIComponent(computer.id)}/${part}`;

/** Why I cannot take this computer from a chosen person, if any. A pause keeps their right. */
export function unchooseReason(computer, person) {
    return computer.rights?.manages?.includes(person.id) && !computer.gives?.includes("manages")
        ? "Only the owner of this computer takes a manager off it."
        : undefined;
}

/** Take the computer from the person, or let them use it. True when saved. */
export function toggleUse(computer, person) {
    const chosen = chosenFor(computer, person);

    if (
        chosen &&
        !confirm(
            `Take ${computer.name} from ${person.name}? They leave its sessions at once, and the sessions they started there move to ${heir(computer)}.`,
        )
    ) {
        return Promise.resolve(false);
    }

    return choosePerson(computer, person, !chosen);
}

/**
 * Change what `person` has of `folder` on `computer` to `level` (`app.ts` `setFolderLevel`). Taking it back says first
 * which of the sessions they started go with it, to who is in charge. True when it was saved.
 */
export async function setLevelOf(computer, person, folder, level) {
    if (level === "none") {
        const there = store.state.sessions.filter(
            (each) => (each.runner ?? THIS_SERVER) === computer.id,
        );
        const gone = leaving(
            folder,
            computer.given?.[person.id] ?? [],
            there.filter((each) => each.createdBy === person.id),
            there.filter((each) => each.worktree),
        ).length;

        if (
            gone > 0 &&
            !confirm(
                `Take ${folder} from ${person.name}? ${gone === 1 ? "The session they started in it moves" : `The ${gone} sessions they started in it move`} to ${heir(computer)}, with the tasks they set up there. Sessions shared with them stay.`,
            )
        ) {
            return false;
        }
    }

    return attempt(async () => {
        keep(await api(route(computer, "level"), { person: person.id, folder, level }));

        return true;
    });
}

/**
 * What `person` has of `folder` on `computer` (`access-tree.js` `levelOf`), and with none of its own, the nearest
 * folder above it they have, with its level (`from`): they have that one here too.
 */
export function levelFor(computer, person, folder) {
    const given =
        chosenFor(computer, person) && !person.sessions ? (computer.given?.[person.id] ?? []) : [];
    const sees = seenFolders(computer, person);
    const until = untilOf(computer, person);
    const from = fromOf(computer, person);
    const level = levelOf(folder, given, sees, until, from);

    if (level !== "none") {
        return { level };
    }

    const holder = given
        .filter((each) => each !== folder && inFolderOf(folder, each))
        .sort((one, other) => other.length - one.length)[0];

    return holder === undefined
        ? { level }
        : { level, from: { folder: holder, level: levelOf(holder, given, sees, until, from) } };
}

/**
 * The time of the level `person` has of `folder` on `computer` (`level`): up to which for "past", from which for
 * "new", undefined for any other. For a level from a folder above (`from`), that folder's time.
 */
export function timeOf(computer, person, folder, level, from) {
    const shown = from?.level ?? level;
    const at = from?.folder ?? folder;

    if (shown === "past") {
        return untilOf(computer, person)[at];
    }

    return shown === "new" ? fromOf(computer, person)[at] : undefined;
}

/**
 * The projects on a computer I am in charge of and how Pi trusts their folders (`GET /api/runners/:id/projects`), as
 * the server last said: kept in the store, so the sheet shows them at once when it opens again. Undefined until known.
 */
export function projectsOf(computer) {
    return store.state.accessProjects?.[computer.id];
}

/** Keep what the server said of a computer's projects (`projectsOf`). */
export function keepProjects(id, answer) {
    store.set({ accessProjects: { ...store.state.accessProjects, [id]: answer } });
}

/**
 * The order of the projects answers of each computer, by its id: the readings asked and the newest one kept, the
 * saves asked and the newest one kept, and how many saves have answered. Answers come back in any order, and an older
 * one must not replace a newer one.
 */
const answers = new Map();

function answersOf(id) {
    if (!answers.has(id)) {
        answers.set(id, { reads: 0, read: 0, saves: 0, saved: 0, answered: 0 });
    }

    return answers.get(id);
}

/**
 * Ask again for the projects of every computer I am in charge of, all at once. One that cannot be asked keeps what was
 * known of it.
 */
export function loadProjects() {
    return Promise.all(
        computers()
            .filter(inCharge)
            .map((computer) => {
                const order = answersOf(computer.id);
                const number = ++order.reads;
                const { answered } = order;

                return api(route(computer, "projects")).then(
                    (answer) => {
                        // Read before a save that has answered since, or before a newer reading: out of date.
                        if (order.answered === answered && number > order.read) {
                            order.read = number;
                            keepProjects(computer.id, answer);
                        }
                    },
                    () => undefined,
                );
            }),
    );
}

/** The last answer for a computer I use but am not in charge of. */
export function sharingOf(computer) {
    return computer.mayUse === false || inCharge(computer)
        ? undefined
        : store.state.accessSharing?.[computer.id];
}

// One counter per computer: a read that left before a newer one cannot replace it, even when it failed.
const sharingReads = new Map();

/** Read what I can give on this computer, or mark the read as failed so it does not keep loading. */
export async function loadSharing(computer) {
    const { me } = store.state;

    // The server refuses a viewer (403), and someone invited to sessions only shares nothing: neither asks.
    if (!prompts(me) || me.sessions || computer.mayUse === false || inCharge(computer)) {
        return;
    }

    const { id } = computer;
    const read = (sharingReads.get(id) ?? 0) + 1;

    sharingReads.set(id, read);

    const answer = await api(route(computer, "sharing")).catch(() => ({
        failed: true,
        people: [],
    }));

    if (sharingReads.get(id) === read) {
        store.set({ accessSharing: { ...store.state.accessSharing, [id]: answer } });
    }
}

/** Read the answers for all computers someone else is in charge of, at once. */
export function loadSharings() {
    return Promise.all(computers().map(loadSharing));
}

/**
 * Save how Pi trusts `folders` on `computer` (`POST /api/runners/:id/trust`: `choice` is "trust", "trust-parent", or
 * "distrust"), and keep the projects the server answers: a decision for a folder above changes other projects too.
 */
export function setTrust(computer, folders, choice) {
    const order = answersOf(computer.id);
    const number = ++order.saves;

    return attempt(async () => {
        const answer = await api(route(computer, "trust"), { folders, choice });

        order.answered++;

        if (number > order.saved) {
            order.saved = number;
            keepProjects(computer.id, answer);
        }
    });
}

/**
 * How Pi trusts a project's folders (`src/server/projects.ts` `ProjectView.trust`: its root first, then each folder
 * outside it, then each folder in it with a decision of its own): `mixed` when they do not all have one answer. Undefined when the server could not read it.
 */
export function trustOfProject(project) {
    const entries = project.trust;

    if (entries === undefined || entries.length === 0) {
        return undefined;
    }

    return {
        entries,
        root: entries[0],
        mixed: entries.some((each) => each.trusted !== entries[0].trusted),
    };
}

/** Choose one person for a computer, or no longer: the others stay as they are now. True when it was saved. */
export function choosePerson(computer, person, on) {
    return attempt(async () => {
        keep(await api(route(computer, "users"), { person: person.id, on }));

        return true;
    });
}

/** Give `person` one right on `computer`, or take it back (`app.ts` `setRight`). True when it was saved. */
export function setRight(computer, person, right, on) {
    return attempt(async () => {
        keep(await api(route(computer, "rights"), { person: person.id, right, on }));

        return true;
    });
}

/** One computer right, as the server declares it (`each`). */
export function RightSwitch({ computer, person, each }) {
    const [busy, setBusy] = useState(false);
    const included = each.key !== "manages" && computer.rights.manages.includes(person.id);
    const on = included || computer.rights[each.key].includes(person.id);
    const hint = included
        ? "Included in Manage this computer."
        : on
          ? each.on
          : (each.off ?? each.on);

    const flip = async () => {
        if (
            !on &&
            each.confirm &&
            !confirm(
                each.confirm.replace(/\{(name|computer)\}/g, (_, field) =>
                    field === "name" ? person.name : computer.name,
                ),
            )
        ) {
            return;
        }

        setBusy(true);

        try {
            await setRight(computer, person, each.key, !on);
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="setting wrap" data-right=${each.key} data-computer=${computer.id}>
        <div class="grow">
            <div class="small">${each.label}</div>
            <div class="muted small">${hint}</div>
        </div>
        <${Switch}
            on=${on}
            disabled=${busy || included}
            label=${`${person.name} ${each.says} ${computer.name}: ${on ? "on" : "off"}`}
            onChange=${flip}
        />
    </div>`;
}

/**
 * The folders on `computer` in which `person` sees every session (`access.ts` `seesFolder`): among the ones given to
 * them there, while they use it and are not held to one session. A viewer's too, who reads them.
 */
export function seenFolders(computer, person) {
    if (!chosenFor(computer, person) || isOwner(person) || person.sessions) {
        return [];
    }

    const given = computer.given?.[person.id] ?? [];

    return (computer.sees?.[person.id] ?? []).filter((each) => given.includes(each));
}

/** Of those, the ones `person` sees only the sessions made up to a time in ("Current sessions"): that time, by folder. */
export const untilOf = (computer, person) => computer.seesUntil?.[person.id] ?? {};

/** Of those, the ones `person` sees only the sessions made from a time on in ("New sessions"): that time, by folder. */
export const fromOf = (computer, person) => computer.seesFrom?.[person.id] ?? {};

/** The home folder of `computer`, as the tree's top row: this server's, or a runner's as it said when it connected. */
export function homeOf(computer) {
    return computer.id === THIS_SERVER ? store.state.server?.home : computer.home;
}

/** Whether `person` has `session` in their own right: they started it, it is shared with them, or they were invited to it. */
const holds = (person, session) =>
    session.createdBy === person.id ||
    session.sharedWith?.includes(person.id) === true ||
    person.sessions?.includes(session.id) === true;

/**
 * The sessions `person` has on `computer`, of the ones I see (who is in charge of it sees every one): the ones they
 * started, the ones shared with them, one they were invited to alone, and every one in a folder they see all of.
 */
export function sessionsOf(computer, person) {
    const there = store.state.sessions.filter(
        (each) => (each.runner ?? THIS_SERVER) === computer.id,
    );
    const sees = seenFolders(computer, person);
    const until = untilOf(computer, person);
    const from = fromOf(computer, person);

    return there.filter(
        (each) => holds(person, each) || seenBy(sees, each, there, until, from) !== undefined,
    );
}

/** Whether a session is locked now: its approval ended, or was revoked, and nobody renewed it (`folder-approvals.ts`). */
export function locked(session) {
    return (store.state.folderApprovals ?? []).some(
        (each) =>
            each.session === String(session.id) &&
            (each.ended || (each.expiresAt !== null && each.expiresAt <= Date.now())),
    );
}

/**
 * How `person` stands on `computer`: chosen for it, and in charge of it by Manage this computer.
 */
export function standing(computer, person) {
    const chosen = chosenFor(computer, person);
    const manager = computer.managers?.includes(person.id) === true;

    return {
        chosen,
        manager,
    };
}

/**
 * Which rows of a tree are open, and the order of the sessions in each open one. Nothing searched for (`find`): a row
 * is closed until opened by hand. A search or a filter opens every row it lists, until one is closed by hand; that
 * starts over when what is searched for changes (`find.stamp`).
 *
 * `inOrder(key, rows)`: the sessions of row `key` as they stood when it was first drawn open, the one whoever reads
 * used last first (`access-tree.js` `orderOf`, `ranked`): a session stays where it is while its button changes, or it
 * is used. Closing the row, or a change of what is searched for, lets go of that order.
 */
export function useGroups(find) {
    const [open, setOpen] = useState(() => new Set());
    const [shut, setShut] = useState(() => ({ stamp: find.stamp, keys: new Set() }));
    const orders = useRef({ stamp: find.stamp, at: new Map() });

    if (orders.current.stamp !== find.stamp) {
        orders.current = { stamp: find.stamp, at: new Map() };
    }

    const closed = shut.stamp === find.stamp ? shut.keys : new Set();

    return {
        isOpen: (key) => (find.active ? !closed.has(key) : open.has(key)),
        toggle(key) {
            orders.current.at.delete(key);

            if (find.active) {
                const keys = new Set(closed);

                if (!keys.delete(key)) {
                    keys.add(key);
                }

                setShut({ stamp: find.stamp, keys });
            } else {
                setOpen((now) => {
                    const next = new Set(now);

                    if (!next.delete(key)) {
                        next.add(key);
                    }

                    return next;
                });
            }
        },
        inOrder(key, rows) {
            let order = orders.current.at.get(key);

            if (order === undefined) {
                order = orderOf(rows);
                orders.current.at.set(key, order);
            }

            return ranked(rows, order);
        },
    };
}

/** What the last row of a computer's tree, All folders, is opened by in the tree's own record of what is open. */
const ALL_FOLDERS = "\0all";

/**
 * All folders, the last row of a computer's tree for who is in charge of it: every folder there, as the folder picker
 * lists them (`folder-listings.js`, whose listings it shares), to give one that holds no session yet. `groups`: the
 * tree's record of what is open (`useGroups`), which keeps these rows too. `shown`: whether the row is drawn at all.
 *
 * It reads a folder only while its row is open, each read on its own: opened, All folders reads the home folder (`~`),
 * whose listing names the computer's top folders. Nothing is read while a linked computer is offline; what is open is
 * read when it is back. Returns the row as a tree: `{ shown, open, rows, toggle }`, each of `rows` a note (`{ note }`), the
 * row that shows the rest of a long list (`{ more, show }`), or a folder (`{ key, name, path, home, open, rows, toggle }`).
 */
export function useAllFolders(computer, groups, shown) {
    const runner = computer.id === THIS_SERVER ? null : computer.id;
    const offline = runner !== null && !computer.online;
    const hidden = showsHidden();
    // Path → what its read gave: `{ listing }`, or `{ failed }`, the server's sentence.
    const [read, setRead] = useState(() => new Map());
    // The folders whose whole list shows, by their row's key.
    const [whole, setWhole] = useState(() => new Set());
    // Path → the number of its read on its way: only the newest answer shows.
    const asked = useRef(new Map());
    const count = useRef(0);
    // The setting the reads were asked with: a change asks each open folder again.
    const asking = useRef({ runner, hidden });
    const wanted = new Set();
    const open = shown && groups.isOpen(ALL_FOLDERS);

    const rowsOf = (entry, key, top) =>
        browseRows({
            folders: entry?.listing?.dirs,
            failed: entry?.failed,
            all: whole.has(key),
        }).map((row) =>
            row.folder === undefined
                ? row.more === undefined
                    ? row
                    : { more: row.more, show: () => setWhole((now) => new Set(now).add(key)) }
                : folderOf({ name: row.folder.name, path: row.folder.path, home: false }, top),
        );

    // A path can show twice (home, and again under `/`): a row's key names the top folder it is under too.
    const folderOf = (folder, top) => {
        const key = `${ALL_FOLDERS}:${top}\n${folder.path}`;
        const opened = groups.isOpen(key);

        if (opened) {
            wanted.add(folder.path);
        }

        return {
            ...folder,
            key,
            open: opened,
            rows: opened ? rowsOf(read.get(folder.path), key, top) : [],
            toggle: () => groups.toggle(key),
        };
    };

    let rows = [];

    if (open && offline) {
        rows = browseRows({ offline: computer.name });
    } else if (open) {
        wanted.add("~");

        const top = read.get("~");

        rows =
            top?.listing === undefined
                ? browseRows({ failed: top?.failed })
                : topFolders(homeOf(computer) ?? top.listing.home, top.listing).map((each) =>
                      folderOf(each, each.path),
                  );
    }

    const reading = offline ? "" : [...wanted].join("\n");

    // Each folder newly open is read now, all at once: what was read before shows meanwhile. A row closed lets go of
    // its read, so it is read again when it opens.
    useEffect(() => {
        const now = new Set(reading === "" ? [] : reading.split("\n"));

        if (asking.current.runner !== runner || asking.current.hidden !== hidden) {
            asking.current = { runner, hidden };
            asked.current.clear();
        }

        for (const path of [...asked.current.keys()]) {
            if (!now.has(path)) {
                asked.current.delete(path);
            }
        }

        const keep = (path, entry) =>
            setRead((was) => {
                const next = new Map(was);

                if (entry === undefined) {
                    next.delete(path);
                } else {
                    next.set(path, entry);
                }

                return next;
            });

        for (const path of now) {
            if (asked.current.has(path)) {
                continue;
            }

            const ask = ++count.current;
            const kept = folderListings.cached(runner, path, hidden);

            asked.current.set(path, ask);
            keep(path, kept === undefined ? undefined : { listing: kept });
            folderListings.read(runner, path, hidden).then(
                (listing) => asked.current.get(path) === ask && keep(path, { listing }),
                (error) => asked.current.get(path) === ask && keep(path, { failed: error.message }),
            );
        }
    }, [reading, runner, hidden]);

    return { shown, open, rows, toggle: () => groups.toggle(ALL_FOLDERS) };
}

/**
 * Where a menu or a note that opens from `button` goes: under it, or above it where the sheet has no room under it,
 * kept inside the sheet (`.sheet`) on both sides. Fixed to the screen, so a list or a grid that scrolls does not cut
 * it off. `width`, `height`: the menu's own size.
 */
export function placeIn(button, width, height) {
    const at = button.getBoundingClientRect();
    const sheet = button.closest(".sheet")?.getBoundingClientRect() ?? {
        top: 0,
        left: 0,
        right: innerWidth,
        bottom: innerHeight,
    };
    const below = sheet.bottom - at.bottom - 8;
    const above = at.top - sheet.top - 8;
    const up = height > below && above > below;
    const left = Math.max(sheet.left + 8, Math.min(at.right - width, sheet.right - 8 - width));

    return {
        up,
        left,
        top: up ? Math.max(sheet.top + 8, at.top - 4 - height) : at.bottom + 4,
        maxHeight: Math.max(120, up ? above : below),
    };
}

/**
 * A menu button (`PopMenu`): the Access menu of a folder (`LevelMenu`) and the trust menu of a project
 * (`access-grid.js` `TrustMenu`) are this one control. The button shows `face`; open, one item for each of `items`
 * (`{ key, name, says, checked }`), with the checked one marked and focused. `onPick(key)` for another than the
 * checked one. Escape, a press outside, or a scroll around it closes it. It opens where there is room in the sheet
 * (`placeIn`).
 */
export function PopMenu({ face, buttonClass, label, title, disabled, menuLabel, items, onPick }) {
    const [open, setOpen] = useState(false);
    const [place, setPlace] = useState(null);
    const box = useRef(null);
    const menu = useRef(null);
    const button = useRef(null);

    useLayoutEffect(() => {
        if (!open || !menu.current || !button.current) {
            setPlace(null);

            return;
        }

        setPlace(placeIn(button.current, menu.current.offsetWidth, menu.current.scrollHeight));
        (
            menu.current.querySelector('[aria-checked="true"]') ??
            menu.current.querySelector("button")
        )?.focus({ preventScroll: true });
    }, [open]);

    // A press outside closes it, as a menu does; so does a scroll of what holds it, which would leave it behind.
    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const outside = (event) => {
            if (!box.current?.contains(event.target)) {
                setOpen(false);
            }
        };

        // The scroll that brought the button into sight as it opened does not close it.
        const opened = Date.now();

        const scrolled = (event) => {
            if (!menu.current?.contains(event.target) && Date.now() - opened > 250) {
                setOpen(false);
            }
        };

        addEventListener("pointerdown", outside, true);
        addEventListener("scroll", scrolled, true);
        addEventListener("resize", scrolled);

        return () => {
            removeEventListener("pointerdown", outside, true);
            removeEventListener("scroll", scrolled, true);
            removeEventListener("resize", scrolled);
        };
    }, [open]);

    const onKey = (event) => {
        const all = [...(menu.current?.querySelectorAll("button") ?? [])];
        const index = all.indexOf(document.activeElement);

        if (event.key === "Escape" && open) {
            // Escape closes the menu, not the sheet around it.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            button.current?.focus();
        } else if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            all[(index + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
        }
    };

    return html`<div class="at-level-box" ref=${box} onKeyDown=${onKey}>
        <button
            ref=${button}
            type="button"
            class=${`button small at-level ${buttonClass ?? ""}`}
            aria-haspopup="menu"
            aria-expanded=${open}
            aria-label=${label}
            title=${title}
            disabled=${disabled}
            onClick=${(event) => {
                // A button half out of a scroller's sight comes into it first, so its menu opens beside it.
                event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
                setOpen(!open);
            }}
        >
            ${face}
            <${Icon} name="down" size=${11} />
        </button>
        ${
            open &&
            html`<div
                class=${`at-level-menu ${place?.up ? "up" : ""}`}
                role="menu"
                aria-label=${menuLabel}
                ref=${menu}
                style=${
                    place
                        ? `left:${place.left}px;top:${place.top}px;max-height:${place.maxHeight}px`
                        : "visibility:hidden;left:0;top:0"
                }
            >
                ${items.map(
                    (each) => html`<button
                        key=${each.key}
                        type="button"
                        class="at-level-item"
                        role="menuitemradio"
                        aria-checked=${each.checked ? "true" : "false"}
                        onClick=${() => {
                            setOpen(false);

                            if (!each.checked) {
                                onPick(each.key);
                            }
                        }}
                    >
                        <span class="at-level-name">
                            ${each.name}
                            ${each.checked && html`<${Icon} name="check" size=${13} />`}
                        </span>
                        ${each.says.map((line) => html`<span class="at-level-says">${line}</span>`)}
                    </button>`,
                )}
            </div>`
        }
    </div>`;
}

/**
 * The levels of the Access menu of a folder's row (`src/server/config.ts` `FolderLevel`): its name in the menu, what
 * the row says when it is chosen, and the one line under its name that says what the person gets. Each level from
 * "start" on lets a user start sessions here; "past", "new", and "all" each show the sessions of others here too: the
 * ones here now, the ones started from now on, or both. A viewer's menu has no "start": they read, and start nothing.
 */
const LEVELS = {
    none: {
        name: "No access",
        short: "None",
        user: "Nothing in this folder but the sessions shared with them.",
        viewer: "Nothing in this folder but the sessions shared with them.",
    },
    start: {
        name: "Start sessions",
        short: "Start",
        user: "They start sessions here, and see theirs and the ones shared with them.",
    },
    past: {
        name: "Current sessions",
        short: "Current",
        user: "They start sessions here, and see every session here now. Not ones started later.",
        viewer: "They read every session here now, whoever started it. Not ones started later.",
    },
    new: {
        name: "New sessions",
        short: "New",
        user: "They start sessions here, and see every session started here from now on. Not the ones here now.",
        viewer: "They read every session started here from now on, whoever starts it. Not the ones here now.",
    },
    all: {
        name: "All sessions",
        short: "All",
        user: "They start sessions here, and see every session here: the ones here now and the ones started later.",
        viewer: "They read every session here, whoever started it: the ones here now and the ones started later.",
    },
};

/** The levels `person` can be given in the Access menu: a viewer's have no "start". */
export const levelsFor = (person) =>
    isViewer(person) ? ["none", "past", "new", "all"] : ["none", "start", "past", "new", "all"];

/** The line under the level shown that says its time (`at`): up to it for "past", from it for "new". */
function timeLine(level, at) {
    if (at === undefined) {
        return [];
    }

    const when = new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

    return level === "past" ? [`Up to ${when}.`] : level === "new" ? [`From ${when}.`] : [];
}

/**
 * The Access menu of a folder (`PopMenu`): a button that says what the person has of it now (`level`, in that level's
 * colour), and open, one item for each level they can be given (`levels`), each with what they get (`LEVELS`).
 * Drawn only where a level can be set: a cell with none has no menu (`access-grid.js`). `at`: the time of the level
 * shown (`timeOf`), said on its item.
 */
export function LevelMenu({ person, folder, where, level, from, at, levels, busy, onPick }) {
    const viewer = isViewer(person);
    // With no level of its own, a folder has the one of the folder above it that has one (`from`): said, quietly.
    const shown = from?.level ?? level;

    const detail = from
        ? `${LEVELS[shown].name}, from ${from.folder}`
        : `Access: ${LEVELS[level].name}`;

    return html`<${PopMenu}
            face=${html`<span>${LEVELS[shown].short}</span>`}
            buttonClass=${`lv-${shown} ${level === "none" ? "ghost" : ""} ${from ? "inherited" : ""}`}
            label=${`Access of ${person.name} to ${folder} on ${where}: ${LEVELS[shown].name}${from ? ` (from ${from.folder})` : ""}`}
            title=${detail}
            disabled=${busy}
            menuLabel=${`Access of ${person.name} to ${folder}`}
            items=${levels.map((each) => ({
                key: each,
                name: LEVELS[each].name,
                says: [
                    LEVELS[each][viewer ? "viewer" : "user"],
                    ...(each === shown ? timeLine(each, at) : []),
                ],
                checked: each === level,
            }))}
            onPick=${onPick}
        />`;
}

/** The "i" of an explanation: one SVG drawn about its centre (a circle, a dot, a stem), 14 px at every width. */
function InfoGlyph() {
    return html`<svg class="info-glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" stroke-width="1.5" />
        <circle cx="8" cy="4.75" r="1" fill="currentColor" />
        <path d="M8 7v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>`;
}

/**
 * An explanation behind a small "i" (`.info-tip`), the one of this sheet: shown while a mouse is over it and on
 * keyboard focus, and by a tap or a click. Escape or a press outside closes it. It opens where there is
 * room in the sheet (`placeIn`).
 */
export function InfoTip({ about, text }) {
    const [open, setOpen] = useState(false);
    // Opened by a mouse over it: it closes when the mouse leaves, unless it was clicked.
    const hovered = useRef(false);
    const [place, setPlace] = useState(null);
    const button = useRef(null);
    const note = useRef(null);

    useLayoutEffect(() => {
        if (!open || !note.current || !button.current) {
            setPlace(null);

            return;
        }

        setPlace(placeIn(button.current, note.current.offsetWidth, note.current.offsetHeight));
    }, [open]);

    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const outside = (event) => {
            if (!button.current?.contains(event.target) && !note.current?.contains(event.target)) {
                setOpen(false);
            }
        };

        const key = (event) => {
            if (event.key === "Escape") {
                // Escape closes the note, not the sheet around it.
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
            }
        };

        const scrolled = () => setOpen(false);

        addEventListener("pointerdown", outside, true);
        addEventListener("keydown", key, true);
        addEventListener("scroll", scrolled, true);

        return () => {
            removeEventListener("pointerdown", outside, true);
            removeEventListener("keydown", key, true);
            removeEventListener("scroll", scrolled, true);
        };
    }, [open]);

    return html`<button
            ref=${button}
            type="button"
            class="info-tip"
            aria-label=${`About ${about}`}
            aria-expanded=${open}
            onClick=${() => {
                // A click on what a mouse opened already keeps it open, until the mouse leaves or Escape.
                setOpen(hovered.current || !open);
                hovered.current = false;
            }}
            onPointerEnter=${(event) => {
                if (event.pointerType === "mouse") {
                    hovered.current = true;
                    setOpen(true);
                }
            }}
            onPointerLeave=${(event) => {
                if (event.pointerType === "mouse" && hovered.current) {
                    hovered.current = false;
                    setOpen(false);
                }
            }}
            onFocus=${(event) => event.currentTarget.matches(":focus-visible") && setOpen(true)}
            onBlur=${() => setOpen(false)}
        >
            <${InfoGlyph} />
        </button>
        ${
            open &&
            html`<div
                class="info-note"
                role="tooltip"
                ref=${note}
                style=${place ? `left:${place.left}px;top:${place.top}px` : "visibility:hidden;left:0;top:0"}
            >
                ${text}
            </div>`
        }`;
}
