// Installed-app acceptance. The HTTP outage and test-build renderer exit affect only these fixtures.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const windows = process.platform === "win32";
const [exe, input, out] = process.argv.slice(2).map((arg) => resolve(arg));
const state = await mkdtemp(join(tmpdir(), "pocket-recovery-"));
const data = join(state, "data");
const settingsTitle = "Desktop Settings — Pi Pocket";
const pageTitle = "Pi Pocket";
const base = "/recovery";
const env = {
    ...process.env,
    PI_POCKET_DESKTOP_STATE: state,
    PI_POCKET_DIR: data,
    PI_POCKET_RECOVERY_SMOKE: "1",
};
const logFile = windows
    ? join(dirname(exe), "launcher.log")
    : join(homedir(), "Library", "Logs", "Pi Pocket", "launcher.log");
const read = (file) => readFile(file, "utf8").catch(() => "");
const previousLog = (await read(logFile)).length;
const log = async () => (await read(logFile)).slice(previousLog);
const requests = [];
let outage = false;
let persistentBoot = true;
let pid;

const fixture = createServer((req, res) => {
    const path = new URL(req.url, "http://test.invalid").pathname;
    const count = requests.filter((entry) => entry.path === path).length + 1;
    const cookie = req.headers.cookie?.includes("recovery=fixture") ?? false;

    requests.push({ path, cookie });
    res.setHeader("Cache-Control", "no-store");

    if (path.endsWith("/api/pocket/info")) {
        res.writeHead(outage && path.startsWith(base) ? 503 : 200, {
            "Content-Type": "application/json",
        }).end('{"name":"pi-pocket","bridge":1}');

        return;
    }

    if ((path === base && count === 1) || path === `${base}/s/9`) {
        // Never send headers. On server switch the attempt and its timers must go away.
        return;
    }

    if (path === base && count === 2) {
        res.setHeader("Set-Cookie", "recovery=fixture; Path=/recovery; HttpOnly; SameSite=Lax");
    }

    const boot = path === base && persistentBoot;
    const fail = path === `${base}/s/8` && outage;
    const exit = path === `${base}/s/7` && count === 1;
    const body = boot
        ? '<p data-part="boot">Fixture startup screen</p>'
        : `<h1>${path === "/replacement" ? "Replacement fixture view" : "Recovery fixture page"}</h1>
           <p>${cookie ? "Fixture sign-in retained" : "No fixture sign-in"}</p>
           ${path === base ? `<button onclick="open('${base}/s/7')">Open extra fixture view</button>` : ""}
           ${path === `${base}/s/7` ? `<a href="${base}/s/8">Open next fixture session</a>` : ""}
           ${path === `${base}/s/8` ? `<a href="${base}/s/9">Open stalled fixture session</a>` : ""}`;

    res.writeHead(fail ? 503 : 200, { "Content-Type": "text/html; charset=utf-8" }).end(`
        <!doctype html><title>Recovery fixture</title>
        <style>body{font:20px system-ui;padding:3rem;background:#eef2f9}button,a{font:inherit}</style>
        <body ${exit ? "data-fixture-exit" : ""}>${body}</body>`);
});

await new Promise((done) => fixture.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const visits = (path) => requests.filter((entry) => entry.path === path);

async function until(description, seen, ms = 25_000) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        if (await seen()) {
            return;
        }

        await delay(200);
    }

    throw new Error(`Timed out: ${description}`);
}

function gui(operation, title, ...args) {
    return exec(input, [String(pid), operation, title, ...args.map(String)], { timeout: 30_000 });
}

async function shot(title, name) {
    const file = join(out, `${name}.png`);

    await gui("shot", title, file);
    assert((await stat(file)).size > 4000, `${name} contains a screenshot of the installed app`);
}

async function start() {
    if (windows) {
        return Number((await exec(input, ["launch", exe], { env, timeout: 15_000 })).stdout.trim());
    }

    const child = spawn(exe, { env, stdio: "ignore" });

    await new Promise((done, reject) => {
        child.once("spawn", done);
        child.once("error", reject);
    });

    return child.pid;
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

async function connect(path) {
    await gui("click", settingsTitle, 95, 104); // Home
    await gui("click", settingsTitle, 420, 193); // Another server
    await gui("click", settingsTitle, 390, 384); // Server address
    await gui("selectAll", settingsTitle);
    await gui("type", settingsTitle, origin + path);
    await gui("expect-field", settingsTitle, origin + path);
    await gui("click", settingsTitle, 350, windows ? 442 : 430); // Connect
}

try {
    const file = join(state, "desktop.json");

    await mkdir(out, { recursive: true });
    await writeFile(
        file,
        JSON.stringify({
            schemaVersion: 1,
            windowPreferencesVersion: 1,
            preferences: { home: { healthInterval: 1, failureThreshold: 1, maxBackoff: 1 } },
        }),
    );
    pid = await start();
    assert(Number.isSafeInteger(pid) && pid > 0);
    await gui("expect-text", settingsTitle, "Another server");
    await gui("reload", settingsTitle); // No session view; this must not connect or start the server.
    await gui("find", settingsTitle);
    assert.deepEqual(requests, []);
    assert.equal(await stat(data).catch(() => null), null);

    await connect(base);
    await until("the initial navigation stalled before headers", () => visits(base).length === 1);
    await until(
        "startup recovery spent one reload and one recreation",
        async () => (await log()).includes("Page recovery (main): stopped."),
        65_000,
    );
    const mainSteps = (await log()).match(/Page recovery \(main\): \w+\./g);

    assert.deepEqual(mainSteps, [
        "Page recovery (main): reloading.",
        "Page recovery (main): recreating.",
        "Page recovery (main): stopped.",
    ]);
    assert.equal(visits(base).length, 3);
    assert.equal(visits(base)[2].cookie, true, "the replacement uses the same remote cookie store");
    await gui("expect-prefix", pageTitle, "The page could not recover.");
    await shot(pageTitle, "recovery-budget-spent");
    await gui("press", pageTitle, "Desktop Settings…");
    await gui("expect-text", settingsTitle, "Another server");
    await shot(settingsTitle, "settings-after-failure");
    await gui("close", settingsTitle);
    await delay(16_000); // Another startup deadline must not give the view a new budget.
    assert.equal(
        visits(base).length,
        3,
        "neither exhaustion nor Settings action starts another attempt",
    );
    persistentBoot = false;
    await gui("press", pageTitle, "Reload");
    await until("the native Reload button made a new request", () => visits(base).length === 4);
    assert.equal(visits(base)[3].cookie, true);
    await gui("expect-text", pageTitle, "Fixture sign-in retained");
    await shot(pageTitle, "recovery-reloaded");
    console.log(
        "Initial request stall and persistent boot screen used one reload and one recreation. Native Settings and Reload worked after exhaustion.",
    );

    await gui("press", pageTitle, "Open extra fixture view");
    await until("the extra view received the real renderer exit callback", async () =>
        (await log()).includes("Page recovery (extra): renderer exited."),
    );
    await until(
        "the extra view reloaded its own session with the same sign-in",
        () => visits(`${base}/s/7`).length === 2 && visits(`${base}/s/7`)[1].cookie,
    );
    await gui("expect-text", pageTitle, "Open next fixture session");
    const mainVisits = visits(base).length;

    outage = true;
    await gui("press", pageTitle, "Open next fixture session");
    await until("the extra view hit the outage", () => visits(`${base}/s/8`).length === 1);
    await until("the same server entered reconnecting", async () =>
        (await read(join(state, "diagnostics.log"))).includes("home.health:"),
    );
    outage = false;
    await until(
        "same-server recovery retried the failed extra view",
        () => visits(`${base}/s/8`).length === 2,
    );
    assert.equal(
        visits(base).length,
        mainVisits,
        "same-server recovery did not reload the healthy main view",
    );
    await gui("expect-text", pageTitle, "Open stalled fixture session");
    await gui("reload", pageTitle);
    await until(
        "the Reload shortcut applied only to the active extra view",
        () => visits(`${base}/s/8`).length === 3,
    );
    assert.equal(visits(base).length, mainVisits);
    await shot(pageTitle, "recovery-extra-session");
    console.log(
        "The extra renderer exited and recovered. A network recovery and the Reload shortcut used the active session, not the healthy main view.",
    );

    await gui("press", pageTitle, "Open stalled fixture session");
    await until(
        "the old extra view started a stalled navigation",
        () => visits(`${base}/s/9`).length === 1,
    );
    await gui("settings", pageTitle);
    await gui("expect-text", settingsTitle, "Another server");
    await connect("/replacement");
    await until("the replacement server opened", () => visits("/replacement").length === 1);
    assert.equal(visits("/replacement")[0].cookie, false);
    await delay(16_000); // Cross the cancelled view's startup deadline.
    assert.equal(visits(`${base}/s/9`).length, 1, "the old generation never made a stale retry");
    assert.equal(visits(base).length, mainVisits);
    await gui("expect-text", pageTitle, "Replacement fixture view");
    await exec(exe, ["--quit"], { env, timeout: 15_000 });
    await until("Quit ended the installed app", exited, 15_000);
    console.log("Switching cancelled the old view's retry. Reload on fresh Home opened no server.");
} finally {
    if (pid && !exited()) {
        await exec(exe, ["--quit"], { env, timeout: 15_000 }).catch(() => {});
        await until("app cleanup", exited, 10_000).catch(() => process.kill(pid));
    }

    fixture.closeAllConnections();
    await new Promise((done) => fixture.close(done));
    console.log(
        (await log())
            .split(/\r?\n/)
            .filter((line) => line.includes("Page recovery ("))
            .join("\n"),
    );
}
