// Manage this computer: who can give it, what changes on that computer alone, and what happens when it ends.
import {
    type App,
    cleanUp,
    fakeTab,
    linkAuthenticator,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { THIS_SERVER } from "../src/server/access.ts";
import { ConfigStore, type StoredRunner, type User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import { STEP_MS, totp } from "../src/server/totp.ts";

let app: App;
let server: Server;
let base: string;
let linker: User;
let laptop: StoredRunner;
let desktop: StoredRunner;
const tokens = new Map<string, string>();
const folder = join(root, "manager-only");
const users = (id: string) => `runners/${id}/users`;
const rights = (id: string) => `runners/${id}/rights`;
const manage = (target: User, on = true) => ({ person: target.id, right: "manages", on });
const whoGives = "Only the owner of this computer chooses who manages it.";
const whoUnchooses = "Only the owner of this computer takes a manager off it.";
const whoUsesLimits = "Only the owner, or someone who manages this server, can do this.";

function person(name: string, role: User["role"] = "guest", sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

async function call<T = { error?: string }>(
    by: User,
    path: string,
    status: number,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
): Promise<T> {
    const response = await fetch(`${base}/api/${path}`, {
        method,
        signal: AbortSignal.timeout(20_000),
        headers: {
            authorization: `Bearer ${tokens.get(by.id) ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = (await response.json()) as T;

    assert.equal(
        response.status,
        status,
        `${by.name} ${method} ${path}: ${JSON.stringify(answer)}`,
    );

    return answer;
}

async function manager(name: string, id = THIS_SERVER, by = owner(app)): Promise<User> {
    const user = person(name);

    await app.choosePerson(id, user.id, true);
    await call(by, rights(id), 200, manage(user));

    return user;
}

before(async () => {
    mkdirSync(folder);
    app = await openApp(scriptedModel());
    linker = person("Linker");
    laptop = app.config.addRunner("Laptop", linker.id, newIdentity().publicKey);
    desktop = app.config.addRunner("Desktop", owner(app).id, newIdentity().publicKey);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    server?.closeAllConnections();

    if (server !== undefined) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await app?.close();
    cleanUp();
});

test("1: a manager sees every session and starts in any folder on their computer", async () => {
    const ada = person("Ada");
    const plain = person("Plain");
    const boss = owner(app);
    const path = realpathSync(folder);
    const first = await app.commands.createSession(boss, { cwd: path });
    const second = await app.commands.createSession(boss, { cwd: root });

    await app.choosePerson(THIS_SERVER, ada.id, true);
    await app.choosePerson(THIS_SERVER, plain.id, true);
    const tab = fakeTab(undefined, ada);

    await app.attach(tab.client);

    type Row = { id: number };
    const listed = async (by: User) =>
        (await call<Row[]>(by, "sessions", 200)).map((row) => row.id);

    try {
        const ids = [Number(first.id), Number(second.id)];

        assert.equal(
            (await listed(ada)).some((id) => ids.includes(id)),
            false,
        );
        await call(boss, rights(THIS_SERVER), 200, manage(ada));
        await until(() => {
            const hello = tab.last("hello")?.user as { rights: { manages: string[] } };
            const sessions = tab.last("sessions") as unknown as Row[] | undefined;

            return (
                hello?.rights.manages.includes(THIS_SERVER) &&
                ids.every((id) => sessions?.some((row) => row.id === id))
            );
        }, "the new hello and session list");
        const seen = await listed(ada);

        assert.ok(ids.every((id) => seen.includes(id)));
        assert.equal(
            (await listed(plain)).some((id) => ids.includes(id)),
            false,
        );
        assert.equal(app.policy.steer(ada, String(first.id)), "allow");
        assert.equal((await app.commands.createSession(ada, { cwd: path })).id !== undefined, true);
        await assert.rejects(app.commands.createSession(plain, { cwd: path }), { status: 403 });
    } finally {
        app.detach(tab.client);
    }
});

test("2: a manager gives wheel but cannot give or take manages", async () => {
    const maya = await manager("Maya");
    const other = await manager("Other manager");
    const plain = person("Chosen user");

    await app.choosePerson(THIS_SERVER, plain.id, true);
    const path = rights(THIS_SERVER);
    const wheel = { person: plain.id, right: "wheel", on: true };

    await call(maya, path, 200, wheel);
    assert.equal(app.policy.has(plain, "wheel", THIS_SERVER), true);
    await call(plain, path, 403, { ...wheel, on: false });
    assert.equal((await call(maya, path, 403, manage(plain))).error, whoGives);
    assert.equal((await call(maya, path, 403, manage(other, false))).error, whoGives);
    assert.equal(app.policy.inCharge(other, THIS_SERVER), true);
    assert.equal(app.policy.inCharge(plain, THIS_SERVER), false);
    assert.equal(app.thisServer(maya)?.gives.includes("manages"), false);
    assert.equal(app.thisServer(owner(app))?.gives.includes("manages"), true);
});

test("3: the linker gives manages on the runner, not the Pi Pocket owner", async () => {
    const boss = owner(app);
    const plain = person("Chosen for Laptop");

    await app.choosePerson(laptop.id, plain.id, true);

    assert.equal((await call(boss, rights(laptop.id), 403, manage(plain))).error, whoGives);
    await call(linker, rights(laptop.id), 200, manage(plain));
    assert.equal(app.policy.inCharge(plain, laptop.id), true);
    assert.equal(app.policy.inCharge(boss, laptop.id), false);
    await app.choosePerson(laptop.id, boss.id, true);
    await call(linker, rights(laptop.id), 200, manage(boss));
    assert.equal(app.policy.inCharge(boss, laptop.id), true);
    assert.equal((await call(boss, rights(laptop.id), 403, manage(plain, false))).error, whoGives);
    await call(linker, rights(laptop.id), 200, manage(boss, false));
});

test("4: only a chosen user who is not limited to sessions can be given manages", async () => {
    const boss = owner(app);
    const viewer = person("Viewer", "viewer");
    const unchosen = person("Not chosen");
    const limited = person("Invited to one session", "guest", ["1"]);
    const path = rights(THIS_SERVER);
    const chosen = person("Can manage");

    await app.choosePerson(THIS_SERVER, viewer.id, true);
    await call(boss, path, 400, manage(viewer));
    await call(boss, path, 400, manage(unchosen));
    await call(boss, path, 400, manage(limited));
    await call(boss, path, 400, manage(boss));
    await app.choosePerson(THIS_SERVER, chosen.id, true);
    await call(boss, path, 200, manage(chosen));
});

test("5: managing one runner gives no right on another computer", async () => {
    const user = await manager("Laptop manager", laptop.id, linker);

    assert.deepEqual((await app.hello(user)).user.rights.manages, [laptop.id]);
    assert.equal(app.policy.mayUseFolder(user, laptop.id, "/any-folder"), true);

    for (const id of [desktop.id, THIS_SERVER]) {
        assert.equal(app.policy.inCharge(user, id), false);
        assert.equal(app.policy.has(user, "wheel", id), false);
        assert.equal(app.policy.mayUseFolder(user, id, "/any-folder"), false);
    }
});

test("6: the Pi Pocket owner and the linker can unlink but a manager cannot", async () => {
    const make = () => app.config.addRunner("Spare", linker.id, newIdentity().publicKey);
    const first = make();
    const second = make();
    const user = await manager("Spare manager", first.id, linker);
    const route = `runners/${first.id}`;

    await call(user, route, 403, undefined, "DELETE");
    assert.equal(app.runners.list(user).find((row) => row.id === first.id)?.mayUnlink, undefined);
    assert.equal(app.runners.list(linker).find((row) => row.id === first.id)?.mayUnlink, true);
    assert.equal(app.runners.list(owner(app)).find((row) => row.id === first.id)?.mayUnlink, true);
    await call(linker, route, 200, undefined, "DELETE");
    await call(owner(app), `runners/${second.id}`, 200, undefined, "DELETE");
    assert.equal(app.config.runnerById(first.id), undefined);
    assert.equal(app.config.runnerById(second.id), undefined);
});

test("7: linking limits belong to people in charge of this server", async () => {
    const local = await manager("Local manager");
    const remote = await manager("Remote manager", laptop.id, linker);
    const ban = { address: "192.0.2.1", since: app.now() };
    const path = `runners/bans?address=${ban.address}`;

    app.config.runnerLinkLimits = { blocks: [], bans: [ban] };
    assert.deepEqual((await call<{ bans: unknown[] }>(local, "runners/locks", 200)).bans, [ban]);
    assert.equal((await call(remote, "runners/locks", 403)).error, whoUsesLimits);
    assert.equal((await call(remote, path, 403, undefined, "DELETE")).error, whoUsesLimits);
    await call(local, path, 200, undefined, "DELETE");
    assert.deepEqual(app.config.runnerLinkLimits?.bans, []);
});

test("8: revocation, demotion, limits and pauses owe only their computers a hand-over", async () => {
    const user = await manager("Manager to revoke");

    await app.choosePerson(desktop.id, user.id, true);
    await call(owner(app), rights(desktop.id), 200, manage(user));
    const { id } = await app.commands.createSession(user, { cwd: folder });

    app.config.setComputerRight(THIS_SERVER, user.id, "manages", false);
    assert.equal(app.policy.inCharge(user, THIS_SERVER), false);
    assert.equal(app.policy.inCharge(user, desktop.id), true);
    assert.deepEqual(app.config.handOvers(THIS_SERVER), [user.id]);
    assert.deepEqual(app.config.handOvers(desktop.id), []);
    assert.deepEqual(app.config.handOvers(laptop.id), []);
    await app.settle();
    assert.equal(app.sessionMeta(id)?.createdBy, owner(app).id);

    app.config.giveRole(user.id, "viewer");
    assert.deepEqual(app.config.rightHolders(desktop.id, "manages"), []);
    assert.deepEqual(app.config.handOvers(desktop.id), [user.id]);
    await app.settle();

    const limited = await manager("Manager to limit");

    app.config.updateUser(limited.id, { sessions: [String(id)] });
    assert.equal(app.config.rightHolders(THIS_SERVER, "manages").includes(limited.id), false);
    assert.ok(app.config.handOvers(THIS_SERVER).includes(limited.id));
    await app.settle();

    const paused = await manager("Manager to pause");

    linkAuthenticator(app, paused);
    app.removeAuthenticator(paused.id, owner(app));
    assert.ok(app.config.rightHolders(THIS_SERVER, "manages").includes(paused.id));
    assert.ok(app.config.handOvers(THIS_SERVER).includes(paused.id));
    assert.equal(app.policy.inCharge(paused, THIS_SERVER), false);
    await app.settle();
    const { secret } = app.authenticators.begin(paused.id, paused.name);

    app.confirmAuthenticator(
        app.config.userById(paused.id)!,
        totp(secret, Math.floor(app.now() / STEP_MS)),
    );
    assert.equal(app.policy.inCharge(paused, THIS_SERVER), true);
    assert.equal(
        app.sessionMeta(id)?.createdBy,
        owner(app).id,
        "handed-over work stays with the owner",
    );
});

test("8b: Manage this computer taken back by its route hands their work over before the answer", async () => {
    const user = await manager("Manager revoked by the route");
    const { id } = await app.commands.createSession(user, { cwd: folder });
    // A hand-over made slow: an answer that does not wait for it comes back first.
    const settle = app.settle.bind(app);
    let settled = 0;

    app.settle = async () => {
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 300));
        settled += 1;
    };

    try {
        await call(owner(app), rights(THIS_SERVER), 200, manage(user, false));
        assert.ok(settled > 0, "the answer waited for the hand-over");
    } finally {
        app.settle = settle;
    }

    assert.deepEqual(app.config.handOvers(THIS_SERVER), [], "nothing is still owed");
    assert.equal(app.sessionMeta(id)?.createdBy, owner(app).id);
});

test("9: a runner manager is not in charge when the runner is blocked", async () => {
    const link = person("Linker to demote");
    const runner = app.config.addRunner("Blocked laptop", link.id, newIdentity().publicKey);
    const user = await manager("Blocked manager", runner.id, link);

    assert.equal(app.policy.inCharge(user, runner.id), true);
    app.config.updateUser(link.id, { sessions: ["1"] });
    assert.equal(
        app.policy.inCharge(link, runner.id),
        false,
        "a linker limited to sessions is not in charge",
    );
    app.config.giveRole(link.id, "viewer");
    assert.equal(app.policy.blocked(runner.id), true);
    assert.equal(app.policy.inCharge(user, runner.id), false);
    assert.equal(app.policy.has(user, "manages", runner.id), false);
    assert.ok(app.config.rightHolders(runner.id, "manages").includes(user.id));
    app.config.updateUser(link.id, { sessions: undefined });
    app.config.giveRole(link.id, "guest");
    assert.equal(app.policy.inCharge(user, runner.id), true);
});

test("10: migration keeps the old manager's charge only where the owner is in charge", () => {
    const dir = join(root, "old-managers");
    const config = new ConfigStore(dir);
    const ada = config.addUser("Legacy manager", "guest").user;
    const vic = config.addUser("Legacy viewer", "viewer").user;
    const sam = config.addUser("Legacy scoped user", "guest", ["1"]).user;
    const pam = config.addUser("Legacy paused manager", "viewer").user;
    const mac = config.addRunner("Owner's runner", config.owner!.id, newIdentity().publicKey);
    const pc = config.addRunner("Someone else's runner", vic.id, newIdentity().publicKey);
    const old = JSON.parse(readFileSync(config.file, "utf8")) as {
        users: (Omit<User, "rights" | "paused"> & {
            rights?: string[];
            paused?: { rights?: string[] };
        })[];
    };

    for (const each of old.users) {
        if (each.id === pam.id) {
            // Paused: a viewer until they link an authenticator again, with their rights kept for then.
            each.paused = { rights: ["managesRunners", "keepsWarm"] };
        } else if (each.id !== config.owner!.id) {
            each.rights = ["managesRunners"];

            if (each.id === ada.id) {
                each.rights.push("keepsWarm");
            }
        }
    }

    writeFileSync(config.file, JSON.stringify(old));
    const migrated = new ConfigStore(dir);

    // A pause keeps who manages a computer, so a paused manager is carried over too, for when their pause ends.
    for (const id of [THIS_SERVER, mac.id]) {
        assert.deepEqual(migrated.computer(id)?.users, [ada.id, pam.id]);
        assert.deepEqual(migrated.rightHolders(id, "manages"), [ada.id, pam.id]);
    }

    assert.deepEqual(migrated.userById(pam.id)?.paused, { rights: ["keepsWarm"] });

    assert.equal(migrated.computer(pc.id)?.users, undefined);
    assert.deepEqual(migrated.rightHolders(pc.id, "manages"), []);
    assert.deepEqual(migrated.userById(ada.id)?.rights, ["keepsWarm"]);
    assert.equal(migrated.userById(vic.id)?.rights, undefined);
    assert.equal(migrated.userById(sam.id)?.rights, undefined);
    const saved = readFileSync(config.file, "utf8");

    assert.doesNotMatch(saved, /managesRunners/);
    new ConfigStore(dir);
    assert.equal(readFileSync(config.file, "utf8"), saved);
});

test("12: the people list calls a manager a user and names their computer", async () => {
    const user = person("Listed manager");
    const boss = owner(app);
    const row = () => app.people(boss).find((each) => each.id === user.id);
    const tab = fakeTab(undefined, boss);

    assert.equal(row()?.inCharge, undefined);
    await app.choosePerson(laptop.id, user.id, true);
    await app.attach(tab.client);

    try {
        await call(linker, rights(laptop.id), 200, manage(user));
        // The owner sees the runner's name, but learns no extra rights there.
        assert.equal(row()?.word, "user");
        assert.deepEqual(row()?.inCharge, [laptop.name]);
        assert.equal(app.policy.inCharge(boss, laptop.id), false);
        await until(() => {
            const rows = tab.last("users") as unknown as ReturnType<App["people"]> | undefined;

            return (
                rows?.find((each) => each.id === user.id)?.inCharge?.includes(laptop.name) === true
            );
        }, "the owner's updated people list");
        await call(linker, rights(laptop.id), 200, manage(user, false));
        assert.equal(row()?.inCharge, undefined);
    } finally {
        app.detach(tab.client);
    }
});

test("20: a manager can un-choose a user who does not manage the computer", async () => {
    const user = await manager("Chooses people");
    const plain = person("Can be un-chosen");
    const path = users(THIS_SERVER);

    await call(user, path, 200, { person: plain.id, on: true });
    assert.equal(app.policy.mayUse(plain, THIS_SERVER), true);
    await call(plain, path, 403, { person: plain.id, on: false });
    await call(user, path, 200, { person: plain.id, on: false });
    assert.equal(app.policy.mayUse(plain, THIS_SERVER), false);
});

test("21: a manager cannot un-choose another manager or themselves in either form", async () => {
    const user = await manager("Cannot un-choose managers");
    const other = await manager("Protected manager");
    const plain = person("Whole list stays");
    const path = users(THIS_SERVER);

    await app.choosePerson(THIS_SERVER, plain.id, true);
    const chosen = app.config.server.users!;
    const saved = readFileSync(app.config.file, "utf8");

    for (const body of [
        { person: other.id, on: false },
        { person: user.id, on: false },
        { users: chosen.filter((id) => id !== other.id && id !== plain.id) },
        { users: chosen.filter((id) => id !== user.id) },
    ]) {
        assert.equal((await call(user, path, 403, body)).error, whoUnchooses);
        assert.equal(readFileSync(app.config.file, "utf8"), saved, "no list or right was changed");
    }
});

test("22: the owner can un-choose a manager; their right ends and their work is handed over", async () => {
    const boss = owner(app);
    const user = await manager("Manager to un-choose");
    const { id } = await app.commands.createSession(user, { cwd: folder });

    await call(boss, users(THIS_SERVER), 200, { person: user.id, on: false });
    assert.equal(app.config.server.users?.includes(user.id), false);
    assert.equal(app.config.rightHolders(THIS_SERVER, "manages").includes(user.id), false);
    assert.equal(app.policy.inCharge(user, THIS_SERVER), false);
    assert.equal(app.sessionMeta(id)?.createdBy, boss.id);
});
