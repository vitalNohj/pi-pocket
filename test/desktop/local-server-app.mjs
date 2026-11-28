// Exercise the installed native app, its native folder dialogs and the bundled launcher.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const windows = process.platform === "win32";
const settings = "Desktop Settings — Pi Pocket";
const pocket = "Pi Pocket";
const exec = promisify(execFile);
const endpoint = (port, host = "127.0.0.1") => `http://${host}:${port}`;
const request = (url, options) => fetch(url, { signal: AbortSignal.timeout(1500), ...options });
const answers = async (url) =>
    (await request(`${url}/api/pocket/info`).catch(() => null))?.ok === true;

async function reserve() {
    const listener = createServer((socket) => socket.destroy());

    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");

    return {
        port: listener.address().port,
        close: () => new Promise((done) => listener.close(done)),
    };
}

async function locker(folder) {
    await mkdir(folder);

    if (!windows) {
        await chmod(folder, 0);

        return () => chmod(folder, 0o700);
    }

    const { stdout } = await exec("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const sid = stdout.match(/S-1-[\d-]+/u)?.[0];

    assert(sid, "the disposable test user has a SID");
    await exec("icacls.exe", [folder, "/deny", `*${sid}:(RD)`]);

    return () => exec("icacls.exe", [folder, "/remove:d", `*${sid}`]);
}

function installedLauncher() {
    assert(process.env.MANIFEST && process.env.APP, "the installer job sets MANIFEST and APP");

    return {
        script: join(dirname(process.env.MANIFEST), "bin", "pi-pocket.js"),
        node: join(process.env.APP, "node", ...(windows ? ["node.exe"] : ["bin", "node"])),
    };
}

export async function testLocalServer({ gui, until, prefs, shot, stateFolder, data, relaunch }) {
    const root = await realpath(stateFolder);
    const workspace = join(root, "Project café");
    const newData = join(root, "Pi Pocket 日本語");
    const marker = join(data, "keep-here.txt");
    const addressFile = (root) => join(root, "launcher-running.json");
    const running = async (root) =>
        JSON.parse(await readFile(addressFile(root), "utf8").catch(() => "null"));
    const press = (label) => gui("press", settings, label);
    const text = (label) => gui("expect-text", settings, label);
    const prefix = (label) => gui("expect-prefix", settings, label);

    const edit = async (label, value) => {
        await gui("focus-field", settings, label);
        await gui("selectAll", settings);
        await gui("paste", settings, value);
    };

    const choose = async (label, accept) => {
        await press(label);
        await gui(
            "press",
            windows ? "Browse For Folder" : settings,
            accept ? (windows ? "OK" : "Choose") : "Cancel",
        );
    };

    const nextExposure = async () => {
        await gui("focus-choice", settings, "Who can connect");
        await gui("chooseNext", settings);
    };

    const serverSettings = () => press("Local server settings");
    const home = () => press("Go to Home");
    const start = () => press("Start Pi Pocket");
    const save = () => press("Save local settings");

    const apply = async () => {
        await press("Restart to apply");
        await press("Continue");
    };

    const stop = async () => {
        await press("Stop");
        await press("Continue");
    };

    const reopen = async () => {
        await gui("settings", pocket);
        await gui("find", settings);
    };

    const ready = async (root, port, previous) => {
        await until("the bundled launcher on the selected port", async () => {
            const record = await running(root);

            return (
                record?.pid !== previous &&
                record?.url === endpoint(port) &&
                (await answers(record.url))
            );
        });

        return (await running(root)).pid;
    };

    await mkdir(workspace);
    await mkdir(newData);
    await mkdir(data);
    await writeFile(marker, "Do not move this test data.\n");
    const first = await reserve();

    await first.close();
    const lanIPv4 = Object.values(networkInterfaces())
        .flat()
        .find((net) => net.family === "IPv4" && !net.internal)?.address;

    assert(lanIPv4, "the test computer has a non-loopback IPv4 interface");
    await press("Home");
    await press("This computer");
    await serverSettings();
    assert.equal((await prefs()).server.access, "local");
    await edit("Port", 65536);
    await save();
    await text("Enter a whole port number between 1 and 65535.");
    await edit("Port", first.port);
    const denied = join(stateFolder, "Unreadable workspace");
    const unlock = await locker(denied);

    try {
        await edit("Default session folder", denied);
        await save();
        await text("Choose a readable folder for new sessions.");
        assert.notEqual((await prefs()).server.cwd, denied);
    } finally {
        await unlock();
    }

    await edit("Default session folder", workspace);
    await choose("Choose session folder…", false);
    await gui("focus-field", settings, "Default session folder");
    await gui("expect-field", settings, workspace);
    assert.notEqual(
        (await prefs()).server.cwd,
        workspace,
        "a cancelled picker does not save anything",
    );
    await choose("Choose session folder…", true);
    await save();
    await until(
        "the session folder and port saved",
        async () => (await prefs()).server.port === first.port,
    );
    await home();
    await start();
    const original = await ready(data, first.port);

    assert.equal(
        await answers(endpoint(first.port, lanIPv4)),
        false,
        "device-only excludes the runner's LAN address",
    );
    await gui("new", pocket);
    await gui("expect-text", pocket, "Default workspace");
    await reopen();
    await serverSettings();

    const busy = await reserve();
    let port;

    try {
        await edit("Port", busy.port);
        await save();
        await until("the staged port saved", async () => (await prefs()).server.port === busy.port);
        await apply();
        await prefix(`Port ${busy.port} is in use.`);
        assert.equal(
            (await running(data)).pid,
            original,
            "an occupied port does not interrupt the old server",
        );
        assert(await answers(endpoint(first.port)));
        const next = await reserve();

        port = next.port;
        await next.close();
        await edit("Port", port);
    } finally {
        await busy.close();
    }

    await edit("Data folder", newData);
    await choose("Choose data folder…", true);
    await nextExposure();
    await save();
    await until(
        "the LAN and data settings saved",
        async () => (await prefs()).server.access === "lan",
    );
    await shot(settings, "local-server-settings");
    const saved = (await prefs()).server;

    assert.equal(await realpath(saved.cwd), await realpath(workspace));
    assert.equal(await realpath(saved.data), await realpath(newData));
    assert.equal(saved.port, port);
    assert.equal(saved.access, "lan");
    assert.equal(await running(newData), null);
    await apply();
    const replaced = await ready(newData, port, original);

    assert(
        await answers(endpoint(port, lanIPv4)),
        "LAN mode answers on the runner's own LAN address",
    );
    assert.equal(await answers(endpoint(first.port)), false);
    assert.equal(await readFile(marker, "utf8"), "Do not move this test data.\n");
    await assert.rejects(stat(join(newData, "keep-here.txt")), { code: "ENOENT" });
    const config = JSON.parse(await readFile(join(newData, "config.json"), "utf8"));
    const hello = await (
        await request(`${endpoint(port)}/api/me`, {
            headers: { Authorization: `Bearer ${config.ownerToken}` },
        })
    ).json();

    assert.equal(await realpath(hello.server.defaultCwd), await realpath(workspace));
    await gui("new", pocket);
    await gui("expect-text", pocket, "Default workspace");
    await shot(pocket, "local-server-default-workspace");
    await relaunch();
    await ready(newData, port, replaced);
    assert.deepEqual((await prefs()).server, saved);
    await reopen();
    await serverSettings();
    await home();
    await stop();
    await until(
        "stop took down the app-owned server",
        async () => (await running(newData)) === null,
    );

    const installed = installedLauncher();
    const borrowed = spawn(
        installed.node,
        [
            installed.script,
            "--desktop",
            "--access",
            "local",
            "--cwd",
            workspace,
            "--data",
            newData,
            "--port",
            String(port),
        ],
        { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    );
    const borrowedExit = once(borrowed, "exit");

    try {
        const pid = await ready(newData, port);

        assert.equal(pid, borrowed.pid);
        await start();
        await reopen();
        await serverSettings();
        await prefix("Another launcher owns this server.");
        await nextExposure();
        await save();
        await until(
            "the borrowed instance's next-launch preferences saved",
            async () => (await prefs()).server.access === "tailscale",
        );
        await shot(settings, "local-server-borrowed");
        assert.equal((await running(newData)).pid, pid);
        assert(
            await answers(endpoint(port)),
            "saving settings does not restart a borrowed launcher",
        );
        await relaunch();
        assert.equal((await running(newData)).pid, pid);
        assert(
            await answers(endpoint(port)),
            "quitting and reopening the app keeps the borrowed launcher alive",
        );
    } finally {
        borrowed.stdin.end();
        await borrowedExit;
    }

    await reopen();
    await serverSettings();
    await testExposure({
        installed,
        stateFolder,
        workspace: saved.cwd,
        port,
        until,
        prefs,
        shot,
        edit,
        save,
        home,
        serverSettings,
        start,
        reopen,
        stop,
        nextExposure,
        prefix,
        ready,
        openBorrowed: () => press("Open Pi Pocket"),
    });
    console.log(
        "Installed local server: selected Unicode folders, saved and restarted, checked device-only and LAN, and left the borrowed launcher alone.",
    );
}

async function testExposure({
    installed,
    stateFolder,
    workspace,
    port,
    until,
    prefs,
    shot,
    edit,
    save,
    home,
    serverSettings,
    start,
    reopen,
    stop,
    nextExposure,
    prefix,
    ready,
    openBorrowed,
}) {
    const fixtureData = join(stateFolder, "Exposure fixture");
    const outcome = join(fixtureData, "test-outcome");
    const backup = join(stateFolder, "original-launcher.js");

    await mkdir(fixtureData);
    await writeFile(outcome, "missing");
    await edit("Data folder", fixtureData);
    await save();
    await until(
        "the isolated exposure fixture folder saved",
        async () => (await prefs()).server.data === fixtureData,
    );
    await copyFile(installed.script, backup);

    try {
        // Replace only the disposable installed job's launcher entry for these six cases.
        // The native app still starts, supervises and verifies the process. No tunnel, tailnet,
        // account, DNS change, or production test seam is involved.
        await writeFile(installed.script, launcherFixture(fixtureData, workspace, port));

        for (const access of ["tailscale", "cloudflare"]) {
            if (access === "cloudflare") {
                await serverSettings();
                await nextExposure();
                await save();
                await until(
                    "Cloudflare selected",
                    async () => (await prefs()).server.access === access,
                );
            }

            await home();
            await writeFile(outcome, `${access}:missing`);
            await (access === "tailscale" ? openBorrowed : start)();
            await prefix(
                access === "tailscale"
                    ? "Tailscale is not connected."
                    : "Cloudflare Tunnel needs cloudflared.",
            );
            await writeFile(outcome, `${access}:failed`);
            await start();
            await prefix("Pi Pocket did not get ready with these settings.");
            assert.equal(
                await answers(endpoint(port)),
                false,
                "no fallback listener after an exposure failure",
            );
            assert.equal((await prefs()).server.access, access);
            await shot(settings, `local-server-${access}-error`);
            await writeFile(outcome, `${access}:ready`);
            await start();
            await ready(fixtureData, port);
            await reopen();
            await stop();
            await until(
                "the app stopped the exposure fixture",
                async () => (await answers(endpoint(port))) === false,
            );
        }
    } finally {
        await copyFile(backup, installed.script);
    }
}

function launcherFixture(data, cwd, port) {
    return `import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const [mode, outcome] = readFileSync(join(${JSON.stringify(data)}, "test-outcome"), "utf8").split(":");
assert.deepEqual(process.argv.slice(2), ["--desktop", "--data", ${JSON.stringify(data)}, "--cwd", ${JSON.stringify(cwd)}, "--port", ${JSON.stringify(String(port))}, "--access", mode]);
if (outcome === "missing") {
    console.error(mode === "tailscale" ? "  Tailscale is not connected on this machine. Connect it with: tailscale up" : "  cloudflared is not installed. Install it with: winget install --id Cloudflare.cloudflared");
    process.exit(1);
}
if (outcome !== "ready") { console.error("Injected launcher failure."); process.exit(1); }
const record = join(${JSON.stringify(data)}, "launcher-running.json");
const server = createServer((req, res) => {
    if (req.url === "/api/pocket/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "pi-pocket" }));
    } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<title>Pi Pocket</title><h1>Exposure fixture ready</h1>");
    }
});
server.listen(${port}, "127.0.0.1", () => writeFileSync(record, JSON.stringify({ version: 1, pid: process.pid, desktop: true, url: ${JSON.stringify(endpoint(port))} })));
process.stdin.resume();
process.stdin.on("end", () => {
    rmSync(record, { force: true });
    server.close(() => process.exit(0));
});
`;
}
