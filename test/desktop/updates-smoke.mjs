// Run only on a disposable GitHub Windows or Mac runner after installing N.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stateFolderName } from "../../packaging/desktop/controller/updates/desktop-updates.mjs";
import { installerName } from "../../packaging/desktop/feed/desktop-builds.mjs";
import { updateFixture } from "./update-fixture.mjs";

const [current, next, input] = process.argv.slice(2);
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
const settings = join(install, "desktop/desktop.json");
const webViewLog = join(dirname(settings), "webview2.log");
const data = join(home, ".pi-pocket");
const running = join(data, "launcher-running.json");
const config = join(data, "config.json");
const savedData = join(data, "desktop-update-test-session.txt");
const cache = join(install, stateFolderName);
const proof = join(temp, "desktop-update-proof");
const origin = "http://127.0.0.1:18787";
const trace = join(proof, "updates-states.jsonl");
const openSettings = join(temp, "show-updates-settings");
const settingsTitle = "Desktop Settings — Pi Pocket";
const updateLine = "Update ready - restart to apply";
const entry = join(
    win ? install : join(app, "Contents/Resources"),
    "desktop-assets/controller/main.mjs",
);

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
                Where-Object { $_.Path -eq $env:PP_APP -and $_.MainWindowTitle -eq 'Pi Pocket' } |
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
        run(input, ["launch", app]);
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

function gui(pid, operation, title, ...args) {
    return run(input, [String(pid), operation, title, ...args.map(String)]);
}

async function screenshot(name, pid) {
    const file = join(proof, `${name}.png`);

    gui(pid, "shot", settingsTitle, file);
    assert((await stat(file)).size > 4000, `${name} contains a window screenshot`);
}

async function exerciseUpdates(pid, fixture, downloaded) {
    async function waitForStatus(phase) {
        return waitFor(`Updates status ${phase}`, async () => {
            const lines = (await readFile(trace, "utf8")).trimEnd().split("\n");
            const snapshot = JSON.parse(lines.at(-1));

            return snapshot.status === phase && snapshot;
        });
    }

    async function capture(phase, name, latest) {
        const state = await waitForStatus(phase);

        assert.equal(state.version, current);
        assert.equal(state.latest, latest);
        assert.equal(state.updateLine, phase === "staged" ? updateLine : null);

        await setTimeout(350); // Let the real WebView paint the new snapshot before capture.
        await screenshot(name, pid);

        return state;
    }

    const click = (x) => gui(pid, "click", settingsTitle, x, 270);
    const check = () => click(295);
    const download = () => click(390);
    const pending = join(cache, "pending.json");

    await writeFile(openSettings, "");
    gui(pid, "find", settingsTitle);

    if (win) {
        // The WinForms window can appear before its WebView finishes loading Settings.
        await waitFor("the bundled Windows Settings page to load", async () =>
            (await readFile(webViewLog, "utf8")).includes(
                "The bundled Desktop Settings page loaded.",
            ),
        );
        await capture("idle", "00-not-checked-yet", null);
    } else {
        await setTimeout(2500);
    }

    check();
    await capture("current", "01-up-to-date", current);
    fixture.run.run_number = Number(next.split(".").at(-1));
    fixture.artifact.name = installerName(process.platform, next);
    check();
    await capture("available", "02-update-available", next);
    download();
    await capture("downloading", "03-downloading", next);

    async function pick(file) {
        click(590); // Select installer…
        await waitForStatus("selecting");

        if (win) {
            gui(pid, "select-file", "Select the downloaded desktop installer", file);
        } else {
            await setTimeout(1000);
            gui(pid, "select-file", settingsTitle, file);
        }
    }

    const bad = join(temp, `wrong-${fixture.artifact.name}`);

    await writeFile(bad, "not the selected build");
    await pick(bad);
    assert.match((await capture("failed", "04-failed", next)).message, /wrong size/);
    await assert.rejects(stat(pending), { code: "ENOENT" });
    check();
    await waitForStatus("available");
    download();
    await waitForStatus("downloading");
    await pick(downloaded);
    await capture("ready", "05-ready-to-apply", next);
    await assert.rejects(stat(pending), { code: "ENOENT" });
    click(480); // Apply
    await capture("staged", "06-staged-for-next-start", next);
    assert.equal((await json(pending)).version, next);
    assert.equal(appVersion(), current);
    assert(process.kill(pid, 0), "Apply did not end the desktop app");
}

async function macSignIns() {
    const contents = await readFile(log, "utf8").catch(() => "");

    return contents.split("The window is signed in.").length - 1;
}

async function launchAttachedApp(version, previous) {
    const signedIn = win ? 0 : await macSignIns();

    launchApp();
    const pid = await waitFor(`a running desktop app at ${version}`, async () => {
        if (!win && (await macSignIns()) <= signedIn) {
            return false;
        }

        const pid = appPid();

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

// A fresh install opens Home. Give N a saved local choice and a non-default Window setting.
await mkdir(dirname(settings), { recursive: true });
await writeFile(
    settings,
    JSON.stringify({
        schemaVersion: 1,
        preferences: {
            home: { mode: "local" },
            updates: { checkAtStartup: false },
            window: { closeToTray: false },
        },
    }),
);

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
    const name = installerName(process.platform, next);
    const bytes = await readFile(join(temp, "desktop-update-next", name));
    const fixture = await updateFixture(process.platform, current, bytes);
    const downloaded = join(temp, name);
    const kept = [runtime, manifest, runtimeFloor, startup, settings, savedData];
    let oldPid, before, configBefore, originalServerInfo;

    try {
        const response = await fetch(`${fixture.url}/installer`, {
            signal: AbortSignal.timeout(30_000),
        });

        assert.ok(response.ok);
        await writeFile(downloaded, Buffer.from(await response.arrayBuffer()));

        // This copy of N runs on the disposable installer runner only. N+1 and every
        // published installer retain the unmodified controller and its pinned feed.
        const driver = new URL("./update-fixture.mjs", import.meta.url).href;
        const original = await readFile(entry, "utf8");

        const anchor = "const beginUpdates = await registerDesktopUpdates(";

        assert(original.includes(anchor), "the installed controller registers updates");
        const argumentList = [fixture.url, trace, openSettings]
            .map((value) => JSON.stringify(value))
            .join(", ");
        const patched = original.replace(
            anchor,
            `installFixtureTransport(${argumentList}, desktop);\n${anchor}`,
        );

        await writeFile(
            entry,
            `import { installFixtureTransport } from ${JSON.stringify(driver)};\n${patched}`,
        );

        if (!win) {
            run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
        }

        oldPid = await launchAttachedApp(current);
        assert.equal((await json(settings)).preferences.window.closeToTray, false);
        before = await Promise.all(kept.map(hash));
        configBefore = await savedConfig();
        originalServerInfo = await serverInfo();
        await exerciseUpdates(oldPid, fixture, downloaded);
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
    const newPid = await launchAttachedApp(next, oldPid);

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
    assert(
        !(await readFile(entry, "utf8")).includes("installFixtureTransport"),
        "the updated app has no fixture transport",
    );
    const summary =
        `Desktop: ${current} (PID ${oldPid}) → ${next} (PID ${newPid}).\n` +
        `Console server PID ${server.pid} still answers. Its Node runtime, package manifest, install marker, sign-in setting, desktop settings and data did not change. Server settings stayed the same apart from presence timestamps.\n`;

    await writeFile(join(proof, "result.txt"), summary);
    console.log(summary);
} catch (error) {
    await writeFile(join(proof, "failure.txt"), `${error.stack}\n${error.stderr ?? ""}`).catch(
        () => {},
    );

    for (const file of [
        log,
        webViewLog,
        join(cache, "last-result.json"),
        join(cache, "setup.log"),
    ]) {
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
