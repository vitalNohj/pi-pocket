// Run from the installer job with the installed Node and the native input driver. No test IPC ships in the app.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const windows = process.platform === "win32";
const [exe, driver, evidence] = process.argv.slice(2).map((path) => resolve(path));
const bin = dirname(process.execPath);
const pocket = windows
    ? join(bin, "..", "app", "node_modules", "pi-pocket")
    : join(bin, "..", "..", "app", "lib", "node_modules", "pi-pocket");
const installed = (path) => import(pathToFileURL(join(pocket, path)).href);
const root = await mkdtemp(join(tmpdir(), "pocket-runner-app-"));
const profile = join(root, "desktop state");
const work = join(root, "workspace");
const env = {
    ...process.env,
    PI_POCKET_DESKTOP_STATE: profile,
    PI_POCKET_DIR: join(root, "local"),
};
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
let signIn;
let signedIn = false;

async function until(description, predicate, timeout = 30_000) {
    const end = Date.now() + timeout;

    while (Date.now() < end) {
        if (await predicate()) {
            return;
        }

        await sleep(200);
    }

    throw new Error(`Did not see ${description}.`);
}

function exited() {
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

async function input(operation, title, ...args) {
    await exec(driver, [String(pid), operation, title, ...args], options);
}

const press = (label, title = settings) => input("press", title, label);
const expect = (label, title = settings) => input("expect-text", title, label);
const focus = (label) => input(windows ? "press" : "focus-field", settings, label);
const type = (text) => input("type", settings, text);

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

try {
    assert.ok(process.env.NPM_CONFIG_REGISTRY?.startsWith("http://127.0.0.1:9/"));
    await mkdir(evidence, { recursive: true });
    await mkdir(work);
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

    app.config.updateUser(owner.id, { setupDismissed: true });
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    const accessPage = `/?direct=${encodeURIComponent(owner.id)}`;

    http = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/" && signIn) {
            // Only this loopback fixture can issue this redirect. The app signs in as a normal browser.
            response.writeHead(303, { Location: signIn, "Cache-Control": "no-store" }).end();
            signIn = undefined;
        } else if (
            request.method === "GET" &&
            request.url === "/" &&
            !signedIn &&
            request.headers.cookie?.includes("pocket_auth=")
        ) {
            // Use the real server page's Access deep link. The tab and list come from the installed web app.
            signedIn = true;
            response.writeHead(303, { Location: accessPage, "Cache-Control": "no-store" }).end();
        } else {
            void handler(request, response);
        }
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
    await press("Runner");
    await expect("Not linked");
    await press("I trust this server");
    await focus("Runner server address");
    await type(address);
    await input("expect-field", settings, address);
    await focus("One-time code");
    await typeCode(app.runners.makeCode(name, owner.id).code);
    await press("Link");
    await until("the installed app redeem the one-time link", runnerId);
    const id = runnerId();

    await press("Enable runner");
    await until("the linked computer online on the server", () => online(id));
    await expect("Connected");
    console.log("The installed Runner card linked and enabled its own runner with no Home server.");

    const runner = app.runners.env(id, work, {
        id: "7053c1d4-4f9f-48b4-81ea-5b3fccc10fb6",
        folder: work,
    });
    const command = runner.exec('node -e "setTimeout(() => {}, 180000)"', {}, BACKGROUND_CONTEXT);

    void command.catch(() => {}); // The fixture stops this command when it disables or quits the runner.
    await expect("Working now");
    await shot("runner-working", settings);
    console.log("The installed Runner card showed Working now.");

    const signed = await fetch(`${address}/api/sign-in-link`, {
        method: "POST",
        headers: { Authorization: `Bearer ${app.config.addDevice(owner.id)}`, "X-Pocket": "1" },
    });

    assert.equal(signed.status, 200, "the disposable server issued a one-time browser sign-in");
    signIn = (await signed.json()).path;
    await press("Home");
    await press("Another server");
    await focus("Server address");
    await type(address);
    await input("expect-field", settings, address);
    await press("Connect");
    await until("the installed app open the linked server's signed-in page", () => signedIn);
    await press("By computer", serverWindow);
    await input("expect-prefix", serverWindow, name);
    assert.ok(online(id), "the listed runner remained online across Home's connection change");
    await shot("server-connected", serverWindow);
    console.log("The server listed the same computer in Access → By computer while it was online.");

    if (windows) {
        await input("close-to-tray", serverWindow); // Do not confuse the window's taskbar button with the tray icon.
    }

    await shot("runner-menu");
    await expect("Working now"); // Selecting the native row opened Runner, not the last Settings section.
    console.log("The native menu showed Working now and its Runner row opened the card.");

    await quit();
    await until("the app quit", exited);
    await until("the app's runner went offline on Quit", () => !online(id));
    const policy = JSON.parse(await readFile(join(profile, "runner", "policy.json"), "utf8"));

    assert.equal(policy.enabled, true, "Quit stops the process but preserves Enable runner");
} finally {
    if (pid && !exited()) {
        await quit().catch(() => {});
        await until("the test app quit", exited, 15_000).catch(() => process.kill(pid));
    }

    await app?.close();
    http?.closeAllConnections();

    if (http) {
        await new Promise((resolve) => http.close(resolve));
    }

    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
