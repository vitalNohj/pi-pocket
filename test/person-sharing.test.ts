// Sharing sessions with one person, several at once (`commands.ts` `sharingWith`, `shareWith`; `GET` and `POST
// /api/users/:id/sharing`): what a person's page in People offers as "Invite to your session". Whoever prompts shares
// the sessions that are theirs to share (`access.ts` `mayShare`) and takes them back; each rule here has someone who
// gets in and someone who is refused.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { newIdentity } from "../src/runner/secure-link.ts";
import { THIS_SERVER } from "../src/server/access.ts";
import type { SharingRow } from "../src/server/commands.ts";
import type { User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();

type Answer = {
    error?: string;
    person?: { id: string; name: string };
    sessions?: SharingRow[];
    refused?: { id: number; reason: string }[];
};

/** A person; `chosen` for this server unless they are invited to `sessions` alone. */
async function person(
    name: string,
    role: User["role"],
    { sessions, chosen = sessions === undefined }: { sessions?: string[]; chosen?: boolean } = {},
): Promise<User> {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    if (chosen) {
        await app.choosePerson(THIS_SERVER, user.id, true);
    }

    return user;
}

async function call(
    user: User,
    path: string,
    body?: unknown,
): Promise<{ status: number; body: Answer }> {
    const response = await fetch(`${address}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
            authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: (await response.json()) as Answer };
}

const sharing = (target: User) => `users/${encodeURIComponent(target.id)}/sharing`;

/** A session here that `starter` started, named `title`. */
async function session(title: string, starter: User = owner(app)): Promise<ConversationId> {
    const id = await newSession(app);

    await app.harness.commit(async (tx) => {
        const meta = (await tx.doc(SessionsDoc)).items[String(id)]!;

        meta.title = title;
        meta.createdBy = starter.id;
    }, context);

    return id;
}

/** Whom session `id` is shared with now, in order of id. */
const sharedWith = (id: ConversationId) => [...(app.sessionMeta(id)?.sharedWith ?? [])].sort();
/** The record of `user` as it is kept now. */
const now = (user: User) => app.config.userById(user.id)!;
/** The rows `by` is told for `target`, by session title. */
const rows = (by: User, target: User) =>
    new Map(
        app.commands.sharingWith(now(by), target.id).sessions.map((each) => [each.title, each]),
    );

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

test("who is in charge reads how one person has each session, and what can be given or taken", async () => {
    const boss = owner(app);
    const gina = await person("List Gina", "guest");
    const mine = await session("list: the owner's");
    const hers = await session("list: Gina's", gina);
    const given = await session("list: shared with Gina");
    const sam = await person("List Sam", "viewer", { sessions: [String(mine)] });
    const nia = await person("List Nia", "guest", { chosen: false });

    await app.commands.shareSession(given, boss, [gina.id]);

    const ginas = rows(boss, gina);

    assert.deepEqual(
        [
            ginas.get("list: the owner's"),
            ginas.get("list: Gina's"),
            ginas.get("list: shared with Gina"),
        ].map((each) => [each?.state, each?.give, each?.take]),
        [
            ["none", true, false],
            ["started", false, true],
            ["shared", false, true],
        ],
    );
    assert.equal(ginas.get("list: the owner's")?.computerName, "This server");
    assert.equal(ginas.get("list: the owner's")?.id, Number(mine));
    assert.equal(ginas.get("list: Gina's")?.id, Number(hers));

    // Invited to one session alone: that one is theirs, and nothing else can be.
    const sams = rows(boss, sam);

    assert.deepEqual(
        [sams.get("list: the owner's"), sams.get("list: Gina's")].map((each) => [
            each?.state,
            each?.give,
            each?.take,
            each?.reason,
        ]),
        [
            ["invited", false, true, undefined],
            ["blocked", false, false, "invited to one session only"],
        ],
    );

    // Not chosen for this server: nothing here can be shared with them yet, and the row says why.
    assert.deepEqual(
        [rows(boss, nia).get("list: the owner's")].map((each) => [
            each?.state,
            each?.give,
            each?.reason,
        ]),
        [["blocked", false, "cannot use This server"]],
    );

    // Theirs by its folder: it can be shared as well, and is not taken alone.
    const cy = await person("List Cy", "guest");

    await app.giveFolders(boss, THIS_SERVER, cy.id, [work]);
    await app.seeFolder(boss, THIS_SERVER, cy.id, work, true);
    assert.deepEqual(
        [rows(boss, cy).get("list: the owner's")].map((each) => [
            each?.state,
            each?.give,
            each?.take,
        ]),
        [["folder", true, false]],
    );
    await app.seeFolder(boss, THIS_SERVER, cy.id, work, false);
});

test("a user shares the sessions they started with a person, several at once, and takes them back", async () => {
    const boss = owner(app);
    const bo = await person("Bo", "guest");
    const ana = await person("Ana", "guest");
    const first = await session("bo: first", bo);
    const second = await session("bo: second", bo);
    const owners = await session("bo: the owner's");

    // Only what is theirs to share is listed: not a session someone else started, also when it is shared with them.
    await app.commands.shareSession(owners, boss, [bo.id]);
    assert.equal(app.canSee(now(bo), owners), true);

    const listed = await call(bo, sharing(ana));

    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.person, { id: ana.id, name: "Ana" });
    assert.deepEqual(listed.body.sessions?.map((each) => each.title).sort(), [
        "bo: first",
        "bo: second",
    ]);

    const shared = await call(bo, sharing(ana), { share: [Number(first), Number(second)] });

    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(shared.body.refused, []);
    assert.deepEqual(sharedWith(first), [ana.id]);
    assert.deepEqual(sharedWith(second), [ana.id]);
    assert.equal(app.canSee(now(ana), first), true);
    assert.deepEqual(
        shared.body.sessions?.map((each) => [each.title, each.state, each.take]).sort(),
        [
            ["bo: first", "shared", true],
            ["bo: second", "shared", true],
        ],
    );

    // Someone else's is not theirs to share: it is refused by name, as one that does not exist is, and the rest is done.
    const mixed = await call(bo, sharing(ana), {
        revoke: [Number(first)],
        share: [Number(owners), 987_654],
    });

    assert.equal(mixed.status, 200);
    assert.deepEqual(
        mixed.body.refused?.map((each) => [each.id, each.reason]).sort(),
        [
            [987_654, "Not a session you can share."],
            [Number(owners), "Not a session you can share."],
        ].sort(),
    );
    assert.deepEqual(sharedWith(first), [], "the one they revoked");
    assert.deepEqual(sharedWith(second), [ana.id], "the other is as it was");
    assert.deepEqual(sharedWith(owners), [bo.id], "the owner's session is not shared on");
    assert.equal(app.canSee(now(ana), owners), false);
    assert.equal(app.canSee(now(ana), first), false);

    // A session hidden from them answers as one that does not exist: nothing tells them it is there.
    const hidden = await session("bo: hidden from Bo");
    const probe = await call(bo, sharing(ana), { share: [Number(hidden)] });

    assert.deepEqual(probe.body.refused, [
        { id: Number(hidden), reason: "Not a session you can share." },
    ]);
    assert.deepEqual(sharedWith(hidden), []);
});

test("a viewer shares nothing, and learns of no one; a person is not shared with what they cannot use", async () => {
    const boss = owner(app);
    const vera = await person("Vera", "viewer");
    const gil = await person("Gil", "guest");
    const nia = await person("Nia", "guest", { chosen: false });
    const here = await session("refusals: here");

    // A viewer gets the same answer for someone here and for no one.
    for (const target of [gil.id, "no-such-person"]) {
        for (const body of [undefined, { share: [Number(here)] }]) {
            const answer = await call(vera, `users/${target}/sharing`, body);

            assert.equal(answer.status, 403, target);
            assert.match(String(answer.body.error), /Viewers cannot share sessions/);
        }
    }

    assert.deepEqual(sharedWith(here), []);

    // No such person, and oneself.
    assert.equal((await call(gil, "users/no-such-person/sharing")).status, 404);
    assert.equal((await call(gil, sharing(gil))).status, 400);

    // Someone invited to one session does not learn of someone invited to another.
    const one = await session("refusals: one");
    const two = await session("refusals: two");
    const sam = await person("Sam", "guest", { sessions: [String(one)] });
    const tom = await person("Tom", "guest", { sessions: [String(two)] });

    assert.equal((await call(sam, sharing(tom))).status, 404);
    assert.equal((await call(sam, sharing(tom), { share: [Number(one)] })).status, 404);

    // Someone not chosen for the session's computer: refused with the reason, and the one that can be is done.
    const cannot = await call(boss, sharing(nia), { share: [Number(here)] });

    assert.equal(cannot.status, 200);
    assert.deepEqual(cannot.body.refused, [
        { id: Number(here), reason: "Nia cannot use this server: choose them for it first." },
    ]);
    assert.deepEqual(sharedWith(here), []);

    // What is asked must be lists of session ids, with something in them, and no session in both.
    for (const body of [{}, { share: "all" }, { share: [-1] }, { share: [1.5] }, null]) {
        assert.equal((await call(boss, sharing(gil), body)).status, 400, JSON.stringify(body));
    }

    assert.equal(
        (await call(boss, sharing(gil), { share: [Number(here)], revoke: [Number(here)] })).status,
        400,
    );
    assert.deepEqual(sharedWith(here), []);
});

test("two people shared with at the same moment both have the session", async () => {
    const boss = owner(app);
    const ana = await person("Both Ana", "guest");
    const cy = await person("Both Cy", "guest");
    const dee = await person("Both Dee", "guest");
    const id = await session("both");

    await Promise.all([
        app.commands.shareWith(boss, ana.id, { share: [Number(id)] }),
        app.commands.shareWith(boss, cy.id, { share: [Number(id)] }),
        app.commands.shareWith(boss, dee.id, { share: [Number(id)] }),
    ]);
    assert.deepEqual(sharedWith(id), [ana.id, cy.id, dee.id].sort());

    // And one taken off while another is added leaves the rest as they are.
    const eve = await person("Both Eve", "guest");

    await Promise.all([
        app.commands.shareWith(boss, cy.id, { revoke: [Number(id)] }),
        app.commands.shareWith(boss, eve.id, { share: [Number(id)] }),
    ]);
    assert.deepEqual(sharedWith(id), [ana.id, dee.id, eve.id].sort());
});

test("asked about one session, the answer tells of that one alone: also why a person in charge of its computer needs none", async () => {
    const boss = owner(app);
    const gina = await person("One Gina", "guest");
    const eli = await person("One Eli", "guest");
    const open = await session("one: open", gina);
    const other = await session("one: other", gina);
    const bosses = await session("one: the owner's");
    const one = (id: ConversationId) => `${sharing(eli)}?session=${String(id)}`;
    const told = (answer: { body: Answer }) =>
        answer.body.sessions?.map((each) => [each.title, each.state, each.give, each.take]);

    // Her open session, and not her other one.
    assert.deepEqual(told(await call(gina, one(open))), [["one: open", "none", true, false]]);
    assert.equal((await call(gina, sharing(eli))).body.sessions?.length, 2);

    // A session that is not hers to share is no row: she is told nothing of it.
    assert.deepEqual(told(await call(gina, one(bosses))), []);
    assert.deepEqual(told(await call(gina, `${sharing(eli)}?session=99999`)), []);

    // Shared from there, the answer is that one row again, as it is now; taken back the same way.
    const shared = await call(gina, one(open), { share: [Number(open)] });

    assert.deepEqual(shared.body.refused, []);
    assert.deepEqual(told(shared), [["one: open", "shared", false, true]]);
    assert.deepEqual(sharedWith(open), [eli.id]);
    assert.deepEqual(sharedWith(other), []);
    assert.deepEqual(told(await call(gina, one(open), { revoke: [Number(open)] })), [
        ["one: open", "none", true, false],
    ]);
    assert.deepEqual(sharedWith(open), []);

    // Not an id: refused, for reading and for changing.
    for (const bad of ["x", "-1", "1.5", ""]) {
        const path = `${sharing(eli)}?session=${bad}`;

        assert.equal((await call(gina, path)).status, 400, bad);
        assert.equal((await call(gina, path)).body.error, "session must be a session id.");
        assert.equal((await call(gina, path, { share: [Number(open)] })).status, 400, bad);
    }

    assert.deepEqual(sharedWith(open), []);

    // A viewer is told nothing this way either.
    const vera = await person("One Vera", "viewer");

    assert.equal((await call(vera, one(open))).status, 403);

    // Someone in charge of the session's computer has every session there: the one row says so, and gives nothing.
    // Without a session asked about, theirs are left out, as before.
    assert.deepEqual(told(await call(gina, `${sharing(boss)}?session=${String(open)}`)), [
        ["one: open", "charge", false, false],
    ]);
    assert.deepEqual((await call(gina, sharing(boss))).body.sessions, []);
});

test("who is in charge takes back what a person started or was invited to; a starter only what they shared", async () => {
    const boss = owner(app);
    const gina = await person("Take Gina", "guest");
    const hers = await session("take: Gina's", gina);
    const alone = await session("take: invited alone");
    const sam = await person("Take Sam", "viewer", { sessions: [String(alone)] });

    // The owner, in charge of this server: a session they started moves to the owner; an invite to one session ends.
    const taken = await call(boss, sharing(gina), { revoke: [Number(hers)] });

    assert.deepEqual(taken.body.refused, []);
    assert.equal(app.sessionMeta(hers)?.createdBy, boss.id);
    assert.equal(app.canSee(now(gina), hers), false);

    assert.deepEqual(
        (await call(boss, sharing(sam), { revoke: [Number(alone)] })).body.refused,
        [],
    );
    assert.deepEqual(now(sam).sessions, []);
    assert.equal(app.canSee(now(sam), alone), false);

    // On a computer someone else linked, its linker is in charge: a starter there ends only a share of their own.
    const lin = await person("Take Lin", "guest", { chosen: false });
    const bo = await person("Take Bo", "guest", { chosen: false });
    const ana = await person("Take Ana", "guest", { chosen: false });
    const laptop = app.config.addRunner("Take laptop", lin.id, newIdentity().publicKey).id;

    await app.choosePerson(laptop, bo.id, true);
    await app.choosePerson(laptop, ana.id, true);

    const there = await session("take: Bo's on the laptop", bo);
    const anas = await session("take: Ana's on the laptop", ana);

    await app.harness.commit(async (tx) => {
        const sessions = (await tx.doc(SessionsDoc)).items;

        sessions[String(there)]!.runner = laptop;
        sessions[String(anas)]!.runner = laptop;
    }, context);

    const shared = await call(bo, sharing(ana), { share: [Number(there)] });

    assert.deepEqual(shared.body.refused, []);
    assert.deepEqual(sharedWith(there), [ana.id]);
    assert.equal(
        shared.body.sessions?.find((each) => each.id === Number(there))?.computerName,
        "Take laptop",
    );

    // Bo does not have Ana's own session to give or to take.
    assert.deepEqual((await call(bo, sharing(ana), { revoke: [Number(anas)] })).body.refused, [
        { id: Number(anas), reason: "Not a session you can share." },
    ]);
    assert.equal(app.sessionMeta(anas)?.createdBy, ana.id);

    assert.deepEqual((await call(bo, sharing(ana), { revoke: [Number(there)] })).body.refused, []);
    assert.deepEqual(sharedWith(there), []);
    assert.equal(app.sessionMeta(there)?.createdBy, bo.id, "it stays the starter's");

    // Taken a second time, there is nothing of theirs to take: said, not done in silence.
    assert.match(
        String(
            (await call(bo, sharing(ana), { revoke: [Number(there)] })).body.refused?.[0]?.reason,
        ),
        /does not have that session from you/,
    );

    // Someone invited to Bo's session alone: only who is in charge takes that from them, not its starter.
    const ivy = await person("Take Ivy", "viewer", { sessions: [String(there)] });

    assert.deepEqual(
        [rows(bo, ivy).get("take: Bo's on the laptop")].map((each) => [each?.state, each?.take]),
        [["invited", false]],
    );
    assert.match(
        String(
            (await call(bo, sharing(ivy), { revoke: [Number(there)] })).body.refused?.[0]?.reason,
        ),
        /Only who is in charge of Take laptop takes a session from someone invited to it alone/,
    );
    assert.deepEqual(now(ivy).sessions, [String(there)]);
    assert.equal(rows(lin, ivy).get("take: Bo's on the laptop")?.take, true);

    // Its linker, in charge, takes Ana's own session there; the owner, who is not, is not offered it.
    assert.equal(rows(lin, ana).get("take: Ana's on the laptop")?.take, true);
    assert.equal(rows(boss, ana).has("take: Ana's on the laptop"), false);
    assert.deepEqual((await call(lin, sharing(ana), { revoke: [Number(anas)] })).body.refused, []);
    assert.equal(app.sessionMeta(anas)?.createdBy, lin.id);

    // Nothing there is listed for its linker as a person to share with: every session on it is theirs.
    assert.deepEqual(
        [...rows(bo, lin).values()].filter((each) => each.computer === laptop),
        [],
    );
});
