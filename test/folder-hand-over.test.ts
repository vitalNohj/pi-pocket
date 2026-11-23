// What follows from a folder is finished whatever cuts it short. A folder taken back from a person, or all sessions in
// one, is saved in the settings file, and the sessions and tasks that go with it are saved with the sessions: the
// settings mark the hand-over as owed in that same save (`config.ts` `ComputerAccess.handOver`), and the next start
// finishes one a restart cut short (`app.ts` `#finishHandOvers`). A move is one save: where Pi works and the session's
// record of it, which access is judged by, never differ (`commands.ts` `configure`, `removeWorktree`). And such
// changes go one at a time, each checked again where it is saved (`app.ts` `#inTurn`, `#requireGiving`). A real App.
import { type App, cleanUp, context, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import { THIS_SERVER } from "../src/server/access.ts";
import type { User } from "../src/server/config.ts";
import { HooksDoc, SessionsDoc } from "../src/server/docs.ts";

const data = join(root, "folder-hand-over-data");
let app: App;
let vera: User;

after(async () => {
    await app?.close();
    cleanUp();
});

/** A folder of its own under the test's folder, as its real path. */
function folder(name: string): string {
    mkdirSync(join(root, name), { recursive: true });

    return realpathSync(join(root, name));
}

const first = folder("hand-over-first");
const second = folder("hand-over-second");

const restart = async (): Promise<void> => {
    await app.close();
    app = await openApp(scriptedModel(), data);
};

/** A session in `cwd`, started by `starter`: Pi works there, and its record says so. */
async function sessionIn(cwd: string, starter: User): Promise<ConversationId> {
    const { id } = await app.commands.createSession(owner(app), { cwd });

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(id)]!.createdBy = starter.id;
    }, context);

    return id;
}

/** A webhook on `target` that `by` made, saved as `hooks.ts` saves one. */
async function hookOf(id: string, by: User, target: ConversationId): Promise<void> {
    await app.harness.commit(async (tx) => {
        (await tx.doc(HooksDoc)).items[id] = {
            id,
            secret: `${id}-secret`,
            name: id,
            instructions: "Look",
            target: Number(target),
            by: by.id,
            createdAt: Date.now(),
            count: 0,
        };
    }, context);
}

const hookBy = async (id: string): Promise<string | undefined> =>
    (await app.harness.snapshot(HooksDoc, context))?.items[id]?.by;
const starterOf = (id: ConversationId): string | undefined => app.sessionMeta(id)?.createdBy;
const owed = (id?: string): readonly string[] => app.config.handOvers(id ?? THIS_SERVER);
const given = (person: User, id?: string): readonly string[] =>
    app.config.givenFolders(id ?? THIS_SERVER, person.id);

/**
 * Watch every save while `change` runs: where Pi works in session `id` and what the session's record says must agree
 * at each one. Says how often Pi's folder changed, and each save that left the two apart.
 */
async function watched(
    id: ConversationId,
    change: () => Promise<unknown>,
): Promise<{ moves: number; apart: string[] }> {
    let works: string | undefined = app.cwdOf(id);
    let record = app.sessionMeta(id)?.cwd;
    let moves = 0;
    const apart: string[] = [];

    assert.equal(works, record, "they agree before the change");

    const watching = app.harness.observeCommits({
        advance: (publication) => {
            for (const change of publication.changes) {
                const each = change as unknown as {
                    type: string;
                    record?: { kind: string };
                    conversationId?: unknown;
                    value?: unknown;
                };

                if (each.type !== "document" || each.value === undefined) {
                    continue;
                }

                if (
                    each.record?.kind === AgentDoc.definition.kind &&
                    String(each.conversationId) === String(id)
                ) {
                    const cwd = (each.value as { cwd?: string }).cwd;

                    if (cwd !== works) {
                        works = cwd;
                        moves += 1;
                    }
                } else if (each.record?.kind === SessionsDoc.definition.kind) {
                    record = (each.value as { items: Record<string, { cwd?: string }> }).items[
                        String(id)
                    ]?.cwd;
                }
            }

            if (works !== record) {
                apart.push(`Pi works in ${String(works)}, the record says ${String(record)}`);
            }
        },
        end: () => {},
    });

    try {
        await change();
    } finally {
        watching.detach();
    }

    return { moves, apart };
}

/** Something to wait at: `reached` once it is, held there until `go`. */
function gate(): {
    reached: Promise<void>;
    reach: () => void;
    held: Promise<void>;
    go: () => void;
} {
    let reach!: () => void;
    let go!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const held = new Promise<void>((resolve) => (go = resolve));

    return { reached, reach, held, go };
}

test("a folder taken back, cut short by a restart: the next start hands its sessions and tasks over", async () => {
    app = await openApp(scriptedModel(), data);
    vera = app.config.addUser("Vera", "guest").user;
    await app.choosePerson(THIS_SERVER, vera.id, true);
    await app.giveFolders(owner(app), THIS_SERVER, vera.id, [first, second]);
    assert.deepEqual(owed(), [], "giving owes nothing");

    // Vera's sessions, one in each folder, and a webhook she made on each.
    const there = await sessionIn(first, vera);
    const kept = await sessionIn(second, vera);

    await hookOf("vera-first", vera, there);
    await hookOf("vera-second", vera, kept);

    // The first folder is taken back: the settings are saved, and the server stops before anything else is.
    app.config.setGivenFolders(THIS_SERVER, vera.id, [second]);
    assert.deepEqual(owed(), [vera.id], "the hand-over is owed, in that same save");
    assert.equal(starterOf(there), vera.id, "nothing is handed over yet");
    await restart();

    assert.equal(starterOf(there), owner(app).id, "her session in that folder is the owner's");
    assert.equal(await hookBy("vera-first"), owner(app).id, "and so is the task she set up on it");
    assert.equal(starterOf(kept), vera.id, "her session in the folder she kept stays hers");
    assert.equal(await hookBy("vera-second"), vera.id);
    assert.deepEqual(owed(), [], "and nothing is left to finish");
    assert.deepEqual(given(vera), [second]);

    // A second start changes nothing.
    await restart();
    assert.equal(starterOf(kept), vera.id);
    assert.equal(await hookBy("vera-second"), vera.id);
});

test("all sessions in a folder, turned off and cut short by a restart: the next start hands the tasks over", async () => {
    const theirs = await sessionIn(second, owner(app));
    const hers = await sessionIn(second, vera);

    await app.seeFolder(owner(app), THIS_SERVER, vera.id, second, true);
    assert.deepEqual(owed(), [], "turning it on owes nothing");
    assert.equal(app.canSee(vera, theirs), true, "by its folder");
    await hookOf("vera-on-theirs", vera, theirs);
    await hookOf("vera-on-hers", vera, hers);

    app.config.setSeenFolder(THIS_SERVER, vera.id, second, false);
    assert.deepEqual(owed(), [vera.id]);
    assert.equal(app.canSee(vera, theirs), false, "she left it at once");
    assert.equal(await hookBy("vera-on-theirs"), vera.id, "her task on it is not handed over yet");
    await restart();

    assert.equal(
        await hookBy("vera-on-theirs"),
        owner(app).id,
        "the task goes to who is in charge",
    );
    assert.equal(await hookBy("vera-on-hers"), vera.id, "her own session's task stays hers");
    assert.equal(starterOf(hers), vera.id);
    assert.deepEqual(owed(), []);
});

test("a session moved out of a folder someone accesses all sessions in: their tasks on it go to who is in charge, in the save of the move", async () => {
    const deeper = folder("hand-over-second/deeper");
    const out = await sessionIn(second, owner(app));
    const inside = await sessionIn(second, owner(app));
    const shared = await sessionIn(second, owner(app));

    await app.seeFolder(owner(app), THIS_SERVER, vera.id, second, true);
    await app.commands.shareSession(shared, owner(app), [vera.id]);

    for (const [name, target] of [
        ["vera-out", out],
        ["vera-inside", inside],
        ["vera-shared", shared],
    ] as const) {
        assert.equal(app.canSee(vera, target), true, `${name}: by its folder`);
        await hookOf(name, vera, target);
    }

    // Every save of the move: never one that leaves the session in the other folder with her task still hers.
    let record = app.sessionMeta(out)?.cwd;
    let by: string | undefined = vera.id;
    const apart: string[] = [];
    const watching = app.harness.observeCommits({
        advance: (publication) => {
            for (const change of publication.changes) {
                const each = change as unknown as {
                    type: string;
                    record?: { kind: string };
                    value?: { items?: Record<string, { cwd?: string; by?: string }> };
                };

                if (each.type !== "document" || each.value === undefined) {
                    continue;
                }

                if (each.record?.kind === SessionsDoc.definition.kind) {
                    record = each.value.items?.[String(out)]?.cwd;
                } else if (each.record?.kind === HooksDoc.definition.kind) {
                    by = each.value.items?.["vera-out"]?.by;
                }
            }

            if (record === first && by === vera.id) {
                apart.push("the session moved, and her task on it is still hers");
            }
        },
        end: () => {},
    });

    try {
        await app.commands.configure(out, owner(app), { cwd: first });
    } finally {
        watching.detach();
    }

    assert.equal(app.sessionMeta(out)?.cwd, first);
    assert.equal(app.canSee(vera, out), false, "it left her with its folder");
    assert.equal(
        await hookBy("vera-out"),
        owner(app).id,
        "her task on it goes to who is in charge",
    );
    assert.deepEqual(apart, [], "in the save of the move");

    // Moved to a folder inside the one she accesses all sessions in, it stays hers, and so does her task.
    await app.commands.configure(inside, owner(app), { cwd: deeper });
    assert.equal(app.sessionMeta(inside)?.cwd, deeper);
    assert.equal(app.canSee(vera, inside), true);
    assert.equal(await hookBy("vera-inside"), vera.id);

    // One shared with her too: she still has it after the move, another way, and keeps her task.
    await app.commands.configure(shared, owner(app), { cwd: first });
    assert.equal(app.canSee(vera, shared), true, "shared with her");
    assert.equal(await hookBy("vera-shared"), vera.id);

    await app.seeFolder(owner(app), THIS_SERVER, vera.id, second, false);
    assert.deepEqual(owed(), []);
    assert.equal(await hookBy("vera-inside"), owner(app).id, "off, the rest follows as before");
    assert.equal(await hookBy("vera-shared"), vera.id);
});

test("a session moved by someone else out of its starter's folders is no longer theirs, with their tasks on it, in the save of the move", async () => {
    const deeper = folder("hand-over-second/deeper");
    const third = folder("hand-over-third");

    assert.deepEqual(given(vera), [second], "the one folder given to her");

    const out = await sessionIn(second, vera);
    const inside = await sessionIn(second, vera);
    // One in a folder that was never hers to work in: a move is not what takes it.
    const stray = await sessionIn(first, vera);

    await hookOf("hers-out", vera, out);
    await hookOf("hers-inside", vera, inside);
    await hookOf("hers-stray", vera, stray);
    assert.equal(app.policy.maySteer(vera, String(out)), true);

    // Every save of the move: never one that leaves it in the other folder and still hers, or her task still hers.
    let record: { cwd?: string; createdBy?: string } | undefined = app.sessionMeta(out);
    let by: string | undefined = vera.id;
    const apart: string[] = [];
    const watching = app.harness.observeCommits({
        advance: (publication) => {
            for (const change of publication.changes) {
                const each = change as unknown as {
                    type: string;
                    record?: { kind: string };
                    value?: {
                        items?: Record<string, { cwd?: string; createdBy?: string; by?: string }>;
                    };
                };

                if (each.type !== "document" || each.value === undefined) {
                    continue;
                }

                if (each.record?.kind === SessionsDoc.definition.kind) {
                    record = each.value.items?.[String(out)];
                } else if (each.record?.kind === HooksDoc.definition.kind) {
                    by = each.value.items?.["hers-out"]?.by;
                }
            }

            if (record?.cwd === first && (record.createdBy === vera.id || by === vera.id)) {
                apart.push("the session moved, and it or her task on it is still hers");
            }
        },
        end: () => {},
    });

    try {
        await app.commands.configure(out, owner(app), { cwd: first });
    } finally {
        watching.detach();
    }

    assert.equal(app.sessionMeta(out)?.cwd, first);
    assert.equal(starterOf(out), owner(app).id, "it is who is in charge's");
    assert.equal(app.canSee(vera, out), false, "she left it");
    assert.equal(await hookBy("hers-out"), owner(app).id, "and so did her task on it");
    assert.deepEqual(apart, [], "in the save of the move");
    assert.deepEqual(owed(), [], "nothing is left for a later start");

    // Moved inside the folder given to her, it stays hers.
    await app.commands.configure(inside, owner(app), { cwd: deeper });
    assert.equal(starterOf(inside), vera.id);
    assert.equal(app.policy.maySteer(vera, String(inside)), true);
    assert.equal(await hookBy("hers-inside"), vera.id);

    // One she could not work in before the move either keeps what it had: the move took nothing from her.
    await app.commands.configure(stray, owner(app), { cwd: third });
    assert.equal(starterOf(stray), vera.id);
    assert.equal(await hookBy("hers-stray"), vera.id);

    // Moved by herself, to a folder that is hers: nothing changes hands.
    await app.commands.configure(inside, vera, { cwd: second });
    assert.equal(starterOf(inside), vera.id);
    assert.equal(await hookBy("hers-inside"), vera.id);
});

test("a move is one save: where Pi works and the session's record never differ", async () => {
    const id = await sessionIn(first, owner(app));
    const { moves, apart } = await watched(id, () =>
        app.commands.configure(id, owner(app), { cwd: second }),
    );

    assert.equal(moves, 1, "Pi's folder changed once");
    assert.deepEqual(apart, []);
    assert.equal(app.cwdOf(id), second);
    assert.equal(app.sessionMeta(id)?.cwd, second);
});

test("removing a worktree is one save: Pi goes back and the record says so together", async () => {
    const repo = folder("hand-over-repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "main.ts"), "export const answer = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "init");

    const { id } = await app.commands.createSession(owner(app), { cwd: repo, worktree: true });

    assert.notEqual(app.sessionMeta(id)?.worktree, undefined);
    assert.notEqual(app.cwdOf(id), repo, "it works in its worktree");

    const { moves, apart } = await watched(id, () =>
        app.commands.removeWorktree(id, owner(app), true),
    );

    assert.equal(moves, 1, "Pi's folder changed once");
    assert.deepEqual(apart, []);
    assert.equal(app.cwdOf(id), repo);
    assert.equal(app.sessionMeta(id)?.cwd, repo);
    assert.equal(app.sessionMeta(id)?.worktree, undefined);
});

test("folder changes go one at a time, and one that fails does not hold up the next", async (t) => {
    const wim = app.config.addUser("Wim", "guest").user;

    await app.choosePerson(THIS_SERVER, wim.id, true);
    await app.giveFolders(owner(app), THIS_SERVER, vera.id, [first, second]);

    // Vera's hand-over is held at its save, as a slow one is.
    const slow = gate();
    const handOver = app.handOver.bind(app);
    let held = false;

    t.mock.method(app, "handOver", async (...args: Parameters<App["handOver"]>) => {
        if (!held) {
            held = true;
            slow.reach();
            await slow.held;
        }

        await handOver(...args);
    });

    const taking = app.giveFolders(owner(app), THIS_SERVER, vera.id, [second]);

    await slow.reached;
    assert.deepEqual(owed(), [vera.id], "owed while it is handed over");

    // A second change waits for the first: it saves nothing, and ends no mark, meanwhile.
    const giving = app.giveFolders(owner(app), THIS_SERVER, wim.id, [first]);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(given(wim), [], "not saved while the first is not finished");
    assert.deepEqual(owed(), [vera.id]);
    slow.go();
    await Promise.all([taking, giving]);
    assert.deepEqual(given(wim), [first]);
    assert.deepEqual(given(vera), [second]);
    assert.deepEqual(owed(), []);
    t.mock.restoreAll();

    // A change that is refused leaves the line free.
    await assert.rejects(app.seeFolder(owner(app), THIS_SERVER, wim.id, second, true), {
        status: 400,
        message: /Give them that folder first/,
    });
    await app.giveFolders(owner(app), THIS_SERVER, wim.id, [first, second]);
    assert.deepEqual(given(wim), [first, second]);
});

test("a folder is given only by who is still in charge, to who is still chosen, where it is saved", async (t) => {
    const lin = app.config.addUser("Lin", "guest").user;
    const laptop = app.config.addRunner("Laptop", lin.id, newIdentity().publicKey);

    await app.choosePerson(laptop.id, vera.id, true);

    // Looking a folder up on the laptop takes a while: held here, then answered as given.
    let looking = gate();

    t.mock.method(app.runners, "checkFolder", async (_id: string, path: string) => {
        looking.reach();
        await looking.held;

        return path;
    });

    // Lin, who linked it, gives Vera a folder there, and is removed while the folder is looked up.
    const byLin = assert.rejects(app.giveFolders(lin, laptop.id, vera.id, ["/srv/work"]), {
        status: 403,
    });

    await looking.reached;
    await app.removeUser(owner(app), lin.id);
    looking.go();
    await byLin;
    assert.deepEqual(given(vera, laptop.id), [], "nothing was given");

    // The owner is in charge of it now, and gives the folder; Vera is taken off the laptop meanwhile.
    looking = gate();

    const byOwner = assert.rejects(app.giveFolders(owner(app), laptop.id, vera.id, ["/srv/work"]), {
        status: 400,
        message: /Choose them for this computer first/,
    });

    await looking.reached;
    await app.choosePerson(laptop.id, vera.id, false);
    looking.go();
    await byOwner;
    assert.deepEqual(given(vera, laptop.id), []);
    assert.deepEqual(owed(laptop.id), []);

    // Chosen again, with nothing in between, it is given.
    looking = gate();
    looking.go();
    await app.choosePerson(laptop.id, vera.id, true);
    await app.giveFolders(owner(app), laptop.id, vera.id, ["/srv/work"]);
    assert.deepEqual(given(vera, laptop.id), ["/srv/work"]);
});
