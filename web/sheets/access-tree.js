// How one person's sessions on one computer sit under the folders given to them there, for the tree in the People and
// Runners sheets (`access.js` `AccessTree`). It follows the server's own rules, so the tree shows what the server
// does: which folder a session counts as working in (`src/server/app.ts` `#accessFolder`), and which given folder
// holds it (`src/server/access.ts` `inFolder`). Plain functions with no imports, so tests load them as they are.

/**
 * Whether a folder's path is Windows' kind (`C:\a\b`), where `\` parts folders as `/` does. A path that starts with
 * `/` is Linux's or macOS's, where `\` is a character of a name like any other.
 */
const windowsPath = (folder) => !folder.startsWith("/");

/** `folder` without the separators at its end, by its own kind of path. */
const baseOf = (folder) => folder.replace(windowsPath(folder) ? /[\\/]+$/ : /\/+$/, "");

/**
 * Whether `folder` is `given` or in it, by the kind of path `given` is: `/a/b` holds `/a/b/c`, and not the folder
 * beside it named `b\c`; `C:\a\b` holds `C:\a\b\c`. The top folder (`/`) holds every path there and nothing else:
 * a remote workspace (`ssh://box/home/me`) is in no folder. As the server has it (`src/server/access.ts` `inFolder`).
 */
export function inFolder(folder, given) {
    const base = baseOf(given);

    if (base === "") {
        return (
            folder === given ||
            folder.startsWith("/") ||
            (windowsPath(given) && folder.startsWith("\\"))
        );
    }

    return (
        folder === given ||
        folder === base ||
        folder.startsWith(`${base}/`) ||
        (windowsPath(given) && folder.startsWith(`${base}\\`))
    );
}

/**
 * The folder a session counts as working in: a session in a git worktree of its own, or of another session on the
 * same computer (`there`: the sessions on it), counts as in the folder that worktree came from. Its own counts only
 * while it works in it: moved to another folder, it is judged by that folder, though the record of its worktree stays.
 */
export function accessFolder(session, there) {
    if (session.worktree?.source && inFolder(session.cwd, session.worktree.path)) {
        return session.worktree.source;
    }

    for (const each of there) {
        if (each.worktree && inFolder(session.cwd, each.worktree.path)) {
            return each.worktree.source;
        }
    }

    return session.cwd;
}

const depthOf = (folder) => baseOf(folder).length;

/**
 * `sessions` under `folders`: each session under the deepest given folder that holds it, so with a folder and one in
 * it both given, a session shows once. `other`: the sessions in no given folder (shared with the person, say).
 */
export function placed(folders, sessions, there) {
    const nodes = folders.map((folder) => ({ folder, sessions: [] }));
    const other = [];

    for (const session of sessions) {
        const at = accessFolder(session, there);
        let best;

        for (const node of nodes) {
            if (
                inFolder(at, node.folder) &&
                (best === undefined || depthOf(node.folder) > depthOf(best.folder))
            ) {
                best = node;
            }
        }

        (best?.sessions ?? other).push(session);
    }

    return { folders: nodes, other };
}

/**
 * Of the sessions a person `started`, the ones that leave them when `folder` is taken back: in it, and in no other
 * folder they keep. The server then moves them to who is in charge (`app.ts` `handOver`).
 */
export function leaving(folder, folders, started, there) {
    const rest = folders.filter((each) => each !== folder);

    return started.filter((session) => {
        const at = accessFolder(session, there);

        return inFolder(at, folder) && !rest.some((each) => inFolder(at, each));
    });
}

/**
 * The folder of `sees` (the folders a person sees every session in) that gives them `session`, or undefined: the
 * server's rule (`src/server/access.ts` `seesFolder`), by the folder the session counts as working in. `until`: the
 * folders they see only the sessions made up to a time in ("Sessions so far"), with that time; a session made later
 * is not theirs by such a folder.
 */
export function seenBy(sees, session, there, until = {}) {
    if (sees.length === 0) {
        return undefined;
    }

    const at = accessFolder(session, there);

    return sees.find(
        (each) =>
            inFolder(at, each) &&
            (until[each] === undefined || (session.createdAt ?? 0) <= until[each]),
    );
}

/**
 * What a person has of one folder, as one level of the Access menu of its row (`src/server/config.ts` `FolderLevel`):
 * "none"; "start", given to start sessions in; "past", and every session made in it up to a time; "all", and every
 * session in it, also later ones. From a computer's record: `given`, `sees`, and `until` (`seesUntil`) of that person.
 */
export function levelOf(folder, given, sees, until) {
    if (!given.includes(folder)) {
        return "none";
    }

    if (!sees.includes(folder)) {
        return "start";
    }

    return until[folder] === undefined ? "all" : "past";
}

/**
 * The folders of one computer as nested rows, for a person's tree in People and Runners: the home folder (`home`),
 * always a top row; every folder in `folders` (the ones given); and the folder each of `sessions` counts as working in
 * (`accessFolder`, `there`: the computer's sessions). A row sits under the deepest other row that holds it, but Home,
 * which is never under another: a folder above it (`/`) is a top row of its own. A session sits in its own folder's row.
 *
 * Returns the top rows, Home first, then the others by path; each row `{ folder, parent, children, sessions }`, its
 * children by path.
 */
export function foldersOf(home, folders, sessions, there) {
    const paths = new Map();

    const add = (folder) => {
        if (folder && !paths.has(baseOf(folder) || folder)) {
            paths.set(baseOf(folder) || folder, {
                folder: baseOf(folder) || folder,
                parent: undefined,
                children: [],
                sessions: [],
            });
        }
    };

    const homePath = home ? baseOf(home) || home : undefined;

    add(homePath);
    folders.forEach(add);

    const at = sessions.map((session) => [session, baseOf(accessFolder(session, there))]);

    at.forEach(([, folder]) => add(folder));

    const nodes = [...paths.values()];

    for (const node of nodes) {
        if (node.folder === homePath) {
            continue;
        }

        for (const other of nodes) {
            if (
                other !== node &&
                inFolder(node.folder, other.folder) &&
                (node.parent === undefined || depthOf(other.folder) > depthOf(node.parent.folder))
            ) {
                node.parent = other;
            }
        }
    }

    for (const [session, folder] of at) {
        paths.get(folder || accessFolder(session, there))?.sessions.push(session);
    }

    const byPath = (one, other) => one.folder.localeCompare(other.folder);

    for (const node of nodes) {
        node.parent?.children.push(node);
    }

    for (const node of nodes) {
        node.children.sort(byPath);
    }

    return nodes
        .filter((each) => each.parent === undefined)
        .sort((one, other) =>
            one.folder === homePath ? -1 : other.folder === homePath ? 1 : byPath(one, other),
        );
}

/**
 * The project of `projects` (`src/server/projects.ts`: each `{ root, folders }`) a session counts as in, by the folder it
 * counts as working in (`accessFolder`): in its root, or in one of its folders outside the root (a worktree Pi Pocket
 * keeps in its data folder). The deepest root wins: a repository inside another is its own project.
 */
export function projectOfFolder(folder, projects) {
    let best;

    for (const project of projects) {
        if (
            (inFolder(folder, project.root) ||
                project.folders.some((each) => inFolder(folder, each))) &&
            (best === undefined || depthOf(project.root) > depthOf(best.root))
        ) {
            best = project;
        }
    }

    return best;
}

/**
 * The rows of one computer as the Access sheet groups them, the same for a person's tree (By person) and the grid of
 * everyone (By computer). `group`:
 * - "folders": the folder rows of `foldersOf`, nested by path, Home first.
 * - "projects": one row for each of `projects` that holds a listed session, by name, with every session in it; then
 *   the rest as "folders" does, without the folders inside a project's root. Each project row is
 *   `{ project, folder: root, children: [], sessions }`. `other`: where the other folders start, for their heading.
 * - "sessions": no folder row, the sessions alone (`flat`).
 */
export function arrange({ home, folders, sessions, there, projects = [], group = "folders" }) {
    if (group === "sessions") {
        return { roots: [], flat: sessions, other: 0 };
    }

    if (group !== "projects" || projects.length === 0) {
        return { roots: foldersOf(home, folders, sessions, there), other: 0 };
    }

    const found = new Map();
    const rest = [];

    for (const session of sessions) {
        const project = projectOfFolder(accessFolder(session, there), projects);

        if (project === undefined) {
            rest.push(session);
        } else {
            if (!found.has(project.root)) {
                found.set(project.root, {
                    project,
                    folder: project.root,
                    parent: undefined,
                    children: [],
                    sessions: [],
                });
            }

            found.get(project.root).sessions.push(session);
        }
    }

    // A project with a folder given in it, and no session listed, still shows: its row says what they have of it.
    for (const folder of folders) {
        const project = projectOfFolder(folder, projects);

        if (project !== undefined && !found.has(project.root)) {
            found.set(project.root, {
                project,
                folder: project.root,
                parent: undefined,
                children: [],
                sessions: [],
            });
        }
    }

    const rows = [...found.values()].sort(
        (one, other) =>
            one.project.name.localeCompare(other.project.name) ||
            one.folder.localeCompare(other.folder),
    );
    const others = foldersOf(
        home,
        folders.filter((folder) => projectOfFolder(folder, projects) === undefined),
        rest,
        there,
    );

    return { roots: [...rows, ...others], other: rows.length };
}

/** A folder's row and every row under it, depth first. */
export function rowsUnder(node) {
    return [node, ...node.children.flatMap(rowsUnder)];
}

/** The words of what was typed in a search field, in lower case. */
export function wordsOf(query) {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether each of `words` is in one of `texts` (a session's name, its folders), whatever the case. */
export function matches(words, ...texts) {
    const all = texts.map((each) => (each ?? "").toLowerCase());

    return words.every((word) => all.some((text) => text.includes(word)));
}

/**
 * Where `words` are in `text`: the indexes of its letters to mark (`ui.js` `Marked`). None where lower case has
 * another length than the text, since the indexes would then point beside the match.
 */
export function hitsOf(text, words) {
    const lower = text.toLowerCase();
    const hits = [];

    if (lower.length !== text.length) {
        return hits;
    }

    for (const word of words) {
        for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) {
            for (let index = at; index < at + word.length; index++) {
                hits.push(index);
            }
        }
    }

    return hits;
}

const HOUR_MS = 3_600_000;

/** The longest of the times a list is filtered by, in hours: "old" is longer ago than this. */
export const OLD_HOURS = 720;

/**
 * Whether a session last used at `usedAt` by whoever reads the list (undefined: never) passes the filter `time`: ""
 * for any time; a number of hours, as "24", for used within them; "old" for used longer ago than `OLD_HOURS`; "never".
 */
export function usedWithin(usedAt, time, now) {
    if (time === "") {
        return true;
    }

    if (time === "never" || usedAt === undefined) {
        return time === "never" && usedAt === undefined;
    }

    return time === "old"
        ? now - usedAt > OLD_HOURS * HOUR_MS
        : now - usedAt <= Number(time) * HOUR_MS;
}

/**
 * How long ago `ms` was, in the few letters a row has room for: "now", "5m", "3h", "6d", then weeks ("3w") up to a
 * year, then years ("2y").
 */
export function ago(ms, now) {
    const minutes = Math.max(0, (now - ms) / 60_000);

    if (minutes < 1) {
        return "now";
    }

    if (minutes < 60) {
        return `${Math.floor(minutes)}m`;
    }

    if (minutes < 24 * 60) {
        return `${Math.floor(minutes / 60)}h`;
    }

    const days = Math.floor(minutes / (24 * 60));

    return days < 14
        ? `${days}d`
        : days < 365
          ? `${Math.floor(days / 7)}w`
          : `${Math.floor(days / 365)}y`;
}

/**
 * Whether a list keeps the row of one session under what is searched and filtered (`find`): each word typed is in its
 * name or in one of its folders (`places`), the person has it or not as `access` asks ("has", "none"), whoever reads
 * last used it within `time` (`usedWithin`), and `by` started it. A row changed since the search last changed is kept
 * whatever it is now (`kept`: their ids), so what was just given can be taken back where it stands.
 */
export function keeps(find, row) {
    if (find.kept.has(row.id)) {
        return true;
    }

    if ((find.access === "has" && !row.has) || (find.access === "none" && row.has)) {
        return false;
    }

    if (
        !usedWithin(row.usedAt, find.time, find.now) ||
        (find.by !== "" && row.starter !== find.by)
    ) {
        return false;
    }

    return matches(find.words, row.title, ...row.places);
}

/**
 * Whether a list keeps a folder with no session to list under what is searched (`find`): only when words alone are
 * searched for, and each is in its path. A filter asks about sessions, and such a folder has none.
 */
export function keepsFolder(find, folder) {
    return (
        find.words.length > 0 &&
        find.access === "" &&
        find.time === "" &&
        find.by === "" &&
        matches(find.words, folder)
    );
}

/**
 * `rows` with the one whoever reads used last first (`usedAt`: when they last sent to Pi in it); the ones they never
 * used come after those, the one that anything happened in last first (`updatedAt`).
 */
export function newest(rows) {
    return [...rows].sort((one, other) =>
        one.usedAt !== undefined && other.usedAt !== undefined
            ? other.usedAt - one.usedAt
            : one.usedAt !== undefined
              ? -1
              : other.usedAt !== undefined
                ? 1
                : (other.updatedAt ?? 0) - (one.updatedAt ?? 0),
    );
}

/** The place of each of `rows` in a list of them, newest first (`newest`): what `ranked` keeps a list in. */
export function orderOf(rows) {
    return new Map(newest(rows).map((row, index) => [row.id, index]));
}

/**
 * `rows` in the order their list had when it was opened (`order`: `orderOf` then), so a row stays where it is when it
 * is used or its button changes; the ones that came since are last, the newest of them first.
 */
export function ranked(rows, order) {
    return newest(rows)
        .map((row, index) => [order.get(row.id) ?? order.size + index, row])
        .sort(([one], [other]) => one - other)
        .map(([, row]) => row);
}

/** `path` as it reads under `folder`: nothing for the folder itself, the rest of the path for one in it. */
export function below(path, folder) {
    const base = baseOf(folder);

    if (path === folder || path === base) {
        return "";
    }

    return path.startsWith(`${base}/`) || (windowsPath(folder) && path.startsWith(`${base}\\`))
        ? path.slice(base.length + 1)
        : path;
}

/** How many folders of one listing All folders shows at first; a row after them shows the rest. */
export const FOLDERS_SHOWN = 50;

/**
 * The top folders of a computer in All folders, as `{ name, path, home }`: its home folder first (`home`, named as the
 * tree names it), then each top folder of its listing (`roots`: `/`, or each Windows drive) that is not its home.
 */
export function topFolders(home, listing) {
    return [
        ...(home === undefined ? [] : [{ name: "Home", path: home, home: true }]),
        ...(listing.roots ?? [])
            .filter((each) => each !== home)
            .map((each) => ({ name: each, path: each, home: false })),
    ];
}

/**
 * The rows under one open folder of All folders, each `{ folder }`, `{ note }`, or `{ more }` (how many more there
 * are): where its computer is offline (`offline`: its name), a note that says so; the server's sentence where it
 * cannot be read (`failed`); "Reading…" until its folders (`folders`) are known; a note where it holds none; else its
 * folders in the order given, the first `FOLDERS_SHOWN` of them unless all are asked for (`all`), then a row for the
 * rest.
 */
export function browseRows({ folders, failed, offline, all = false }) {
    if (offline !== undefined) {
        return [{ note: `Folders show when ${offline} is online.` }];
    }

    if (failed !== undefined) {
        return [{ note: failed }];
    }

    if (folders === undefined) {
        return [{ note: "Reading…" }];
    }

    if (folders.length === 0) {
        return [{ note: "No folders in it." }];
    }

    const shown = all ? folders : folders.slice(0, FOLDERS_SHOWN);

    return [
        ...shown.map((folder) => ({ folder })),
        ...(shown.length < folders.length ? [{ more: folders.length - shown.length }] : []),
    ];
}
