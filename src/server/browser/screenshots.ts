/** Saving browser screenshots where the session's file tools run, on this server or on its linked computer. */
import type { Context } from "@earendil-works/chord";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { extname } from "node:path";

export type ScreenshotFormat = "png" | "jpeg" | "webp";

/** The saved image's longest side, in device pixels; unrelated to the model's smaller preview. */
export const SCREENSHOT_MAX = 16_384;
/** The saved file's byte limit. The preview still returns when saving is refused. */
export const SCREENSHOT_BYTES = 50 * 1024 * 1024;

export function screenshotFormat(path: string): ScreenshotFormat {
    switch (extname(path).toLowerCase()) {
        case ".png":
            return "png";
        case ".jpg":
        case ".jpeg":
            return "jpeg";
        case ".webp":
            return "webp";
        default:
            throw new Error("Use .png, .jpg/.jpeg, or .webp for a screenshot path.");
    }
}

/** Write through the same environment as `write`, never through the server's filesystem. */
export async function saveScreenshot(
    env: ExecutionEnv,
    path: string,
    bytes: Uint8Array,
    context: Context,
): Promise<string> {
    if (bytes.byteLength > SCREENSHOT_BYTES) {
        throw new Error("The screenshot exceeds 50 MB: it was not saved.");
    }

    const absolute = getOrThrow(await env.absolutePath(path, context));
    const info = await env.fileInfo(absolute, context);

    if (info.ok && info.value.kind === "directory") {
        throw new Error(`${absolute} is a folder: give a screenshot file path.`);
    }

    if (!info.ok && info.error.code !== "not_found") {
        throw info.error;
    }

    // Joining on the environment also handles a linked computer's Windows paths.
    const parent = getOrThrow(await env.joinPath([absolute, ".."], context));

    getOrThrow(await env.createDir(parent, { recursive: true }, context));
    getOrThrow(await env.writeFile(absolute, bytes, context));

    return absolute;
}
