import { access, opendir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { onlyKeys } from "../../protocol/index.mjs";
import { localAccess, localPort } from "../../protocol/state.mjs";
import { connectionError } from "../connection/probe.mjs";

export function localFolder(value) {
    if (
        typeof value !== "string" ||
        !value ||
        value.length > 2048 ||
        /[\u0000-\u001f\u007f]/u.test(value)
    ) {
        return false;
    }

    // An absolute drive path or UNC share, not a drive-relative path or a Win32 device namespace.
    return process.platform === "win32"
        ? /^(?:[a-z]:[\\/]|[\\/]{2}[^?.\\/][^\\/]*[\\/][^\\/]+)/iu.test(value) &&
              !/["<>|?*]/u.test(value)
        : value.startsWith("/");
}

export function localDefaults() {
    const cwd = homedir();
    const port = Number(process.env.PI_POCKET_PORT);
    let data = process.env.PI_POCKET_DIR;

    if (data === "~" || data?.startsWith("~/")) {
        data = join(cwd, data.slice(1));
    }

    const folder = data ? resolve(data) : null;

    return {
        cwd,
        data: localFolder(folder) ? folder : join(cwd, ".pi-pocket"),
        port: localPort(port) ? port : 8787,
        access: "local",
    };
}

export const localRules = {
    cwd: localFolder,
    data: localFolder,
    port: localPort,
    access: localAccess,
};
export const localSettings = (value) =>
    onlyKeys(value, Object.keys(localRules)) &&
    Object.entries(localRules).every(([key, valid]) => valid(value[key]));
export const sameLocalSettings = (a, b) =>
    Boolean(b) && Object.keys(localRules).every((key) => a[key] === b[key]);

async function checkFolder(folder, writable, allowNew) {
    let target = folder;

    try {
        if (allowNew) {
            await stat(folder).catch((error) => {
                if (error.code !== "ENOENT") {
                    throw error;
                }

                // The launcher can create a new data folder. Saving a preference must not create it.
                target = dirname(folder);
            });
        }

        await access(target, constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0));
        const directory = await opendir(target);

        await directory.close();
    } catch {
        throw connectionError(
            "folder",
            writable
                ? "Choose a readable, writable data folder, or a new folder inside one."
                : "Choose a readable folder for new sessions.",
        );
    }
}

export async function checkLocalFolders(settings) {
    await checkFolder(settings.cwd, false, false);
    await checkFolder(settings.data, true, true);
}

export async function checkLocalPort(settings, ownedAddress) {
    if (ownedAddress) {
        const address = new URL(ownedAddress);
        const port = Number(address.port || (address.protocol === "https:" ? 443 : 80));

        if (port === settings.port) {
            return; // The launcher will check the real bind after its old listener shuts down.
        }
    }

    // Only the launcher can choose the live Tailscale interface. It checks its bind itself.
    if (settings.access === "tailscale") {
        return;
    }

    const host = settings.access === "lan" ? "0.0.0.0" : "127.0.0.1";
    const server = createServer((socket) => socket.destroy());

    await new Promise((done, reject) => {
        server.once("error", (error) =>
            reject(
                error.code === "EADDRINUSE"
                    ? connectionError(
                          "port-in-use",
                          `Port ${settings.port} is in use. Choose a different port, or use Another server to connect to a server you know.`,
                      )
                    : connectionError(
                          "port",
                          `Pi Pocket could not listen on port ${settings.port}. Choose a different port.`,
                      ),
            ),
        );
        server.listen({ host, port: settings.port, exclusive: true }, () => server.close(done));
    });
}
