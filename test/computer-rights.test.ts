// The rights who is in charge of a computer gives one person at a time there (`access.ts` `overridesTurns`,
// `allowsOwn`): to take the wheel from a driver, and to allow a call their own message led to while approvals need
// someone else. Set over `POST /api/runners/:id/rights`, by the owner for this server and by a runner's linker there.
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import {
    addPerson,
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "../src/server/access.ts";
import type { ServerView } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

const route: FauxResponseStep = (request) =>
    fauxAssistantMessage([fauxText(`echo: ${lastText(request as never).text}`)]);

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();
let alex: User;
let bea: User;
let vera: User;
let nell: User;
let host: User;
let laptop: string;

async function person(name: string, role: User["role"]): Promise<User> {
    const { user, token } = await addPerson(app, name, role);

    tokens.set(user.id, token);

    return user;
}

async function call<T = Record<string, unknown>>(
    user: User,
    path: string,
    body: unknown,
): Promise<{ status: number; body: T }> {
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

    return { status: response.status, body: (await response.json()) as T };
}

/** Send a message as `user` and wait for the answer, so they are the one who asked for what Pi does next. */
async function sayAs(user: User, id: ConversationId, text: string): Promise<void> {
    const { submissionId } = await app.commands.submit(id, user, {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

let calls = 0;

/** Ask for approval of a bash call, as Lancet Guard does. Resolves with the answer. */
function ask(id: ConversationId, subject: string) {
    const request = {
        id: `approval-${++calls}`,
        conversationId: id,
        taskId: calls as never,
        callId: `call-${calls}`,
        tool: "bash",
        subject,
        reason: "risky",
        createdAt: Date.now(),
    };

    return { request, answered: app.approvals.request(request, context) };
}

before(async () => {
    app = await openApp(scriptedModel(route));
    alex = await person("Alex", "guest");
    bea = await person("Bea", "guest");
    vera = await person("Vera", "viewer");

    // Nell has an account and is chosen for no computer; Host linked a computer of their own.
    const added = app.config.addUser("Nell", "guest");

    nell = added.user;
    tokens.set(nell.id, added.token);

    const linked = app.config.addUser("Host", "guest");

    host = linked.user;
    tokens.set(host.id, linked.token);
    laptop = app.config.addRunner("Laptop", host.id, newIdentity().publicKey).id;
    app.config.setUsers(laptop, [owner(app).id, alex.id]);

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

test("the owner gives a chosen user a right on this server, and takes it back; nobody else does, and nobody else gets one", async () => {
    const rights = `runners/${THIS_SERVER}/rights`;

    assert.deepEqual((await app.hello(alex)).user.rights.wheel, [], "none until it is given");
    assert.deepEqual((await app.hello(alex)).user.rights.allows, []);
    assert.deepEqual(
        (await app.hello(owner(app))).user.rights.wheel,
        [THIS_SERVER],
        "theirs: in charge",
    );

    // Refused: a user gives none, also not to themselves.
    for (const by of [alex, bea, vera, host]) {
        const refused = await call(by, rights, { person: alex.id, right: "wheel", on: true });

        assert.equal(refused.status, 403, by.name);
    }

    // Refused: a viewer, someone not chosen here, the owner themselves, nobody, and a right there is none of.
    for (const [who, body] of [
        ["a viewer", { person: vera.id, right: "wheel", on: true }],
        ["not chosen", { person: nell.id, right: "wheel", on: true }],
        ["in charge", { person: owner(app).id, right: "wheel", on: true }],
        ["nobody", { person: "nobody", right: "wheel", on: true }],
        ["no such right", { person: alex.id, right: "everything", on: true }],
        ["no answer", { person: alex.id, right: "wheel" }],
    ] as const) {
        assert.equal((await call(owner(app), rights, body)).status, 400, who);
    }

    assert.deepEqual(app.config.server.rights?.wheel, undefined, "a refusal saved nothing");

    const given = await call<ServerView>(owner(app), rights, {
        person: alex.id,
        right: "wheel",
        on: true,
    });

    assert.equal(given.status, 200);
    assert.deepEqual(given.body.rights.wheel, [alex.id], "the answer is the computer as it is now");
    assert.deepEqual(given.body.rights.allows, [], "one right is not the other");
    assert.equal(app.policy.overridesTurns(alex, THIS_SERVER), true);
    assert.equal(app.policy.allowsOwn(alex, THIS_SERVER), false);
    assert.equal(app.policy.overridesTurns(bea, THIS_SERVER), false, "and it is each person's own");
    assert.deepEqual((await app.hello(alex)).user.rights.wheel, [THIS_SERVER]);
    assert.deepEqual((await app.hello(bea)).user.rights.wheel, []);

    // Given twice is given once.
    await call(owner(app), rights, { person: alex.id, right: "wheel", on: true });
    assert.deepEqual(app.config.server.rights?.wheel, [alex.id]);

    const taken = await call<ServerView>(owner(app), rights, {
        person: alex.id,
        right: "wheel",
        on: false,
    });

    assert.deepEqual(taken.body.rights.wheel, []);
    assert.equal(app.config.server.rights?.wheel, undefined, "nobody holds it: no entry is kept");
    assert.equal(app.policy.overridesTurns(alex, THIS_SERVER), false);
});

test("on a runner someone else linked, its linker gives the rights, and the owner does not", async () => {
    const rights = `runners/${laptop}/rights`;

    assert.equal(app.policy.overridesTurns(host, laptop), true, "in charge there");
    assert.equal(
        app.policy.overridesTurns(owner(app), laptop),
        false,
        "the owner is one of its people",
    );
    assert.equal(app.policy.allowsOwn(owner(app), laptop), false);

    for (const by of [owner(app), alex]) {
        assert.equal(
            (await call(by, rights, { person: alex.id, right: "allows", on: true })).status,
            403,
            by.name,
        );
    }

    const given = await call<{ rights: { wheel: string[]; allows: string[] } }>(host, rights, {
        person: owner(app).id,
        right: "allows",
        on: true,
    });

    assert.equal(given.status, 200);
    assert.deepEqual(given.body.rights.allows, [owner(app).id]);
    assert.deepEqual(given.body.rights.wheel, []);
    assert.equal(app.policy.allowsOwn(owner(app), laptop), true);
    assert.equal(app.policy.overridesTurns(owner(app), laptop), false);
    assert.deepEqual((await app.hello(owner(app))).user.rights.allows, [THIS_SERVER, laptop]);
    assert.equal(app.policy.allowsOwn(alex, laptop), false, "chosen there too, and not given it");

    // A right there is not one here, nor the other way.
    assert.equal(app.policy.allowsOwn(host, THIS_SERVER), false);

    // No longer chosen there, the owner holds nothing there; chosen again, still nothing.
    await app.choosePerson(laptop, owner(app).id, false);
    assert.equal(app.config.runnerById(laptop)?.rights?.allows, undefined);
    assert.equal(app.policy.allowsOwn(owner(app), laptop), false);
    await app.choosePerson(laptop, owner(app).id, true);
    assert.equal(app.policy.allowsOwn(owner(app), laptop), false);
});

test("take turns: a user takes the wheel from a driver who is here only once who is in charge lets them", async () => {
    const id = await newSession(app);
    const alexTab = fakeTab(id, alex);
    const beaTab = fakeTab(id, bea);
    const driver = () => alexTab.field("turns") as { on?: boolean; driver?: string } | undefined;

    try {
        await app.attach(alexTab.client);
        await app.attach(beaTab.client);
        await app.collab.turns(id, bea, { action: "on" });
        await until(() => driver()?.driver === bea.id, "Bea to drive");

        // Refused: Bea is here and driving.
        await assert.rejects(app.collab.turns(id, alex, { action: "claim" }), {
            status: 409,
            message: "Bea is driving. Ask to drive instead.",
        });
        await assert.rejects(app.collab.turns(id, alex, { action: "off" }), {
            status: 409,
            message: "Bea is driving. Ask them to turn take turns off.",
        });
        await assert.rejects(app.collab.turns(id, alex, { action: "handover", to: alex.id }), {
            status: 403,
            message: "Only the driver can hand over the wheel",
        });

        app.setRight(owner(app), {
            computer: THIS_SERVER,
            person: alex.id,
            right: "wheel",
            on: true,
        });

        // Allowed now, each of the three.
        await app.collab.turns(id, alex, { action: "claim" });
        await until(() => driver()?.driver === alex.id, "Alex to drive");
        await app.collab.turns(id, bea, { action: "ask" });
        await assert.rejects(
            app.collab.turns(id, bea, { action: "claim" }),
            /Alex is driving/,
            "Bea was given nothing",
        );
        await app.collab.turns(id, alex, { action: "handover", to: bea.id });
        await until(() => driver()?.driver === bea.id, "Bea to drive again");
        await app.collab.turns(id, alex, { action: "handover", to: alex.id });
        await until(() => driver()?.driver === alex.id, "Alex to hand it to themselves for her");
        await app.collab.turns(id, alex, { action: "handover", to: bea.id });
        await until(() => driver()?.driver === bea.id, "Bea to drive once more");
        await app.collab.turns(id, alex, { action: "off" });
        await until(() => driver()?.on === false, "take turns to go off under her");

        // Taken back: as before.
        await app.collab.turns(id, bea, { action: "on" });
        await until(() => driver()?.driver === bea.id, "Bea to drive a last time");
        app.setRight(owner(app), {
            computer: THIS_SERVER,
            person: alex.id,
            right: "wheel",
            on: false,
        });
        await assert.rejects(app.collab.turns(id, alex, { action: "claim" }), /Bea is driving/);

        // The owner, in charge here, needs nobody's leave.
        await app.collab.turns(id, owner(app), { action: "off" });
    } finally {
        app.detach(alexTab.client);
        app.detach(beaTab.client);
    }
});

test("with approvals that need someone else, a user allows their own call only once who is in charge lets them", async () => {
    await app.setApprovalRule(owner(app), "others");

    try {
        const id = await newSession(app);

        await sayAs(alex, id, "clean up the build folder");

        const first = ask(id, "rm -rf build");

        assert.equal(app.approvals.forConversation(id)[0]?.requestedBy, alex.id);
        await assert.rejects(app.answerApproval(first.request.id, true, alex), {
            status: 403,
            message: "Someone else has to allow a call that your message led to.",
        });

        // The other right does not count for it.
        app.setRight(owner(app), {
            computer: THIS_SERVER,
            person: alex.id,
            right: "wheel",
            on: true,
        });
        await assert.rejects(app.answerApproval(first.request.id, true, alex), { status: 403 });

        app.setRight(owner(app), {
            computer: THIS_SERVER,
            person: alex.id,
            right: "allows",
            on: true,
        });
        assert.equal(await app.answerApproval(first.request.id, true, alex), true);
        assert.deepEqual(await first.answered, { allow: true, by: "Alex" });

        // Bea's own call is still someone else's to allow: the right is Alex's alone.
        await sayAs(bea, id, "and the dist folder");

        const second = ask(id, "rm -rf dist");

        await assert.rejects(app.answerApproval(second.request.id, true, bea), { status: 403 });
        assert.equal(await app.answerApproval(second.request.id, true, alex), true);
        await second.answered;

        // A call nobody is known to have asked for stays with who is in charge, right or no right.
        const quiet = await newSession(app);
        const third = ask(quiet, "rm -rf cache");

        assert.equal(app.approvals.forConversation(quiet)[0]?.requestedBy, undefined);
        await assert.rejects(app.answerApproval(third.request.id, true, alex), {
            status: 403,
            message:
                "Nobody is known to have asked for this call, so only the owner, or someone who manages runners, can allow it.",
        });
        assert.equal(await app.answerApproval(third.request.id, true, owner(app)), true);
        await third.answered;

        // So does who manages runners: in charge of this server as the owner is, they allow it too.
        const mona = await person("Mona", "guest");
        const unasked = ask(quiet, "rm -rf logs");

        await assert.rejects(app.answerApproval(unasked.request.id, true, mona), { status: 403 });
        app.setRight(owner(app), { person: mona.id, right: "managesRunners", on: true });
        assert.equal(
            await app.answerApproval(unasked.request.id, true, app.config.userById(mona.id)!),
            true,
        );
        assert.deepEqual(await unasked.answered, { allow: true, by: "Mona" });
        app.setRight(owner(app), { person: mona.id, right: "managesRunners", on: false });
        await app.settle();

        // Taken back: as before.
        app.setRight(owner(app), {
            computer: THIS_SERVER,
            person: alex.id,
            right: "allows",
            on: false,
        });
        await sayAs(alex, id, "and the tmp folder");

        const fourth = ask(id, "rm -rf tmp");

        await assert.rejects(app.answerApproval(fourth.request.id, true, alex), {
            status: 403,
            message: "Someone else has to allow a call that your message led to.",
        });
        assert.equal(
            await app.answerApproval(fourth.request.id, false, alex),
            true,
            "denying is open",
        );
        await fourth.answered;
    } finally {
        await app.setApprovalRule(owner(app), "anyone");
    }
});

test("no longer chosen for a computer, a person keeps no right there, also when chosen again; a removed person none anywhere", async () => {
    app.setRight(owner(app), { computer: THIS_SERVER, person: alex.id, right: "wheel", on: true });
    app.setRight(owner(app), { computer: THIS_SERVER, person: alex.id, right: "allows", on: true });
    app.setRight(owner(app), { computer: THIS_SERVER, person: bea.id, right: "wheel", on: true });
    assert.deepEqual(app.config.server.rights?.wheel, [alex.id, bea.id]);

    await app.choosePerson(THIS_SERVER, alex.id, false);
    assert.deepEqual(app.config.server.rights?.wheel, [bea.id], "Bea's stays");
    assert.equal(app.config.server.rights?.allows, undefined);
    await app.choosePerson(THIS_SERVER, alex.id, true);
    assert.equal(app.policy.overridesTurns(alex, THIS_SERVER), false);
    assert.equal(app.policy.allowsOwn(alex, THIS_SERVER), false);

    // Made a viewer, Bea holds it in name only: a viewer prompts nowhere.
    app.config.giveRole(bea.id, "viewer");
    assert.equal(app.policy.overridesTurns(bea, THIS_SERVER), false);
    app.config.giveRole(bea.id, "guest");
    assert.equal(app.policy.overridesTurns(bea, THIS_SERVER), true);

    await app.removeUser(owner(app), bea.id);
    assert.equal(app.config.server.rights?.wheel, undefined);
});
