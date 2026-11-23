/**
 * Chat between two people, on a person's page in People. Only the two read a thread: no route, event, or push gives a
 * thread or a count to anyone else, and Pi never sees one. Who may chat is `access.ts` `mayMessage`. The unread counts
 * live on the server, in the index, so every device of a person shows the same without opening any messages.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { type Cursor, defineDocFamily, type Storage } from "@earendil-works/pi-durable";
import { NO_CHAT } from "./access.ts";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    DIRECT_LIMIT,
    DirectDoc,
    DirectIndexDoc,
    type DirectIndexValue,
    type DirectMessage,
    type DirectThread,
    type SealedDirectMessage,
    type StoredDirectMessage,
} from "./docs.ts";
import { HttpError } from "./errors.ts";
import { clientKey } from "./requests.ts";
import type { Client } from "./room.ts";

const context = BACKGROUND_CONTEXT;

const MAX_DIRECT_TEXT = 4000;
const KEY_FILE = "direct.key";
const KEY_STAGE = "direct.key.tmp";
const UNREADABLE = "This message cannot be read on this server anymore.";

// A new base drops the whole old revision chain, not just the plaintext in the latest value.
const SealingDirectDoc = defineDocFamily({ ...DirectDoc.definition, checkpointWhen: () => true });

function aad(thread: string, id: string): Buffer {
    return Buffer.from(JSON.stringify([thread, id]));
}

function seal(
    thread: string,
    { id, userId, at, text }: DirectMessage,
    key: Buffer,
): SealedDirectMessage {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });

    cipher.setAAD(aad(thread, id));
    // Text is the only written payload. JSON also preserves any lone surrogates in it.
    const data = Buffer.concat([cipher.update(JSON.stringify({ text })), cipher.final()]);
    const sealed = [nonce, cipher.getAuthTag(), data].map((part) => part.toString("base64url"));

    return { id, userId, at, sealed: `v1:${sealed.join(":")}` };
}

/** The key of the thread between two people: their ids, sorted, so both name the same one. */
export function directKey(a: string, b: string): string {
    return [a, b].sort().join(":");
}

/** Add a message to a thread, within a commit, and drop the oldest past `limit`. */
export function addDirect(
    thread: { messages: StoredDirectMessage[] },
    message: SealedDirectMessage,
    limit = DIRECT_LIMIT,
): void {
    thread.messages.push(message);

    if (thread.messages.length > limit) {
        thread.messages.splice(0, thread.messages.length - limit);
    }
}

export class Direct {
    readonly #app: PocketApp;
    /** The committed index, by thread key: what each person is told comes from here, without a read. */
    #threads: Record<string, DirectThread> = {};
    /** The counts each tab last got, as JSON, so a change elsewhere does not send them again. */
    readonly #told = new WeakMap<Client, string>();
    readonly #warned = new Set<string>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Register even before either file exists. Protect the staging file too if a write is cut short. */
    watchKey(): void {
        for (const name of [KEY_FILE, KEY_STAGE]) {
            this.#app.secrets.watchFile({
                path: join(this.#app.dataDir, name),
                read: (text) => [{ value: text.trim(), label: "direct chat key" }],
            });
        }
    }

    #key(): Buffer {
        const app = this.#app;
        const path = join(app.dataDir, KEY_FILE);
        let encoded: string;

        try {
            // Read again for each operation, so a missing or replaced key does not use a stale copy.
            encoded = readFileSync(path, "utf8").trim();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }

            const key = randomBytes(32);
            const stage = join(app.dataDir, KEY_STAGE);

            // The app holds the data folder's lock. Publish a complete key before any commit can use it.
            rmSync(stage, { force: true });
            writeFileSync(stage, `${key.toString("base64")}\n`, {
                flag: "wx",
                mode: 0o600,
                flush: true,
            });
            renameSync(stage, path);
            app.secrets.sync();

            return key;
        }

        const key = Buffer.from(encoded, "base64");

        if (key.length !== 32 || key.toString("base64") !== encoded) {
            throw new Error("Invalid direct chat key file");
        }

        return key;
    }

    #keyForReading(): Buffer | undefined {
        try {
            return this.#key();
        } catch {
            // A bad key file must not stop someone from opening their chat.
            return undefined;
        }
    }

    #message(
        thread: string,
        message: Readonly<StoredDirectMessage>,
        key: Buffer | undefined,
    ): DirectMessage {
        const { id, userId, at } = message;

        if (!("sealed" in message)) {
            return { id, userId, at, text: message.text };
        }

        const parts = /^v1:([\w-]{16}):([\w-]{22}):([\w-]+)$/.exec(message.sealed);

        if (key !== undefined && parts !== null) {
            try {
                const nonce = Buffer.from(parts[1]!, "base64url");
                const cipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });

                cipher.setAAD(aad(thread, id));
                cipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
                const data = Buffer.concat([
                    cipher.update(Buffer.from(parts[3]!, "base64url")),
                    cipher.final(),
                ]);
                const payload = JSON.parse(data.toString("utf8")) as { text?: unknown };

                if (typeof payload.text === "string") {
                    return { id, userId, at, text: payload.text };
                }
            } catch {
                // Do not report untrusted input or error details to the log.
            }
        }

        if (!this.#warned.has(thread)) {
            this.#warned.add(thread);
            this.#app.log(`Direct chat ${thread}: could not decrypt a message`);
        }

        return { id, userId, at, text: UNREADABLE };
    }

    /** At startup: seal legacy threads and mark their old bytes for scrubbing. Retry unfinished scrubs on startup. */
    async sealLegacy(storage: Storage, database: SqliteDatabase): Promise<void> {
        const harness = this.#app.harness;
        const query = {
            scope: { kind: "session" },
            kind: DirectDoc.definition.kind,
            at: "current",
        } as const;
        let cursor: Cursor | undefined;

        do {
            const page = await storage.scanDocuments(query, 256, cursor, context);

            for (const { key } of page.items) {
                if (key === undefined) {
                    continue;
                }

                const doc = await harness.snapshot(DirectDoc, key, context);

                if (!doc?.messages.some((message) => !("sealed" in message))) {
                    continue;
                }

                const bytes = this.#key();

                await harness.commit(async (tx) => {
                    const thread = await tx.doc(SealingDirectDoc, key, null);

                    thread.messages = thread.messages.map((message) =>
                        "sealed" in message ? { ...message } : seal(key, message, bytes),
                    );
                    (await tx.doc(DirectIndexDoc)).scrub = true;
                }, context);
            }

            cursor = page.next;
        } while (cursor !== undefined);

        if ((await harness.snapshot(DirectIndexDoc, context))?.scrub !== true) {
            return;
        }

        let scrubbed = false;

        try {
            // A base removes old rows, but their bytes can still be in free pages or frames in the WAL.
            await database.exec("VACUUM");
            const checkpoint = await database.get<{ busy: number }>(
                "PRAGMA wal_checkpoint(TRUNCATE)",
            );

            scrubbed = checkpoint?.busy === 0;
        } catch {
            // A cleanup failure, such as no space to rebuild the database, does not stop startup.
        }

        if (!scrubbed) {
            this.#app.log(
                "Direct chat: old plaintext bytes may still be in SQLite. The next start will try again.",
            );

            return;
        }

        await harness.commit(async (tx) => {
            delete (await tx.doc(DirectIndexDoc)).scrub;
        }, context);
    }

    /** At start, before any tab: the threads and counts from the stored index. */
    load(value: Readonly<DirectIndexValue> | null | undefined): void {
        this.#threads = structuredClone(value?.threads ?? {});
    }

    /** The index changed in a commit: keep it, and tell each tab whose counts changed. */
    committed(value: Readonly<DirectIndexValue> | null | undefined): void {
        this.load(value);
        this.tell();
    }

    /**
     * What `user` has not read, by the other person's id: only from people they may chat with now. A count of someone
     * who lost the chat stays stored, and shows again when they have it again.
     */
    unread(user: User): Record<string, number> {
        const counts: Record<string, number> = {};

        for (const thread of Object.values(this.#threads)) {
            const count = Object.hasOwn(thread.unread, user.id) ? thread.unread[user.id]! : 0;
            const other = thread.people[0] === user.id ? thread.people[1] : thread.people[0];

            if (
                count > 0 &&
                thread.people.includes(user.id) &&
                this.#app.policy.mayMessage(user, { id: other })
            ) {
                counts[other] = count;
            }
        }

        return counts;
    }

    /** Send the counts to one tab (always), or to every tab whose counts changed since they were last sent. */
    tell(client?: Client): void {
        for (const each of client === undefined ? this.#app.clients : [client]) {
            const counts = this.unread(each.user);
            const json = JSON.stringify(counts);

            if (client === undefined && this.#told.get(each) === json) {
                continue;
            }

            this.#told.set(each, json);
            each.send("direct-unread", counts);
        }
    }

    /** The thread between `user` and `otherId`: empty when they never wrote. */
    async thread(user: User, otherId: string): Promise<{ messages: DirectMessage[] }> {
        this.#app.policy.requireMessage(user, { id: otherId });
        const thread = directKey(user.id, otherId);
        const doc = await this.#app.harness.snapshot(DirectDoc, thread, context);
        const key = this.#keyForReading();

        return {
            messages: (doc?.messages ?? []).map((message) => this.#message(thread, message, key)),
        };
    }

    /** `user` writes to `otherId`. A retried send (the same `requestId`) returns the first message and adds nothing. */
    async post(
        user: User,
        otherId: string,
        request: { text: string; requestId: string },
    ): Promise<DirectMessage> {
        const app = this.#app;

        app.policy.requireMessage(user, { id: otherId });
        const text = request.text.trim();

        if (text === "") {
            throw new HttpError(400, "Message is empty");
        }

        if (text.length > MAX_DIRECT_TEXT) {
            throw new HttpError(413, `Chat messages are limited to ${MAX_DIRECT_TEXT} characters`);
        }

        const key = directKey(user.id, otherId);
        const messageId = `${user.id.slice(0, 8)}-${clientKey(request.requestId)}`;
        const { kept, created } = await app.harness.commit(async (tx) => {
            // A role or a right can change while the request waits: judged again where the message is stored.
            if (!app.policy.mayMessage(user, { id: otherId })) {
                throw new HttpError(403, NO_CHAT);
            }

            const doc = await tx.doc(DirectDoc, key, null);
            const existing = doc.messages.find((each) => each.id === messageId);

            if (existing !== undefined) {
                return { kept: { ...existing }, created: false } as const;
            }

            const at = Date.now();
            const sealed = seal(key, { id: messageId, userId: user.id, at, text }, this.#key());

            addDirect(doc, sealed);

            const index = await tx.doc(DirectIndexDoc);
            const thread = Object.hasOwn(index.threads, key) ? index.threads[key] : undefined;

            if (thread === undefined) {
                index.threads[key] = {
                    people: [user.id, otherId].sort() as [string, string],
                    at,
                    unread: { [otherId]: 1 },
                };
            } else {
                thread.at = at;
                thread.unread[otherId] =
                    (Object.hasOwn(thread.unread, otherId) ? thread.unread[otherId]! : 0) + 1;
            }

            return { kept: sealed, created: true } as const;
        }, context);

        if (!created) {
            return this.#message(key, kept, this.#keyForReading());
        }

        const message: DirectMessage = { id: kept.id, userId: kept.userId, at: kept.at, text };

        for (const client of app.clients) {
            if (client.user.id === user.id) {
                client.send("direct", { person: otherId, messages: [message] });
            } else if (client.user.id === otherId) {
                client.send("direct", { person: user.id, messages: [message] });
            }
        }

        this.#notify(user, otherId, message);

        return message;
    }

    /** `user` read the thread with `otherId`: their count goes, on every device. */
    async read(user: User, otherId: string): Promise<void> {
        this.#app.policy.requireMessage(user, { id: otherId });
        const key = directKey(user.id, otherId);

        await this.#app.harness.commit(async (tx) => {
            const index = await tx.doc(DirectIndexDoc);
            const thread = Object.hasOwn(index.threads, key) ? index.threads[key] : undefined;

            if (thread !== undefined && Object.hasOwn(thread.unread, user.id)) {
                delete thread.unread[user.id];
            }
        }, context);
    }

    /** A removed person: every thread of theirs goes, with its counts. */
    async forget(userId: string): Promise<void> {
        await this.#retire((thread) => thread.people.includes(userId));
    }

    /** At start: the threads of people whose removal a restart cut short before `forget` was saved. */
    async forgetGone(): Promise<void> {
        const app = this.#app;
        const gone = (thread: DirectThread) =>
            thread.people.some((id) => app.config.userById(id) === undefined);

        if (Object.values(this.#threads).some(gone)) {
            await this.#retire(gone);
        }
    }

    async #retire(which: (thread: DirectThread) => boolean): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const index = await tx.doc(DirectIndexDoc);

            for (const [key, thread] of Object.entries(index.threads)) {
                if (which(thread)) {
                    await tx.retireDoc(DirectDoc, key);
                    delete index.threads[key];
                }
            }
        }, context);
    }

    /** A push to the other person, unless they are looking (`alerts.ts` `direct`). */
    #notify(from: User, to: string, message: DirectMessage): void {
        const other = this.#app.config.userById(to);

        if (other !== undefined) {
            this.#app.alerts.direct(from, other, message);
        }
    }
}
