/**
 * The projects on one computer, for the Access sheet's grid (`web/sheets/access-grid.js`): the git repositories its
 * sessions work in, each with the worktree folders those sessions use, and how Pi trusts each of those folders. Only for
 * who is in charge of that computer, who decides trust there; anyone else learns nothing of them (404).
 *
 * A project is found as the Memory sheet finds it (`memory.ts` `Memory.project`): its cache, and on a runner its git
 * there. A folder in no repository is in no project.
 */

import { inFolder } from "./access.ts";
import { mapLimit } from "./gallery/reach.ts";
import type { FolderTrust, SkillSources } from "./skills.ts";

/** How many folders are looked up at once: git runs once a folder, here or on a runner. */
const LOOKUPS_AT_ONCE = 4;

/** One project on a computer, as the Access sheet shows it. */
export type ProjectView = {
    /** Its repository's top folder there: a worktree counts for its main checkout. */
    root: string;
    name: string;
    /** Its folders the sessions there work in, the root's own first when one does. */
    folders: string[];
    /**
     * How Pi trusts its folders: `root` first, then each folder outside `root` (a worktree Pi Pocket keeps in its data
     * folder). Absent when the decisions cannot be read.
     */
    trust?: FolderTrust[];
};

export type ProjectsView = {
    /** Pi's `defaultProjectTrust` setting, which decides for a folder with no decision. */
    defaultProjectTrust: SkillSources["defaultProjectTrust"];
    projects: ProjectView[];
};

/** A session there, as far as its project goes: its folder (a worktree's own folder for a session in one). */
export type ProjectSession = { id: number; cwd: string };

/**
 * The projects of `sessions` (on one computer, not archived): `projectOf` finds a folder's (a cached lookup), `trustOf`
 * reads a folder's trust (undefined: unreadable). At most `LOOKUPS_AT_ONCE` lookups run at once.
 */
export async function projectsOf(
    sessions: readonly ProjectSession[],
    projectOf: (session: ProjectSession) => Promise<{ root?: string; name: string } | undefined>,
    trustOf: (folder: string) => FolderTrust | undefined,
): Promise<ProjectView[]> {
    // One lookup for each folder: the first session working there stands for the others.
    const byFolder = new Map<string, ProjectSession>();

    for (const session of sessions) {
        if (!byFolder.has(session.cwd)) {
            byFolder.set(session.cwd, session);
        }
    }

    const found = await mapLimit([...byFolder], LOOKUPS_AT_ONCE, async ([folder, session]) => ({
        folder,
        project: await projectOf(session).catch(() => undefined),
    }));
    const projects = new Map<string, { name: string; folders: Set<string> }>();

    for (const { folder, project } of found) {
        if (project?.root === undefined) {
            continue;
        }

        const entry = projects.get(project.root) ?? { name: project.name, folders: new Set() };

        entry.folders.add(folder);
        projects.set(project.root, entry);
    }

    return [...projects]
        .map(([root, { name, folders }]) => {
            const sorted = [...folders].sort((a, b) => a.localeCompare(b));
            const outside = sorted.filter((folder) => !inFolder(folder, root));
            const trust = [root, ...outside].map(trustOf);

            return {
                root,
                name,
                folders: sorted,
                ...(trust.every((each) => each !== undefined) ? { trust } : {}),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}
