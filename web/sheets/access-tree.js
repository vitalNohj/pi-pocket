// How one person's sessions on one computer sit under the folders given to them there, for the tree in the People and
// Runners sheets (`access.js` `AccessTree`). It follows the server's own rules, so the tree shows what the server
// does: which folder a session counts as working in (`src/server/app.ts` `#accessFolder`), and which given folder
// holds it (`src/server/access.ts` `inFolder`). Plain functions with no imports, so tests load them as they are.

/** Whether `folder` is `given` or in it, on either kind of path: `/a/b`, or `C:\a\b`. */
export function inFolder(folder, given) {
    const base = given.replace(/[\\/]+$/, "");

    return (
        folder === given ||
        base === "" ||
        folder === base ||
        folder.startsWith(`${base}/`) ||
        folder.startsWith(`${base}\\`)
    );
}

/**
 * The folder a session counts as working in: a session in a git worktree of its own, or of another session on the
 * same computer (`there`: the sessions on it), counts as in the folder that worktree came from.
 */
export function accessFolder(session, there) {
    if (session.worktree?.source) {
        return session.worktree.source;
    }

    for (const each of there) {
        if (each.worktree && inFolder(session.cwd, each.worktree.path)) {
            return each.worktree.source;
        }
    }

    return session.cwd;
}

const depthOf = (folder) => folder.replace(/[\\/]+$/, "").length;

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

/** `path` as it reads under `folder`: nothing for the folder itself, the rest of the path for one in it. */
export function below(path, folder) {
    const base = folder.replace(/[\\/]+$/, "");

    if (path === folder || path === base) {
        return "";
    }

    return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
        ? path.slice(base.length + 1)
        : path;
}
