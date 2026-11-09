// Recurring tasks keep their own approval (`app.ts` `approveTask`, `folder-approvals.ts` `addTask`): a webhook or a
// repeat runs when nobody is there, so it is approved when it is made, from a live approval of its folder or a fresh
// code, and keeps that approval while it exists, however long it goes unused. New instructions need a fresh one. Each
// run still checks the owner's rules: its person chosen, the folder still given, its approval not revoked.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { ScheduleDoc } from "../src/server/docs.ts";
import type { FolderRequestView } from "../src/server/folder-requests.ts";

let clock = 1_800_000_000_000;
let app: App;
let alex: User;
let given: string;
let folderCount = 0;
const DAY = 86_400_000;

function newFolder(): string {
    const folder = join(given, `t${String(++folderCount)}`);

    mkdirSync(folder, { recursive: true });

    return realpathSync(folder);
}

/** Alex's waiting request for a task, once it is there. */
async function taskRequest(): Promise<FolderRequestView> {
    let found: FolderRequestView | undefined;

    await until(() => {
        found = app.folderRequests.list(alex).find((each) => each.kind === "task");

        return found !== undefined;
    }, "Alex's request for a task");

    return found!;
}

/** A session of Alex's in a new folder they approved, with a model to answer. */
async function alexSession(): Promise<{ id: ConversationId; folder: string }> {
    const folder = newFolder();

    app.folderApprovals.add(alex.id, { computer: "this-server", folder }, "totp", alex.id);

    const { id } = await app.commands.createSession(alex, { cwd: folder });

    await app.commands.configure(id, alex, {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return { id, folder };
}

/** A post to `hook` with the secret in its address (`/hook/<id>/<secret>`), as anything but GitHub would send. */
const post = (hook: { id: string; path: string }) =>
    app.hooks.deliver(hook.id, {
        secret: hook.path.split("/").at(-1)!,
        headers: {},
        body: Buffer.from('{"deploy":"failed"}'),
    });

before(async () => {
    app = await openApp(scriptedModel(), undefined, () => clock);
    alex = app.config.addUser("Alex", "guest").user;
    app.config.setServerUsers([alex.id]);
    mkdirSync(join(root, "tasks"), { recursive: true });
    given = realpathSync(join(root, "tasks"));
});

beforeEach(() => {
    app.config.setGivenFolders(undefined, alex.id, [given]);
    app.config.updateUser(alex.id, { approvalDays: undefined });
    app.config.setFolderApprovals([]);
});

after(async () => {
    await app.close();
    cleanUp();
});

test("a webhook made with a live approval keeps its own, which lasts while it exists however long unused", async () => {
    const { id, folder } = await alexSession();
    const hook = await app.hooks.add(alex, id, { name: "Deploys", instructions: "Fix it" });
    const own = app.folderApprovals.task(`hook:${hook.id}`);

    assert.equal(own?.person, alex.id);
    assert.equal(own?.folder, folder);
    assert.equal(own?.method, "totp");
    assert.deepEqual(
        app.folderApprovals
            .list(alex)
            .filter((each) => each.task !== undefined)
            .map((each) => [each.label, each.expiresAt]),
        [["Webhook “Deploys”", null]],
    );

    // A month later Alex's own approval of the folder has ended; the webhook still runs on its own.
    clock += 30 * DAY;
    assert.equal(app.folderApprovals.has(alex.id, { computer: "this-server", folder }), false);
    assert.equal((await post(hook)).status, 202);
    await until(() => !app.isBusy(id), "the webhook's answer");

    // Removing it takes its approval too.
    await app.hooks.remove(alex, hook.id);
    assert.equal(app.folderApprovals.task(`hook:${hook.id}`), undefined);
});

test("a webhook made without a live approval waits for a code; denied, nothing is made", async () => {
    const { id, folder } = await alexSession();

    app.config.setFolderApprovals([]);

    const denied = assert.rejects(
        app.hooks.add(alex, id, { name: "Nope", instructions: "x" }),
        /Cancelled|did not allow/,
    );
    const first = await taskRequest();

    assert.equal(first.folder, folder);
    app.folderRequests.deny(owner(app), first.id);
    await denied;
    assert.ok((await app.hooks.list(alex)).every((each) => each.name !== "Nope"));

    const making = app.hooks.add(alex, id, { name: "Yes", instructions: "y" });

    await app.folderRequests.approve(owner(app), (await taskRequest()).id, { method: "owner" });

    const hook = await making;

    assert.equal(app.folderApprovals.task(`hook:${hook.id}`)?.method, "owner");
});

test("new instructions need a fresh approval, even with a live one", async () => {
    const { id } = await alexSession();
    const hook = await app.hooks.add(alex, id, { name: "Edits", instructions: "Before" });

    // The same words again change nothing, and ask nothing.
    await app.hooks.update(alex, hook.id, "Before");
    assert.deepEqual(app.folderRequests.list(alex), []);

    const editing = app.hooks.update(alex, hook.id, "After");
    const request = await taskRequest();

    app.folderRequests.deny(owner(app), request.id);
    await assert.rejects(editing, /Cancelled|did not allow/);
    assert.equal(
        (await app.hooks.list(alex)).find((each) => each.id === hook.id)?.instructions,
        "Before",
    );

    const again = app.hooks.update(alex, hook.id, "After");

    await app.folderRequests.approve(owner(app), (await taskRequest()).id, { method: "owner" });
    assert.equal((await again).instructions, "After");
});

test("each run checks the owner's rules: revoked, the folder taken back, or its person not chosen, it stops", async () => {
    const { id } = await alexSession();
    const hook = await app.hooks.add(alex, id, { name: "Checked", instructions: "Run" });
    const own = app.folderApprovals.task(`hook:${hook.id}`)!;

    // Revoked from the approvals list: its posts are refused.
    app.folderApprovals.revoke(owner(app), own.id);
    await assert.rejects(post(hook), { status: 410 });

    // Approved again, then the folder taken back: refused too.
    app.folderApprovals.addTask(
        alex.id,
        { computer: "this-server", folder: own.folder! },
        `hook:${hook.id}`,
        "Webhook",
        "owner",
        owner(app).id,
    );
    app.config.setGivenFolders(undefined, alex.id, []);
    await assert.rejects(post(hook), { status: 410 });
    app.config.setGivenFolders(undefined, alex.id, [given]);

    // Alex no longer chosen for this server: refused.
    app.config.setServerUsers([]);
    await assert.rejects(post(hook), { status: 410 });
    app.config.setServerUsers([alex.id]);
});

test("a repeating schedule keeps its approval; revoked, its next run is cancelled", async () => {
    const { id } = await alexSession();
    const repeat = await app.commands.schedule(id, alex, { when: "every 20m ping", zone: "UTC" });

    assert.ok(repeat.approval?.startsWith(`schedule:${String(id)}:`));

    const own = app.folderApprovals.task(repeat.approval!)!;

    assert.equal(own.person, alex.id);
    app.folderApprovals.revoke(alex, own.id);
    assert.equal(
        app.schedules.held(id, repeat),
        "its approval was revoked, or the folder was taken back",
    );

    // Cancelling one removes its approval.
    const other = await app.commands.schedule(id, alex, { when: "every 30m pong", zone: "UTC" });

    assert.ok(app.folderApprovals.task(other.approval!));
    await app.commands.cancelSchedule(id, alex, other.id);
    assert.equal(app.folderApprovals.task(other.approval!), undefined);
    assert.ok(
        Object.values((await app.harness.snapshot(ScheduleDoc, id, context))?.items ?? {}).every(
            (each) => each.id !== other.id,
        ),
    );
});

test("the owner's own tasks here need no code, and someone never asked keeps a task without one", async () => {
    const folder = newFolder();
    const { id } = await app.commands.createSession(owner(app), { cwd: folder });
    const hook = await app.hooks.add(owner(app), id, { name: "Mine", instructions: "x" });

    assert.ok(app.folderApprovals.task(`hook:${hook.id}`));

    app.config.updateUser(alex.id, { approvalDays: 0 });

    const theirs = await app.commands.createSession(alex, { cwd: newFolder() });
    const made = await app.hooks.add(alex, theirs.id, { name: "Free", instructions: "y" });

    assert.ok(app.folderApprovals.task(`hook:${made.id}`));
    assert.deepEqual(app.folderRequests.list(alex), []);
});
