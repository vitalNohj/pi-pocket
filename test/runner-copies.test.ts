// The files that Pi Pocket's server and its runner (`packages/runner/`) both need: each side keeps its own copy, and
// the two copies must be the same bytes, since neither side imports the other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ROOT = new URL("../", import.meta.url);

/** The pairs: the server's copy first, the runner's second, as paths from the repository's root. */
const PAIRS: [string, string][] = [
    ...["protocol", "secure-link", "tunnels", "transport", "read-snapshot", "folders", "tools"].map(
        (name): [string, string] => [
            `src/server/runner-link/${name}.ts`,
            `packages/runner/src/${name}.ts`,
        ],
    ),
    ["src/server/pi-session-files.ts", "packages/runner/src/pi-session-files.ts"],
    ["bin/strip-types.js", "packages/runner/bin/strip-types.js"],
];

describe("the files that exist twice", () => {
    for (const [server, runner] of PAIRS) {
        it(`${server} and ${runner} are the same`, () => {
            const one = readFileSync(new URL(server, ROOT));
            const other = readFileSync(new URL(runner, ROOT));

            assert.ok(
                one.equals(other),
                `${server} and ${runner} differ. Copy the one you changed over the other. When the link between a server and a runner changes, also raise LINK_PROTOCOL.`,
            );
        });
    }
});
