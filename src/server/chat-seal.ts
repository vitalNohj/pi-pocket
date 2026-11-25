/** The shared key, message format, and startup cleanup for the people chats. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import type { Cursor, Storage } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { DirectIndexDoc, ProjectChatIndexDoc } from "./docs.ts";
import { describe } from "./errors.ts";

const context = BACKGROUND_CONTEXT;
const KEY_FILE = "direct.key";
const KEY_STAGE = "direct.key.tmp";

export const UNREADABLE = "This message cannot be read on this server anymore.";

/** Register even before either file exists. Protect the staging file too if a write is cut short. */
export function watchChatKey(app: PocketApp): void {
    for (const name of [KEY_FILE, KEY_STAGE]) {
        app.secrets.watchFile({
            path: join(app.dataDir, name),
            read: (text) => [{ value: text.trim(), label: "direct chat key" }],
        });
    }
}

export function chatKey(app: PocketApp): Buffer {
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

export function chatKeyForReading(app: PocketApp): Buffer | undefined {
    try {
        return chatKey(app);
    } catch {
        // A bad key file must not stop someone from opening their chat.
        return undefined;
    }
}

/**
 * The key for sealing old messages at startup, or undefined when the key file cannot be used. Then the old messages stay
 * as they are, people still read them, and the next start tries again: a bad key file must not stop the server.
 */
export function chatKeyAtStart(app: PocketApp, chat: string): Buffer | undefined {
    try {
        return chatKey(app);
    } catch (error) {
        app.log(
            `${chat}: old messages were not sealed, since the chat key cannot be used (${describe(error)}). The next start will try again.`,
        );

        return undefined;
    }
}

export function seal(key: Buffer, aad: Buffer, text: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });

    cipher.setAAD(aad);
    // Text is the only written payload. JSON also preserves any lone surrogates in it.
    const data = Buffer.concat([cipher.update(JSON.stringify({ text })), cipher.final()]);
    const sealed = [nonce, cipher.getAuthTag(), data].map((part) => part.toString("base64url"));

    return `v1:${sealed.join(":")}`;
}

export function open(key: Buffer, aad: Buffer, sealed: string): string | undefined {
    const parts = /^v1:([\w-]{16}):([\w-]{22}):([\w-]+)$/.exec(sealed);

    if (parts !== null) {
        try {
            const nonce = Buffer.from(parts[1]!, "base64url");
            const cipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });

            cipher.setAAD(aad);
            cipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
            const data = Buffer.concat([
                cipher.update(Buffer.from(parts[3]!, "base64url")),
                cipher.final(),
            ]);
            const payload = JSON.parse(data.toString("utf8")) as { text?: unknown };

            if (typeof payload.text === "string") {
                return payload.text;
            }
        } catch {
            // Do not report untrusted input or error details to the log.
        }
    }

    return undefined;
}

/** Scan even chats that are not in their index. */
export async function* chatKeys(storage: Storage, kind: string): AsyncGenerator<string> {
    const query = { scope: { kind: "session" }, kind, at: "current" } as const;
    let cursor: Cursor | undefined;

    do {
        const page = await storage.scanDocuments(query, 256, cursor, context);

        for (const { key } of page.items) {
            if (key !== undefined) {
                yield key;
            }
        }

        cursor = page.next;
    } while (cursor !== undefined);
}

/** Seal both chats before rebuilding SQLite, then clear both marks together. */
export async function sealChats(
    app: PocketApp,
    storage: Storage,
    database: SqliteDatabase,
): Promise<void> {
    // Keep one pass on the storage at a time. No scrub begins before both passes commit.
    await app.direct.sealLegacy(storage);
    await app.projectChat.sealLegacy(storage);
    const { harness } = app;
    const [direct, project] = await Promise.all([
        harness.snapshot(DirectIndexDoc, context),
        harness.snapshot(ProjectChatIndexDoc, context),
    ]);
    const scrubDirect = direct?.scrub === true;
    const scrubProject = project?.scrub === true;

    if (!scrubDirect && !scrubProject) {
        return;
    }

    let scrubbed = false;

    try {
        // A base removes old rows, but their bytes can still be in free pages or frames in the WAL.
        await database.exec("VACUUM");
        const checkpoint = await database.get<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)");

        scrubbed = checkpoint?.busy === 0;
    } catch {
        // A cleanup failure, such as no space to rebuild the database, does not stop startup.
    }

    if (!scrubbed) {
        const chat = scrubDirect
            ? scrubProject
                ? "Direct and project chat"
                : "Direct chat"
            : "Project chat";

        app.log(
            `${chat}: old plaintext bytes may still be in SQLite. The next start will try again.`,
        );

        return;
    }

    await harness.commit(async (tx) => {
        if (scrubDirect) {
            delete (await tx.doc(DirectIndexDoc)).scrub;
        }

        if (scrubProject) {
            const index = await tx.doc(ProjectChatIndexDoc);

            index.sealed = true;
            delete index.scrub;
        }
    }, context);
}
