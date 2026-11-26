// Run only on a disposable GitHub Windows or Mac runner after installing N.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
    stageDesktopUpdate,
    stateFolderName,
} from "../../packaging/desktop/controller/updates/desktop-updates.mjs";
import { installerName } from "../../packaging/desktop/feed/desktop-builds.mjs";
import { updateFixture } from "./update-fixture.mjs";

const [current, next] = process.argv.slice(2);
const win = process.platform === "win32";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.ok(win || process.platform === "darwin");

const home = homedir();
const temp = process.env.RUNNER_TEMP;
const install = win
    ? join(process.env.LOCALAPPDATA, "Pi Pocket")
    : join(home, "Library/Application Support/Pi Pocket");
const app = win ? join(install, "Pi Pocket.exe") : join(home, "Applications/Pi Pocket.app");
const runtime = win ? join(install, "node/node.exe") : join(install, "node/bin/node");
const manifest = join(
    install,
    win ? "app/node_modules/pi-pocket/package.json" : "app/lib/node_modules/pi-pocket/package.json",
);
const runtimeFloor = join(install, win ? "app/setup-finished.txt" : "runtime-floor.txt");
const startup = win
    ? join(process.env.APPDATA, "Microsoft/Windows/Start Menu/Programs/Startup/Pi Pocket.lnk")
    : join(home, "Library/LaunchAgents/io.github.tannermidd.pi-pocket.plist");
const log = win ? join(install, "launcher.log") : join(home, "Library/Logs/Pi Pocket/launcher.log");
const data = join(home, ".pi-pocket");
const running = join(data, "launcher-running.json");
const config = join(data, "config.json");
const savedData = join(data, "desktop-update-test-session.txt");
const cache = join(install, stateFolderName);
const proof = join(temp, "desktop-update-proof");
const origin = "http://127.0.0.1:18787";

function run(command, args, env = process.env) {
    return execFileSync(command, args, {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env,
    }).trim();
}

function powershell(code, env) {
    return run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", code], env);
}

async function waitFor(description, attempt) {
    const end = Date.now() + 90_000;
    let last;

    while (Date.now() < end) {
        try {
            const value = await attempt();

            if (value) {
                return value;
            }
        } catch (error) {
            last = error;
        }

        await setTimeout(700);
    }

    throw new Error(`Timed out: ${description}`, { cause: last });
}

async function json(file) {
    return JSON.parse(await readFile(file, "utf8"));
}

async function hash(file) {
    return createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
}

async function savedConfig() {
    const settings = await json(config);

    // Closing and reopening the web view changes people's server presence timestamps.
    for (const user of settings.users) {
        delete user.lastSeen;
    }

    // Compare a fingerprint so a failed assertion does not log the owner token.
    return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

function appVersion() {
    if (win) {
        return powershell("(Get-Item -LiteralPath $env:PP_APP).VersionInfo.ProductVersion", {
            ...process.env,
            PP_APP: app,
        });
    }

    return run("/usr/bin/plutil", [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        join(app, "Contents/Info.plist"),
    ]);
}

function appPid() {
    if (win) {
        const result = powershell(
            `
            $app = Get-Process -Name 'Pi Pocket' -ErrorAction SilentlyContinue |
                Where-Object { $_.Path -eq $env:PP_APP -and $_.MainWindowHandle -ne 0 } |
                Select-Object -First 1
            if ($app) { $app.Id }
        `,
            { ...process.env, PP_APP: app },
        );

        return Number(result);
    }

    return Number(run("/usr/bin/pgrep", ["-f", "/Pi Pocket[.]app/Contents/MacOS/Pi Pocket$"]));
}

function launchApp() {
    if (win) {
        const child = spawn(app, [], { stdio: "ignore" });

        child.unref();
    } else {
        run("/usr/bin/open", ["-a", app]);
    }
}

function quitApp() {
    if (win) {
        run(app, ["--quit"]);
    } else {
        run(join(app, "Contents/MacOS/Pi Pocket"), ["--quit"]);
    }
}

function screenshot(name, pid) {
    const file = join(proof, `${name}.png`);

    if (win) {
        powershell(
            `
            Add-Type -AssemblyName System.Windows.Forms, System.Drawing
            $app = Get-Process -Id ([int]$env:PP_APP_PID)
            (New-Object -ComObject WScript.Shell).AppActivate($app.Id) | Out-Null
            Start-Sleep -Seconds 2
            $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
            $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
                $bitmap.Save($env:PP_SCREENSHOT, [System.Drawing.Imaging.ImageFormat]::Png)
            } finally {
                $graphics.Dispose()
                $bitmap.Dispose()
            }
        `,
            { ...process.env, PP_APP_PID: String(pid), PP_SCREENSHOT: file },
        );
    } else {
        run("/usr/sbin/screencapture", ["-x", file]);
    }
}

async function attachedApp(version, previous) {
    const pid = await waitFor(`a running desktop app at ${version}`, async () => {
        const started = (await readFile(log, "utf8")).includes(`Pi Pocket desktop app ${version}`);
        const pid = started && appPid();

        return pid !== previous && pid;
    });

    assert.equal(appVersion(), version);
    await setTimeout(4000);

    return pid;
}

await mkdir(proof, { recursive: true });
assert.equal(appVersion(), current);
assert.equal((await json(manifest)).version, current);
assert.ok((await stat(startup)).isFile());

// Start a real Pi Pocket console launcher separately. The desktop app must leave it alone.
const env = {
    ...process.env,
    NPM_CONFIG_PREFIX: join(install, "app"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
};
const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";

env[pathKey] = `${dirname(runtime)}${delimiter}${env[pathKey] ?? ""}`;
const server = spawn(
    runtime,
    [
        join(dirname(manifest), "bin/pi-pocket.js"),
        "--access",
        "local",
        "--yes",
        "--port",
        "18787",
        "--data",
        data,
    ],
    {
        cwd: temp,
        env,
        stdio: "ignore",
        windowsHide: true,
    },
);

server.once("error", (error) => console.error(error));

async function serverInfo() {
    const response = await fetch(`${origin}/api/pocket/info`, {
        signal: AbortSignal.timeout(5000),
    });

    return response.ok ? response.json() : null;
}

try {
    await waitFor(
        "the console server to answer",
        async () => (await json(running)).pid === server.pid && (await serverInfo()),
    );
    await writeFile(savedData, "saved before desktop-only update\n");
    const kept = [runtime, manifest, runtimeFloor, startup, savedData];
    const before = await Promise.all(kept.map(hash));
    const configBefore = await savedConfig();
    const originalServerInfo = await serverInfo();

    launchApp();
    const oldPid = await attachedApp(current);

    screenshot("before", oldPid);

    const name = installerName(process.platform, next);
    const bytes = await readFile(join(temp, "desktop-update-next", name));
    const fixture = await updateFixture(process.platform, next, bytes);

    try {
        const downloaded = join(temp, name);
        const response = await fetch(`${fixture.url}/installer`, {
            signal: AbortSignal.timeout(30_000),
        });

        assert.ok(response.ok);
        await writeFile(downloaded, Buffer.from(await response.arrayBuffer()));
        const staged = await stageDesktopUpdate(
            current,
            process.platform,
            downloaded,
            cache,
            fixture.request,
        );

        assert.equal(staged.phase, "staged");
        assert.equal(staged.version, next);
    } finally {
        fixture.close();
    }

    quitApp();
    await waitFor("the old desktop process to exit without ending the console launcher", () => {
        try {
            process.kill(oldPid, 0);

            return false;
        } catch (error) {
            return error.code === "ESRCH";
        }
    });
    assert.equal((await json(running)).pid, server.pid);
    assert.deepEqual(await serverInfo(), originalServerInfo);
    // Simulate a freshly orphaned handoff so startup has to reclaim it immediately.
    await writeFile(
        join(cache, "applying.json"),
        JSON.stringify({ pid: oldPid, started: Date.now() }),
    );
    launchApp();

    const newPid = await attachedApp(next, oldPid);

    assert.deepEqual(await json(join(cache, "last-result.json")), {
        phase: "applied",
        current,
        version: next,
    });
    assert.equal((await json(running)).pid, server.pid);
    assert.equal(server.exitCode, null);
    assert.deepEqual(await serverInfo(), originalServerInfo);
    assert.deepEqual(await Promise.all(kept.map(hash)), before);
    assert.equal(await savedConfig(), configBefore, "Pi Pocket settings changed");
    screenshot("after", newPid);
    const summary =
        `Desktop: ${current} (PID ${oldPid}) → ${next} (PID ${newPid}).\n` +
        `Console server PID ${server.pid} still answers. Its Node runtime, package manifest, install marker, sign-in setting and data did not change. Server settings stayed the same apart from presence timestamps.\n`;

    await writeFile(join(proof, "result.txt"), summary);
    console.log(summary);
} catch (error) {
    for (const file of [log, join(cache, "last-result.json"), join(cache, "setup.log")]) {
        const contents = await readFile(file, "utf8").catch(() => null);

        if (contents) {
            console.log(file, contents);
        }
    }

    throw error;
} finally {
    try {
        quitApp();
    } finally {
        server.kill();
    }
}
