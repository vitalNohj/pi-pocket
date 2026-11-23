// What another computer installs to get a runner, and the command that runs it there (`runnerInstall` in
// `src/server/runners.ts`), with and without `PI_POCKET_RUNNER_PACKAGE`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runnerInstall } from "../src/server/runners.ts";

const VARIABLE = "PI_POCKET_RUNNER_PACKAGE";
const pin = (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        optionalDependencies: Record<string, string>;
    }
).optionalDependencies["pi-pocket-runner"];

describe("the runner's install line", () => {
    let saved: string | undefined;

    beforeEach(() => {
        saved = process.env[VARIABLE];
    });

    afterEach(() => {
        if (saved === undefined) {
            delete process.env[VARIABLE];
        } else {
            process.env[VARIABLE] = saved;
        }
    });

    it("is the runner's package at the version Pi Pocket pins, by default", () => {
        delete process.env[VARIABLE];

        assert.ok(pin !== undefined && pin !== "");
        assert.deepEqual(runnerInstall(), {
            package: `pi-pocket-runner@${pin}`,
            command: "pi-pocket-runner",
        });
    });

    it("is the server's choice, run as pi-pocket-runner when it names the runner's package", () => {
        process.env[VARIABLE] = "  https://example.com/pi-pocket-runner-0.2.0.tgz \n";

        assert.deepEqual(runnerInstall(), {
            package: "https://example.com/pi-pocket-runner-0.2.0.tgz",
            command: "pi-pocket-runner",
        });
    });

    it("is the server's choice, run as pi-pocket runner for a whole Pi Pocket", () => {
        process.env[VARIABLE] = "https://example.com/pi-pocket-0.31.0.tgz";

        assert.deepEqual(runnerInstall(), {
            package: "https://example.com/pi-pocket-0.31.0.tgz",
            command: "pi-pocket runner",
        });
    });
});
