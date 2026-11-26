import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { modulesWith } from "../../config.ts";
import { HttpError } from "../../errors.ts";
import { send } from "../../http/io.ts";
import { modelById } from "./catalog.js";
import { ModelCache } from "./model-cache.ts";

export const DICTATION_ASSET_VERSION = "offline-v1";

const SHERPA = "@sherpaw/asr";
const WASM = "prebuilt/asr.wasm";
const sherpaFile = (name: string) => join(modulesWith(SHERPA), SHERPA, "dist", name);
const ENGINE_SCRIPTS = new Map([
    ["asr-api.js", "index.js"],
    ["asr-B3QtWJoU.js", "asr-B3QtWJoU.js"],
    ["tokens-wFJ0vjND.js", "tokens-wFJ0vjND.js"],
]);
const headers = {
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "private, no-store",
};

export const workerPolicy =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'";

/** Only the fixed worker, worklet and pinned ESM files. No generic vendor file reader. */
export async function engineScript(name: string): Promise<string | undefined> {
    const vendor = ENGINE_SCRIPTS.get(name);

    if (vendor !== undefined) {
        return readFile(sherpaFile(vendor), "utf8");
    }

    const local =
        name === "worker.js"
            ? "engine-worker.js"
            : name === "worklet.js"
              ? "audio-worklet.js"
              : null;

    return local ? readFile(new URL(`./${local}`, import.meta.url), "utf8") : undefined;
}

export const engineBinary = () => readFile(sherpaFile(WASM));

/** A single byte range only. The total size and the ETag are fixed by the pin. */
export function byteRange(value: string, size: number): { start: number; end: number } | undefined {
    const match = /^bytes=(\d{0,12})-(\d{0,12})$/.exec(value);

    if (!match || (!match[1] && !match[2])) {
        return undefined;
    }

    if (!match[1]) {
        const suffix = Number(match[2]);

        return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : undefined;
    }

    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;

    return start <= end ? { start, end } : undefined;
}

/** Fixed public assets only. The caller checks that the first-party browser module is enabled for this account. */
export async function serveDictationAsset(
    request: IncomingMessage,
    response: ServerResponse,
    path: readonly string[],
    cache: ModelCache,
    allowed: () => boolean,
): Promise<void> {
    if (!allowed()) {
        throw new HttpError(404, "Not found");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");

        throw new HttpError(405, "Files are only read");
    }

    if (path.length === 1) {
        const name = path[0]!;

        if (name === "engine.wasm") {
            const data = request.method === "HEAD" ? "" : await engineBinary();

            send(response, 200, data, "application/wasm", headers);

            return;
        }

        const source = await engineScript(name);

        if (source !== undefined) {
            send(
                response,
                200,
                request.method === "HEAD" ? "" : source,
                "text/javascript; charset=utf-8",
                {
                    ...headers,
                    // The script contains no private data. A loaded tab can start an idle-unloaded worker without the server.
                    "cache-control": "private, max-age=86400",
                    ...(name === "worker.js" ? { "content-security-policy": workerPolicy } : {}),
                },
            );

            return;
        }
    }

    const file =
        path.length === 3 && path[0] === "model"
            ? modelById(path[1]!)?.files.find((item) => item.name === path[2])
            : undefined;

    if (file === undefined) {
        throw new HttpError(404, "Not found");
    }

    // A link, image or cross-origin simple request cannot make the server fill its public cache.
    if (request.headers["x-pocket"] !== "1") {
        throw new HttpError(403, "Missing X-Pocket header");
    }

    const range =
        request.headers.range === undefined ? null : byteRange(request.headers.range, file.size);

    if (range === undefined) {
        response.writeHead(416, { ...headers, "content-range": `bytes */${file.size}` });
        response.end();

        return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    const status = range === null ? 200 : 206;
    const fileHeaders = {
        ...headers,
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        "content-length": String(end - start + 1),
        etag: `"${file.sha256}"`,
        ...(range === null ? {} : { "content-range": `bytes ${start}-${end}/${file.size}` }),
    };

    if (request.method === "HEAD") {
        response.writeHead(status, fileHeaders);
        response.end();

        return;
    }

    const stop = new AbortController();
    const closed = () => stop.abort();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(12 * 60_000)]);

    if (response.destroyed) {
        return;
    }

    response.once("close", closed);

    try {
        await cache.withFile(file, signal, async (cached) => {
            if (!allowed()) {
                throw new HttpError(404, "Not found");
            }

            response.writeHead(status, fileHeaders);
            await pipeline(createReadStream(cached, { start, end }), response, { signal });
        });
    } catch (error) {
        if (!stop.signal.aborted) {
            throw error;
        }
    } finally {
        response.off("close", closed);
    }
}
