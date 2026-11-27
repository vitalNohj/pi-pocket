import { isAbsolute } from "node:path";
import { MAX_PACKET_BYTES, parseRequest } from "../protocol/index.mjs";
import { DesktopController } from "./index.mjs";
import { registerDictation } from "./dictation/index.mjs";
import { registerRunner } from "./runner/desktop.mjs";

const [folder, platform, version, migration] = process.argv.slice(2);

if (
    !folder ||
    !isAbsolute(folder) ||
    !["windows", "macos"].includes(platform) ||
    !version ||
    version.length > 64 ||
    !["new", "existing"].includes(migration)
) {
    process.stderr.write("Invalid desktop controller arguments.\n");
    process.exit(2);
}

const desktop = new DesktopController({
    folder,
    platform,
    version,
    existingInstall: migration === "existing",
    write: (packet) => {
        const line = JSON.stringify(packet);

        if (
            Buffer.byteLength(line) > MAX_PACKET_BYTES ||
            process.stdout.writableLength > MAX_PACKET_BYTES * 4
        ) {
            process.exit(3);
        }

        process.stdout.write(line + "\n");
    },
});

// Installed feature modules register here before load, so saved preferences can be validated on the first read.
const root = new URL("./dictation/runtime/", import.meta.url);
const runner = registerRunner(desktop, folder);

await registerDictation(desktop, { folder, root });
await desktop.load();

const decoder = new TextDecoder("utf-8", { fatal: true });
const line = Buffer.alloc(MAX_PACKET_BYTES);
let size = 0;
let discard = false;
let started = false;
let outstanding = 0;

let closing = false;

async function close() {
    if (closing) {
        return;
    }

    closing = true;
    desktop.close();

    try {
        await runner.close();
    } finally {
        process.exit(0);
    }
}

process.stdout.on("error", () => void close());
process.stdin.on("error", () => void close());
process.stdin.on("end", () => void close());
process.stdin.on("data", (chunk) => {
    let position = 0;

    while (position < chunk.length) {
        const newline = chunk.indexOf(10, position);
        const end = newline === -1 ? chunk.length : newline;
        const bytes = end - position;

        if (size + bytes > line.length) {
            discard = true;
        }

        if (!discard) {
            chunk.copy(line, size, position, end);
            size += bytes;
        }

        position = newline === -1 ? end : end + 1;

        if (newline === -1) {
            break;
        }

        if (!discard) {
            let request;

            try {
                request = parseRequest(decoder.decode(line.subarray(0, size)));
            } catch {
                // Ignore invalid UTF-8 and continue at the next packet boundary.
            }

            if (request && outstanding < 64) {
                outstanding++;
                void desktop
                    .receive(request)
                    .then(() => {
                        if (
                            !started &&
                            request.command === "subscribe" &&
                            request.value === undefined
                        ) {
                            started = true;
                            void runner.boot().catch(() => {
                                desktop.setSlice("runner", {
                                    status: "error",
                                    label: "Runner needs attention",
                                    message:
                                        "The runner could not start. Reopen Pi Pocket and try again.",
                                });
                            });
                            void desktop.begin();
                        }
                    })
                    .finally(() => {
                        outstanding--;
                    });
            }
        }

        size = 0;
        discard = false;
    }
});
