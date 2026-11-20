/**
 * Pinned sessions, for the browsers where a person turned syncing on: private to each person, saved in SQLite, and sent
 * to all their connected devices. A browser with syncing off keeps its own pins and never asks for these.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { type PinnedSessions as Stored, PinnedSessionsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

const MAX_PINNED = 500;

export class PinnedSessions {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The synced pins of `user`, in pin order; undefined while no browser of theirs gave a list. */
    async list(user: User): Promise<number[] | undefined> {
        const doc = await this.#app.harness.snapshot(PinnedSessionsDoc, BACKGROUND_CONTEXT);
        const pinned = doc?.users[user.id];

        return pinned === undefined ? undefined : [...pinned];
    }

    /**
     * Replace the whole list: a browser sends what it shows, so the last change wins, as with pins in one browser. The
     * ids are not checked against what `user` may see: the list is theirs alone, and browsers show only the sessions
     * they know.
     */
    async set(user: User, body: { pinned?: unknown }): Promise<void> {
        const pinned = body?.pinned;

        if (
            !Array.isArray(pinned) ||
            pinned.length > MAX_PINNED ||
            !pinned.every((id) => Number.isSafeInteger(id) && (id as number) > 0)
        ) {
            throw new HttpError(
                400,
                `pinned must be a list of up to ${MAX_PINNED} session ids, each a positive whole number.`,
            );
        }

        // The first of each id keeps its place: a list that came twice the same id pins it once.
        const unique = [...new Set(pinned as number[])];

        await this.#app.harness.commit(async (tx) => {
            (await tx.doc(PinnedSessionsDoc)).users[user.id] = unique;
        }, BACKGROUND_CONTEXT);
    }

    /** Send only the signed-in person's committed list, or null if they cannot sync pins or have no list yet. */
    committed(value: Stored | null): void {
        for (const client of this.#app.clients) {
            const pinned = client.user.role === "viewer" ? undefined : value?.users[client.user.id];

            client.send("pinned-sessions", pinned === undefined ? null : [...pinned]);
        }
    }
}
