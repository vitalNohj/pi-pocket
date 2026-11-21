// The rights given one person at a time (`rights.ts`): each is declared once, kept in one shape, answered by one check
// (`access.ts` `has`), given by one rule (`offer`) through one setter (`app.ts` `setRight`), and told to the app, which
// draws its switches from that. One table goes over every right.
import {
    type App,
    cleanUp,
    linkAuthenticator,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { THIS_SERVER } from "../src/server/access.ts";
import { ConfigStore, type User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import {
    COMPUTER_RIGHTS,
    PERSON_RIGHTS,
    RIGHTS,
    declared,
    toldRights,
    type PersonRight,
} from "../src/server/rights.ts";
import { STEP_MS, totp } from "../src/server/totp.ts";

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();

function person(name: string, role: User["role"], sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

async function call(
    user: User,
    path: string,
    body: unknown,
): Promise<{ status: number; body: { error?: string } }> {
    const response = await fetch(`${address}/api/${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
            authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    return { status: response.status, body: (await response.json()) as { error?: string } };
}

/** A request that must be refused with `status` and words like `said`. */
async function refused(
    user: User,
    path: string,
    body: unknown,
    status: number,
    said: RegExp,
): Promise<void> {
    const answer = await call(user, path, body);
    const what = `${user.name} ${path} ${JSON.stringify(body)}`;

    assert.equal(answer.status, status, what);
    assert.match(String(answer.body.error), said, what);
}

/** A request that must work. */
async function done(user: User, path: string, body: unknown): Promise<void> {
    const answer = await call(user, path, body);

    assert.equal(answer.status, 200, `${user.name} ${path}: ${JSON.stringify(answer.body)}`);
}

/** The record of `user` as it is kept now. */
const kept = (user: User) => app.config.userById(user.id)!;
/** What `viewer` is told of `target` in the people list. */
const told = (viewer: User, target: User) =>
    app.people(kept(viewer)).find((each) => each.id === target.id) as
        { rights?: PersonRight[]; offer?: Partial<Record<PersonRight, string>> } | undefined;
const has = (user: User, right: PersonRight) => app.policy.has(user, right);
const give = (user: User, right: PersonRight, on = true) =>
    app.setRight(owner(app), { person: user.id, right, on });

/** The owner lets `name` manage users. */
function manager(name: string): User {
    const user = person(name, "guest");

    give(user, "managesUsers");

    return user;
}

before(async () => {
    app = await openApp(scriptedModel());
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

test("every right is declared once, and the app is told its words and none of its rules", async () => {
    assert.deepEqual(PERSON_RIGHTS, [
        "linksRunners",
        "invites",
        "managesUsers",
        "managesRunners",
        "managesServer",
        "keepsWarm",
    ]);
    assert.deepEqual(COMPUTER_RIGHTS, ["wheel", "allows"]);
    assert.deepEqual([...PERSON_RIGHTS, ...COMPUTER_RIGHTS], Object.keys(RIGHTS));

    const said = (await app.hello(owner(app))).server.rights;

    assert.deepEqual(said, toldRights());
    assert.deepEqual(
        said.map((each) => [each.key, each.scope]),
        Object.entries(RIGHTS).map(([key, each]) => [key, each.scope]),
    );

    for (const each of said) {
        assert.equal(each.label, declared(each.key).label);
        assert.equal(each.on, declared(each.key).on);

        // Who may hold or give it is the server's to decide (`access.ts` `has`, `offer`), never the app's.
        for (const rule of ["whole", "gives", "with", "lapses"]) {
            assert.equal(rule in each, false, `${each.key} ${rule}`);
        }
    }
});

test("one check answers for every right: the owner has them all, a user what they were given, nobody else any", async () => {
    const gil = person("Gil", "guest");
    const vera = person("Vera", "viewer");
    const sam = person("Sam", "guest", ["1"]);

    app.config.setServerUsers([gil.id, vera.id]);

    for (const right of PERSON_RIGHTS) {
        assert.equal(has(owner(app), right), true, right);
        assert.equal(has(gil, right), false, right);
        assert.equal(has({ id: "nobody" } as User, right), false, right);

        give(gil, right);
        assert.equal(has(gil, right), true, right);
        assert.deepEqual(kept(gil).rights, [right], right);

        // A viewer holds none, whatever their record says; nor does someone limited to one session one that takes the
        // whole server.
        app.config.updateUser(vera.id, { rights: [right] });
        assert.equal(has(vera, right), false, right);
        app.config.updateUser(sam.id, { rights: [right] });
        assert.equal(has(sam, right), declared(right).whole !== true, right);

        give(gil, right, false);
        assert.equal(has(gil, right), false, right);
        assert.equal(kept(gil).rights, undefined, `${right}: nothing held leaves no list`);
        app.config.updateUser(vera.id, { rights: [] });
        app.config.updateUser(sam.id, { rights: [] });
    }

    // The methods that name a right ask the same check.
    give(gil, "linksRunners");
    give(gil, "keepsWarm");

    for (const each of [owner(app), gil, vera, sam]) {
        assert.equal(app.policy.mayLink(each), has(each, "linksRunners"), each.name);
        assert.equal(app.policy.invites(each), has(each, "invites"), each.name);
        assert.equal(app.policy.managesPeople(each), has(each, "managesUsers"), each.name);
        assert.equal(app.policy.managesRunners(each), has(each, "managesRunners"), each.name);
        assert.equal(app.policy.managesServer(each), has(each, "managesServer"), each.name);
        assert.equal(app.policy.keepsWarm(each), has(each, "keepsWarm"), each.name);
    }

    // A hello says each of them: a person's right held or not, a computer's by the computers it is held on.
    assert.deepEqual((await app.hello(owner(app))).user.rights, {
        linksRunners: true,
        invites: true,
        managesUsers: true,
        managesRunners: true,
        managesServer: true,
        keepsWarm: true,
        wheel: [THIS_SERVER],
        allows: [THIS_SERVER],
    });
    assert.deepEqual((await app.hello(kept(gil))).user.rights, {
        linksRunners: true,
        invites: false,
        managesUsers: false,
        managesRunners: false,
        managesServer: false,
        keepsWarm: true,
        wheel: [],
        allows: [],
    });

    // What is kept is one list: only declared rights, each once, in their order. The owner keeps none.
    app.config.updateUser(gil.id, {
        rights: ["keepsWarm", "nonsense" as PersonRight, "linksRunners", "keepsWarm"],
    });
    assert.deepEqual(kept(gil).rights, ["linksRunners", "keepsWarm"]);
    app.config.updateUser(owner(app).id, { rights: ["keepsWarm"] });
    assert.equal(kept(owner(app)).rights, undefined);

    // A computer's right goes through the same check and the same setter.
    assert.equal(app.policy.has(gil, "wheel", THIS_SERVER), false);
    app.setRight(owner(app), { computer: THIS_SERVER, person: gil.id, right: "wheel", on: true });
    assert.equal(app.policy.has(gil, "wheel", THIS_SERVER), true);
    assert.equal(app.policy.has(gil, "allows", THIS_SERVER), false);
    assert.equal(app.policy.overridesTurns(gil, THIS_SERVER), true);
    assert.deepEqual(app.config.server.rights, { wheel: [gil.id] });
    assert.deepEqual((await app.hello(kept(gil))).user.rights.wheel, [THIS_SERVER]);
    app.setRight(owner(app), { computer: THIS_SERVER, person: gil.id, right: "wheel", on: false });
    assert.equal(app.config.server.rights, undefined, "nobody holds one: no entry is kept");

    // Each scope takes only its own rights.
    assert.throws(
        () =>
            app.setRight(owner(app), {
                computer: THIS_SERVER,
                person: gil.id,
                right: "keepsWarm",
                on: true,
            }),
        /Send person, right \(wheel or allows\), and on\./,
    );
    assert.throws(
        () => app.setRight(owner(app), { person: gil.id, right: "wheel", on: true }),
        /Send right \(linksRunners, invites, managesUsers, managesRunners, managesServer, keepsWarm\) and on\./,
    );
});

test("one rule says who gives a right, to the setter and to the app alike", async () => {
    const mona = manager("Mona 2");
    const max = manager("Max 2");
    const gil = person("Gil 2", "guest");
    const vera = person("Vera 2", "viewer");
    const sam = person("Sam 2", "guest", ["1"]);
    const path = (user: User) => `users/${user.id}/rights`;
    const more = /You can only give what you have yourself/;

    // What each switch offers: the owner turns each on for a user; for a viewer there is none, and for someone
    // limited to one session only what does not take the whole server.
    assert.deepEqual(told(owner(app), gil)?.offer, {
        linksRunners: "open",
        invites: "open",
        managesUsers: "open",
        managesRunners: "open",
        managesServer: "open",
        keepsWarm: "open",
    });
    assert.equal(told(owner(app), vera)?.offer, undefined);
    assert.deepEqual(told(owner(app), sam)?.offer, { keepsWarm: "open" });
    // Who manages users has Invite people with that: it stays on, and is no switch of its own.
    assert.deepEqual(told(owner(app), mona)?.offer, {
        linksRunners: "open",
        invites: "with",
        managesUsers: "open",
        managesRunners: "open",
        managesServer: "open",
        keepsWarm: "open",
    });
    assert.deepEqual(told(owner(app), mona)?.rights, ["invites", "managesUsers"]);
    // A user who manages users gives only what they have themselves, and never a right only the owner gives: to
    // manage users, runners, or the server.
    assert.deepEqual(told(mona, gil)?.offer, {
        linksRunners: "lacking",
        invites: "open",
        keepsWarm: "lacking",
    });
    // They change nobody who manages users, nor themselves; a person reads their own rights, and offers none.
    assert.equal(told(mona, max)?.offer, undefined);
    assert.deepEqual(told(mona, max)?.rights, ["invites", "managesUsers"]);
    assert.equal(told(mona, mona)?.offer, undefined);
    assert.deepEqual(told(mona, mona)?.rights, ["invites", "managesUsers"]);
    assert.equal(told(gil, gil)?.offer, undefined);
    assert.equal(told(gil, mona)?.rights, undefined, "nobody else reads them");
    assert.equal(told(owner(app), owner(app))?.offer, undefined);
    assert.equal(told(owner(app), owner(app))?.rights, undefined, "the owner has them all");

    for (const right of PERSON_RIGHTS) {
        const { gives, whole, label } = declared(right);
        const owners = gives === "owner";
        const body = (on: boolean) => ({ right, on });
        // Who can hold it, as the refusal says it: a user, and for a right that takes the whole server, one who is not
        // limited to one session.
        const must = (name: string) =>
            new RegExp(
                `${name} must be a user${whole === true ? " who is not limited to one session" : ""} to ${label.toLowerCase()}\\.`,
            );

        // The setter refuses what the offer does not open, in the same words for every right.
        await refused(owner(app), path(vera), body(true), 400, must("Vera 2"));
        assert.equal(kept(vera).rights, undefined, right);

        if (whole === true) {
            await refused(owner(app), path(sam), body(true), 400, must("Sam 2"));
        } else {
            await done(owner(app), path(sam), body(true));
            assert.deepEqual(kept(sam).rights, [right]);
            await done(owner(app), path(sam), body(false));
        }

        await refused(owner(app), path(owner(app)), body(true), 404, /No such person/);
        await refused(owner(app), "users/nobody/rights", body(true), 404, /No such person/);
        await refused(owner(app), path(gil), { right, on: "yes" }, 400, /on must be true or false/);
        await refused(gil, path(gil), body(true), 403, /Only the owner can do that/);

        if (owners) {
            // Only the owner gives it, and takes it back.
            await refused(mona, path(gil), body(true), 403, /Only the owner can do that/);
            await refused(mona, path(gil), body(false), 403, /Only the owner can do that/);
            await done(owner(app), path(gil), body(true));
            assert.equal(has(gil, right), true, right);
            await done(owner(app), path(gil), body(false));
            continue;
        }

        const hers = has(mona, right);

        assert.equal(told(mona, gil)?.offer?.[right], hers ? "open" : "lacking", right);

        if (!hers) {
            await refused(mona, path(gil), body(true), 403, more);
            assert.equal(has(gil, right), false, right);

            // What the owner gave someone, they take back without having it: the switch is theirs for that.
            await done(owner(app), path(gil), body(true));
            assert.equal(told(mona, gil)?.offer?.[right], "open", right);
            await done(mona, path(gil), body(false));
            assert.equal(has(gil, right), false, right);
            // With it themselves, they give it.
            await done(owner(app), path(mona), body(true));
        }

        await done(mona, path(gil), body(true));
        assert.equal(has(gil, right), true, right);
        assert.equal(told(owner(app), gil)?.rights?.includes(right), true, right);
        assert.equal(told(gil, gil)?.rights?.includes(right), true, right);
        assert.equal((await app.hello(kept(gil))).user.rights[right], true, right);
        // Another who manages users is not theirs to change, whatever the right.
        await refused(mona, path(max), body(true), 403, /manage|Only the owner/);
    }

    // No right of that name, and none held on a computer, is given here.
    await refused(owner(app), path(gil), { right: "everything", on: true }, 400, /Send right \(/);
    await refused(owner(app), path(gil), { right: "wheel", on: true }, 400, /Send right \(/);
    await refused(owner(app), path(gil), { on: true }, 400, /Send right \(/);

    // The routes each right had of its own are gone.
    for (const old of ["links-runners", "invites", "manages-users", "keeps-warm"]) {
        const before = JSON.stringify(kept(vera));

        assert.equal((await call(owner(app), `users/${vera.id}/${old}`, { on: true })).status, 404);
        assert.equal(JSON.stringify(kept(vera)), before, old);
    }
});

test("a right stays kept while its person cannot hold it, unless it lapses; a pause keeps one that lapses", () => {
    const pia = person("Pia", "guest");

    for (const right of PERSON_RIGHTS) {
        give(pia, right);
    }

    assert.deepEqual(kept(pia).rights, PERSON_RIGHTS);

    // Made a viewer: they hold none; the rights to manage (users, runners, the server) lapse, the others wait for them.
    app.config.updateUser(pia.id, { role: "viewer" });
    assert.deepEqual(kept(pia).rights, ["linksRunners", "invites", "keepsWarm"]);

    for (const right of PERSON_RIGHTS) {
        assert.equal(has(pia, right), false, right);
    }

    app.config.updateUser(pia.id, { role: "guest" });

    for (const right of PERSON_RIGHTS) {
        assert.equal(has(pia, right), declared(right).lapses !== true, right);
    }

    // Paused (their authenticator was removed): the ones that lapse are kept for when they link one again.
    const lapsing = PERSON_RIGHTS.filter((right) => declared(right).lapses === true);

    assert.deepEqual(lapsing, ["managesUsers", "managesRunners", "managesServer"]);

    for (const right of lapsing) {
        give(pia, right);
    }

    linkAuthenticator(app, pia);
    app.removeAuthenticator(pia.id, owner(app));
    assert.equal(kept(pia).role, "viewer");
    assert.deepEqual(kept(pia).rights, ["linksRunners", "invites", "keepsWarm"]);
    assert.deepEqual(kept(pia).paused, { rights: lapsing });

    for (const right of PERSON_RIGHTS) {
        assert.equal(has(pia, right), false, right);
    }

    const { secret } = app.authenticators.begin(pia.id, pia.name);

    app.confirmAuthenticator(kept(pia), totp(secret, Math.floor(app.now() / STEP_MS)));
    assert.equal(kept(pia).role, "guest");
    assert.deepEqual(kept(pia).rights, PERSON_RIGHTS);
    assert.equal(Object.hasOwn(kept(pia), "paused"), false);

    for (const right of PERSON_RIGHTS) {
        assert.equal(has(pia, right), true, right);
    }
});

test("a file that kept each right in a field of its own has them gathered into one shape at load", () => {
    const directory = mkdtempSync(join(root, "rights-"));
    const first = new ConfigStore(directory);
    const boss = first.users.find((each) => each.role === "owner")!;
    const ann = first.addUser("Ann", "guest").user;
    const pat = first.addUser("Pat", "viewer").user;
    const laptop = first.addRunner("Laptop", boss.id, "key");
    const read = () =>
        JSON.parse(readFileSync(first.file, "utf8")) as {
            users: Record<string, unknown>[];
            server?: Record<string, unknown>;
            runners: Record<string, unknown>[];
        };
    const old = read();
    const of = (file: ReturnType<typeof read>, id: string) =>
        file.users.find((each) => each.id === id)!;

    // As the server before `rights.ts` kept them.
    Object.assign(of(old, ann.id), {
        linksRunners: true,
        invites: true,
        managesUsers: true,
        keepsWarm: true,
    });
    Object.assign(of(old, pat.id), { keepsWarm: true, paused: { managesUsers: true } });
    old.server = { users: [ann.id], wheel: [ann.id], allows: [ann.id] };
    Object.assign(old.runners[0]!, { users: [ann.id], wheel: [], allows: [ann.id] });
    writeFileSync(first.file, JSON.stringify(old, null, 2));

    const next = new ConfigStore(directory);

    // The four there were then; the rights declared since are nobody's until the owner gives them.
    const then = ["linksRunners", "invites", "managesUsers", "keepsWarm"];

    assert.deepEqual(next.userById(ann.id)?.rights, then);
    assert.deepEqual(next.userById(pat.id)?.rights, ["keepsWarm"]);
    assert.deepEqual(next.userById(pat.id)?.paused, { rights: ["managesUsers"] });
    assert.deepEqual(next.server.rights, { wheel: [ann.id], allows: [ann.id] });
    assert.deepEqual(next.runnerById(laptop.id)?.rights, { allows: [ann.id] });
    assert.deepEqual(next.rightHolders(undefined, "wheel"), [ann.id]);
    assert.deepEqual(next.rightsOn(laptop.id), { wheel: [], allows: [ann.id] });

    // Saved so, in that load: no field of the old shape is left.
    const saved = read();

    for (const user of saved.users) {
        for (const key of PERSON_RIGHTS) {
            assert.equal(key in user, false, `${String(user.name)} ${key}`);
        }
    }

    assert.equal("managesUsers" in (of(saved, pat.id).paused as object), false);

    for (const computer of [saved.server!, saved.runners[0]!]) {
        for (const key of COMPUTER_RIGHTS) {
            assert.equal(key in computer, false, key);
        }
    }

    assert.deepEqual(of(saved, ann.id).rights, then);

    // A file in the one shape is left as it is.
    const text = readFileSync(first.file, "utf8");

    assert.deepEqual(new ConfigStore(directory).userById(ann.id)?.rights, then);
    assert.equal(readFileSync(first.file, "utf8"), text);
});
