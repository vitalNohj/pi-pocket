// Manage runners: the owner lets a user manage runners (`access.ts` `managesRunners`). Such a user is in charge wherever
// the owner is: on this server, and on the runners the owner linked (`inCharge`). On a runner someone else linked they
// only list it, to unlink it. The one a computer's sessions and tasks go to stays the owner (`inChargeOf`). Once they
// no longer manage runners (taken back, made a viewer, their authenticator removed), what they had by that alone is
// handed over, also when a restart cuts it short (`config.ts` `#oweManaged`, `app.ts` `settle`). A real App.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    linkAuthenticator,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import { THIS_SERVER } from "../src/server/access.ts";
import type { StoredRunner, User } from "../src/server/config.ts";
import { HooksDoc } from "../src/server/docs.ts";
import type { FolderRequestView } from "../src/server/folder-requests.ts";
import { createHandler } from "../src/server/http.ts";
import { STEP_MS, totp } from "../src/server/totp.ts";

const data = join(root, "manage-runners-data");
let app: App;
let server: Server | undefined;
let address: string;
const tokens = new Map<string, string>();
/** A runner the owner linked, and one someone else did. */
let owners: StoredRunner;
let lins: StoredRunner;
let lin: User;

/** A folder of its own under the test's folder, as its real path. */
function folder(name: string): string {
    mkdirSync(join(root, name), { recursive: true });

    return realpathSync(join(root, name));
}

const first = folder("manage-runners-first");
const second = folder("manage-runners-second");

function person(name: string, role: User["role"]): User {
    const { user, token } = app.config.addUser(name, role);

    tokens.set(user.id, token);

    return user;
}

async function call<T = { error?: string }>(
    user: User,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/${path}`, {
        method,
        signal: AbortSignal.timeout(20_000),
        headers: {
            authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = text;
    }

    return { status: response.status, body: parsed as T };
}

/** A request that must be refused with `status` and words like `said`. */
async function refused(
    user: User,
    path: string,
    body: unknown,
    status: number,
    said: RegExp,
    method?: string,
): Promise<void> {
    const answer = await call(user, path, body, method);

    assert.equal(answer.status, status, `${user.name} ${path}`);
    assert.match(String(answer.body.error), said, `${user.name} ${path}`);
}

/** A request that must work. */
async function done<T = unknown>(
    user: User,
    path: string,
    body?: unknown,
    method?: string,
): Promise<T> {
    const answer = await call<T>(user, path, body, method);

    assert.equal(answer.status, 200, `${user.name} ${path}: ${JSON.stringify(answer.body)}`);

    return answer.body;
}

/** The record of `user` as it is kept now. */
const kept = (user: User): User => app.config.userById(user.id)!;

/** A user who manages runners, made so by the owner over the route People uses. */
async function manager(name: string): Promise<User> {
    const user = person(name, "guest");

    await done(owner(app), `users/${user.id}/rights`, { right: "managesRunners", on: true });

    return user;
}

/** A session `starter` starts in `cwd`. */
async function sessionIn(cwd: string, starter: User): Promise<ConversationId> {
    return (await app.commands.createSession(kept(starter), { cwd })).id;
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

const nothingOwed = (): void => {
    for (const id of [undefined, owners.id, lins.id]) {
        assert.deepEqual(owed(id), [], `nothing owed on ${id ?? "this server"}`);
    }
};

async function listen(): Promise<void> {
    const made = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    server = made;
    await new Promise<void>((resolve) => made.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${String((made.address() as AddressInfo).port)}`;
}

async function hangUp(): Promise<void> {
    const open = server;

    server = undefined;
    open?.closeAllConnections();
    await new Promise<void>((resolve) =>
        open === undefined ? resolve() : open.close(() => resolve()),
    );
}

before(async () => {
    app = await openApp(scriptedModel(), data);
    await listen();
    lin = person("Lin", "guest");
    owners = app.config.addRunner("Owner's laptop", owner(app).id, newIdentity().publicKey);
    lins = app.config.addRunner("Lin's laptop", lin.id, newIdentity().publicKey);
});

after(async () => {
    await hangUp();
    await app?.close();
    cleanUp();
});

test("who manages runners is in charge of this server and the owner's runners, and of no runner someone else linked", async () => {
    const mona = await manager("Mona");
    const gil = person("Gil", "guest");
    const charge =
        /Only the owner, or someone who manages runners, can change this server's settings/;
    const theirs = /Only whoever is in charge of this computer can change its settings/;
    const manages = /Only someone who manages runners can do that/;

    assert.equal(app.policy.managesRunners(mona), true);
    assert.equal(app.policy.managesRunners(gil), false);

    for (const [id, hers] of [
        [THIS_SERVER, true],
        [owners.id, true],
        [lins.id, false],
    ] as const) {
        assert.equal(app.policy.inCharge(mona, id), hers, id);
        assert.equal(app.policy.mayManage(mona, id), hers, id);
        assert.equal(app.policy.mayUseFolder(mona, id, "/srv/anything"), hers, id);
        assert.equal(app.policy.inCharge(gil, id), false, id);
        // The owner's own charge is as it was, and so is a linker's.
        assert.equal(app.policy.inCharge(owner(app), id), id !== lins.id, id);
        assert.equal(app.policy.inCharge(lin, id), id === lins.id, id);
    }

    // This server's record, its people, and its settings: hers as they are the owner's.
    type Told = { inCharge?: boolean; managers?: string[] };

    assert.equal((await done<Told>(mona, "runners/this-server")).inCharge, true);
    // The view names who is in charge there by managing runners, for their row under it: not the owner, nor a linker.
    assert.deepEqual((await done<Told>(owner(app), "runners/this-server")).managers, [mona.id]);
    await refused(gil, "runners/this-server", undefined, 403, charge);
    await done(mona, "runners/this-server/users", { person: gil.id, on: true });
    assert.deepEqual(app.config.server.users, [gil.id]);
    await refused(gil, "runners/this-server/users", { person: lin.id, on: true }, 403, charge);

    // The runners: the owner's with its people, as its linker reads it; Lin's only as something to unlink.
    type Row = { id: string; inCharge?: boolean; users?: unknown[]; managers?: string[] };
    const rows = await done<Row[]>(mona, "runners");
    const row = (id: string) => rows.find((each) => each.id === id);

    assert.equal(row(owners.id)?.inCharge, true);
    assert.deepEqual(row(owners.id)?.users, []);
    assert.deepEqual(row(owners.id)?.managers, [mona.id]);
    assert.equal(row(lins.id)?.inCharge, false);
    assert.equal(row(lins.id)?.users, undefined, "nothing of its people");
    assert.equal(row(lins.id)?.managers, undefined, "nor of who else is in charge of it");
    assert.deepEqual(
        (await done<Row[]>(lin, "runners")).find((each) => each.id === lins.id)?.managers,
        [],
        "nobody is in charge of a runner someone else linked by managing runners",
    );
    assert.deepEqual(
        await done<Row[]>(gil, "runners"),
        [],
        "a user who is chosen nowhere lists none",
    );
    await done(mona, `runners/${owners.id}/users`, { person: gil.id, on: true });
    await refused(mona, `runners/${lins.id}/users`, { person: gil.id, on: true }, 403, theirs);
    await refused(gil, `runners/${owners.id}/users`, { person: lin.id, on: true }, 403, theirs);

    // What guards linking is theirs to see and lift.
    await done(mona, "runners/locks");
    await refused(gil, "runners/locks", undefined, 403, manages);
    await refused(mona, "runners/bans?address=192.0.2.1", undefined, 404, /not banned/, "DELETE");
    await refused(gil, "runners/bans?address=192.0.2.1", undefined, 403, manages, "DELETE");

    // They unlink any runner, as the owner does; a user unlinks none but their own.
    const spare = app.config.addRunner("Spare", lin.id, newIdentity().publicKey);

    await refused(gil, `runners/${spare.id}`, undefined, 403, /can remove it/, "DELETE");
    await done(mona, `runners/${spare.id}`, undefined, "DELETE");
    assert.equal(app.config.runnerById(spare.id), undefined);
    await refused(mona, "runners/this-server", undefined, 400, /cannot be removed/, "DELETE");

    // A hello says it, with this server's record; and the app offers Runners by it.
    const hello = await app.hello(kept(mona));

    assert.equal(hello.user.rights.managesRunners, true);
    assert.equal(hello.thisServer?.inCharge, true);
    assert.equal((await app.hello(kept(gil))).user.rights.managesRunners, false);
    assert.equal((await app.hello(kept(gil))).thisServer, undefined);

    // Who a computer's sessions and tasks go to, and who hears what it asks, stays one person: the owner.
    const session = await sessionIn(first, owner(app));

    assert.equal(app.policy.inChargeOf(String(session)), owner(app).id);

    // In charge only as one who manages runners, they are chosen as anyone is; the owner is not.
    await done(owner(app), "runners/this-server/users", { person: mona.id, on: true });
    assert.equal(app.config.server.users?.includes(mona.id), true);
    await refused(
        mona,
        "runners/this-server/users",
        { person: owner(app).id, on: true },
        400,
        /in charge of it, and has it anyway/,
    );
});

test("who manages runners works in any folder, has every session there, and answers what the owner answers", async () => {
    const mona = await manager("Mona 2");
    const gil = person("Gil 2", "guest");
    const theirs = await sessionIn(first, owner(app));

    // Chosen for nothing and given no folder: any folder is theirs, with no approval.
    const hers = await sessionIn(second, mona);

    assert.equal(starterOf(hers), mona.id);
    await assert.rejects(app.commands.createSession(kept(gil), { cwd: second }), { status: 403 });

    // Every session here, whoever started it: to see, to prompt without a renewal, and to share.
    assert.equal(app.canSee(kept(mona), theirs), true);
    assert.equal(app.policy.steer(mona, String(theirs)), "allow");
    assert.equal(app.policy.mayShare(mona, String(theirs)), true);
    assert.equal(app.canSee(kept(gil), theirs), false);
    assert.equal(
        (
            app.sessions(kept(mona)).find((each) => String(each.id) === String(theirs)) as
                { inCharge?: boolean } | undefined
        )?.inCharge,
        true,
    );

    // A user's new folder waits for an approval: theirs to allow from the app, as the owner does.
    await app.choosePerson(THIS_SERVER, gil.id, true);
    await app.giveFolders(owner(app), THIS_SERVER, gil.id, [first]);

    const starting = app.commands.createSession(kept(gil), { cwd: first });
    let request: FolderRequestView | undefined;

    await until(() => {
        request = app.folderRequests
            .list(kept(mona))
            .find((each) => each.person === gil.id && each.folder === first);

        return request !== undefined;
    }, "Gil's request, in her list");
    await done(mona, `folder-requests/${request!.id}`, { approve: true });
    assert.equal(starterOf((await starting).id), gil.id);
});

test("managing runners taken back: what they had by it alone is handed over before the answer, and the rest stays", async () => {
    const mona = await manager("Mona 3");

    await app.choosePerson(THIS_SERVER, mona.id, true);
    await app.giveFolders(owner(app), THIS_SERVER, mona.id, [first]);

    const theirs = await sessionIn(second, owner(app));
    const inside = await sessionIn(first, mona);
    const outside = await sessionIn(second, mona);

    await hookOf("mona-inside", mona, inside);
    await hookOf("mona-outside", mona, outside);
    await hookOf("mona-theirs", mona, theirs);

    const tab = fakeTab(theirs, kept(mona));

    await app.attach(tab.client);

    try {
        await done(owner(app), `users/${mona.id}/rights`, { right: "managesRunners", on: false });

        assert.equal(app.policy.inCharge(mona, THIS_SERVER), false);
        assert.equal(app.policy.inCharge(mona, owners.id), false);
        // Her session in a folder that is not given to her, and her task on it, are the owner's.
        assert.equal(starterOf(outside), owner(app).id);
        assert.equal(await hookBy("mona-outside"), owner(app).id);
        assert.equal(app.canSee(kept(mona), outside), false);
        // The one in the folder given to her stays hers, with her task.
        assert.equal(starterOf(inside), mona.id);
        assert.equal(await hookBy("mona-inside"), mona.id);
        assert.equal(app.policy.maySteer(mona, String(inside)), true);
        // A session she had only as one in charge: she left it, and her task on it moved on.
        assert.equal(app.canSee(kept(mona), theirs), false);
        assert.equal(await hookBy("mona-theirs"), owner(app).id);
        assert.match(String(tab.last("missing")?.message), /no longer shared with you/);
        nothingOwed();

        // And none of what the owner's are: this server's record, another's folder request, what guards linking.
        await refused(mona, "runners/this-server", undefined, 403, /manages runners/);
        await refused(mona, "runners/locks", undefined, 403, /manages runners/);
        assert.equal((await app.hello(kept(mona))).user.rights.managesRunners, false);
        assert.equal((await app.hello(kept(mona))).thisServer, undefined);
        await assert.rejects(app.commands.createSession(kept(mona), { cwd: second }), {
            status: 403,
        });
    } finally {
        app.detach(tab.client);
    }
});

test("made a viewer, or with their authenticator removed, they manage runners no longer: their sessions are handed over", async () => {
    const vic = await manager("Vic");
    const hers = await sessionIn(second, vic);

    await hookOf("vic-hers", vic, hers);
    await done(owner(app), `users/${vic.id}`, { role: "viewer" });
    assert.equal(kept(vic).role, "viewer");
    assert.equal(kept(vic).rights, undefined, "it lapses");
    assert.equal(app.policy.inCharge(vic, THIS_SERVER), false);
    assert.equal(starterOf(hers), owner(app).id);
    assert.equal(await hookBy("vic-hers"), owner(app).id);
    nothingOwed();

    // A lost phone: paused, they are a viewer; the right waits for them, and what they had by it does not.
    const nora = await manager("Nora");
    const noras = await sessionIn(second, nora);

    linkAuthenticator(app, nora);
    await done(owner(app), `users/${nora.id}/authenticator`, undefined, "DELETE");
    assert.equal(kept(nora).role, "viewer");
    assert.deepEqual(kept(nora).paused, { rights: ["managesRunners"] });
    assert.equal(app.policy.inCharge(nora, THIS_SERVER), false);
    assert.equal(starterOf(noras), owner(app).id);
    nothingOwed();

    const { secret } = app.authenticators.begin(nora.id, nora.name);

    app.confirmAuthenticator(kept(nora), totp(secret, Math.floor(app.now() / STEP_MS)));
    assert.equal(kept(nora).role, "guest");
    assert.equal(app.policy.inCharge(nora, THIS_SERVER), true, "in charge again");
    assert.equal(starterOf(noras), owner(app).id, "what was handed over stays so");
    nothingOwed();
});

test("the hand-over is owed in the save that ends it, on each computer they were in charge of, and a restart finishes it", async () => {
    const pia = await manager("Pia");
    const hers = await sessionIn(second, pia);

    await hookOf("pia-hers", pia, hers);
    nothingOwed();

    // The settings are saved, and the server stops before anything else is.
    app.config.setPersonRight(pia.id, "managesRunners", false);
    assert.deepEqual(owed(), [pia.id], "on this server");
    assert.deepEqual(owed(owners.id), [pia.id], "on the runner the owner linked");
    assert.deepEqual(owed(lins.id), [], "not on a runner someone else linked");
    assert.equal(starterOf(hers), pia.id, "nothing is handed over yet");
    assert.equal(app.canSee(kept(pia), hers), false, "though it is no longer hers to use");

    await hangUp();
    await app.close();
    app = await openApp(scriptedModel(), data);

    assert.equal(starterOf(hers), owner(app).id);
    assert.equal(await hookBy("pia-hers"), owner(app).id);
    nothingOwed();

    // Giving it, and a change that leaves it as it is, owe nothing.
    app.config.setPersonRight(pia.id, "managesRunners", true);
    app.config.updateUser(pia.id, { name: "Pia P." });
    nothingOwed();
    app.config.setPersonRight(pia.id, "managesRunners", false);
    assert.deepEqual(owed(), [pia.id]);
    await app.settle();
    nothingOwed();
});
