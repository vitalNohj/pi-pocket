// Run the installed app, not a copy of the Settings page. Input and screenshots come from the OS.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fixture } from "./fixture.mjs";

const windows = process.platform === "win32";
const [exe, input, out, speechCache] = process.argv.slice(2).map((arg) => resolve(arg));
const settingsTitle = "Desktop Settings — Pi Pocket";
const stateFolder = await mkdtemp(join(tmpdir(), "pocket-desktop-smoke-"));
const data = join(stateFolder, "server-data");
const settings = join(stateFolder, "desktop.json");
const environment = { ...process.env, PI_POCKET_DESKTOP_STATE: stateFolder, PI_POCKET_DIR: data };
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

    await quit();
    await until("Quit ended the app", () => exited(app));
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
