// Run the installed app, not a copy of the Settings page. Input and screenshots come from the OS.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { fixture } from "./fixture.mjs";
const [exe, input, out] = process.argv.slice(2).map((arg) => resolve(arg));
const settingsTitle = "Desktop Settings — Pi Pocket";
const stateFolder = await mkdtemp(join(tmpdir(), "pocket-desktop-smoke-"));
const data = join(stateFolder, "server-data");
const settings = join(stateFolder, "desktop.json");
const environment = { ...process.env, PI_POCKET_DESKTOP_STATE: stateFolder, PI_POCKET_DIR: data };
const remote = await fixture();
const exec = promisify(execFile);
let app;

function start(...args) {
    return spawn(exe, args, { env: environment, stdio: ["ignore", "ignore", "inherit"] });
}

async function until(description, condition, timeout = 30_000) {
    const end = Date.now() + timeout;

    while (Date.now() < end) {
        if (await condition()) {
            return;
        }

        await sleep(400);
    }

    throw new Error(`Timed out: ${description}`);
}

const prefs = async () => JSON.parse(await readFile(settings, "utf8")).preferences;

async function gui(command, title, ...args) {
    const parameters = [String(app.pid), command, title, ...args.map(String)];

    try {
        return await exec(input, parameters, { timeout: 30_000, windowsHide: true });
    } catch (error) {
        console.error(`Desktop input ${command} failed (app exit: ${app.exitCode}).`);
        if (error.stderr) {
            console.error(error.stderr.trim());
        }
        throw error;
    }
}

async function shot(title, name) {
    const file = join(out, `${name}.png`);

    await gui("shot", title, file);
    assert((await stat(file)).size > 4000, `${name} contains a window screenshot`);
}

function quit() {
    const closing = start("--quit");

    return new Promise((resolve, reject) => {
        closing.once("error", reject);
        closing.once("exit", (status) =>
            status === 0 ? resolve() : reject(new Error(`--quit exited ${status}`)),
        );
    });
}

async function noLocalServer() {
    assert.deepEqual(
        await readdir(data).catch((error) =>
            error.code === "ENOENT" ? [] : Promise.reject(error),
        ),
        [],
        "Home and remote mode did not start a local server or create server data",
    );
}

try {
    await mkdir(out, { recursive: true });
    app = start();
    await until("a fresh desktop settings file", () => stat(settings).catch(() => null));
    await gui("find", settingsTitle);
    await sleep(2500);
    assert.equal((await prefs()).home.mode, null);
    assert.equal((await prefs()).window.titleBar, "seamless");
    await noLocalServer();
    await shot(settingsTitle, "home-fresh-install");

    // The installed Settings asset has a fixed sidebar and starts with the Home section.
    // The OS adapters convert these viewport points to screen coordinates.
    await gui("click", settingsTitle, 95, 287); // Window section
    await shot(settingsTitle, "desktop-settings");
    await gui("click", settingsTitle, 254, 192); // Close to tray
    await until(
        "Window preference saved",
        async () => (await prefs()).window.closeToTray === false,
    );
    await gui("close", settingsTitle);
    const second = start();

    await until("second launch raised the first process", () => second.exitCode === 0);
    await gui("find", settingsTitle);
    await sleep(1000);
    await gui("click", settingsTitle, 95, 287);
    await gui("click", settingsTitle, 254, 192);
    await until(
        "saved preference restored when the window reopened",
        async () => (await prefs()).window.closeToTray === true,
    );
    console.log(
        "Settings opened offline, saved a Window preference, and restored it when reopened.",
    );

    await gui("click", settingsTitle, 95, 104); // Home section
    await gui("click", settingsTitle, 420, 193); // Another server
    await shot(settingsTitle, "home-another-server");
    await gui("click", settingsTitle, 390, 384); // Server address
    await gui("type", settingsTitle, remote.address);
    await gui("click", settingsTitle, 280, 442); // Check
    await until("Check used the base-path identity endpoint", () =>
        remote.requests.some(({ path }) => path === "/pocket/api/pocket/info"),
    );
    assert.equal((await prefs()).home.mode, null);
    assert(!remote.requests.some(({ path }) => path === "/pocket"));
    await gui("click", settingsTitle, 350, 442); // Connect
    await until(
        "Another server connection saved",
        async () => (await prefs()).home.remoteAddress === remote.address,
    );
    assert.equal((await prefs()).home.mode, "remote");
    await until("the fixture loaded in the app and reported only the page bridge", () =>
        remote.requests.some(({ path }) => path === "/pocket/page-only"),
    );
    assert(
        !remote.requests.some(({ authenticated }) => authenticated),
        "remote views do not send local owner credentials",
    );
    await noLocalServer();
    await shot("Pi Pocket", "home-connected-fixture");
    console.log(
        "Check did not connect. Connect used the base path. The fixture had no Desktop Settings API or local credentials.",
    );

    await quit();
    await until("Quit ended the app", () => app.exitCode !== null);
    console.log("The installed app passed the offline Settings and remote Home smoke test.");
} finally {
    await remote.close();

    if (app && app.exitCode === null) {
        await quit().catch(() => {});
        await until("app cleanup", () => app.exitCode !== null, 10_000).catch(() => app.kill());
    }
}
