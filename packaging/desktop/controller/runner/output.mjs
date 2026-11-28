import { serverAddress } from "../connection/probe.mjs";

// The start command writes activity on stdout. The rest of its output is for a person, not a protocol.
const ACTIVITY = "PI-POCKET-ACTIVITY ";

export const MAX_LINE = 16 * 1024;

export function runnerActivity(line) {
    if (!line.startsWith(ACTIVITY) || Buffer.byteLength(line) > MAX_LINE) {
        return;
    }

    try {
        const { working, folders } = JSON.parse(line.slice(ACTIVITY.length));

        if (
            typeof working === "boolean" &&
            Array.isArray(folders) &&
            folders.length <= 128 &&
            folders.every(
                (folder) =>
                    typeof folder === "string" && folder.length > 0 && folder.length <= 4096,
            ) &&
            working === folders.length > 0
        ) {
            // Folder paths are not needed in Settings or in the tray.
            return { working, workingFolders: folders.length };
        }
    } catch {
        // A malformed packet cannot change the last valid signal.
    }
}

// Discard an entire oversized line, not just its prefix. A suffix can look like a new control line.
export function boundedLines(onLine) {
    let pending = Buffer.alloc(0);
    let discarding = false;

    return (chunk) => {
        for (let offset = 0; offset < chunk.length;) {
            const newline = chunk.indexOf(10, offset);
            const end = newline === -1 ? chunk.length : newline;
            const piece = chunk.subarray(offset, end);

            if (!discarding && pending.length + piece.length <= MAX_LINE) {
                pending = Buffer.concat([pending, piece]);
            } else {
                discarding = true;
                pending = Buffer.alloc(0);
            }

            if (newline === -1) {
                break;
            }

            const line = discarding ? null : pending.toString("utf8").replace(/\r$/, "");

            pending = Buffer.alloc(0);
            discarding = false;
            offset = newline + 1;

            if (line !== null) {
                onLine(line);
            }
        }
    };
}

const timestamp = /^\[[\p{Nd}\p{Zs}\p{Cf}:.]{1,32}\] /u;

// Never show raw output. Even normal logs can contain a server-supplied WebSocket reason or tool output.
export function runnerLog(line, server) {
    if (!timestamp.test(line)) {
        return;
    }

    const text = line.replace(timestamp, "");

    if (
        (text.startsWith(`Connected to ${server} as "`) && text.endsWith('".')) ||
        text === `Reconnected to ${server}. Running commands continue.`
    ) {
        return { status: "connected", message: "Connected to the linked server." };
    }

    if (
        /^Disconnected(?: \(.*\))?\. Reconnecting automatically\./.test(text) ||
        text.startsWith("Connection error (")
    ) {
        return { status: "offline", message: "Connection lost. The runner will try again." };
    }

    if (text.startsWith(`${server} did not prove it is the server this computer linked to`)) {
        return {
            status: "offline",
            message:
                "The server did not prove its identity. Check the address. If the server was replaced, link again.",
        };
    }

    if (text.startsWith("The server reset the connection.")) {
        return { message: "The server reset the connection and ended the previous commands." };
    }

    if (text.startsWith("Tool process:")) {
        return { message: "The runner reported a tool process problem." };
    }
}

export function runnerAddress(given) {
    // The CLI decides if plain HTTP is permitted.
    return serverAddress(given)?.replace(/\/+$/, "");
}

export function runnerIdentity(lines) {
    if (lines[0] === "This computer is not linked.") {
        return null;
    }

    const name = lines[0]?.match(/^Computer: (.+)$/)?.[1];
    const server = runnerAddress(lines[1]?.match(/^Server: (.+)$/)?.[1]);

    if (!name || !server) {
        return;
    }

    return {
        name: name
            .replace(/[\p{Cc}\p{Cf}]/gu, "")
            .replace(/\b[\dA-Z]{4}(?:-[\dA-Z]{4}){2}\b/gi, "[code]")
            .slice(0, 120),
        server,
    };
}
