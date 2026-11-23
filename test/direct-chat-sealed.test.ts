// The database is not a way for Pi to read a chat. Only the two people get the opened messages, not the key.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test, type TestContext } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PocketApp } from "../src/server/app.ts";
import type { User } from "../src/server/config.ts";
import { directKey } from "../src/server/direct.ts";
import { DirectDoc, DirectIndexDoc, type DirectMessage } from "../src/server/docs.ts";

const unreadable = "This message cannot be read on this server anymore.";
const secretText = () => `Private chat text ${randomUUID()}`;

function fixture(t: TestContext, route?: FauxResponseStep) {
    const data = join(root, randomUUID());
    const model = scriptedModel(route);

    const open = async () => {
        const app = await openApp(model, data);

        t.after(() => app.close());

        return app;
    };

    return { data, keyFile: join(data, "direct.key"), open };
}

const guest = (app: App, name = "Lee") => app.config.addUser(name, "guest").user;
const stored = async (app: App, a: User, b: User) =>
    (await app.harness.snapshot(DirectDoc, directKey(a.id, b.id), context))?.messages ?? [];
const post = (app: App, from: User, to: User, text: string) =>
    app.direct.post(from, to.id, { text, requestId: randomUUID() });
const index = (app: App) => app.harness.snapshot(DirectIndexDoc, context);

async function keepLegacyMessage(app: App, from: User, to: User): Promise<DirectMessage> {
    const key = directKey(from.id, to.id);
    const message: DirectMessage = { id: "legacy", userId: from.id, at: 100, text: secretText() };

    await app.harness.commit(async (tx) => {
        (await tx.doc(DirectDoc, key, null)).messages.push(message);
        (await tx.doc(DirectIndexDoc)).threads[key] = {
            people: [from.id, to.id],
            at: message.at,
            unread: { [to.id]: 1 },
        };
    }, context);

    return message;
}

function absentFromSqlite(data: string, ...texts: string[]): void {
    for (const file of ["pocket.sqlite", "pocket.sqlite-wal"]) {
        const bytes = readFileSync(join(data, file));

        for (const text of texts) {
            assert.equal(bytes.includes(text), false, `${file} holds plaintext chat text`);
        }
    }
}

after(cleanUp);

test("startup with no legacy chats or pending scrub does not vacuum or checkpoint", async (t) => {
    const exec = t.mock.method(DatabaseSync.prototype, "exec");
    const prepare = t.mock.method(DatabaseSync.prototype, "prepare");
    const app = await fixture(t).open();
    const sql = [...exec.mock.calls, ...prepare.mock.calls].map(
        ({ arguments: [statement] }) => statement,
    );

    // The adapter also checkpoints on close. Count only SQL issued during startup.
    assert.ok(sql.includes("PRAGMA journal_mode = WAL"));
    assert.deepEqual(
        sql.filter((statement) => /\b(?:VACUUM|wal_checkpoint)\b/i.test(statement)),
        [],
    );
    assert.equal(await index(app), undefined, "startup does not write the index");
});

test("startup with a busy checkpoint serves sealed chats and retries the scrub on restart", async (t) => {
    const { data, open } = fixture(t);
    let app = await open();
    const from = owner(app);
    const to = guest(app);
    const message = await keepLegacyMessage(app, from, to);
    const logged = t.mock.method(PocketApp.prototype, "log");

    await app.close();
    const reader = new DatabaseSync(join(data, "pocket.sqlite"), { readOnly: true });
    const prepare = t.mock.method(DatabaseSync.prototype, "prepare");

    try {
        reader.exec("BEGIN");
        assert.ok(reader.prepare("SELECT id FROM documents LIMIT 1").get());
        // Leave the transaction open so its snapshot prevents truncating the WAL.
        app = await open();
        const [sealed] = await stored(app, from, to);

        assert.ok(sealed !== undefined && "sealed" in sealed && !("text" in sealed));
        assert.deepEqual(await app.direct.thread(to, from.id), { messages: [message] });
        assert.equal((await index(app))?.scrub, true);
        assert.ok(
            prepare.mock.calls.some(
                ({ arguments: [sql] }) => sql === "PRAGMA wal_checkpoint(TRUNCATE)",
            ),
        );
        assert.deepEqual(
            logged.mock.calls
                .map(({ arguments: [line] }) => line)
                .filter((line) => line.startsWith("Direct chat:")),
            [
                "Direct chat: old plaintext bytes may still be in SQLite. The next start will try again.",
            ],
        );
    } finally {
        reader.close();
    }

    await app.close();
    app = await open();
    assert.equal((await index(app))?.scrub, undefined);
    absentFromSqlite(data, message.text);
    assert.deepEqual(await app.direct.thread(to, from.id), { messages: [message] });
});

test("startup completes a pending scrub even when all messages are already sealed", async (t) => {
    const { data, open } = fixture(t);
    let app = await open();
    const from = owner(app);
    const to = guest(app);
    const message = await keepLegacyMessage(app, from, to);

    await app.close();
    // Fail before VACUUM touches the file: the durable state is the same as a stop just after sealing.
    const exec = DatabaseSync.prototype.exec;
    let failVacuum = true;
    const executed = t.mock.method(
        DatabaseSync.prototype,
        "exec",
        function (this: DatabaseSync, sql: string) {
            if (sql === "VACUUM" && failVacuum) {
                throw new Error("simulated full disk");
            }

            exec.call(this, sql);
        },
    );

    app = await open();
    const sealed = await stored(app, from, to);

    assert.equal(sealed.length, 1);
    assert.ok("sealed" in sealed[0]! && !("text" in sealed[0]!));
    assert.equal((await index(app))?.scrub, true);
    assert.ok(readFileSync(join(data, "pocket.sqlite")).includes(message.text));
    await app.close();

    failVacuum = false;
    app = await open();
    assert.equal(executed.mock.calls.filter(({ arguments: [sql] }) => sql === "VACUUM").length, 2);
    assert.equal((await index(app))?.scrub, undefined);
    assert.deepEqual(await stored(app, from, to), sealed);
    absentFromSqlite(data, message.text);
});

test("new messages are absent from SQLite and WAL and both people read them", async (t) => {
    const { data, keyFile, open } = fixture(t);
    const app = await open();
    const from = owner(app);
    const to = guest(app);
    const text = secretText();

    assert.equal(existsSync(keyFile), false, "the key is lazy");
    const first = await post(app, from, to, text);
    const second = await post(app, from, to, text);

    absentFromSqlite(data, text);
    assert.deepEqual(await app.direct.thread(from, to.id), { messages: [first, second] });
    assert.deepEqual(await app.direct.thread(to, from.id), { messages: [first, second] });
    assert.equal(first.text, text);

    const kept = await stored(app, from, to);
    const nonces = kept.map((message) => {
        assert.ok("sealed" in message && !("text" in message));
        assert.match(message.sealed, /^v1:[\w-]{16}:[\w-]{22}:[\w-]+$/);

        return message.sealed.split(":")[1];
    });

    assert.notEqual(
        nonces[0],
        nonces[1],
        "a fresh nonce for each message, even with identical text",
    );
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64").length, 32);
});

test("startup seals legacy messages, clears old revision bytes, and can run twice", async (t) => {
    const { data, keyFile, open } = fixture(t);
    let app = await open();
    const from = owner(app);
    const to = guest(app);
    const unindexed = guest(app, "Mo");
    const key = directKey(from.id, to.id);
    const first: DirectMessage = { id: "old", userId: from.id, at: 100, text: secretText() };
    const second: DirectMessage = { ...first, id: "newer", at: 101, text: secretText() };
    const orphan: DirectMessage = { ...first, id: "unindexed", text: secretText() };

    await app.harness.commit(async (tx) => {
        (await tx.doc(DirectDoc, key, null)).messages.push(first);
        (await tx.doc(DirectDoc, directKey(from.id, unindexed.id), null)).messages.push(orphan);
        (await tx.doc(DirectIndexDoc)).threads[key] = {
            people: [from.id, to.id],
            at: first.at,
            unread: { [to.id]: 1 },
        };
    }, context);
    // Only the second message is current: startup must also remove the old plaintext revision.
    await app.harness.commit(async (tx) => {
        (await tx.doc(DirectDoc, key, null)).messages.splice(0, 1, second);
    }, context);

    assert.deepEqual(await app.direct.thread(to, from.id), { messages: [second] });
    assert.ok(existsSync(keyFile), "reading an old chat creates the key");
    await app.close();
    const db = readFileSync(join(data, "pocket.sqlite"));

    for (const message of [first, second, orphan]) {
        assert.ok(db.includes(message.text), "the old build stored plaintext");
    }

    app = await open();
    const sealed = await stored(app, from, to);

    assert.equal(sealed.length, 1);
    assert.ok("sealed" in sealed[0]! && !("text" in sealed[0]!));
    assert.ok("sealed" in (await stored(app, from, unindexed))[0]!);
    absentFromSqlite(data, first.text, second.text, orphan.text);
    assert.deepEqual(await app.direct.thread(to, from.id), { messages: [second] });
    assert.deepEqual(await app.direct.thread(unindexed, from.id), { messages: [orphan] });
    assert.deepEqual(app.direct.unread(to), { [from.id]: 1 });
    await app.close();

    app = await open();
    assert.deepEqual(await stored(app, from, to), sealed, "a restart does not seal twice");
    assert.deepEqual(await app.direct.thread(from, to.id), { messages: [second] });
});

test("a sealed message cannot be moved to another thread or message id", async (t) => {
    const app = await fixture(t).open();
    const from = owner(app);
    const to = guest(app);
    const other = guest(app, "Mo");
    const original = await post(app, from, to, secretText());
    const [sealed] = await stored(app, from, to);

    assert.ok(sealed !== undefined && "sealed" in sealed);
    await app.harness.commit(async (tx) => {
        (await tx.doc(DirectDoc, directKey(from.id, other.id), null)).messages.push(sealed);
        (await tx.doc(DirectDoc, directKey(from.id, to.id), null)).messages.push({
            ...sealed,
            id: "changed-id",
        });
    }, context);

    assert.deepEqual(await app.direct.thread(other, from.id), {
        messages: [{ ...original, text: unreadable }],
    });
    assert.deepEqual(await app.direct.thread(to, from.id), {
        messages: [original, { ...original, id: "changed-id", text: unreadable }],
    });
});

test("with a replaced key every message has a fallback and unread counts still work", async (t) => {
    const { keyFile, open } = fixture(t);
    const app = await open();
    const from = owner(app);
    const to = guest(app);
    const messages = [
        await post(app, from, to, secretText()),
        await post(app, from, to, secretText()),
    ];
    const logged = t.mock.method(app, "log", (_line: string) => {});

    writeFileSync(keyFile, `${randomBytes(32).toString("base64")}\n`);
    const tab = fakeTab(undefined, to);

    await app.attach(tab.client);
    t.after(() => app.detach(tab.client));
    assert.deepEqual(app.direct.unread(to), { [from.id]: 2 });
    assert.deepEqual(tab.last("direct-unread"), { [from.id]: 2 });
    assert.equal(app.people(to).find((person) => person.id === from.id)?.mayMessage, true);

    for (const [a, b] of [
        [from, to],
        [to, from],
    ] as const) {
        assert.deepEqual(await app.direct.thread(a, b.id), {
            messages: messages.map((message) => ({ ...message, text: unreadable })),
        });
    }

    assert.deepEqual(
        logged.mock.calls.map(({ arguments: args }) => args),
        [[`Direct chat ${directKey(from.id, to.id)}: could not decrypt a message`]],
    );
    await app.direct.read(to, from.id);
    assert.deepEqual(app.direct.unread(to), {});
});

test("Lancet Guard blocks direct.key before it exists but lets bash and read use a neighboring file", async (t) => {
    const results: string[] = [];

    const route: FauxResponseStep = (request) => {
        const { role, text } = lastText(request as never);

        if (role === "toolResult") {
            results.push(text);

            return fauxAssistantMessage([fauxText("Done.")]);
        }

        const [tool, path] = text.replace(/^\[from: [^\]]+\] /, "").split(" ");
        const call =
            tool === "bash"
                ? fauxToolCall("bash", { command: `cat ${path}` })
                : fauxToolCall("read", { path: path! });

        return fauxAssistantMessage([call], { stopReason: "toolUse" });
    };

    const { data, keyFile, open } = fixture(t, route);
    const app = await open();
    const from = owner(app);
    const to = guest(app);
    const dump = join(data, "neighbor.txt");

    await app.setExtensionEnabled(from, "guard.ts", true);
    const id = await newSession(app);

    const turn = async (text: string) => {
        const before = results.length;

        await say(app, id, text);
        assert.equal(results.length, before + 1);

        return results[before]!;
    };

    assert.equal(existsSync(keyFile), false);

    for (const tool of ["bash", "read"]) {
        assert.match(
            await turn(`${tool} ${keyFile}`),
            new RegExp(`Lancet Guard blocked this ${tool} call`),
        );
    }

    await post(app, from, to, secretText());
    const value = readFileSync(keyFile, "utf8").trim();

    writeFileSync(dump, `ordinary output\n${value}\n`, { mode: 0o600 });

    for (const tool of ["bash", "read"]) {
        assert.match(
            await turn(`${tool} ${keyFile}`),
            new RegExp(`Lancet Guard blocked this ${tool} call`),
        );
        const allowed = await turn(`${tool} ${dump}`);

        assert.equal(
            allowed.includes(value),
            false,
            "the tool result hides the key from the model",
        );
        assert.match(allowed, /ordinary output/);
        assert.match(allowed, /\[direct chat key\]/);
    }

    const transcript = JSON.stringify(await app.transcripts.allEntries(id, true));

    assert.equal(
        transcript.includes(value),
        false,
        "the tool result hides the key from the transcript",
    );
    assert.match(transcript, /\[direct chat key\]/);
});
