// A person who leaves a computer (removed, no longer chosen, or no longer given a folder) hands their sessions and tasks
// there to who is in charge (`app.ts` `handOver`): their own sessions, and the tasks they set up on sessions shared with
// them; in one commit, so a restart finishes a removal it cut short; and Pi then works for who has the session.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import { HooksDoc, ScheduleDoc, SessionsDoc } from "../src/server/docs.ts";

const data = join(root, "hand-over-data");
let app: App;

after(async () => {
    await app?.close();
    cleanUp();
});

/** A webhook on `target` that `by` made, saved as `hooks.ts` saves one. */
async function hookOf(id: string, by: string, target: ConversationId): Promise<void> {
    await app.harness.commit(async (tx) => {
        (await tx.doc(HooksDoc)).items[id] = {
            id,
            secret: `${id}-secret`,
            name: id,
            instructions: "Look",
            target: Number(target),
            by,
            createdAt: Date.now(),
            count: 0,
        };
    }, context);
}

/** A repeating schedule on `target` that `by` set, saved as `schedules.ts` saves one. */
async function scheduleOf(id: string, by: string, target: ConversationId): Promise<void> {
    await app.harness.commit(async (tx) => {
        (await tx.doc(ScheduleDoc, target)).items[id] = {
            id,
            text: "Check",
            content: "Check",
            next: Date.now() + 3_600_000,
            every: { minutes: 60 },
            zone: "UTC",
            by,
            createdAt: Date.now(),
            runs: 0,
        } as never;
    }, context);
}

async function hookBy(id: string): Promise<string | undefined> {
    return (await app.harness.snapshot(HooksDoc, context))?.items[id]?.by;
}

async function scheduleBy(target: ConversationId, id: string): Promise<string | undefined> {
    return (await app.harness.snapshot(ScheduleDoc, target, context))?.items[id]?.by;
}

/** The session is `person`'s, and shared with `shared`. */
async function sessionOf(id: ConversationId, person: string, shared: string[] = []): Promise<void> {
    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(id)]!;

        meta.createdBy = person;

        if (shared.length > 0) {
            meta.sharedWith = shared;
        }
    }, context);
}

test("a person no longer chosen hands over the tasks they set up on a session shared with them", async () => {
    app = await openApp(scriptedModel(), data);

    const alex = app.config.addUser("Alex", "guest").user;
    const bea = app.config.addUser("Bea", "guest").user;

    app.config.setServerUsers([alex.id, bea.id]);

    // Bea's session, shared with Alex; Alex set up a webhook and a schedule on it.
    const beas = await newSession(app);

    await sessionOf(beas, bea.id, [alex.id]);
    await hookOf("alex-on-beas", alex.id, beas);
    await scheduleOf("alex-schedule", alex.id, beas);

    // Bea's own hook stays hers.
    await hookOf("bea-own", bea.id, beas);

    // Alex is taken off this server: the tasks go to the session's starter, Bea.
    await app.choosePeople(THIS_SERVER, [bea.id]);
    assert.equal(await hookBy("alex-on-beas"), bea.id, "the hook is the session's starter's");
    assert.equal(await scheduleBy(beas, "alex-schedule"), bea.id, "and so is the schedule");
    assert.equal(await hookBy("bea-own"), bea.id);

    // A task on a session still shared with the person stays theirs.
    const kept = await newSession(app);

    app.config.setServerUsers([alex.id, bea.id]);
    await sessionOf(kept, bea.id, [alex.id]);
    await hookOf("alex-kept", alex.id, kept);
    await app.handOver(alex.id, THIS_SERVER);
    assert.equal(await hookBy("alex-kept"), alex.id, "they may still steer there");
});

test("a removal a restart cut short is finished at the next start", async () => {
    const carl = app.config.addUser("Carl", "guest").user;

    app.config.setServerUsers([carl.id]);

    const his = await newSession(app);

    await sessionOf(his, carl.id);
    await hookOf("carl-hook", carl.id, his);
    await scheduleOf("carl-schedule", carl.id, his);

    // Removed, and the server stops before the hand-over is saved.
    app.config.removeUser(carl.id);
    await app.close();

    app = await openApp(scriptedModel(), data);
    assert.equal(app.sessionMeta(his)?.createdBy, owner(app).id, "the session is the owner's");
    assert.equal(await hookBy("carl-hook"), owner(app).id, "so is its hook");
    assert.equal(await scheduleBy(his, "carl-schedule"), owner(app).id, "and its schedule");
});

test("Pi works for who has the session now, and a linked session still starts", async () => {
    const dana = app.config.addUser("Dana", "guest").user;

    app.config.setServerUsers([dana.id]);

    const hers = await newSession(app);

    await sessionOf(hers, dana.id);
    // Dana wrote last: Pi works for her.
    await app.commands.submit(hers, dana, { text: "Do the thing", requestId: "dana-1" });

    for (let tries = 0; tries < 50 && app.attribution.requesterOf(hers) !== dana.id; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(app.attribution.requesterOf(hers), dana.id);

    await app.removeUser(owner(app), dana.id);
    assert.equal(app.sessionMeta(hers)?.createdBy, owner(app).id);
    assert.equal(
        app.attribution.requesterOf(hers),
        owner(app).id,
        "Pi now works for who has the session",
    );
});

test("taking one session from a person leaves the tasks on their other sessions with them", async () => {
    // Pat was never chosen for this server: two of the owner's sessions are shared with her, one at a time.
    const pat = app.config.addUser("Pat", "guest").user;
    const taken = await newSession(app);
    const kept = await newSession(app);
    const never = await newSession(app);

    await sessionOf(taken, owner(app).id, [pat.id]);
    await sessionOf(kept, owner(app).id, [pat.id]);
    await sessionOf(never, owner(app).id);
    assert.equal(app.policy.mayUse(pat, THIS_SERVER), false);
    assert.equal(
        app.policy.maySteer(pat, String(kept)),
        true,
        "a share counts without being chosen",
    );

    await hookOf("pat-taken", pat.id, taken);
    await scheduleOf("pat-taken-schedule", pat.id, taken);
    await hookOf("pat-kept", pat.id, kept);
    await scheduleOf("pat-kept-schedule", pat.id, kept);
    // A task of hers on a session she does not have: for a hand-over of everything, not for this.
    await hookOf("pat-never", pat.id, never);

    await app.revokeSession(owner(app), taken, pat.id);
    assert.equal(app.canSee(pat, taken), false);
    assert.equal(await hookBy("pat-taken"), owner(app).id, "its tasks go to its starter");
    assert.equal(await scheduleBy(taken, "pat-taken-schedule"), owner(app).id);
    assert.equal(app.policy.maySteer(pat, String(kept)), true, "she still steers the other");
    assert.equal(await hookBy("pat-kept"), pat.id, "and its tasks stay hers");
    assert.equal(await scheduleBy(kept, "pat-kept-schedule"), pat.id);
    assert.equal(await hookBy("pat-never"), pat.id, "nothing else of hers is touched");

    // A hand-over of everything of hers here follows the same rule as what she may steer.
    await app.handOver(pat.id, THIS_SERVER);
    assert.equal(
        await hookBy("pat-kept"),
        pat.id,
        "a session shared with her is still hers to steer",
    );
    assert.equal(await scheduleBy(kept, "pat-kept-schedule"), pat.id);
    assert.equal(await hookBy("pat-never"), owner(app).id, "one she does not have is not");

    // Ivy is invited to two sessions alone.
    const first = await newSession(app);
    const second = await newSession(app);
    const ivy = app.config.addUser("Ivy", "guest", [String(first), String(second)]).user;

    await hookOf("ivy-first", ivy.id, first);
    await hookOf("ivy-second", ivy.id, second);
    await app.revokeSession(owner(app), first, ivy.id);
    assert.deepEqual(app.config.userById(ivy.id)?.sessions, [String(second)]);
    assert.equal(await hookBy("ivy-first"), owner(app).id);
    assert.equal(
        await hookBy("ivy-second"),
        ivy.id,
        "the task on the session she is still invited to",
    );
    await app.handOver(ivy.id, THIS_SERVER);
    assert.equal(await hookBy("ivy-second"), ivy.id);
});
