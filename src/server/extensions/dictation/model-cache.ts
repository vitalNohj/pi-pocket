import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../../errors.ts";
import type { ModelFile } from "./catalog.js";

const CACHE_LIMIT = 2 * 1024 ** 3;
const DOWNLOAD_MS = 10 * 60_000;
const DIGEST = /^[a-f0-9]{64}$/;
const CDN = new Set([
    "huggingface.co",
    "cdn-lfs.hf.co",
    "cdn-lfs.huggingface.co",
    "cas-bridge.xethub.hf.co",
]);

/** The input URL comes only from the catalogue. Never forward cookies, authorization or client headers. */
async function fetchPin(file: ModelFile, signal: AbortSignal, fetcher: typeof fetch) {
    let url = new URL(file.url);

    for (let step = 0; step < 6; step++) {
        const approvedHost =
            CDN.has(url.hostname) || /^[a-z0-9-]+\.aws\.cdn\.hf\.co$/.test(url.hostname);

        if (
            url.protocol !== "https:" ||
            url.port ||
            url.username ||
            url.password ||
            !approvedHost
        ) {
            break;
        }

        const result = await fetcher(url, { signal, redirect: "manual", credentials: "omit" });

        if ([301, 302, 303, 307, 308].includes(result.status)) {
            const location = result.headers.get("location");

            await result.body?.cancel();

            if (!location) {
                break;
            }

            url = new URL(location, url);
        } else if (result.status === 200 && result.body) {
            const length = result.headers.get("content-length");

            if (length === null || Number(length) === file.size) {
                return result.body;
            }

            await result.body.cancel();
            break;
        } else {
            await result.body?.cancel();
            break;
        }
    }

    throw new HttpError(502, "The speech model download source did not return the pinned file.");
}

/** One cache per server. Only complete, SHA-256 checked files become visible. */
export class ModelCache {
    #writing = false;
    #readers = 0;
    #used = new Map<string, number>();
    #held = new Map<string, number>();
    #verified = new Map<string, string>();
    #root: string;
    #limit: number;
    #fetcher: typeof fetch;

    constructor(root: string, { limit = CACHE_LIMIT, fetcher = fetch } = {}) {
        this.#root = root;
        this.#limit = limit;
        this.#fetcher = fetcher;
    }

    async withFile(file: ModelFile, signal: AbortSignal, read: (path: string) => Promise<void>) {
        if (!DIGEST.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1) {
            throw new Error("Invalid pinned speech file");
        }

        if (file.size > this.#limit) {
            throw new HttpError(507, "The file exceeds the server's speech model cache limit.");
        }

        if (this.#readers >= 4) {
            throw new HttpError(429, "The server is busy sending speech files. Try again shortly.");
        }

        this.#readers++;

        const id = file.sha256;
        const path = join(this.#root, id);

        this.#held.set(id, (this.#held.get(id) ?? 0) + 1);

        try {
            await mkdir(this.#root, { recursive: true, mode: 0o700 });

            if (!(await lstat(this.#root)).isDirectory()) {
                throw new HttpError(507, "The server's speech model cache is not a folder.");
            }

            if (!(await this.#checked(file, path, signal))) {
                if (this.#writing) {
                    throw new HttpError(
                        429,
                        "The server is preparing a speech file. Try again shortly.",
                    );
                }

                this.#writing = true;

                try {
                    await this.#fill(file, path, signal);
                } finally {
                    this.#writing = false;
                }
            }

            signal.throwIfAborted();
            this.#used.set(id, Date.now());
            await read(path);
        } finally {
            const left = (this.#held.get(id) ?? 1) - 1;

            if (left === 0) {
                this.#held.delete(id);
            } else {
                this.#held.set(id, left);
            }

            this.#readers--;
        }
    }

    /** Open an installed pin without making a network request, including when it is missing or damaged. */
    async installedFile(file: ModelFile, signal: AbortSignal) {
        if (!DIGEST.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1) {
            throw new Error("Invalid pinned speech file");
        }

        const path = join(this.#root, file.sha256);

        if (
            !(await lstat(this.#root).catch(() => undefined))?.isDirectory() ||
            !(await this.#checked(file, path, signal))
        ) {
            throw new HttpError(
                404,
                "A speech file is missing or damaged. Download the model again.",
            );
        }

        return path;
    }

    async #checked(file: ModelFile, path: string, signal?: AbortSignal) {
        const stat = await lstat(path).catch(() => undefined);

        if (!stat?.isFile() || stat.size !== file.size) {
            return false;
        }

        const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

        if (this.#verified.get(file.sha256) !== stamp) {
            const hash = createHash("sha256");

            for await (const chunk of createReadStream(path, { end: file.size - 1, signal })) {
                hash.update(chunk);
            }

            if (hash.digest("hex") !== file.sha256) {
                return false;
            }

            this.#verified.set(file.sha256, stamp);
        }

        return true;
    }

    /** Drop the oldest unused entries to make room; count temporary files too after a crash. */
    async #room(file: ModelFile) {
        const entries = [];
        let used = 0;

        for (const name of await readdir(this.#root)) {
            if (!DIGEST.test(name) && !/^part-[a-f0-9-]{36}$/.test(name)) {
                continue;
            }

            const path = join(this.#root, name);
            const stat = await lstat(path);

            if (stat.isFile()) {
                used += stat.size;
                entries.push({ name, path, stat, at: this.#used.get(name) ?? stat.mtimeMs });
            }
        }

        entries.sort((a, b) => a.at - b.at);

        for (const { name, path, stat } of entries) {
            if (used + file.size <= this.#limit) {
                break;
            }

            if (
                !this.#held.has(name) &&
                (DIGEST.test(name) || Date.now() - stat.mtimeMs >= DOWNLOAD_MS)
            ) {
                await rm(path);
                used -= stat.size;
                this.#used.delete(name);
                this.#verified.delete(name);
            }
        }

        const fs = await statfs(this.#root);

        if (used + file.size > this.#limit || fs.bavail * fs.bsize < file.size) {
            throw new HttpError(507, "Not enough space in the server's speech model cache.");
        }
    }

    async #fill(file: ModelFile, path: string, signal: AbortSignal) {
        const temp = join(this.#root, `part-${randomUUID()}`);
        const download = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MS)]);

        try {
            // The existing file was not valid. A pinned name never refers to a different version.
            await rm(path, { force: true });
            await this.#room(file);

            const body = await fetchPin(file, download, this.#fetcher);
            const hash = createHash("sha256");
            let size = 0;

            async function* checked() {
                for await (const bytes of body) {
                    size += bytes.byteLength;

                    if (size > file.size) {
                        throw new HttpError(502, "The speech model file is larger than expected.");
                    }

                    hash.update(bytes);
                    yield bytes;
                }
            }

            await pipeline(checked(), createWriteStream(temp, { flags: "wx", mode: 0o600 }), {
                signal: download,
            });

            if (size !== file.size || hash.digest("hex") !== file.sha256) {
                throw new HttpError(502, "The speech model file failed its SHA-256 check.");
            }

            download.throwIfAborted();
            await rename(temp, path);
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            if (error && typeof error === "object" && "code" in error && error.code === "ENOSPC") {
                throw new HttpError(507, "Not enough disk space for the speech model file.");
            }

            throw new HttpError(502, "The speech model download stopped. Try again.");
        } finally {
            await rm(temp, { force: true }).catch(() => {});
        }
    }
}
