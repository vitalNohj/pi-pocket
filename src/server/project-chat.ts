/** The people chat shared by sessions in the same folder on one computer. Pi never sees it. */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDocFamily, type Storage } from "@earendil-works/pi-durable";
import { THIS_SERVER } from "./access.ts";
import type { PocketApp } from "./app.ts";
import {
    chatKey,
    chatKeyAtStart,
    chatKeyForReading,
    chatKeys,
    open,
    seal,
    UNREADABLE,
} from "./chat-seal.ts";
import { chatMentions, MAX_CHAT_TEXT } from "./collab.ts";
import type { User } from "./config.ts";
import {
    CHAT_LIMIT,
    ProjectChatDoc,
    ProjectChatIndexDoc,
    type ProjectChatMessage,
    type SealedProjectChatMessage,
    type StoredProjectChatMessage,
} from "./docs.ts";
import { HttpError } from "./errors.ts";
import { clientKey } from "./requests.ts";

const context = BACKGROUND_CONTEXT;
const noChat = () => new HttpError(404, "No project chat here.");

type Place = { key: string; computer: string; folder: string };

function projectChatKey(computer: string, folder: string): string {
    return createHash("sha256").update(`${computer}\n${folder}`).digest("hex").slice(0, 32);
}

// A new base drops old revisions, including plain messages no longer in the chat.
const SealingProjectChatDoc = defineDocFamily({
    ...ProjectChatDoc.definition,
    checkpointWhen: () => true,
});

function aad(key: string, id: string): Buffer {
    return Buffer.from(JSON.stringify(["project-chat", key, id]));
}

function sealMessage(
    key: string,
    { text, mentions, ...metadata }: ProjectChatMessage,
    bytes: Buffer,
): SealedProjectChatMessage {
    return {
        ...metadata,
        ...(mentions === undefined ? {} : { mentions: [...mentions] }),
        sealed: seal(bytes, aad(key, metadata.id), text),
    };
}

export class ProjectChat {
    readonly #app: PocketApp;
    readonly #warned = new Set<string>();
    /** Old plain messages are still stored, since this start could not seal them: retiring one leaves bytes to scrub. */
    #plain = false;
    #setting = Promise.resolve();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    on(): boolean {
        return this.#app.config.server.projectChat !== false;
    }

    /** Seal old chats and mark the index while old plain bytes may still be in SQLite. */
    async sealLegacy(storage: Storage): Promise<void> {
        const { harness } = this.#app;
        const index = await harness.snapshot(ProjectChatIndexDoc, context);
        let markIndex = index !== undefined && index.sealed !== true;

        for await (const key of chatKeys(storage, ProjectChatDoc.definition.kind)) {
            const doc = await harness.snapshot(ProjectChatDoc, key, context);

            if (!doc?.messages.some((message) => !("sealed" in message))) {
                continue;
            }

            const bytes = chatKeyAtStart(this.#app, "Project chat");

            if (bytes === undefined) {
                this.#plain = true;

                return;
            }

            await harness.commit(async (tx) => {
                const chat = await tx.doc(SealingProjectChatDoc, key, null);
                const index = await tx.doc(ProjectChatIndexDoc);

                for (const [i, message] of chat.messages.entries()) {
                    if (!("sealed" in message)) {
                        chat.messages[i] = sealMessage(key, message, bytes);
                    }
                }

                index.sealed = true;
                index.scrub = true;
            }, context);
            markIndex = false;
        }

        // Chats retired before sealing may have left plain bytes in free pages, even with no chat left to read.
        if (markIndex) {
            await harness.commit(async (tx) => {
                const index = await tx.doc(ProjectChatIndexDoc);

                index.sealed = true;
                index.scrub = true;
            }, context);
        }
    }

    #message(
        key: string,
        message: Readonly<StoredProjectChatMessage>,
        bytes: Buffer | undefined,
    ): ProjectChatMessage {
        if (!("sealed" in message)) {
            return message;
        }

        const { sealed, ...metadata } = message;
        const text = bytes === undefined ? undefined : open(bytes, aad(key, message.id), sealed);

        if (text === undefined && !this.#warned.has(key)) {
            this.#warned.add(key);
            this.#app.log(`Project chat ${key}: could not decrypt a message`);
        }

        return { ...metadata, text: text ?? UNREADABLE };
    }

    #place(user: User, sessionId: ConversationId): Place {
        const app = this.#app;

        if (!this.on()) {
            throw noChat();
        }

        try {
            app.requireSee(user, sessionId);
        } catch (error) {
            if (error instanceof HttpError && error.status === 404) {
                throw noChat();
            }

            throw error;
        }

        const place = app.folderOf(sessionId);

        if (place === undefined || !app.policy.mayChatIn(user, place.computer, place.path)) {
            throw noChat();
        }

        return {
            key: projectChatKey(place.computer, place.path),
            computer: place.computer,
            folder: place.path,
        };
    }

    async thread(
        user: User,
        sessionId: ConversationId,
    ): Promise<Place & { messages: ProjectChatMessage[] }> {
        const place = this.#place(user, sessionId);
        const doc = await this.#app.harness.snapshot(ProjectChatDoc, place.key, context);

        if (this.#place(user, sessionId).key !== place.key) {
            throw noChat();
        }

        const bytes = chatKeyForReading(this.#app);

        return {
            ...place,
            messages: (doc?.messages ?? []).map((message) =>
                this.#message(place.key, message, bytes),
            ),
        };
    }

    /** A retry returns the first message, and sends no event or push. */
    async post(
        user: User,
        sessionId: ConversationId,
        request: { text?: unknown; requestId?: unknown },
    ): Promise<ProjectChatMessage> {
        const place = this.#place(user, sessionId);

        if (typeof request.text !== "string" || typeof request.requestId !== "string") {
            throw new HttpError(400, "text and requestId are required");
        }

        const text = request.text.trim();

        if (text === "") {
            throw new HttpError(400, "Message is empty");
        }

        if (text.length > MAX_CHAT_TEXT) {
            throw new HttpError(413, `Chat messages are limited to ${MAX_CHAT_TEXT} characters`);
        }

        const app = this.#app;
        const { key, computer, folder } = place;
        const id = `${user.id.slice(0, 8)}-${clientKey(request.requestId)}`;
        const { message, created } = await app.harness.commit(async (tx) => {
            const doc = await tx.doc(ProjectChatDoc, key, null);
            const index = await tx.doc(ProjectChatIndexDoc);

            // The setting, the session's folder, or a person's access may change while this post waits.
            if (this.#place(user, sessionId).key !== key) {
                throw noChat();
            }

            index.sealed = true;
            const existing = doc.messages.find((each) => each.id === id);

            if (existing !== undefined) {
                return {
                    message: JSON.parse(JSON.stringify(existing)) as StoredProjectChatMessage,
                    created: false,
                } as const;
            }

            const mentions = chatMentions(
                text,
                user.id,
                app.config.users.filter((person) => app.policy.mayChatIn(person, computer, folder)),
            );
            const at = Date.now();
            const message: ProjectChatMessage = {
                id,
                userId: user.id,
                name: app.config.userById(user.id)!.name,
                text,
                at,
                ...(mentions.length === 0 ? {} : { mentions }),
            };

            doc.messages.push(sealMessage(key, message, chatKey(app)));

            if (doc.messages.length > CHAT_LIMIT) {
                doc.messages.splice(0, doc.messages.length - CHAT_LIMIT);
            }

            index.chats[key] = { computer, folder, at };

            return { message, created: true } as const;
        }, context);

        if (created && this.on()) {
            this.#posted(place, message);
        }

        if (this.#place(user, sessionId).key !== key) {
            throw noChat();
        }

        return created ? message : this.#message(key, message, chatKeyForReading(app));
    }

    #posted({ key, computer, folder }: Place, message: ProjectChatMessage): void {
        const app = this.#app;
        const looking = new Set<string>();

        for (const client of app.clients) {
            const id = client.conversationId;
            const place = id === undefined ? undefined : app.folderOf(id);

            if (
                id !== undefined &&
                place?.computer === computer &&
                place.path === folder &&
                app.canSee(client.user, id) &&
                app.policy.mayChatIn(client.user, computer, folder)
            ) {
                client.send("project-chat", { key, messages: [message] }, id);

                if (client.visible !== false) {
                    looking.add(client.user.id);
                }
            }
        }

        for (const id of message.mentions ?? []) {
            const person = app.config.userById(id);

            if (
                person !== undefined &&
                !looking.has(id) &&
                app.policy.mayChatIn(person, computer, folder)
            ) {
                app.alerts.project(person, key, message);
            }
        }
    }

    /** A tab can still see a session after losing its folder. Have it ask for its chat again. */
    accessChanged(): void {
        if (!this.on()) {
            return;
        }

        for (const client of this.#app.clients) {
            if (client.conversationId !== undefined) {
                client.send("project-chat-access", { on: true });
            }
        }
    }

    async setOn(user: User, on: boolean): Promise<void> {
        const app = this.#app;

        app.policy.requireManagesServer(user);

        // A new "on" must not run ahead of the retirement a previous "off" started.
        const setting = this.#setting.then(async () => {
            app.policy.requireManagesServer(user);

            if (on && !this.on()) {
                // An earlier retirement may not have finished. Keep the routes closed until it does.
                await this.#retire(() => true);
                app.policy.requireManagesServer(user);
            }

            app.config.setProjectChat(on);

            if (!on) {
                await this.#retire(() => true);
            }

            for (const client of app.clients) {
                client.send("project-chat-access", { on });
            }
        });

        this.#setting = setting.catch(() => {});
        await setting;
    }

    /** At start and on unlink: also finish a retirement that a restart cut short. */
    async forgetGone(): Promise<void> {
        await this.#retire(
            (computer) =>
                !this.on() ||
                (computer !== THIS_SERVER && this.#app.config.runnerById(computer) === undefined),
        );
    }

    async #retire(which: (computer: string) => boolean): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const index = await tx.doc(ProjectChatIndexDoc);

            index.sealed = true;

            for (const [key, { computer }] of Object.entries(index.chats)) {
                if (which(computer)) {
                    await tx.retireDoc(ProjectChatDoc, key);
                    delete index.chats[key];

                    if (this.#plain) {
                        index.scrub = true;
                    }
                }
            }
        }, context);
    }
}
