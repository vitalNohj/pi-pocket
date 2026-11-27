import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// This holds only the local switch and terminal exit latch. Only the CLI opens link.json.
// The native process adapter makes this directory private before the controller saves policy.
export function runnerPolicy(dir) {
    const path = join(dir, "policy.json");
    let policy;

    try {
        const info = lstatSync(path);

        if (info.isFile() && info.size < 256) {
            policy = JSON.parse(readFileSync(path, "utf8"));
        }
    } catch {
        // Missing or unreadable preferences leave the runner disabled.
    }

    return {
        policy,
        savePolicy(next) {
            const temp = join(dir, `policy-${randomUUID()}.tmp`);

            try {
                writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
                renameSync(temp, path);
            } finally {
                rmSync(temp, { force: true });
            }
        },
    };
}
