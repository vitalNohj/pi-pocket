// An invite to the sessions its maker chose (`api.ts` `inviteGrant`, `auth.ts` `redeem`, `app.ts` `welcome`): Custom in
// the Invite sheet. Its maker gives a session only while they may share it (`access.ts` `mayShare`), judged when the
// invite is made and again when someone joins with it. Each rule has someone who gets in and someone who is refused.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import type { User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();

type Answer = { code?: string; grant?: { chosen?: string[] }; error?: string };

/** A person; chosen for this server unless `chosen` is false. */
async function person(name: string, role: User["role"], chosen = true): Promise<User> {
    const { user, token } = app.config.addUser(name, role);

    tokens.set(user.id, token);

    if (chosen) {
        await app.choosePerson(THIS_SERVER, user.id, true);
    }

    return user;
}

async function invite(user: User, body: unknown): Promise<{ status: number; body: Answer }> {
    const response = await fetch(`${address}/api/invite`, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
            authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    return { status: response.status, body: (await response.json()) as Answer };
}

/** Join with invite `code` as `name`: the new person, once the join page sent them on. */
async function join(code: string, name: string): Promise<User> {
    const joined = await fetch(`${address}/join/${code}`, {
        method: "POST",
        body: `name=${encodeURIComponent(name)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
    });

    assert.equal(joined.status, 303, `${name} joins`);

    return app.config.users.find((each) => each.name === name)!;
}

/** A session here that `starter` started, named `title`; `pip`: it is that person's PiP. */
async function session(title: string, starter: User, pip = false): Promise<ConversationId> {
    const id = await newSession(app);

    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(id)]!;

        meta.title = title;
        meta.createdBy = starter.id;

        if (pip) {
            meta.pip = starter.id;
        }
    }, context);

    return id;
}

/** The ids of the sessions `user` sees now, in order. */
const listed = (user: User) =>
    app
        .sessions(app.config.userById(user.id)!)
        .map((each) => String(each.id))
        .sort();
/** How many invites for someone new are live. */
const live = () =>
    (
        JSON.parse(readFileSync(app.config.file, "utf8")) as { invites?: { device?: true }[] }
    ).invites?.filter((each) => each.device !== true).length ?? 0;

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

test("the owner gives 2 of 4 sessions: whoever joins sees exactly those, is chosen here, and is held to no session", async () => {
    const boss = owner(app);
    const one = await session("custom: one", boss);
    const two = await session("custom: two", boss);
    const three = await session("custom: three", boss);
    const four = await session("custom: four", boss);
    // Each id once, whatever was sent.
    const made = await invite(boss, { sessions: [Number(one), Number(three), Number(one)] });

    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.deepEqual(made.body.grant?.chosen, [String(one), String(three)]);
    assert.match(
        await (await fetch(`${address}/join/${made.body.code}`)).text(),
        /the 2 sessions chosen for you/,
    );

    const cal = await join(made.body.code!, "Custom Cal");

    assert.deepEqual(listed(cal), [String(one), String(three)].sort());
    assert.ok(![two, four].some((each) => app.canSee(cal, each)), "not the other two");
    assert.equal(cal.role, "viewer");
    assert.equal(cal.sessions, undefined, "not held to one session");
    assert.equal(
        app.config.server.users?.includes(cal.id),
        true,
        "chosen for this server, which the owner is in charge of",
    );
    // Its sessions are shared by who made it, theirs to take back.
    assert.equal(app.sessionMeta(one)?.sharedBy?.[cal.id], boss.id);

    // One session: the join page says so.
    const single = await invite(boss, { sessions: [Number(two)] });

    assert.match(
        await (await fetch(`${address}/join/${single.body.code}`)).text(),
        /the session chosen for you/,
    );
});

test("a user who may invite gives a session they started; one of someone else's that they only see is refused, and no invite is made", async () => {
    const boss = owner(app);
    const gina = await person("Custom Gina", "guest");

    app.setRight(boss, { person: gina.id, right: "invites", on: true });

    const hers = await session("custom: Gina's", gina);
    const shown = await session("custom: the owner's, shared with Gina", boss);
    const hidden = await session("custom: the owner's, hidden from Gina", boss);

    await app.commands.shareSession(shown, boss, [gina.id]);
    assert.equal(app.canSee(app.config.userById(gina.id)!, shown), true);

    const before = live();

    for (const each of [shown, hidden]) {
        const refused = await invite(gina, { sessions: [Number(hers), Number(each)] });

        // The same answer for a session she sees and may not share and for one hidden from her: nothing is learned.
        assert.deepEqual(
            [refused.status, refused.body.error],
            [400, "No such session"],
            String(each),
        );
    }

    assert.equal(live(), before, "no invite was made");

    const made = await invite(gina, { sessions: [Number(hers)] });

    assert.equal(made.status, 200, JSON.stringify(made.body));

    const ted = await join(made.body.code!, "Custom Ted");

    assert.deepEqual(listed(ted), [String(hers)]);
    assert.equal(app.canSee(ted, shown), false);
    // Gina is in charge of no computer: the session is shared, and who uses this server stays the owner's choice.
    assert.equal(app.config.server.users?.includes(ted.id) ?? false, false);
});

test("a session whose share its maker lost between making and joining is not given; the other one is", async () => {
    const boss = owner(app);
    const lea = await person("Custom Lea", "guest");

    app.setRight(boss, { person: lea.id, right: "invites", on: true });
    // She shares on what was shared with her here.
    app.setRight(boss, { computer: THIS_SERVER, person: lea.id, right: "reshares", on: true });

    const hers = await session("custom: Lea's", lea);
    const passed = await session("custom: the owner's, passed on by Lea", boss);

    await app.commands.shareSession(passed, boss, [lea.id]);

    const made = await invite(lea, { sessions: [Number(hers), Number(passed)] });

    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.deepEqual(made.body.grant?.chosen, [String(hers), String(passed)]);

    // She still sees it, and no longer shares it on.
    app.setRight(boss, { computer: THIS_SERVER, person: lea.id, right: "reshares", on: false });
    assert.equal(app.canSee(app.config.userById(lea.id)!, passed), true);

    const max = await join(made.body.code!, "Custom Max");

    assert.deepEqual(listed(max), [String(hers)]);
    assert.equal(app.canSee(max, passed), false, "not the one she may no longer share");
});

test("a maker without Invite people, or who may start sessions nowhere, is refused with 403", async () => {
    const boss = owner(app);
    const nell = await person("Custom Nell", "guest");
    const owners = await session("custom: the owner's, for Nell", boss);
    // Invite people, and chosen for no computer: she may start sessions nowhere.
    const ora = await person("Custom Ora", "guest", false);

    app.setRight(boss, { person: ora.id, right: "invites", on: true });

    const before = live();
    const without = await invite(nell, { sessions: [Number(owners)] });
    const nowhere = await invite(ora, { sessions: [Number(owners)] });

    assert.deepEqual(
        [without.status, without.body.error],
        [403, "You do not have the Invite people permission."],
    );
    assert.deepEqual(
        [nowhere.status, nowhere.body.error],
        [403, "Only people who may start sessions here can invite others."],
    );
    assert.equal(live(), before);
});

test("sessions with a session or a folder, an empty list, 201 ids, ids that are no ids, a PiP session, and an archived session are refused with 400", async () => {
    const boss = owner(app);
    const kept = await session("custom: kept", boss);
    const archived = await session("custom: archived", boss);
    const pip = await session("custom: PiP", boss, true);

    await app.commands.updateSession(archived, boss, { archived: true });

    const before = live();
    const list = "sessions must be a list of 1 to 200 session ids.";
    const cases: [unknown, string][] = [
        [{ sessions: [Number(kept)], session: String(kept) }, "with a session"],
        [{ sessions: [Number(kept)], session: String(kept), folder: true }, "with a folder"],
        [{ sessions: [] }, list],
        [{ sessions: Array.from({ length: 201 }, () => Number(kept)) }, list],
        [{ sessions: [String(kept)] }, list],
        [{ sessions: [-1] }, list],
        [{ sessions: [1.5] }, list],
        [{ sessions: Number(kept) }, list],
        [{ sessions: [Number(kept), Number(pip)] }, "No such session"],
        [{ sessions: [Number(kept), Number(archived)] }, "No such session"],
        [{ sessions: [Number(kept), 987_654] }, "No such session"],
    ];

    for (const [body, error] of cases) {
        const answer = await invite(boss, body);

        assert.equal(answer.status, 400, JSON.stringify(body));

        if (error === list || error === "No such session") {
            assert.equal(answer.body.error, error, JSON.stringify(body));
        }
    }

    assert.equal(live(), before, "no invite was made");

    // 200 ids is the most, and allowed.
    assert.equal(
        (await invite(boss, { sessions: Array.from({ length: 200 }, () => Number(kept)) })).status,
        200,
    );
});
