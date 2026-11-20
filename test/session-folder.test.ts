// A session on this server is saved by the folder it really works in, links followed (`workspace.ts` `checkDirectory`),
// as a runner's is. Its folder decides who accesses it by "User accesses all sessions in folder" and whose it stays
// when folders change, so one started through a link must not count as in the link's folder. Sessions saved before by
// a link's path, or left behind by a move a restart cut short, follow at the next start (`app.ts` `#realFolders`).
// A real App.
import {
    type App,
    answerRequests,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import type { User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";

const data = join(root, "sf-data");
/** Given to Alex, who accesses all sessions in it. In it, `link` leads out, to `other`. */
const proj = join(root, "sf-proj");
const other = join(root, "sf-other");
/** Given to Bea. `shortcut`, beside it, leads into it; `out`, in it, leads out of it. */
const hers = join(root, "sf-hers");
const shortcut = join(root, "sf-shortcut");

let app: App;
let alex: User;
let bea: User;

let stopAnswering: () => void = () => {};

for (const each of [proj, other, hers]) {
    mkdirSync(each);
}

symlinkSync(other, join(proj, "link"), "dir");
symlinkSync(hers, shortcut, "dir");
symlinkSync(other, join(hers, "out"), "dir");

after(async () => {
    stopAnswering();
    await app?.close();
    cleanUp();
});

const now = (user: User): User => app.config.userById(user.id)!;
const sees = (user: User, id: ConversationId): boolean => app.canSee(now(user), id);
const steers = (user: User, id: ConversationId): boolean =>
    app.policy.maySteer(now(user), String(id));
const saved = (id: ConversationId) => app.sessionMeta(id)!;

/** Save session `id` as an older version did: by the path typed, or with its record left behind by a move. */
async function savedAs(id: ConversationId, record: string, works = record): Promise<void> {
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(id)]!.cwd = record;
        (await tx.doc(AgentDoc, id)).cwd = works;
    }, context);
}

async function restart(folder = data): Promise<void> {
    stopAnswering();
    await app.close();
    app = await openApp(scriptedModel(), folder);
    stopAnswering = answerRequests(app, () => true);
}

test("a session started through a link is saved by the folder it works in, and judged by it", async () => {
    app = await openApp(scriptedModel(), data);
    stopAnswering = answerRequests(app, () => true);
    alex = app.config.addUser("Alex", "guest").user;
    bea = app.config.addUser("Bea", "guest").user;

    for (const each of [alex, bea]) {
        await app.choosePerson(THIS_SERVER, each.id, true);
    }

    await app.giveFolders(owner(app), THIS_SERVER, alex.id, [proj]);
    await app.seeFolder(owner(app), THIS_SERVER, alex.id, proj, true);
    await app.giveFolders(owner(app), THIS_SERVER, bea.id, [hers]);

    // The owner starts one in the folder, and one through the link in it that leads out.
    const inside = await newSession(app, proj);
    const through = await newSession(app, join(proj, "link"));

    assert.equal(saved(through).cwd, other, "saved by where it works");
    assert.equal(app.cwdOf(through), other);
    assert.deepEqual(app.folderOf(through), { computer: THIS_SERVER, path: other });
    assert.equal(sees(alex, inside), true, "all sessions in his folder");
    assert.equal(sees(alex, through), false, "not one that works outside it");
    assert.equal(steers(alex, through), false);
    assert.ok(!app.sessions(now(alex)).some((each) => String(each.id) === String(through)));

    // Bea starts one through a link that leads into her folder: it is in her folder, and stays hers.
    const { id: own } = await app.commands.createSession(now(bea), { cwd: shortcut });

    assert.equal(saved(own).cwd, hers);
    assert.equal(saved(own).createdBy, bea.id);
    await app.giveFolders(owner(app), THIS_SERVER, bea.id, [hers, proj]);
    assert.equal(
        saved(own).createdBy,
        bea.id,
        "her folders changed, and it is still in one of them",
    );
    await app.giveFolders(owner(app), THIS_SERVER, bea.id, [hers]);

    // Through the link that leads out of her folder she starts nothing.
    await assert.rejects(app.commands.createSession(now(bea), { cwd: join(hers, "out") }), {
        status: 403,
    });
});

test("a session moved through a link is saved by the folder it moved to", async () => {
    const id = await newSession(app, proj);

    assert.equal(sees(alex, id), true);
    await app.commands.configure(id, owner(app), { cwd: join(proj, "link") });
    assert.equal(saved(id).cwd, other);
    assert.equal(app.cwdOf(id), other);
    assert.equal(sees(alex, id), false, "it works outside his folder now");
});

test("sessions saved by a link's path, or left behind by a move, follow at the next start", async () => {
    // Saved by the link's path, as before: Alex has it by his folder, though it works outside it.
    const typed = await newSession(app, proj);

    await savedAs(typed, join(proj, "link"));
    assert.equal(sees(alex, typed), true, "as it was judged before");

    // A move a restart cut short: Pi works in the other folder, and the session's record still names his.
    const cut = await newSession(app, proj);

    await savedAs(cut, proj, other);
    assert.equal(sees(alex, cut), true, "as it was judged before");

    // Bea's, saved by the link that leads into her folder: outside her folders as written, in one in truth.
    const { id: kept } = await app.commands.createSession(now(bea), { cwd: hers });

    await savedAs(kept, shortcut);

    // And hers saved by the link that leads out of it: in her folder as written, outside it in truth.
    const { id: outside } = await app.commands.createSession(now(bea), { cwd: hers });

    await savedAs(outside, join(hers, "out"));

    // One whose folder is gone stays as written.
    const gone = await newSession(app, proj);

    await savedAs(gone, join(root, "sf-gone"));
    await restart();

    assert.equal(saved(typed).cwd, other);
    assert.equal(app.cwdOf(typed), other);
    assert.equal((await app.harness.snapshot(AgentDoc, typed, context))?.cwd, other);
    assert.equal(sees(alex, typed), false, "it works outside his folder");

    const approval = app.folderApprovals.get(String(typed));

    assert.ok(approval === undefined || approval.folder === other, "its approval names its folder");

    assert.equal(saved(cut).cwd, other, "the record follows where Pi works");
    assert.equal(app.cwdOf(cut), other);
    assert.equal(sees(alex, cut), false);

    assert.equal(saved(kept).cwd, hers);
    assert.equal(saved(kept).createdBy, bea.id, "in her folder: it stays hers");
    assert.equal(sees(bea, kept), true);

    assert.equal(saved(outside).cwd, other);
    assert.equal(saved(outside).createdBy, owner(app).id, "outside her folders: it is the owner's");
    assert.equal(sees(bea, outside), false);

    assert.equal(saved(gone).cwd, join(root, "sf-gone"));

    // Nothing is left to do: a second start changes nothing.
    const before = JSON.stringify([typed, cut, kept, outside, gone].map((id) => saved(id)));

    await restart();
    assert.equal(JSON.stringify([typed, cut, kept, outside, gone].map((id) => saved(id))), before);
});

test("a worktree is saved by its real path when the data folder is reached through a link", async () => {
    const real = join(root, "sf-linked-data");
    const linked = join(root, "sf-data-link");
    const repo = join(root, "sf-repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

    mkdirSync(real);
    symlinkSync(real, linked, "dir");
    mkdirSync(repo);
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "main.ts"), "export const answer = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    await restart(linked);

    const { id } = await app.commands.createSession(owner(app), { cwd: repo, worktree: true });
    const made = saved(id).worktree!;

    assert.ok(made.path.startsWith(join(real, "worktrees")), made.path);
    assert.equal(made.source, repo);
    assert.equal(saved(id).cwd, made.path);
    assert.deepEqual(app.folderOf(id), { computer: THIS_SERVER, path: repo });

    // Saved through the link, as before: the next start saves the worktree and the session by their real paths.
    const typed = join(linked, "worktrees", made.path.slice(join(real, "worktrees").length + 1));

    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(id)]!;

        meta.cwd = typed;
        meta.worktree = { ...made, path: typed };
        (await tx.doc(AgentDoc, id)).cwd = typed;
    }, context);
    await restart(linked);
    assert.deepEqual(saved(id).worktree, made);
    assert.equal(saved(id).cwd, made.path);
    assert.equal(app.cwdOf(id), made.path);
    assert.deepEqual(app.folderOf(id), { computer: THIS_SERVER, path: repo });
});
