// A person no longer chosen for a computer loses the sessions shared with them there at once. Who is chosen is saved in
// the settings file and the shares with the sessions, so the two cannot be saved in one step: the settings mark the
// person as leaving in the same save that drops them (`config.ts` `StoredRunner.leaving`), no share there counts for
// them from then on (`access.ts` `Computer.leaving`), and the rest (`app.ts` `#finishLeaving`) is finished by the next
// start when a restart cut it short. A real App.
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
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import { THIS_SERVER } from "../src/server/access.ts";
import type { User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";

const data = join(root, "unchoose-data");
let app: App;

after(async () => {
    await app?.close();
    cleanUp();
});

/** Change what is saved of session `id`, as the app's own saves do. */
async function saved(
    id: ConversationId,
    change: (meta: { createdBy?: string; sharedWith?: string[]; runner?: string }) => void,
): Promise<void> {
    await app.harness.commit(async (tx) => {
        change((await tx.doc(SessionsDoc)).items[String(id)]!);
    }, context);
}

const chosen = (): readonly string[] => app.config.server.users ?? [];
const sees = (person: User, id: ConversationId): boolean =>
    app.canSee(app.config.userById(person.id)!, id);
const steers = (person: User, id: ConversationId): boolean =>
    app.policy.maySteer(app.config.userById(person.id)!, String(id));

test("an unchoose a restart cut short ends the shares at once, and the next start takes them back", async () => {
    app = await openApp(scriptedModel(), data);

    const vera = app.config.addUser("Vera", "guest").user;

    await app.choosePerson(THIS_SERVER, vera.id, true);

    // The owner's session, shared with Vera; and one Vera started.
    const shared = await newSession(app);
    const hers = await newSession(app);

    await app.commands.shareSession(shared, owner(app), [vera.id]);
    await saved(hers, (meta) => {
        meta.createdBy = vera.id;
    });
    assert.equal(sees(vera, shared), true);
    assert.equal(sees(vera, hers), true);

    // The settings are saved, and the server stops before anything else is.
    app.config.setServerUsers([]);
    assert.deepEqual(app.sessionMeta(shared)?.sharedWith, [vera.id], "the share is still saved");
    assert.deepEqual(app.config.leaving(undefined), [vera.id]);
    assert.equal(sees(vera, shared), false, "but it no longer counts");
    assert.equal(steers(vera, shared), false);
    assert.equal(sees(vera, hers), false);
    await app.close();

    app = await openApp(scriptedModel(), data);
    assert.equal(app.sessionMeta(shared)?.sharedWith, undefined, "the share is taken back");
    assert.equal(app.sessionMeta(hers)?.createdBy, owner(app).id, "her session is the owner's");
    assert.deepEqual(app.config.leaving(undefined), [], "and nothing is left to finish");
    assert.equal(sees(vera, shared), false);

    // Chosen again, she sees nothing from before: only what is shared with her anew.
    await app.choosePerson(THIS_SERVER, vera.id, true);
    assert.equal(sees(vera, shared), false);
    assert.equal(sees(vera, hers), false);
    assert.deepEqual(await app.commands.shareSession(shared, owner(app), [vera.id]), [vera.id]);
    assert.equal(sees(vera, shared), true);
});

test("a share saved while its person is unchosen does not come back", async () => {
    const wes = app.config.addUser("Wes", "guest").user;

    await app.choosePerson(THIS_SERVER, wes.id, true);

    const id = await newSession(app);

    await app.commands.shareSession(id, owner(app), [wes.id]);

    // Both at once: the share's check passes while Wes is still chosen, and its save comes with him unchosen.
    await Promise.all([
        app.choosePerson(THIS_SERVER, wes.id, false),
        app.commands.shareSession(id, owner(app), [wes.id]),
    ]);
    assert.equal(app.sessionMeta(id)?.sharedWith, undefined);
    assert.equal(sees(wes, id), false);
    assert.equal(steers(wes, id), false);
    assert.deepEqual(app.config.leaving(undefined), []);
});

test("a share is not kept for someone who is leaving, and turning them off again finishes it", async () => {
    const xan = app.config.addUser("Xan", "guest").user;

    await app.choosePerson(THIS_SERVER, xan.id, true);

    const kept = await newSession(app);
    const other = await newSession(app);

    await app.commands.shareSession(kept, owner(app), [xan.id]);
    await app.commands.shareSession(other, owner(app), [xan.id]);

    // Cut short, with no restart: the settings alone.
    app.config.setServerUsers(chosen().filter((each) => each !== xan.id));
    assert.equal(sees(xan, kept), false);

    // Saving the list he was on does not keep him on it.
    assert.deepEqual(await app.commands.shareSession(kept, owner(app), [xan.id]), []);
    assert.deepEqual(app.sessionMeta(other)?.sharedWith, [xan.id], "this one is still saved");

    // The switch, turned off again, takes back the rest.
    await app.choosePerson(THIS_SERVER, xan.id, false);
    assert.equal(app.sessionMeta(other)?.sharedWith, undefined);
    assert.deepEqual(app.config.leaving(undefined), []);
    assert.equal(sees(xan, other), false);
});

test("two people changed at once both count", async () => {
    const yara = app.config.addUser("Yara", "guest").user;
    const zed = app.config.addUser("Zed", "guest").user;

    await app.choosePerson(THIS_SERVER, yara.id, true);

    const id = await newSession(app);

    await app.commands.shareSession(id, owner(app), [yara.id]);
    await Promise.all([
        app.choosePerson(THIS_SERVER, yara.id, false),
        app.choosePerson(THIS_SERVER, zed.id, true),
    ]);
    assert.equal(chosen().includes(zed.id), true);
    assert.equal(chosen().includes(yara.id), false);
    assert.equal(app.sessionMeta(id)?.sharedWith, undefined);
    assert.deepEqual(app.config.leaving(undefined), []);
});

test("leaving a linked computer ends the shares there, and no others", async () => {
    const kim = app.config.addUser("Kim", "guest").user;
    const laptop = app.config.addRunner("Laptop", owner(app).id, newIdentity().publicKey);

    await app.choosePerson(laptop.id, kim.id, true);

    // One session on the laptop and one on this server, both shared with Kim, who was never chosen for this server.
    const there = await newSession(app);
    const here = await newSession(app);

    await saved(there, (meta) => {
        meta.runner = laptop.id;
        meta.sharedWith = [kim.id];
    });
    await saved(here, (meta) => {
        meta.sharedWith = [kim.id];
    });
    assert.equal(sees(kim, there), true);
    assert.equal(sees(kim, here), true);

    app.config.setRunnerUsers(laptop.id, []);
    assert.deepEqual(app.config.leaving(laptop.id), [kim.id]);
    assert.equal(sees(kim, there), false, "no share on the laptop counts");
    assert.equal(sees(kim, here), true, "the one on this server does");
    await app.close();

    app = await openApp(scriptedModel(), data);
    assert.equal(app.sessionMeta(there)?.sharedWith, undefined);
    assert.deepEqual(app.sessionMeta(here)?.sharedWith, [kim.id]);
    assert.deepEqual(app.config.leaving(laptop.id), []);
    assert.equal(sees(kim, here), true);
});
