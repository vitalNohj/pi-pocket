// Run the installed app, not a copy of the Settings page. Input and screenshots come from the OS.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { testBridge } from "./bridge-smoke.mjs";
import { fixture } from "./fixture.mjs";

const windows = process.platform === "win32";
const [exe, input, out, speechCache] = process.argv.slice(2).map((arg) => resolve(arg));
const settingsTitle = "Desktop Settings — Pi Pocket";
const stateFolder = await mkdtemp(join(tmpdir(), "pocket-desktop-smoke-"));
const data = join(stateFolder, "server-data");
const settings = join(stateFolder, "desktop.json");
const environment = {
    ...process.env,
    PI_POCKET_DESKTOP_STATE: stateFolder,
    PI_POCKET_DIR: data,
    PI_POCKET_TEST_STATUS_MENU: "1",
};
const remote = await fixture({ dictation: Boolean(speechCache) });
const exec = promisify(execFile);
let app;

async function start() {
    if (windows) {
        const { stdout } = await exec(input, ["launch", exe], {
            env: environment,
            timeout: 15_000,
        });
        const pid = Number(stdout.trim());

        assert(
            Number.isSafeInteger(pid) && pid > 0,
            "the desktop launched as a Windows application",
        );

        return pid;
    }

    const child = spawn(exe, { env: environment, stdio: ["ignore", "ignore", "inherit"] });

    await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
    });

    return child.pid;
}

function exited(pid) {
    try {
        process.kill(pid, 0);

        return false;
    } catch (error) {
        if (error.code !== "ESRCH") {
            throw error;
        }

        return true;
    }
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
    const parameters = [String(app), command, title, ...args.map(String)];

    try {
        return await exec(input, parameters, { timeout: 30_000, windowsHide: true });
    } catch (error) {
        console.error(`Desktop input ${command} failed (app exited: ${exited(app)}).`);

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

const quit = () => exec(exe, ["--quit"], { env: environment, timeout: 15_000 });
const webViewLog = () => readFile(join(stateFolder, "webview2.log"), "utf8").catch(() => "");

async function waitForSettings(opened) {
    if (windows) {
        await until(
            "Windows Settings loaded the bundled page",
            async () =>
                (await webViewLog()).split("The bundled Desktop Settings page loaded.").length >
                opened,
            65_000,
        );
    } else {
        await sleep(2500);
    }

    await gui("find", settingsTitle);
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

async function stopApp() {
    await quit();
    await until("Quit ended the app", () => exited(app));
    app = undefined;
}

async function testStartupRetry() {
    const requests = (server, path) =>
        server.requests.filter((request) => request.path === `/pocket/${path}`).length;
    const probes = (server = remote) => requests(server, "api/pocket/info");
    const pages = (server = remote) => requests(server, "page-only");
    const connect = (label) => gui("press", settingsTitle, label);
    const shown = (label) => gui("expect-text", settingsTitle, label);
    const pageTitle = "Pi Pocket";

    // Keep the address that the installed UI saved. Set short intervals in the disposable
    // profile while the app is stopped, so we can test several real relaunches in CI.
    async function launchSaved(server, mode, home = {}) {
        const file = JSON.parse(await readFile(settings, "utf8"));

        assert.equal(file.preferences.home.mode, "remote");
        assert.equal(file.preferences.home.remoteAddress, server.address);
        Object.assign(file.preferences.home, {
            connectAtStartup: true,
            healthInterval: 1,
            failureThreshold: 1,
            maxBackoff: 2,
            ...home,
        });
        await writeFile(settings, JSON.stringify(file));
        server.setMode(mode);
        const before = { probes: probes(server), pages: pages(server) };

        app = await start();

        return before;
    }

    const auto = await launchSaved(remote, "down", { maxBackoff: 8 });
    const times = [];

    for (let n = 1; n <= 4; n++) {
        await until(
            `startup probe ${n} reached the unavailable server`,
            () => probes() >= auto.probes + n,
        );
        times.push(performance.now());
    }

    // Observations use 400 ms polling and include scheduler latency. The shared test
    // checks the exact schedule and cap with a controlled clock.
    assert(times[3] - times[2] >= 2500, "consecutive startup failures increased the retry delay");
    assert.equal(pages(), auto.pages);
    await shown("Retry now");
    await shot(settingsTitle, "startup-retry-waiting");
    remote.setMode("sso");
    await shown("Open webpage anyway");
    assert.equal(pages(), auto.pages, "startup retry did not open the HTML-only sign-in page");
    await shot(settingsTitle, "startup-retry-preview-not-opened");
    remote.setMode("pocket");
    await until(
        "the saved server opened automatically after it recovered",
        () => pages() > auto.pages,
    );
    assert.equal((await prefs()).home.remoteAddress, remote.address);
    await shot(pageTitle, "startup-retry-connected");
    console.log(
        "Saved startup backed off, did not open an HTML-only page, and recovered without editing the address.",
    );

    // The existing active-page recovery still reloads the page after a failed health check.
    const connected = pages();

    remote.setMode("down");
    await until("the active page reported connection loss", async () =>
        (await readFile(join(stateFolder, "diagnostics.log"), "utf8")).includes(
            "home.health: not-pocket",
        ),
    );
    await gui("expect-text", pageTitle, "Pi Pocket fixture server");
    assert.equal(pages(), connected, "probing left the existing page intact");
    remote.setMode("pocket");
    await until("the existing session view recovered", () => pages() > connected);
    await stopApp();

    const zero = await launchSaved(remote, "down", { healthInterval: 0 });

    await shown("Retry now");
    remote.setMode("pocket");
    await sleep(2500);
    assert.equal(probes(), zero.probes + 1, "interval 0 allowed only the initial probe");
    assert.equal(pages(), zero.pages);
    await connect("Retry now");
    await until(
        "Retry now opened the saved address without waiting for the timer",
        () => pages() > zero.pages,
    );
    await shot(pageTitle, "startup-retry-now");
    await stopApp();

    const disabled = await launchSaved(remote, "pocket", { connectAtStartup: false });

    await shown("Connect");
    await sleep(2500);
    assert.equal(
        probes(),
        disabled.probes,
        "Connect at startup off suppressed even the initial probe",
    );
    assert.equal(pages(), disabled.pages);
    await connect("Connect");
    await until("explicit Connect worked with auto-connect off", () => pages() > disabled.pages);
    await stopApp();

    const other = await fixture();

    try {
        const switching = await launchSaved(remote, "down");

        await until(
            "startup retry was active before switching servers",
            () => probes() >= switching.probes + 2,
        );
        await shown("Retry now");
        await gui(windows ? "press" : "focus-field", settingsTitle, "Server address");
        await gui("selectAll", settingsTitle);
        await gui("type", settingsTitle, other.address);
        await gui("expect-field", settingsTitle, other.address);
        await connect("Connect");
        await until(
            "the new server replaced the pending startup connection",
            () => pages(other) > 0,
        );
        const switched = probes();

        remote.setMode("pocket");
        await sleep(2500);
        assert.equal(probes(), switched, "changing servers canceled the old startup retry");
        assert.equal(pages(), switching.pages, "the old server did not replace the new page");
        await stopApp();

        await launchSaved(other, "down");
        await shown("Retry now");
        await stopApp();
        const stopped = probes(other);

        other.setMode("pocket");
        await sleep(2500);
        assert.equal(probes(other), stopped, "Quit canceled the saved-server retry");
    } finally {
        await other.close();
    }

    await noLocalServer();
    console.log(
        "The installed app passed active recovery, interval 0, Retry now, startup opt-out, server change, and Quit.",
    );
}

try {
    await mkdir(out, { recursive: true });

    if (speechCache) {
        // The installer’s offline engine smoke downloaded these pinned files. The native pipe rechecks them.
        const models = join(stateFolder, "speech-models-v1");

        await mkdir(models);
        await cp(speechCache, join(models, "whisper-tiny"), { recursive: true });
        await writeFile(join(models, "selected"), "whisper-tiny");
        environment.PI_POCKET_DICTATION_SMOKE_PCM = fileURLToPath(
            new URL("../fixtures/dictation-jfk.pcm", import.meta.url),
        );
    }

    app = await start();
    await until("a fresh desktop settings file", () => stat(settings).catch(() => null));
    await waitForSettings(1);
    assert.equal((await prefs()).home.mode, null);
    assert.equal((await prefs()).window.titleBar, "seamless");
    await noLocalServer();
    await shot(settingsTitle, "home-fresh-install");

    if (speechCache) {
        await gui("click", settingsTitle, 95, 217); // Dictation in the installed sidebar.
        await shot(settingsTitle, "dictation-settings");
        assert.notDeepEqual(
            await readFile(join(out, "dictation-settings.png")),
            await readFile(join(out, "home-fresh-install.png")),
            "the Dictation screenshot is not another Home screenshot",
        );
    }

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
    const second = await start();

    await until("second launch raised the first process", () => exited(second));
    await waitForSettings(2);
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
    // WebKit uses a shorter native select control above these two buttons.
    const remoteButtonCenter = windows ? 442 : 430;

    try {
        await gui("click", settingsTitle, 390, 384); // Server address
        await gui("type", settingsTitle, remote.address);
        console.log("Home: Typed the fixture server address.");
        await gui("expect-field", settingsTitle, remote.address);
        console.log("Home: Read the exact fixture address from the focused field.");
        await gui("click", settingsTitle, 280, remoteButtonCenter); // Check
        console.log("Home: Clicked Check.");
        await until("Check used the base-path identity endpoint", () =>
            remote.requests.some(({ path }) => path === "/pocket/api/pocket/info"),
        );
        console.log("Home: The fixture received /pocket/api/pocket/info.");
    } catch (error) {
        await shot(settingsTitle, "home-check-failed").catch(() => {});

        throw error;
    }

    assert.equal((await prefs()).home.mode, null);
    assert(!remote.requests.some(({ path }) => path === "/pocket"));
    await gui("click", settingsTitle, 350, remoteButtonCenter); // Connect
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

    if (speechCache) {
        const seen = (suffix) =>
            remote.requests.some(({ path }) => path.endsWith(`/speech-${suffix}`));

        await until("the fixture attached the native dictation capability", () => seen("ready"));
        await gui("click", "Pi Pocket", 172, 199);
        await until(
            "speech from the installed native capture path reached the draft",
            () => seen("pass") || seen("error") || seen("mismatch"),
            110_000,
        );
        assert(
            seen("pass"),
            "The native capture pipe must transcribe the fixture without sending words to its server.",
        );
        const menu = join(out, "dictation-menu.png");

        await gui("dictation-menu", "Pi Pocket", menu);
        assert((await stat(menu)).size > 4000, "the native menu screenshot is not empty");
        console.log("The installed native capture pipe transcribed the fixture offline.");
    }

    console.log(
        "Check did not connect. Connect used the base path. The fixture had no Desktop Settings API or local credentials.",
    );

    await testBridge({ remote, gui, until, prefs, waitForSettings, shot, out, stateFolder });
    await stopApp();
    await testStartupRetry();
    console.log("The installed app passed the offline Settings and remote Home smoke test.");
} finally {
    if (app && !exited(app)) {
        await quit().catch(() => {});
        await until("app cleanup", () => exited(app), 10_000).catch(() => process.kill(app));
    }

    await remote.close();

    if (windows) {
        console.log(await webViewLog());
    }
}
