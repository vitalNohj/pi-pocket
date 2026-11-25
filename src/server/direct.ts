/**
 * Chat between two people, on a person's page in People. Only the two read a thread: no route, event, or push gives a
 * thread or a count to anyone else, and Pi never sees one. Who may chat is `access.ts` `mayMessage`. The unread counts
 * live on the server, in the index, so every device of a person shows the same without opening any messages.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, type Storage } from "@earendil-works/pi-durable";
import { NO_CHAT } from "./access.ts";
import type { PocketApp } from "./app.ts";
import { chatKey, chatKeyForReading, chatKeys, open, seal, UNREADABLE } from "./chat-seal.ts";
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

// A new base drops the whole old revision chain, not just the plaintext in the latest value.
const SealingDirectDoc = defineDocFamily({ ...DirectDoc.definition, checkpointWhen: () => true });

function aad(thread: string, id: string): Buffer {
    return Buffer.from(JSON.stringify([thread, id]));
}

function sealMessage(
    thread: string,
    { id, userId, at, text }: DirectMessage,
    key: Buffer,
): SealedDirectMessage {
    return { id, userId, at, sealed: seal(key, aad(thread, id), text) };
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

    #message(
        thread: string,
        message: Readonly<StoredDirectMessage>,
        key: Buffer | undefined,
    ): DirectMessage {
        const { id, userId, at } = message;

        if (!("sealed" in message)) {
            return { id, userId, at, text: message.text };
        }

        const text = key === undefined ? undefined : open(key, aad(thread, id), message.sealed);

        if (text === undefined && !this.#warned.has(thread)) {
            this.#warned.add(thread);
            this.#app.log(`Direct chat ${thread}: could not decrypt a message`);
        }

        return { id, userId, at, text: text ?? UNREADABLE };
    }

    /** At startup: seal legacy threads and mark their old bytes for scrubbing. */
    async sealLegacy(storage: Storage): Promise<void> {
        const { harness } = this.#app;

        for await (const key of chatKeys(storage, DirectDoc.definition.kind)) {
            const doc = await harness.snapshot(DirectDoc, key, context);

            if (!doc?.messages.some((message) => !("sealed" in message))) {
                continue;
            }

            const bytes = chatKey(this.#app);

            await harness.commit(async (tx) => {
                const thread = await tx.doc(SealingDirectDoc, key, null);

                thread.messages = thread.messages.map((message) =>
                    "sealed" in message ? { ...message } : sealMessage(key, message, bytes),
                );
                (await tx.doc(DirectIndexDoc)).scrub = true;
            }, context);
        }
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
        const key = chatKeyForReading(this.#app);

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
            const sealed = sealMessage(
                key,
                { id: messageId, userId: user.id, at, text },
                chatKey(app),
            );

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
            return this.#message(key, kept, chatKeyForReading(app));
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
