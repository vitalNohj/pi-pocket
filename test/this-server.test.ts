// "This server" in the Runners sheet: the server as a computer (`access.ts` `THIS_SERVER`), with the owner as its
// linker. The owner chooses its people, its rules, and its saved folders over the same routes as a runner's; it cannot be
// removed, and nobody else learns of its people or folders, also not from live updates.
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import {
    type App,
    cleanUp,
    context,
    fakeTab,
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
import { THIS_SERVER } from "../src/server/access.ts";
import type { ServerView } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();
let alex: User;
let vera: User;
let sam: User;
let runnerId: string;
const project = join(root, "project");

function person(name: string, role: User["role"], sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

async function call<T = Record<string, unknown>>(
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

before(async () => {
    app = await openApp(scriptedModel());
    alex = person("Alex", "guest");
    vera = person("Vera", "viewer");
    sam = person("Sam", "guest", ["1"]);
    runnerId = app.config.addRunner("Laptop", owner(app).id, newIdentity().publicKey).id;
    mkdirSync(project, { recursive: true });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await app?.close();
    cleanUp();
});

test("the owner sees this server as a computer they linked, with nobody chosen and nothing given", async () => {
    const shown = await call<ServerView>(owner(app), `runners/${THIS_SERVER}`);

    assert.equal(shown.status, 200);
    assert.deepEqual(shown.body, {
        id: THIS_SERVER,
        name: "This server",
        createdBy: owner(app).id,
        users: [],
        given: {},
        sees: {},
        seesUntil: {},
        rights: { wheel: [], allows: [], reshares: [] },
        inCharge: true,
        managers: [],
    });
    assert.deepEqual((await app.hello(owner(app))).thisServer, shown.body);
});

test("nobody else learns of its people or folders", async () => {
    for (const each of [alex, vera, sam]) {
        assert.equal((await call(each, `runners/${THIS_SERVER}`)).status, 403);
        assert.equal("thisServer" in (await app.hello(each)), false);
    }
});

test("it cannot be removed", async () => {
    const refused = await call<{ error: string }>(
        owner(app),
        `runners/${THIS_SERVER}`,
        undefined,
        "DELETE",
    );

    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /cannot be removed/);
});

test("the owner chooses its people: a chosen guest may start here, a viewer may only see", async () => {
    assert.equal(app.policy.mayStart(alex, THIS_SERVER), false, "not chosen yet");

    const chosen = await call<ServerView>(owner(app), `runners/${THIS_SERVER}/users`, {
        users: [alex.id, vera.id, sam.id, owner(app).id, "nobody"],
    });

    assert.equal(chosen.status, 200);
    // Never the owner, someone removed, or a person invited to one session.
    assert.deepEqual(chosen.body.users, [
        { id: alex.id, name: "Alex", role: "guest" },
        { id: vera.id, name: "Vera", role: "viewer" },
    ]);
    assert.equal(app.policy.mayStart(alex, THIS_SERVER), true);
    assert.equal(app.policy.mayUse(vera, THIS_SERVER), true);
    assert.equal(app.policy.mayStart(vera, THIS_SERVER), false);
    assert.equal(app.policy.mayUse(sam, THIS_SERVER), false);
});

test("a chosen guest cannot choose people or change its rules", async () => {
    assert.equal(
        (await call(alex, `runners/${THIS_SERVER}/users`, { users: [alex.id] })).status,
        403,
    );
    assert.equal((await call(alex, `runners/${THIS_SERVER}/settings`, {})).status, 403);
    assert.equal(
        (
            await call(alex, `runners/${THIS_SERVER}/given`, {
                person: alex.id,
                folders: [project],
            })
        ).status,
        403,
    );
});

test("computer settings no longer set or show the old sharing switch", async () => {
    const settings = { network: false, downloads: "/tmp", shareNew: true };
    const saved = await call(owner(app), `runners/${runnerId}/settings`, settings);

    assert.equal(saved.status, 200);
    assert.equal("shareNew" in saved.body, false);
    assert.equal("shareNew" in app.config.runnerById(runnerId)!, false);
    assert.equal(app.config.runnerById(runnerId)?.settings?.network, false);
    assert.equal(app.config.runnerById(runnerId)?.settings?.downloads, "/tmp");

    const here = await call(owner(app), `runners/${THIS_SERVER}/settings`, settings);

    assert.equal(here.status, 200);
    assert.equal("shareNew" in here.body, false);
    assert.equal("shareNew" in app.config.server, false);
    assert.equal("network" in here.body, false);
    assert.equal("downloads" in here.body, false);
    assert.equal((await call(owner(app), "runners/nobody/settings", settings)).status, 404);
});

test("the owner gives a chosen person folders; only those and the folders in them may be used", async () => {
    const real = realpathSync(project);

    assert.equal(app.policy.folder(alex, THIS_SERVER, real).kind, "refuse", "nothing given yet");

    const given = await call<ServerView>(owner(app), `runners/${THIS_SERVER}/given`, {
        person: alex.id,
        folders: [project],
    });

    assert.equal(given.status, 200);
    assert.deepEqual(given.body.given[alex.id], [real]);
    assert.equal(app.policy.folder(alex, THIS_SERVER, join(real, "inner")).kind, "ask");
    assert.equal(app.policy.folder(alex, THIS_SERVER, root).kind, "refuse");

    const taken = await call<ServerView>(owner(app), `runners/${THIS_SERVER}/given`, {
        person: alex.id,
        folders: [],
    });

    assert.deepEqual(taken.body.given[alex.id], []);
    assert.equal(app.policy.folder(alex, THIS_SERVER, real).kind, "refuse");
});

test("a change reaches the owner's tabs live, and never anyone else's", async () => {
    const ownerTab = fakeTab(undefined, owner(app));
    const alexTab = fakeTab(undefined, alex);

    await app.attach(ownerTab.client);
    await app.attach(alexTab.client);

    try {
        await call(owner(app), `runners/${THIS_SERVER}/users`, { users: [alex.id] });
        await until(
            () => (ownerTab.last("this-server") as ServerView | undefined)?.users.length === 1,
            "the owner's tab hears of the change",
        );
        assert.deepEqual((ownerTab.last("this-server") as ServerView).users, [
            { id: alex.id, name: "Alex", role: "guest" },
        ]);
        assert.equal(
            alexTab.events.some((each) => each.event === "this-server"),
            false,
        );
    } finally {
        app.detach(ownerTab.client);
        app.detach(alexTab.client);
    }
});

test("one person is chosen, or no longer, and the others stay as they are", async () => {
    // What the People sheet's switch sends: the list as it is now, with that one change.
    const added = await call<ServerView>(owner(app), `runners/${THIS_SERVER}/users`, {
        person: vera.id,
        on: true,
    });

    assert.equal(added.status, 200);
    assert.deepEqual(
        added.body.users.map((each) => each.name),
        ["Alex", "Vera"],
        "Alex, chosen before, stays",
    );

    // Chosen twice is chosen once.
    await call(owner(app), `runners/${THIS_SERVER}/users`, { person: vera.id, on: true });
    assert.deepEqual(app.config.server.users, [alex.id, vera.id]);

    const removed = await call<ServerView>(owner(app), `runners/${THIS_SERVER}/users`, {
        person: vera.id,
        on: false,
    });

    assert.deepEqual(
        removed.body.users.map((each) => each.name),
        ["Alex"],
    );
    assert.equal(app.policy.mayUse(vera, THIS_SERVER), false);
    assert.equal(app.policy.mayStart(alex, THIS_SERVER), true);

    // The same list as a runner's: the same route, the same answer.
    const there = await call<{ users: { name: string }[] }>(
        owner(app),
        `runners/${runnerId}/users`,
        { person: alex.id, on: true },
    );

    assert.deepEqual(
        there.body.users.map((each) => each.name),
        ["Alex"],
    );
    await call(owner(app), `runners/${runnerId}/users`, { person: alex.id, on: false });
    assert.deepEqual(app.config.runnerById(runnerId)?.users, []);
});

test("choosing one person says why it cannot be done, and is the owner's alone", async () => {
    const one = await call<{ error: string }>(owner(app), `runners/${THIS_SERVER}/users`, {
        person: sam.id,
        on: true,
    });

    assert.equal(one.status, 400);
    assert.match(one.body.error, /invited to one session only/);

    const self = await call<{ error: string }>(owner(app), `runners/${THIS_SERVER}/users`, {
        person: owner(app).id,
        on: true,
    });

    assert.equal(self.status, 400);
    assert.match(self.body.error, /in charge of it/);
    assert.equal(
        (await call(owner(app), `runners/${THIS_SERVER}/users`, { person: "nobody", on: true }))
            .status,
        404,
    );
    assert.equal(
        (await call(owner(app), `runners/${THIS_SERVER}/users`, { person: vera.id })).status,
        400,
        "on is needed",
    );
    // Someone chosen for it is not in charge of it.
    assert.equal(
        (await call(alex, `runners/${THIS_SERVER}/users`, { person: vera.id, on: true })).status,
        403,
    );
    assert.deepEqual(app.config.server.users, [alex.id]);
});

test("someone no longer chosen leaves at once", async () => {
    assert.equal(app.policy.mayStart(alex, THIS_SERVER), true);
    await call(owner(app), `runners/${THIS_SERVER}/users`, { users: [] });
    assert.equal(app.policy.mayUse(alex, THIS_SERVER), false);
    assert.equal(app.policy.mayUse(vera, THIS_SERVER), false);
});

test("no longer chosen, a person loses the sessions shared with them there, also when chosen again", async () => {
    await call(owner(app), `runners/${THIS_SERVER}/users`, { users: [alex.id, vera.id] });

    const { id } = await app.commands.createSession(owner(app), { cwd: project });

    await app.commands.shareSession(id, owner(app), [alex.id, vera.id]);
    assert.equal(app.canSee(alex, id), true, "shared with a chosen person");

    // Alex is unchosen; Vera stays.
    await call(owner(app), `runners/${THIS_SERVER}/users`, { users: [vera.id] });
    assert.equal(app.canSee(alex, id), false, "the share ended with the choice");
    assert.deepEqual(app.sessionMeta(id)?.sharedWith, [vera.id], "the others keep theirs");
    assert.equal(app.canSee(vera, id), true);

    // Chosen again: only what is shared with them anew.
    await call(owner(app), `runners/${THIS_SERVER}/users`, { users: [alex.id, vera.id] });
    assert.equal(app.canSee(alex, id), false, "the old share does not come back");
});

test("an invite to every session passes on only the sessions its maker started", async () => {
    // Gina linked her own computer and chose Alex there; a session of hers is shared with everyone chosen on it.
    const gina = person("Gina", "guest");
    const ginas = app.config.addRunner("Gina's laptop", gina.id, newIdentity().publicKey).id;

    app.config.setUsers(ginas, [alex.id]);
    await call(owner(app), `runners/${THIS_SERVER}/users`, { users: [alex.id, vera.id] });

    const { id: local } = await app.commands.createSession(owner(app), { cwd: project });
    const { id: hers } = await app.commands.createSession(owner(app), { cwd: project });

    await app.commands.shareSession(local, owner(app), [alex.id, vera.id]);
    // Moved to Gina's computer, hers and shared with Alex: everyone chosen there.
    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(hers)]!;

        meta.runner = ginas;
        meta.createdBy = gina.id;
        meta.sharedWith = [alex.id];
    }, context);
    assert.equal(app.canSee(owner(app), hers), false, "the owner sees nothing on Gina's computer");

    // A session Alex started on this server, which everyone chosen here has: the owner sees it, and did not start it.
    const { id: alexs } = await app.commands.createSession(owner(app), { cwd: project });

    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(alexs)]!;

        meta.createdBy = alex.id;
        meta.sharedWith = [vera.id];
    }, context);
    assert.equal(app.canSee(owner(app), alexs), true);

    // The owner's invite: the session the owner started, never Alex's, never Gina's.
    const fromOwner = person("Olive", "viewer");

    await app.welcome(fromOwner.id, owner(app).id);
    assert.equal(app.canSee(fromOwner, local), true, "the inviter's own session");
    assert.equal(app.canSee(fromOwner, alexs), false, "not a session someone else started");
    assert.equal(app.canSee(fromOwner, hers), false, "not a session the inviter may not see");

    // The owner is in charge of this server, so who joins is chosen for it: its switch says what they have. They are
    // chosen for no computer on which nothing became theirs.
    const chosenFor = (computer: string, who: User) =>
        (computer === THIS_SERVER
            ? app.config.server.users
            : app.config.runnerById(computer)?.users
        )?.includes(who.id) === true;

    assert.equal(chosenFor(THIS_SERVER, fromOwner), true, "chosen where sessions became theirs");
    assert.equal(chosenFor(runnerId, fromOwner), false, "not where none did");
    assert.equal(chosenFor(ginas, fromOwner), false);

    // Alex's invite: Alex's own session. Not Gina's, which is shared with Alex and is not Alex's to share, and not
    // the owner's, shared with Alex too.
    const fromAlex = person("Abe", "viewer");

    await app.welcome(fromAlex.id, alex.id);
    assert.equal(app.canSee(fromAlex, alexs), true, "the inviter's own session");
    assert.equal(app.canSee(fromAlex, hers), false, "not a session shared with the inviter");
    assert.equal(app.canSee(fromAlex, local), false, "nor the owner's");
    // Alex is in charge of neither computer: the sessions are shared, and the choice stays with who is.
    assert.equal(chosenFor(ginas, fromAlex), false, "not chosen by someone not in charge");
    assert.equal(chosenFor(THIS_SERVER, fromAlex), false);

    // The switch of who was chosen by the invite takes the sessions back, as any switch does.
    await call(owner(app), `runners/${THIS_SERVER}/users`, { person: fromOwner.id, on: false });
    assert.equal(chosenFor(THIS_SERVER, fromOwner), false);
    assert.equal(app.canSee(fromOwner, local), false, "off: the shared session is taken back");
});

test("an invite to a folder passes on only its maker's sessions in that folder, on that computer", async () => {
    const other = join(root, "other-project");

    mkdirSync(other, { recursive: true });

    const { id: inside } = await app.commands.createSession(owner(app), { cwd: project });
    const { id: outside } = await app.commands.createSession(owner(app), { cwd: other });
    const { id: alexs } = await app.commands.createSession(owner(app), { cwd: project });

    // In the same folder, but Alex's.
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(alexs)]!.createdBy = alex.id;
    }, context);

    const folder = app.folderOf(inside)!;

    assert.deepEqual(folder, { computer: THIS_SERVER, path: app.cwdOf(inside) });

    const fay = person("Fay", "viewer");

    await app.welcome(fay.id, owner(app).id, folder);
    assert.equal(app.canSee(fay, inside), true, "the inviter's session in the folder");
    assert.equal(app.canSee(fay, outside), false, "not the inviter's session in another folder");
    assert.equal(app.canSee(fay, alexs), false, "not someone else's session in the folder");
    assert.equal(
        app.config.server.users?.includes(fay.id),
        true,
        "chosen for the folder's computer, which the inviter is in charge of",
    );

    // The same path on another computer is another folder.
    const finn = person("Finn", "viewer");

    await app.welcome(finn.id, owner(app).id, { computer: runnerId, path: folder.path });
    assert.equal(app.canSee(finn, inside), false);
    // Nothing became theirs: chosen nowhere.
    assert.equal(app.config.runnerById(runnerId)?.users?.includes(finn.id) ?? false, false);
    assert.equal(app.config.server.users?.includes(finn.id) ?? false, false);
});

test("the owner limits the spend of a session they may see, and learns nothing of one they may not", async () => {
    const gina = person("Gina spends", "guest");
    const ginas = app.config.addRunner("Gina's desktop", gina.id, newIdentity().publicKey).id;
    const { id: mine } = await app.commands.createSession(owner(app), { cwd: project });
    const { id: hers } = await app.commands.createSession(owner(app), { cwd: project });

    // Moved to Gina's computer and hers: the owner is not in charge there, and sees nothing of it.
    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(hers)]!;

        meta.runner = ginas;
        meta.createdBy = gina.id;
    }, context);
    assert.equal(app.canSee(owner(app), hers), false);

    const allowed = await call(owner(app), "spend", { session: Number(mine), budget: 5 });

    assert.equal(allowed.status, 200);
    assert.equal(app.sessionMeta(mine)?.budget, 5);

    // The same answer as for an id no session has: the id says nothing, and no limit is set.
    const refused = await call(owner(app), "spend", { session: Number(hers), budget: 5 });
    const missing = await call(owner(app), "spend", { session: 987_654, budget: 5 });

    assert.equal(refused.status, 404);
    assert.deepEqual(refused.body, missing.body);
    assert.equal(missing.status, 404);
    assert.equal(app.sessionMeta(hers)?.budget, undefined);
    // Nobody else sets one at all.
    assert.equal((await call(alex, "spend", { session: Number(mine), budget: 1 })).status, 403);
});

test("the owner limits a person to sessions the owner may share, never to one on a computer they see nothing of", async () => {
    const gina = person("Gina limits", "guest");
    const ginas = app.config.addRunner("Gina's tablet", gina.id, newIdentity().publicKey).id;
    const pat = person("Pat", "viewer");
    const { id: mine } = await app.commands.createSession(owner(app), { cwd: project });
    const { id: hers } = await app.commands.createSession(owner(app), { cwd: project });
    const limited = () => app.config.userById(pat.id)?.sessions;

    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(hers)]!;

        meta.runner = ginas;
        meta.createdBy = gina.id;
    }, context);
    assert.equal(app.canSee(owner(app), hers), false);

    // Allowed: a session of this server, which the owner is in charge of.
    const allowed = await call(owner(app), `users/${pat.id}`, { sessions: [Number(mine)] });

    assert.equal(allowed.status, 200);
    assert.deepEqual(limited(), [String(mine)]);
    assert.equal(app.canSee(pat, mine), true);

    // Refused: Gina's session, with the answer an id of no session gets. Pat keeps what they had, and sees nothing more.
    const refused = await call(owner(app), `users/${pat.id}`, {
        sessions: [Number(mine), Number(hers)],
    });
    const missing = await call(owner(app), `users/${pat.id}`, { sessions: [987_654] });

    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, missing.body);
    assert.deepEqual(limited(), [String(mine)]);
    assert.equal(app.canSee(pat, hers), false);

    // A session they have already stays theirs through a change (Gina invited them to hers).
    app.config.updateUser(pat.id, { sessions: [String(hers)] });
    assert.equal(
        (await call(owner(app), `users/${pat.id}`, { sessions: [Number(hers), Number(mine)] }))
            .status,
        200,
    );
    assert.deepEqual(limited(), [String(hers), String(mine)]);
});

test("the people list names a limited person's sessions only to those who may see them", async () => {
    const gina = person("Gina lists", "guest");
    const ginas = app.config.addRunner("Gina's phone", gina.id, newIdentity().publicKey).id;
    const { id: mine } = await app.commands.createSession(owner(app), { cwd: project });
    const { id: hers } = await app.commands.createSession(owner(app), { cwd: project });

    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(hers)]!;

        meta.runner = ginas;
        meta.createdBy = gina.id;
    }, context);
    const quinn = person("Quinn", "viewer", [String(hers), String(mine)]);
    const listed = (viewer: User) =>
        app.people(viewer).find((each) => each.id === quinn.id)?.sessions;

    // The owner sees their own session there, and nothing of Gina's computer: not even that session's id.
    assert.deepEqual(listed(owner(app)), [Number(mine)]);
    // Gina is in charge of her computer; the owner's session is not shared with her.
    assert.deepEqual(listed(gina), [Number(hers)]);
    // Someone who sees neither still learns that Quinn is limited.
    assert.deepEqual(listed(person("Rae", "guest")), []);
});

test("a copy tells where it was forked from only to those who may see that session", async () => {
    const { id: source } = await app.commands.createSession(owner(app), { cwd: project });
    const { id: copy } = await app.commands.createSession(owner(app), { cwd: project });

    await call(owner(app), `runners/${THIS_SERVER}/users`, { users: [alex.id, vera.id] });
    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(copy)]!.forkedFrom = {
            id: Number(source),
            entryId: 3,
        };
    }, context);
    await app.commands.shareSession(copy, owner(app), [alex.id]);
    assert.equal(app.canSee(alex, source), false);

    const mineTab = fakeTab(copy, owner(app));
    const alexTab = fakeTab(copy, alex);

    await app.attach(mineTab.client);
    await app.attach(alexTab.client);

    try {
        await until(
            () => mineTab.last("view") !== undefined && alexTab.last("view") !== undefined,
            "both tabs get the session",
        );
        assert.deepEqual(
            (mineTab.last("view")?.conversation as { forkedFrom?: unknown }).forkedFrom,
            { id: Number(source), entryId: 3 },
        );
        // Alex learns that it is a copy, and not of which session.
        assert.deepEqual(
            (alexTab.last("view")?.conversation as { forkedFrom?: unknown }).forkedFrom,
            {},
        );
    } finally {
        app.detach(mineTab.client);
        app.detach(alexTab.client);
    }
});

test("a tab whose person can no longer see a session gets none of its live events, before it is moved out", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: project });

    app.config.setUsers(THIS_SERVER, [alex.id, vera.id]);
    await app.commands.shareSession(id, owner(app), [alex.id]);

    const alexTab = fakeTab(id, alex);
    const accessChanged = app.accessChanged;

    await app.attach(alexTab.client);

    try {
        const room = await app.room(id);
        const attached = alexTab.events.length;

        await app.collab.postChat(id, owner(app), { text: "before", requestId: "c1" });
        await until(
            () => alexTab.events.slice(attached).some((each) => each.event === "chat"),
            "the shared tab hears the live chat",
        );

        // End the share but hold back eviction: the room must check for itself.
        app.accessChanged = () => {};

        await app.harness.commit(async (tx) => {
            delete (await tx.doc(SessionsDoc)).items[String(id)]!.sharedWith;
        }, context);
        assert.equal(app.canSee(alex, id), false);
        assert.equal(alexTab.client.conversationId, id);

        const heard = alexTab.events.length;

        await app.collab.postChat(id, owner(app), { text: "secret after", requestId: "c2" });
        await until(
            () => room.chat.some((message) => message.text === "secret after"),
            "the chat reaching the room",
        );
        assert.doesNotMatch(
            JSON.stringify(alexTab.events.slice(heard)),
            /secret after/,
            "nothing of the session reaches them",
        );
    } finally {
        app.accessChanged = accessChanged;
        app.detach(alexTab.client);
    }
});
