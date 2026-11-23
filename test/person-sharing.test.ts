// Sharing sessions with one person, several at once (`commands.ts` `sharingWith`, `shareWith`; `GET` and `POST
// /api/users/:id/sharing`): what Invite and Revoke on a session's row do on a person's page in People. Whoever prompts
// shares the sessions that are theirs to share (`access.ts` `mayShare`) and takes them back; each rule here has someone who
// gets in and someone who is refused. So has what someone who shares what they were given does (`rights.ts`
// `reshares`, given on each computer by who is in charge of it): a session shared with them there, and a folder given
// to them there (`POST /api/runners/:id/give`).
import {
    type App,
    approveSession,
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
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import { THIS_SERVER } from "../src/server/access.ts";
import type { SharingComputer, SharingRow } from "../src/server/commands.ts";
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
    charge?: { id: string; name: string }[];
    computers?: SharingComputer[];
    refused?: { id: number; reason: string }[];
    ok?: boolean;
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

test("the sessions on a computer a person is in charge of are left out, and that computer is named", async () => {
    const boss = owner(app);
    const gina = await person("One Gina", "guest");
    const eli = await person("One Eli", "guest");
    const open = await session("one: open", gina);

    await session("one: other", gina);

    // Every session of hers to share is a row, each with what one button does: none is his yet.
    assert.deepEqual(
        (await call(gina, sharing(eli))).body.sessions
            ?.map((each) => [each.title, each.state, each.give, each.take])
            .sort(),
        [
            ["one: open", "none", true, false],
            ["one: other", "none", true, false],
        ],
    );
    assert.deepEqual((await call(gina, sharing(eli))).body.charge, [], "in charge of nothing");

    // Someone in charge of the sessions' computer has every session there: none is a row, and the computer is named,
    // so the page says why its list is empty.
    assert.deepEqual((await call(gina, sharing(boss))).body.sessions, []);
    assert.deepEqual((await call(gina, sharing(boss))).body.charge, [
        { id: THIS_SERVER, name: "This server" },
    ]);

    // And nothing there is shared with them: they have it anyway.
    const tried = await call(gina, sharing(boss), { share: [Number(open)] });

    assert.deepEqual(tried.body.refused, []);
    assert.deepEqual(sharedWith(open), []);
});

test("a folder a person accesses all sessions in changes no share: each session is as it was when that ends", async () => {
    const boss = owner(app);
    const cy = await person("Folder Cy", "guest");
    const before = await session("folder: shared before");
    const during = await session("folder: invited while it is on");
    const never = await session("folder: never invited");

    const state = (id: ConversationId) => {
        const row = app.commands
            .sharingWith(now(boss), cy.id)
            .sessions.find((each) => each.id === Number(id));

        return [row?.state, row?.give, row?.take, app.canSee(now(cy), id)];
    };

    await app.giveFolders(boss, THIS_SERVER, cy.id, [work]);
    assert.deepEqual((await call(boss, sharing(cy), { share: [Number(before)] })).body.refused, []);
    assert.deepEqual(state(before), ["shared", false, true, true]);
    assert.deepEqual(state(during), ["none", true, false, false]);

    // The folder's switch on: every session in it is theirs. The one shared before is still a share, to take back
    // alone; the others are theirs by the folder, and can be invited.
    await app.seeFolder(boss, THIS_SERVER, cy.id, work, true);
    assert.deepEqual(state(before), ["shared", false, true, true]);
    assert.deepEqual(state(during), ["folder", true, false, true]);
    assert.deepEqual(state(never), ["folder", true, false, true]);
    assert.deepEqual(sharedWith(during), [], "the folder shares nothing itself");

    // Invited to one while it is on, and one shared before taken back: both stay theirs by the folder.
    assert.deepEqual((await call(boss, sharing(cy), { share: [Number(during)] })).body.refused, []);
    assert.deepEqual(
        (await call(boss, sharing(cy), { revoke: [Number(before)] })).body.refused,
        [],
    );
    assert.deepEqual(state(during), ["shared", false, true, true]);
    assert.deepEqual(state(before), ["folder", true, false, true]);
    assert.deepEqual(sharedWith(before), []);

    // One theirs by the folder alone is not taken alone: refused, and named with the reason.
    const refused = await call(boss, sharing(cy), { revoke: [Number(never)] });

    assert.deepEqual(
        refused.body.refused?.map((each) => each.id),
        [Number(never)],
    );
    assert.match(refused.body.refused?.[0]?.reason ?? "", /accesses all sessions in that folder/);

    // The switch off: what they were invited to stays; the rest is gone, as each was left.
    await app.seeFolder(boss, THIS_SERVER, cy.id, work, false);
    assert.deepEqual(state(during), ["shared", false, true, true]);
    assert.deepEqual(state(before), ["none", true, false, false]);
    assert.deepEqual(state(never), ["none", true, false, false]);
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
        /Only whoever is in charge of Take laptop can take a session from someone invited to it alone/,
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

test("someone who shares what they were given shares a session shared with them, and ends only the shares they made", async () => {
    const boss = owner(app);
    const lea = await person("Lead Lea", "guest");
    const pat = await person("Lead Pat", "guest");
    const ana = await person("Lead Ana", "guest");
    const tom = await person("Lead Tom", "guest");
    const given = await session("lead: the owner's, shared");
    const also = await session("lead: the owner's, shared too");
    const kept = await session("lead: the owner's, not shared");
    const pats = await session("lead: Pat's", pat);
    const title = "lead: the owner's, shared";
    const mayShare = (user: User) =>
        app.sessions(now(user)).find((each) => each.id === Number(given))?.mayShare;

    app.setRight(boss, { computer: THIS_SERVER, person: lea.id, right: "reshares", on: true });
    await app.commands.shareSession(given, boss, [lea.id, pat.id]);
    await app.commands.shareSession(also, boss, [lea.id]);

    // Without it, a session shared with them is not theirs to share: not listed, and it answers as a missing one.
    assert.equal(app.canSee(now(pat), given), true);
    assert.equal(rows(pat, ana).has(title), false);
    assert.equal(mayShare(pat), undefined);
    assert.deepEqual((await call(pat, sharing(ana), { share: [Number(given)] })).body.refused, [
        { id: Number(given), reason: "Not a session you can share." },
    ]);
    await assert.rejects(
        app.commands.shareSession(given, now(pat), [ana.id]),
        /or someone who shares what they were given there can share it/,
    );
    assert.throws(
        () => app.commands.sharing(given, now(pat)),
        /or someone who shares what they were given there can share it/,
    );
    assert.equal(app.canSee(now(ana), given), false);

    // With it, it is: listed, and never one they do not have themselves.
    assert.equal(mayShare(lea), true);
    assert.deepEqual(
        [rows(lea, ana).get(title)].map((each) => [each?.state, each?.give, each?.take]),
        [["none", true, false]],
    );
    assert.equal(rows(lea, ana).has("lead: the owner's, not shared"), false);

    const shared = await call(lea, sharing(ana), {
        share: [Number(given), Number(also), Number(kept)],
    });

    assert.deepEqual(shared.body.refused, [
        { id: Number(kept), reason: "Not a session you can share." },
    ]);
    assert.deepEqual(sharedWith(given), [ana.id, lea.id, pat.id].sort());
    assert.equal(app.canSee(now(ana), given), true);
    assert.equal(app.canSee(now(ana), kept), false);
    // Who shared it is kept, and told: that share is theirs to end.
    assert.deepEqual(app.sessionMeta(given)?.sharedBy, {
        [lea.id]: boss.id,
        [pat.id]: boss.id,
        [ana.id]: lea.id,
    });
    assert.deepEqual(
        [rows(lea, ana).get(title)].map((each) => [each?.state, each?.give, each?.take, each?.by]),
        [["shared", false, true, { id: lea.id, name: "Lead Lea" }]],
    );

    // A share someone else made is not theirs to end: the row says who made it, and offers nothing.
    await app.commands.shareSession(given, boss, [lea.id, pat.id, ana.id, tom.id]);
    assert.equal(
        app.sessionMeta(given)?.sharedBy?.[ana.id],
        lea.id,
        "a share kept keeps who made it",
    );
    assert.deepEqual(
        [rows(lea, tom).get(title)].map((each) => [each?.state, each?.give, each?.take, each?.by]),
        [["shared", false, false, { id: boss.id, name: boss.name }]],
    );

    const refused = await call(lea, sharing(tom), { revoke: [Number(given)] });

    assert.deepEqual(
        refused.body.refused?.map((each) => each.id),
        [Number(given)],
    );
    assert.match(
        String(refused.body.refused?.[0]?.reason),
        /Only whoever shared it with Lead Tom, its starter, or whoever is in charge of this server can take it back/,
    );
    assert.equal(sharedWith(given).includes(tom.id), true);
    // Nor anyone's who has no part in it.
    assert.deepEqual((await call(pat, sharing(ana), { revoke: [Number(given)] })).body.refused, [
        { id: Number(given), reason: "Not a session you can share." },
    ]);
    assert.equal(sharedWith(given).includes(ana.id), true);

    // The session's own sheet: a share that is not theirs to end is locked, and a save of theirs leaves it. They are
    // not listed themselves.
    const sheet = app.commands.sharing(given, now(lea));

    assert.deepEqual(
        sheet.people
            .filter((each) => each.name.startsWith("Lead "))
            .map((each) => [each.name, each.locked === true])
            .sort(),
        [
            ["Lead Ana", false],
            ["Lead Pat", true],
            ["Lead Tom", true],
        ],
    );
    assert.deepEqual(
        app.commands
            .sharing(given, boss)
            .people.filter((each) => each.locked === true)
            .map((each) => each.name),
        [],
        "nothing is locked to who is in charge",
    );
    assert.deepEqual(
        (await app.commands.shareSession(given, now(lea), [])).sort(),
        [lea.id, pat.id, tom.id].sort(),
    );
    assert.equal(app.canSee(now(ana), given), false);
    assert.equal(app.sessionMeta(given)?.sharedBy?.[ana.id], undefined);

    // A session's starter ends any share of it, also one somebody else made.
    await app.commands.shareSession(pats, now(pat), [lea.id]);
    assert.deepEqual((await call(lea, sharing(ana), { share: [Number(pats)] })).body.refused, []);
    assert.equal(app.sessionMeta(pats)?.sharedBy?.[ana.id], lea.id);
    assert.deepEqual((await call(pat, sharing(ana), { revoke: [Number(pats)] })).body.refused, []);
    assert.deepEqual(sharedWith(pats), [lea.id]);

    // Who shared it is kept only while it is shared: taken by who is in charge, or with the person off the computer,
    // it is gone, so a later share never has the giver of an earlier one.
    assert.deepEqual((await call(lea, sharing(ana), { share: [Number(also)] })).body.refused, []);
    assert.equal(app.sessionMeta(also)?.sharedBy?.[ana.id], lea.id);
    assert.deepEqual((await call(boss, sharing(ana), { revoke: [Number(also)] })).body.refused, []);
    assert.deepEqual(app.sessionMeta(also)?.sharedBy, { [lea.id]: boss.id });
    assert.deepEqual((await call(lea, sharing(ana), { share: [Number(also)] })).body.refused, []);
    await app.choosePerson(THIS_SERVER, ana.id, false);
    assert.deepEqual(sharedWith(also), [lea.id]);
    assert.deepEqual(app.sessionMeta(also)?.sharedBy, { [lea.id]: boss.id });
    await app.choosePerson(THIS_SERVER, ana.id, true);
    await app.commands.shareSession(also, boss, [lea.id, ana.id]);
    assert.equal(app.sessionMeta(also)?.sharedBy?.[ana.id], boss.id);
    assert.equal(rows(lea, ana).get("lead: the owner's, shared too")?.take, false);

    // The right taken back: what they shared is still theirs to take back, and they share nothing more.
    assert.deepEqual((await call(lea, sharing(ana), { share: [Number(given)] })).body.refused, []);
    app.setRight(boss, { computer: THIS_SERVER, person: lea.id, right: "reshares", on: false });
    assert.equal(mayShare(lea), undefined);
    assert.deepEqual(
        [rows(lea, ana).get(title)].map((each) => [each?.state, each?.give, each?.take]),
        [["shared", false, true]],
    );
    assert.equal(rows(lea, tom).has(title), false, "nothing of theirs to give or take there");
    assert.deepEqual((await call(lea, sharing(pat), { share: [Number(also)] })).body.refused, [
        { id: Number(also), reason: "Not a session you can share." },
    ]);
    assert.deepEqual((await call(lea, sharing(ana), { revoke: [Number(given)] })).body.refused, []);
    assert.equal(sharedWith(given).includes(ana.id), false);
    assert.equal(rows(lea, ana).has(title), false, "and then there is nothing of theirs there");
    await app.commands.shareSession(given, boss, [pat.id, tom.id, ana.id]);

    // Removed: a share they made stays, for its starter or who is in charge to end; who made it is forgotten.
    await app.commands.shareSession(pats, now(pat), [lea.id]);
    app.setRight(boss, { computer: THIS_SERVER, person: lea.id, right: "reshares", on: true });
    assert.deepEqual((await call(lea, sharing(tom), { share: [Number(pats)] })).body.refused, []);
    assert.deepEqual(app.sessionMeta(pats)?.sharedBy, { [lea.id]: pat.id, [tom.id]: lea.id });
    await app.removeUser(boss, lea.id);
    assert.deepEqual(sharedWith(pats), [tom.id]);
    assert.equal(app.sessionMeta(pats)?.sharedBy, undefined);
    assert.equal(app.canSee(now(tom), pats), true);
});

test("a session tells each person when they last used it themselves, and nobody who shared it", async () => {
    const boss = owner(app);
    const lea = await person("Used Lea", "guest");
    const ana = await person("Used Ana", "guest");
    const id = await session("used: the owner's");
    const row = (user: User) => app.sessions(now(user)).find((each) => each.id === Number(id))!;

    const send = async (user: User, text: string, via?: string): Promise<void> => {
        const { submissionId } = await app.commands.submit(
            id,
            now(user),
            { text, requestId: crypto.randomUUID() },
            via,
        );

        await (await app.harness.submission(submissionId, context))!.wait(context);
    };

    await app.commands.shareSession(id, boss, [lea.id]);
    approveSession(app, id, lea);

    // Nobody sent since this was kept: its starter used it at its last activity, anyone else never.
    const before = app.sessionMeta(id)!.updatedAt;

    assert.equal(row(boss).usedAt, before);
    assert.equal(row(lea).usedAt, undefined);

    await send(lea, "hello");

    const used = app.sessionMeta(id)!.usedBy;

    assert.deepEqual(Object.keys(used ?? {}).sort(), [boss.id, lea.id].sort());
    assert.equal(row(lea).usedAt, used?.[lea.id]);
    assert.ok((row(lea).usedAt ?? 0) >= before);
    assert.equal(row(boss).usedAt, before, "its starter keeps the last activity before that");

    // A message sent for a person (another agent's) is not their use of it.
    await send(boss, "sent for them", "PiP");
    assert.equal(row(boss).usedAt, before);
    await send(boss, "their own");
    assert.ok((row(boss).usedAt ?? 0) >= (used?.[lea.id] ?? Infinity));
    assert.equal(row(lea).usedAt, used?.[lea.id], "each person's is their own");

    // The list tells neither record, to anyone: a reader gets their own last use alone.
    for (const user of [boss, lea]) {
        assert.equal("sharedBy" in row(user), false, user.name);
        assert.equal("usedBy" in row(user), false, user.name);
    }

    assert.deepEqual(app.sessionMeta(id)?.sharedBy, { [lea.id]: boss.id });

    // An invite's sessions are shared by who made it: theirs to take back, as any share they made.
    const ivy = await person("Used Ivy", "viewer", { chosen: false });
    const leas = await session("used: Lea's", lea);

    await app.welcome(ivy.id, lea.id);
    assert.deepEqual(app.sessionMeta(leas)?.sharedBy, { [ivy.id]: lea.id });
    assert.equal(app.sessionMeta(id)?.sharedBy?.[ivy.id], undefined, "only what they started");
    // Welcomed again, a share they had already keeps who made it.
    await app.commands.shareSession(leas, boss, [ivy.id]);
    await app.welcome(ivy.id, lea.id);
    assert.deepEqual(app.sessionMeta(leas)?.sharedBy, { [ivy.id]: lea.id });

    // A person's page gets it with each session, and who started it; an archived session is not listed.
    const told = rows(boss, ana).get("used: the owner's");

    assert.equal(told?.usedAt, row(boss).usedAt);
    assert.equal(told?.updatedAt, app.sessionMeta(id)?.updatedAt);
    assert.deepEqual(told?.starter, { id: boss.id, name: boss.name });
    assert.equal(told?.folder, work);
    await app.commands.updateSession(id, boss, { archived: true });
    assert.equal(rows(boss, ana).has("used: the owner's"), false);
    await app.commands.updateSession(id, boss, { archived: false });
    assert.equal(rows(boss, ana).has("used: the owner's"), true);
});

test("someone who shares what they were given gives a folder that was given to them, and takes back only what they gave", async () => {
    const boss = owner(app);
    const lea = await person("Give Lea", "guest");
    const pat = await person("Give Pat", "guest");
    const ana = await person("Give Ana", "guest");
    const tom = await person("Give Tom", "guest");
    const vera = await person("Give Vera", "viewer");
    const nia = await person("Give Nia", "guest", { chosen: false });
    const give = (by: User, target: string, folder: string, on?: boolean) =>
        call(by, `runners/${THIS_SERVER}/give`, { person: target, folder, on });
    const sees = (by: User, target: string, folder: string, on: boolean) =>
        call(by, `runners/${THIS_SERVER}/sees`, { person: target, folder, on });
    const has = (user: User) => [...app.config.givenFolders(THIS_SERVER, user.id)];
    const seen = (user: User) => [...app.config.seenFolders(THIS_SERVER, user.id)];
    const told = (by: User, target: User) => app.commands.sharingWith(now(by), target.id).computers;
    const folder = (by: User, target: User) => told(by, target)[0]?.folders[0];

    app.setRight(boss, { computer: THIS_SERVER, person: lea.id, right: "reshares", on: true });

    for (const each of [lea, pat, tom]) {
        await app.giveFolders(boss, THIS_SERVER, each.id, [work]);
    }

    // What each is told they can give a person: their own folders with the right, nothing without it. Who is in
    // charge reads every folder in Runners, so none is told here.
    assert.deepEqual(told(lea, ana), [
        {
            id: THIS_SERVER,
            name: "This server",
            folders: [{ path: work, has: false, sees: false, give: true, take: false, see: false }],
        },
    ]);
    assert.deepEqual(told(pat, ana), []);
    assert.deepEqual(told(boss, ana), []);
    // To someone who does not use the computer, nothing: who uses it is its one in charge's to choose.
    assert.deepEqual(
        told(lea, nia).map((each) => [each.reason, each.folders.map((one) => one.give)]),
        [
            [
                "Give Nia cannot use This server. Whoever is in charge of it chooses who uses it.",
                [false],
            ],
        ],
    );

    // Refused: without the right; a folder that is not theirs, also one inside theirs; to someone who does not prompt
    // there; to themselves, and to no one; and any viewer.
    for (const [answer, status, reason] of [
        [
            await give(pat, ana.id, work, true),
            403,
            /You cannot give folders on this server: Share what they were given is off for you there/,
        ],
        [await give(lea, ana.id, `${work}/sub`, true), 403, /only a folder that was given to you/],
        [await give(lea, ana.id, "/", true), 403, /only a folder that was given to you/],
        [await give(lea, nia.id, work, true), 400, /Give Nia cannot use this server\. Whoever is/],
        [await give(lea, vera.id, work, true), 400, /Give Vera is a viewer/],
        [await give(lea, lea.id, work, true), 400, /That is you/],
        [await give(lea, "no-such-person", work, true), 404, /No such person/],
        [await give(vera, ana.id, work, true), 403, /Viewers cannot give folders/],
        [await give(lea, ana.id, work), 400, /Send person, folder, and on/],
    ] as const) {
        assert.equal(answer.status, status, String(reason));
        assert.match(String(answer.body.error), reason);
    }

    assert.deepEqual(has(ana), []);

    // Given: the folder is theirs to work in, and who gave it is kept and told.
    const given = await give(lea, ana.id, work, true);

    assert.equal(given.status, 200, JSON.stringify(given.body));
    assert.deepEqual(given.body, { ok: true });
    assert.deepEqual(has(ana), [work]);
    assert.deepEqual(app.config.givenBy(THIS_SERVER, ana.id), { [work]: lea.id });
    assert.equal(app.policy.mayUseFolder(now(ana), THIS_SERVER, work), true);
    assert.deepEqual(folder(lea, ana), {
        path: work,
        has: true,
        sees: false,
        give: false,
        take: true,
        see: false,
        by: { id: lea.id, name: "Give Lea" },
    });

    // The whole list saved again by who is in charge (Runners) keeps who gave a folder that stays in it.
    await app.giveFolders(boss, THIS_SERVER, ana.id, [work]);
    assert.deepEqual(app.config.givenBy(THIS_SERVER, ana.id), { [work]: lea.id });

    // A folder someone else gave is not theirs to take back, nor its switch theirs to set.
    assert.deepEqual(app.config.givenBy(THIS_SERVER, tom.id), { [work]: boss.id });
    assert.deepEqual(
        [folder(lea, tom)].map((each) => [each?.has, each?.give, each?.take, each?.see]),
        [[true, false, false, false]],
    );

    const kept = await give(lea, tom.id, work, false);

    assert.equal(kept.status, 403);
    assert.match(
        String(kept.body.error),
        /Only whoever gave Give Tom that folder, or whoever is in charge of this server, can take it back/,
    );
    assert.equal((await sees(lea, tom.id, work, true)).status, 403);
    assert.equal((await sees(pat, ana.id, work, false)).status, 403);
    assert.deepEqual(has(tom), [work]);

    // All sessions in it: they turn it on only while they access them all themselves.
    const early = await sees(lea, ana.id, work, true);

    assert.equal(early.status, 403);
    assert.match(String(early.body.error), /while you access all sessions in it yourself/);
    await app.seeFolder(boss, THIS_SERVER, lea.id, work, true);
    assert.equal(folder(lea, ana)?.see, true);

    const on = await sees(lea, ana.id, work, true);

    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual(on.body, { ok: true }, "they get no view of the computer");
    assert.deepEqual(seen(ana), [work]);
    assert.deepEqual(
        [folder(lea, ana)].map((each) => [each?.sees, each?.see]),
        [[true, true]],
    );

    const anas = await session("give: Ana's in the folder", ana);

    // The right taken back: they give nothing more, and what they gave is still theirs to turn off and take back.
    app.setRight(boss, { computer: THIS_SERVER, person: lea.id, right: "reshares", on: false });
    assert.equal((await give(lea, pat.id, work, true)).status, 403);
    assert.deepEqual(
        [folder(lea, ana)].map((each) => [each?.has, each?.give, each?.take, each?.see]),
        [[true, false, true, true]],
    );
    assert.deepEqual(told(lea, pat), [], "and they are told of no folder to give");
    assert.equal((await sees(lea, ana.id, work, false)).status, 200);
    assert.deepEqual(seen(ana), []);
    assert.equal((await sees(lea, ana.id, work, true)).status, 403, "not on again without it");

    const taken = await give(lea, ana.id, work, false);

    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.deepEqual(has(ana), []);
    assert.deepEqual(app.config.givenBy(THIS_SERVER, ana.id), {});
    assert.equal(
        app.sessionMeta(anas)?.createdBy,
        boss.id,
        "what they started there moves to who is in charge, as when the one in charge takes it",
    );
    assert.deepEqual(told(lea, ana), []);
    assert.equal((await give(lea, ana.id, work, false)).status, 200, "taken twice changes nothing");

    // Who is in charge gives and takes any folder by the same route.
    assert.equal((await give(boss, tom.id, work, false)).status, 200);
    assert.deepEqual(has(tom), []);
    assert.equal((await give(boss, tom.id, work, true)).status, 200);
    assert.deepEqual(app.config.givenBy(THIS_SERVER, tom.id), { [work]: boss.id });

    // A removed person is forgotten as who gave a folder: it stays given, for who is in charge to take back.
    app.setRight(boss, { computer: THIS_SERVER, person: lea.id, right: "reshares", on: true });
    assert.equal((await give(lea, ana.id, work, true)).status, 200);
    await app.removeUser(boss, lea.id);
    assert.deepEqual(has(ana), [work]);
    assert.deepEqual(app.config.givenBy(THIS_SERVER, ana.id), {});
});

test("what was given is shared on by computer: on for one is not on for another, its one in charge gives it, and the owner needs it too on a runner someone else linked", async () => {
    const boss = owner(app);
    const lin = await person("Each Lin", "guest", { chosen: false });
    const lea = await person("Each Lea", "guest");
    const ana = await person("Each Ana", "guest");
    const tom = await person("Each Tom", "guest");
    const vera = await person("Each Vera", "viewer");
    const laptop = app.config.addRunner("Each laptop", lin.id, newIdentity().publicKey).id;
    const folder = "/srv/each";

    for (const each of [lea, ana, tom, boss]) {
        await app.choosePerson(laptop, each.id, true);
    }

    // A session of the owner's here, and one of Lin's on the laptop: both shared with Lea, the one there with the owner
    // too. Lea has a folder here, and one there, which the owner has as well.
    const here = await session("each: here");
    const there = await session("each: there", lin);

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(there)]!.runner = laptop;
    }, context);
    await app.commands.shareSession(here, boss, [lea.id]);
    await app.commands.shareSession(there, now(lin), [lea.id, boss.id]);
    await app.giveFolders(boss, THIS_SERVER, lea.id, [work]);
    app.config.setGivenFolders(laptop, lea.id, [folder]);
    app.config.setGivenFolders(laptop, boss.id, [folder]);
    app.accessChanged();

    const cannot = "Not a session you can share.";
    const off = /Share what they were given is off for you there/;
    const share = async (by: User, id: ConversationId, target: User = ana) =>
        (await call(by, sharing(target), { share: [Number(id)] })).body.refused?.map(
            (each) => each.reason,
        );
    const give = (by: User, computer: string, path: string, target: User = ana) =>
        call(by, `runners/${computer}/give`, { person: target.id, folder: path, on: true });
    const set = (by: User, computer: string, target: User, on: boolean) =>
        call(by, `runners/${computer}/rights`, { person: target.id, right: "reshares", on });
    /** Whether `user` shares what they were given on this server, and on the laptop. */
    const holds = (user: User) =>
        [THIS_SERVER, laptop].map((each) => app.policy.reshares(now(user), each));
    const offered = (user: User, id: ConversationId) =>
        app.sessions(now(user)).find((each) => each.id === Number(id))?.mayShare;
    /** The folders `by` is offered on `target`'s page, by computer. */
    const told = (by: User, target: User) =>
        app.commands
            .sharingWith(now(by), target.id)
            .computers.map((each) => [each.id, each.folders.map((one) => one.path)]);

    // Off for everyone until it is given: only who is in charge of a computer has it there. The owner is in charge
    // here, and no one special on the laptop.
    assert.deepEqual(holds(lea), [false, false]);
    assert.deepEqual(holds(boss), [true, false]);
    assert.deepEqual(holds(lin), [false, true]);
    assert.deepEqual(await share(lea, here), [cannot]);
    assert.deepEqual(await share(lea, there), [cannot]);

    // The owner turns it on for Lea here: she shares on what she was given here, and nothing on the laptop.
    assert.equal((await set(boss, THIS_SERVER, lea, true)).status, 200);
    assert.deepEqual(holds(lea), [true, false]);
    assert.deepEqual([offered(lea, here), offered(lea, there)], [true, undefined]);
    // A person's page offers her the folders given to her here, and none of the laptop's.
    assert.deepEqual(told(lea, ana), [[THIS_SERVER, [work]]]);
    assert.deepEqual(await share(lea, here), []);
    assert.deepEqual(sharedWith(here), [ana.id, lea.id].sort());
    assert.equal((await give(lea, THIS_SERVER, work)).status, 200);
    assert.deepEqual(await share(lea, there), [cannot]);
    assert.equal(app.canSee(now(ana), there), false);

    const refused = await give(lea, laptop, folder);

    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /You cannot give folders on Each laptop: /);
    assert.match(String(refused.body.error), off);
    assert.deepEqual([...app.config.givenFolders(laptop, ana.id)], []);

    // On the laptop its linker gives it: not the owner, and not Lea herself.
    for (const by of [boss, lea]) {
        const answer = await set(by, laptop, lea, true);

        assert.equal(answer.status, 403, by.name);
        assert.match(String(answer.body.error), /Only whoever is in charge of this computer/);
    }

    assert.equal((await set(lin, laptop, lea, true)).status, 200);
    assert.deepEqual(holds(lea), [true, true]);
    assert.deepEqual(app.config.rightHolders(laptop, "reshares"), [lea.id]);
    assert.deepEqual((await app.hello(now(lea))).user.rights.reshares, [THIS_SERVER, laptop]);
    assert.equal(offered(lea, there), true);
    assert.deepEqual(await share(lea, there), []);
    assert.equal(app.canSee(now(ana), there), true);
    assert.equal((await give(lea, laptop, folder)).status, 200);
    assert.deepEqual(app.config.givenBy(laptop, ana.id), { [folder]: lea.id });

    // The owner there: what was shared with them and given to them they pass on only once Lin lets them.
    assert.equal(offered(boss, there), undefined);
    assert.deepEqual(await share(boss, there, tom), [cannot]);

    const notYet = await give(boss, laptop, folder, tom);

    assert.equal(notYet.status, 403);
    assert.match(String(notYet.body.error), off);
    assert.equal((await set(lin, laptop, boss, true)).status, 200);
    assert.deepEqual(holds(boss), [true, true]);
    assert.equal(offered(boss, there), true);
    assert.deepEqual(await share(boss, there, tom), []);
    assert.equal(app.canSee(now(tom), there), true);
    assert.equal((await give(boss, laptop, folder, tom)).status, 200);
    assert.deepEqual(app.config.givenBy(laptop, tom.id), { [folder]: boss.id });

    // Only someone chosen there who prompts gets it: no viewer, nobody who is not chosen, and who is in charge needs
    // none.
    for (const [answer, said] of [
        [await set(boss, THIS_SERVER, vera, true), /A viewer cannot prompt/],
        [await set(boss, THIS_SERVER, lin, true), /Choose them for this computer first/],
        [await set(lin, laptop, lin, true), /needs no such permission there/],
    ] as const) {
        assert.equal(answer.status, 400, String(said));
        assert.match(String(answer.body.error), said);
    }

    // Taken back here, it stays on the laptop, and what she shared and gave stays.
    assert.equal((await set(boss, THIS_SERVER, lea, false)).status, 200);
    assert.deepEqual(holds(lea), [false, true]);
    // Now a person's page offers her the laptop's folder, and none here.
    assert.deepEqual(told(lea, tom), [[laptop, [folder]]]);
    assert.deepEqual(sharedWith(here), [ana.id, lea.id].sort());
    assert.deepEqual([...app.config.givenFolders(THIS_SERVER, ana.id)], [work]);
    assert.deepEqual(await share(lea, here, tom), [cannot]);

    // No longer chosen for the laptop, she holds nothing there, also when chosen again.
    await app.choosePerson(laptop, lea.id, false);
    assert.deepEqual(app.config.rightHolders(laptop, "reshares"), [boss.id]);
    await app.choosePerson(laptop, lea.id, true);
    assert.deepEqual(holds(lea), [false, false]);
    assert.deepEqual(app.config.rightHolders(laptop, "reshares"), [boss.id]);
});
