// The Linux service (`src/runner/service.ts`): its unit, and that it needs an authenticator.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { STOPPED_BY_SERVER } from "../src/runner/main.ts";
import { SERVICE_NEEDS_TOTP, serviceUnit, unitPath } from "../src/runner/service.ts";

const launcher = fileURLToPath(new URL("../bin/pi-pocket.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-pocket-service-test-"));

after(() => rmSync(root, { recursive: true, force: true }));

/** A link file without an authenticator. */
function linkFile(): string {
    const file = join(root, `runner-${Math.random().toString(36).slice(2)}.json`);

    writeFileSync(
        file,
        JSON.stringify({ server: "https://pocket.example.com", id: "x", name: "Build", key: "k" }),
        { mode: 0o600 },
    );

    return file;
}

const runner = (...args: string[]) =>
    spawnSync(process.execPath, [launcher, "runner", ...args], {
        encoding: "utf8",
        env: { ...process.env, PI_POCKET_RUNNER_CONFIG: "" },
        timeout: 30_000,
    });

describe("the runner service", () => {
    it("writes a unit that starts the runner as a service, and does not restart it when that cannot help", () => {
        const unit = serviceUnit({
            node: "/usr/bin/node",
            launcher: "/opt/pi pocket/bin/pi-pocket.js",
            file: "/home/me/.pi-pocket/runner.json",
            path: "/usr/bin:/bin",
            noRestart: [STOPPED_BY_SERVER, SERVICE_NEEDS_TOTP],
        });

        assert.match(
            unit,
            /^ExecStart="\/usr\/bin\/node" "\/opt\/pi pocket\/bin\/pi-pocket.js" runner start --service --config "\/home\/me\/.pi-pocket\/runner.json"$/m,
        );
        assert.match(unit, /^RestartPreventExitStatus=3 4$/m);
        assert.match(unit, /^Environment="PATH=\/usr\/bin:\/bin"$/m);
        assert.equal(
            unitPath({ XDG_CONFIG_HOME: "/x" }),
            "/x/systemd/user/pi-pocket-runner.service",
        );
    });

    it("refuses to start as a service without an authenticator, with how to set one up", () => {
        const result = runner("start", "--service", "--config", linkFile());

        assert.equal(result.status, SERVICE_NEEDS_TOTP, result.stderr);
        assert.match(result.stderr, /authenticator/);
        assert.match(result.stderr, /pi-pocket runner totp setup/);
    });

    it(
        "refuses to install the service without an authenticator",
        {
            skip:
                process.platform !== "linux" || spawnSync("systemctl", ["--version"]).status !== 0,
        },
        () => {
            const result = runner("service", "--config", linkFile());

            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.match(result.stdout + result.stderr, /pi-pocket runner totp setup/);
        },
    );
});
