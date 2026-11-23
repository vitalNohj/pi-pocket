/** The runner's own version, from its own package: it sends it to the server, which shows it on the computer's card. */
import { readFileSync } from "node:fs";

let version: string | undefined;

/** The `version` of this runner's `package.json`, read one time. */
export function runnerVersion(): string {
    if (version === undefined) {
        try {
            const read = JSON.parse(
                readFileSync(new URL("../package.json", import.meta.url), "utf8"),
            ) as { version?: unknown };

            version = typeof read.version === "string" ? read.version : "0.0.0";
        } catch {
            version = "0.0.0";
        }
    }

    return version;
}
