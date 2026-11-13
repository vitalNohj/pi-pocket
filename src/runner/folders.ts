/** Folder paths as this computer compares them: its own case rules, its own real paths. */
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

function comparable(folder: string, platform: NodeJS.Platform): string {
    const paths = platform === "win32" ? win32 : posix;
    const normalized = paths.normalize(folder);
    const root = paths.parse(normalized).root;
    const trimmed =
        normalized === root
            ? root
            : normalized.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");

    return platform === "darwin" || platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Same folder or a descendant, not a sibling with the same prefix. */
export function folderContains(
    parent: string,
    folder: string,
    platform: NodeJS.Platform = process.platform,
): boolean {
    const left = comparable(parent, platform);
    const right = comparable(folder, platform);
    const separator = platform === "win32" ? "\\" : "/";

    return (
        right === left || right.startsWith(left.endsWith(separator) ? left : `${left}${separator}`)
    );
}

/** A missing asked folder keeps the path the server gave. */
export async function realFolder(folder: string): Promise<string> {
    return realpath(folder).catch(() => folder);
}
