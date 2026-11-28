// Run from the installer job with the installed Node and the native input driver. No test IPC ships in the app.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
    browserSignIn,
    installedModules,
    observeReply,
    runningLocal,
    sameFolder,
} from "./fixture.mjs";

const windows = process.platform === "win32";
const [exe, driver, evidence] = process.argv.slice(2).map((path) => resolve(path));
const pocket = join(installedModules(), "pi-pocket");
const installed = (path) => import(pathToFileURL(join(pocket, path)).href);
const root = await mkdtemp(join(tmpdir(), "pocket-runner-app-"));
const profile = join(root, "desktop state");
const localData = join(root, "local");
const folders = join(root, "runner-folders");
const work = join(folders, "allowed-workspace");
const outside = join(folders, "not-granted");
const env = { ...process.env, PI_POCKET_DESKTOP_STATE: profile, PI_POCKET_DIR: localData };
const settings = "Desktop Settings — Pi Pocket";
const serverWindow = "Pi Pocket";
const name = windows
    ? "Windows Desktop Runner"
    : process.arch === "arm64"
      ? "Apple Silicon Desktop Runner"
      : "Intel Mac Desktop Runner";
const exec = promisify(execFile);
const options = { timeout: 45_000, windowsHide: true };
let pid;
let app;
let http;
let borrowed;
let borrowedExit;

async function until(description, predicate, timeout = 30_000) {
    const end = Date.now() + timeout;

    while (Date.now() < end) {
        const result = await predicate();

        if (result) {
            return result;
        }

        await sleep(200);
    }

    throw new Error(`Did not see ${description}.`);
}

function exited(processId = pid) {
    try {
        process.kill(processId, 0);

        return false;
    } catch (error) {
        if (error.code !== "ESRCH") {
            throw error;
        }

        return true;
    }
}

async function input(operation, title, ...args) {
    await exec(driver, [String(pid), operation, title, ...args], options);
}

const press = (label, title = settings) => input("press", title, label);
const expect = (label, title = settings) => input("expect-text", title, label);
const focus = (label, title = settings) => input(windows ? "press" : "focus-field", title, label);
const type = (text, title = settings) => input("type", title, text);
const page = (label) => press(label, serverWindow);
const prefs = async () =>
    JSON.parse(await readFile(join(profile, "desktop.json"), "utf8")).preferences;

async function fill(label, text, title = settings, replace = false) {
    await focus(label, title);

    if (replace) {
        await input("selectAll", title);
    }

    await type(text, title);
    await input("expect-field", title, text);
}

function typeCode(code) {
    return new Promise((resolve, reject) => {
        const child = execFile(
            driver,
            [String(pid), "type-private", settings],
            options,
            (error) => {
                if (error) {
                    reject(new Error("Could not type the disposable code into Desktop Settings."));
                } else {
                    resolve();
                }
            },
        );

        child.stdin.on("error", () => {});
        child.stdin.end(`${code}\n`);
    });
}

async function shot(file, title) {
    const path = join(evidence, `${file}.png`);

    if (title) {
        await input("shot", title, path);
    } else {
        await input("tray-shot", "Runner: Working now", path);
    }

    assert((await stat(path)).size > 4000, `${file} contains a screenshot`);
}

async function launch() {
    if (windows) {
        const { stdout } = await exec(driver, ["launch", exe], { ...options, env });

        return Number(stdout.trim());
    }

    const child = spawn(exe, { env, stdio: ["ignore", "ignore", "inherit"] });

    await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
    });

    return child.pid;
}

const quit = () => exec(exe, ["--quit"], { ...options, env });
const closeSettings = () => input("close", settings);

async function openSettings() {
    await page("Menu");
    await page("Desktop Settings");
}

async function openAccess() {
    await page("Menu");
    await page("Access");
    await page("By computer");
}

async function connect(address) {
    await press("Home");
    await press("Another server");
    await fill("Server address", address, settings, true);
    await press("Connect");
    await until("Home saved the distinct server", async () => {
        const { home } = await prefs();

        return home.mode === "remote" && home.remoteAddress === address;
    });
}

async function choosePath(crumb, path) {
    await page(`${crumb}: type a path`);
    await fill("Go to a path", path, serverWindow, true);
    await page("OK");
}

async function localStart() {
    assert.equal(
        (await prefs()).home.mode,
        null,
        "Start must use a clean Home, not the upgrade flag",
    );
    assert.equal(await runningLocal(localData), undefined);
    await press("This computer");
    await press("Start Pi Pocket");
    const local = await until("the bundled local server", () => runningLocal(localData), 60_000);

    assert.equal((await fetch(`${local.address}/api/me`)).status, 401);
    // Only the signed-in owner's initial setup sheet has this button.
    await page("Not now");
    await input("new", serverWindow);
    await expect("New session: pick a folder", serverWindow);
    await choosePath("~", work);
    await expect("allowed-workspace: type a path", serverWindow);
    await shot("local-owner-picker", serverWindow);
    await page("Open");
    // Read only this disposable server's token to verify the result. The app never receives it from the test.
    const { ownerToken } = JSON.parse(await readFile(join(localData, "config.json"), "utf8"));

    await until("the authenticated local picker created a session", async () => {
        const reply = await fetch(`${local.address}/api/sessions`, {
            headers: { Authorization: `Bearer ${ownerToken}` },
            signal: AbortSignal.timeout(2500),
        });

        assert.equal(reply.status, 200);

        return (await reply.json()).some(({ title }) => title === "allowed-workspace");
    });
    await expect("allowed-workspace", serverWindow);
    console.log(
        "Fresh Home started the bundled local server and signed in to create a session in the installed view.",
    );

    return local;
}

async function checkAndReturnToLocal(address, local, sawFailedCheck, navigations) {
    await page("Close");
    const before = navigations();

    await openSettings();
    await press("Home");
    await press("Another server");
    await fill("Server address", `${address}/unavailable`, settings, true);
    await press("Check");
    await expect("No Pi Pocket server answered at this address.");
    assert(sawFailedCheck(), "the app probed the failed candidate");
    const { home } = await prefs();

    assert.equal(home.remoteAddress, address);
    assert.equal(home.mode, "remote");
    await shot("failed-check-kept-remote", settings);
    await closeSettings();
    await expect("Menu", serverWindow);
    assert.equal(navigations(), before, "failed Check must not open or reload the server view");
    assert.deepEqual(await runningLocal(localData), local);
    await openSettings();
    await press("Home");
    await press("This computer");
    await expect("Running on this computer");
    await press("Open Pi Pocket");
    await until("Home connected back to Local", async () => (await prefs()).home.mode === "local");
    await expect("allowed-workspace", serverWindow);
    assert.deepEqual(await runningLocal(localData), local);
    await openSettings();
    await press("Home");
    await press("This computer");
    await press("Stop");
    await press("Continue");
    await until("Stop ended only the app-owned launcher", () => exited(local.pid));
    assert.equal((await fetch(`${address}/api/pocket/info`)).status, 200);
    console.log(
        "A failed Check kept the remote page. Local stayed up across the switch and stopped only on Stop.",
    );
}

async function borrowLocal() {
    // This launcher belongs to the test, not the desktop. Keep its own lifetime pipe open across app Quit.
    borrowed = spawn(
        process.execPath,
        [join(pocket, "bin", "pi-pocket.js"), "--desktop", "--data", localData],
        {
            cwd: work,
            env,
            stdio: ["pipe", "ignore", "ignore"],
            windowsHide: true,
        },
    );
    borrowed.stdin.on("error", () => {});
    borrowedExit = new Promise((resolve) => {
        borrowed.once("error", resolve);
        borrowed.once("close", resolve);
    });
    const local = await until(
        "the independent launcher",
        async () => {
            const state = await runningLocal(localData);

            return state?.pid === borrowed.pid ? state : undefined;
        },
        60_000,
    );

    // The Home card still displays the last stopped snapshot. Start inspects before it launches.
    await press("Start Pi Pocket");
    await input("find", serverWindow);
    await openSettings();
    await press("Home");
    await press("This computer");
    await expect("Already running (console or other launcher)");
    assert.deepEqual(await runningLocal(localData), local);
    await shot("borrowed-local", settings);
    await quit();
    await until("the desktop quit without taking its borrowed server with it", () => exited());
    assert.deepEqual(await runningLocal(localData), local);
    borrowed.stdin.end();
    await until("the test stopped its own launcher", () => exited(local.pid));
    await borrowedExit;
    console.log("The app opened a console-owned local server and left it running on Quit.");
}

try {
    assert.ok(process.env.NPM_CONFIG_REGISTRY?.startsWith("http://127.0.0.1:9/"));
    await mkdir(evidence, { recursive: true });
    await mkdir(work, { recursive: true });
    await mkdir(outside);
    await installed("bin/strip-types.js");
    const { PocketApp } = await installed("src/server/app.ts");
    const { createHandler } = await installed("src/server/http.ts");
    const { BACKGROUND_CONTEXT } = await installed(
        "node_modules/@earendil-works/chord/dist/context/index.js",
    );

    app = await PocketApp.open({
        dataDir: join(root, "fixture server"),
        defaultCwd: work,
        home: root,
        supervised: false,
        log: () => {},
    });
    const owner = app.config.users.find((user) => user.role === "owner");
    const guestName = "Fixture Guest";
    const { user: guest, token: guestToken } = app.config.addUser(guestName, "guest");
    const ownerToken = app.config.addDevice(owner.id);
    const accessPage = `/?direct=${encodeURIComponent(owner.id)}`;
    const sessions = [];
    let signIn;
    let openAccessOnSignIn = true;
    let code;
    let failedCheck = false;
    let browserNavigations = 0;
    let scopeReply;

    app.config.updateUser(owner.id, { setupDismissed: true });
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    http = createServer((request, response) => {
        const { method, url } = request;

        if (url?.startsWith("/unavailable")) {
            failedCheck = true;
            response.writeHead(503, { "Content-Type": "application/json" }).end("{}");

            return;
        }

        if (
            request.headers["sec-fetch-mode"] === "navigate" &&
            request.headers["sec-fetch-dest"] === "document"
        ) {
            browserNavigations++;
        }

        if (method === "GET" && url === "/") {
            if (signIn) {
                // Normal sign-in on this isolated fixture. Neither token nor cookie is recorded in the evidence.
                response.writeHead(303, { Location: signIn, "Cache-Control": "no-store" }).end();
                signIn = undefined;

                return;
            }

            if (openAccessOnSignIn && request.headers.cookie?.includes("pocket_auth=")) {
                openAccessOnSignIn = false;
                response
                    .writeHead(303, { Location: accessPage, "Cache-Control": "no-store" })
                    .end();

                return;
            }
        }

        if (method === "POST" && url === "/api/runners/code") {
            observeReply(response, (reply) => {
                code = reply.code;
            });
        } else if (method === "POST" && url === "/api/sessions") {
            observeReply(response, (reply) => sessions.push(reply.id));
        } else if (
            method === "GET" &&
            /\/api\/runners\/[^/]+\/fs\?/.test(url ?? "") &&
            request.headers.cookie
        ) {
            observeReply(response, (reply) => {
                scopeReply = reply;
            });
        }

        void handler(request, response);
    });
    http.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${http.address().port}`;
    const online = (id) => app.runners.link(id).online;
    const runnerId = () => app.config.runners.find((runner) => runner.name === name)?.id;

    pid = await launch();
    assert(Number.isSafeInteger(pid) && pid > 0, "the installed app launched");
    await expect("Start Pi Pocket");
    const local = await localStart();

    signIn = await browserSignIn(app, address, owner);
    await openSettings();
    await connect(address);
    await page("By computer");
    assert.equal(
        openAccessOnSignIn,
        false,
        "the embedded remote view signed in with its own cookie",
    );
    assert.deepEqual(await runningLocal(localData), local);
    await shot("server-connected", serverWindow);
    await checkAndReturnToLocal(
        address,
        local,
        () => failedCheck,
        () => browserNavigations,
    );

    // The regular Access sheet issues the code. The test copies that response, not a separate programmatic link.
    openAccessOnSignIn = true;
    await connect(address);
    await page("By computer");
    await page("Link a computer");
    await fill("Name", name, serverWindow);
    await page("Get a link code");
    await until("the code requested by the web UI", () => code);
    await page("Done");
    await page("Close");
    await openSettings();
    await press("Runner");
    await expect("Not linked");
    await press("I trust this server");
    await fill("Runner server address", address);
    await focus("One-time code");
    await typeCode(code);
    code = undefined;
    await press("Link");
    const id = await until("the installed app redeem the one-time link", runnerId);

    await press("Enable runner");
    await until("the linked computer online on the server", () => online(id));
    await expect("Connected");
    await closeSettings();

    await input("new", serverWindow);
    await page(name);
    await choosePath("~", folders);
    await expect("not-granted", serverWindow);
    await page("allowed-workspace");
    await shot("runner-owner-picker", serverWindow);
    await page("Open");
    const session = await until(
        "a session created by Open in the runner picker",
        () => sessions[0],
    );
    const meta = app.sessionMeta(session);

    assert.equal(meta?.runner, id);
    assert.equal(meta?.createdBy, owner.id);
    await sameFolder(meta.cwd, work);

    // Run one bounded operation using the session's real runner scope, not a synthetic scope made by this test.
    const marker = join(work, "runner-was-here.txt");
    const command = app
        .envFor(session)
        .exec(
            `node -e "require('fs').writeFileSync('runner-was-here.txt', 'picker session'); setTimeout(() => {}, 45000)"`,
            {},
            BACKGROUND_CONTEXT,
        );

    void command.catch(() => {});
    await until("the operation ran in the picked folder", () => stat(marker).catch(() => null));
    assert.equal(await readFile(marker, "utf8"), "picker session");
    await openSettings();
    await press("Runner");
    await expect("Working now");
    await shot("runner-working", settings);
    await closeSettings();

    if (windows) {
        await input("close-to-tray", serverWindow);
    }

    await shot("runner-menu");
    await expect("Working now");
    assert.equal((await command).ok, true);
    await expect("Connected");
    await closeSettings();
    console.log(
        "A session made in the normal folder picker ran work in the selected folder and showed native activity.",
    );

    await openAccess();
    await page(name);
    await page(`${guestName} may use ${name}: off`);
    const realWork = app.cwdOf(session);

    await page(`Access of ${guestName} to ${realWork} on ${name}: No access`);
    await page("Start sessions");
    await until(
        "the web UI grant one folder to the guest",
        () =>
            app.config.runners.find((runner) => runner.id === id)?.given?.[guest.id]?.length === 1,
    );
    await page("Close");

    // Relaunch on the same remote server. Normal sign-in asks before switching to the guest account.
    await quit();
    await until("the desktop quit", () => exited());
    await until("the desktop runner went offline on Quit", () => !online(id));
    assert.equal(
        JSON.parse(await readFile(join(profile, "runner", "policy.json"), "utf8")).enabled,
        true,
    );
    signIn = `/login?${new URLSearchParams({ token: guestToken })}`;
    scopeReply = undefined;
    pid = await launch();
    await page(`Sign in as ${guestName}`);
    await until("the same enabled runner reconnect after relaunch", () => online(id));
    assert.equal(runnerId(), id);

    await input("new", serverWindow);
    await page(name);
    // Outside a grant, the guest's folder listing is the virtual root: only the granted path, not its siblings.
    await expect(realWork, serverWindow);
    assert.equal(scopeReply?.path, "");
    assert.equal(scopeReply?.dirs.length, 1);
    await sameFolder(scopeReply.dirs[0].path, work);
    await shot("runner-scoped-guest-picker", serverWindow);
    const deny = await fetch(`${address}/api/sessions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${guestToken}`,
            "Content-Type": "application/json",
            "X-Pocket": "1",
        },
        body: JSON.stringify({ cwd: outside, runner: id }),
    });

    assert.equal(deny.status, 403, "the server refuses a guest start outside the grant");
    await page("Cancel");
    await openSettings();
    await press("Runner");
    await expect("Connected");
    const revoked = await fetch(`${address}/api/runners/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerToken}`, "X-Pocket": "1" },
    });

    assert.equal(revoked.status, 200);
    await expect("Link ended");
    await shot("runner-link-ended", settings);
    console.log(
        "The scoped guest saw only the allowed folder. Relaunch kept the runner link; revocation ended it.",
    );

    await press("Home");
    await press("This computer");
    await borrowLocal();
} finally {
    if (pid && !exited()) {
        await quit().catch(() => {});
        await until("the test app quit", () => exited(), 15_000).catch(() => process.kill(pid));
    }

    if (borrowed?.pid) {
        borrowed.stdin.end();
        await until("the test launcher quit", () => exited(borrowed.pid), 15_000).catch(() =>
            borrowed.kill(),
        );
        await borrowedExit;
    }

    await app?.close();
    http?.closeAllConnections();

    if (http) {
        await new Promise((resolve) => http.close(resolve));
    }

    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
