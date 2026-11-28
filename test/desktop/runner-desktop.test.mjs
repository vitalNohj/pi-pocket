import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DesktopController } from "../../packaging/desktop/controller/index.mjs";
import { registerRunner } from "../../packaging/desktop/controller/runner/desktop.mjs";

const server = "https://pocket.example.test/base";
const code = "ZZY1-ZZY2-ZZY3"; // Synthetic code; never used on a live server.

async function fixture(t) {
    const folder = await mkdtemp(join(tmpdir(), "pocket-runner-desktop-"));
    const packets = [];
    const commands = [];
    const desktop = new DesktopController({
        folder,
        platform: "macos",
        version: "0.30.1",
        existingInstall: false,
        write: (packet) => packets.push(packet),
    });
    let policy = { enabled: false, ended: false };
    let linked = false;
    let emitStart;
    const runner = registerRunner(desktop, folder, {
        policy,
        savePolicy: (next) => {
            policy = next;
        },
        start(request, emit) {
            commands.push(request.action);

            switch (request.action) {
                case "status":
                    if (linked) {
                        emit("Computer: Installer test", true);
                        emit(`Server: ${server}`, true);
                        emit("This computer's key: private-fingerprint", true);
                    } else {
                        emit("This computer is not linked.", true);
                    }

                    break;
                case "link":
                    assert.equal(request.server, server);
                    assert.equal(request.code, code);
                    emit(`Unexpected diagnostic with ${code}`, false);
                    linked = true;
                    break;

                case "start": {
                    const { promise: done, resolve } = Promise.withResolvers();

                    emitStart = emit;

                    return {
                        done,
                        stop: () => {
                            commands.push("stop");
                            resolve(0);

                            return done;
                        },
                    };
                }

                case "unlink":
                    linked = false;
                    break;
            }

            return { done: Promise.resolve(0), stop: async () => {} };
        },
    });

    t.after(async () => {
        desktop.close();
        await runner.close();
        await rm(folder, { recursive: true, force: true });
    });

    let next = 0;

    const receive = async (command, value) => {
        const id = ++next;

        await desktop.receive({ id, command, value });

        return packets.find((packet) => packet.type === "result" && packet.id === id);
    };

    await desktop.load();

    // Startup queues a diagnostics write. Let it finish before this fixture can remove the folder.
    const deadline = Date.now() + 5000;
    const log = join(folder, "diagnostics.log");

    while (!(await readFile(log, "utf8").catch(() => "")).includes("controller.start: ok\n")) {
        assert.ok(Date.now() < deadline, "the controller wrote its startup diagnostic");
        await sleep(20);
    }

    await receive("subscribe");
    await runner.boot();

    return {
        desktop,
        packets,
        commands,
        receive,
        action: (id, data) => receive("action", { id, data }),
        emit: (line) => emitStart(line, true),
        policy: () => policy,
        close: () => runner.close(),
    };
}

test("typed Runner actions and live menu states work with no Home server", async (t) => {
    const f = await fixture(t);
    const view = () => f.desktop.snapshot();
    const row = () => view().menus.tray.find((item) => item.data?.section === "runner");
    const link = { server, code, trusted: true, allowHttp: false };

    assert.equal(view().home.active, null);
    assert.equal(view().runner.status, "unlinked");
    assert.equal(view().runner.source, "vitalNohj/pi-pocket");
    assert.deepEqual(row(), {
        id: "settings.open",
        label: "Runner: Off",
        enabled: true,
        data: { section: "runner" },
    });
    assert.equal(
        (await f.action("runner.link", { ...link, shell: "unknown" })).error.code,
        "invalid",
    );
    assert.equal(
        (await f.action("runner.link", { ...link, trusted: false })).error.code,
        "runner.trust",
    );
    assert.equal(
        (
            await f.action("runner.link", {
                ...link,
                server: "https://example.test/login?once=private",
            })
        ).error.code,
        "runner.input",
    );
    assert.equal(
        (await f.receive("patchPreferences", { runner: { enabled: true } })).error.code,
        "invalid",
    );
    assert.deepEqual(f.commands, ["status"]);
    assert.equal((await f.action("runner.link", link)).ok, true);
    assert.equal(view().runner.name, "Installer test");
    assert.equal(view().runner.server, server);
    assert.equal(row().label, "Runner: Off");
    assert.equal((await f.action("runner.enable", { enabled: true })).ok, true);
    assert.equal(f.policy().enabled, true);
    assert.equal(row().label, "Runner: Connecting");
    f.emit(`[12:34:56] Connected to ${server} as "Installer test".`);
    assert.equal(row().label, "Runner: Connected");
    f.emit('PI-POCKET-ACTIVITY {"working":true,"folders":["/private/work"]}');
    assert.equal(view().runner.workingFolders, 1);
    assert.equal(row().label, "Runner: Working now");
    assert.match(
        (await f.action("runner.reconnect")).error.message,
        /working now.*background tasks/,
    );
    assert.equal(
        (await f.action("runner.enable", { enabled: false })).error.code,
        "runner.confirm",
    );
    assert.equal((await f.action("runner.unlink")).error.code, "runner.confirm");
    assert.equal((await f.action("runner.enable", { enabled: false, confirmed: true })).ok, true);
    assert.equal(view().runner.working, false);
    assert.equal(view().runner.linked, true);
    assert.equal((await f.action("runner.unlink", { confirmed: true })).ok, true);
    assert.equal(view().runner.linked, false);
    assert.match(view().runner.message, /also remove it on the server/);
    const output = JSON.stringify(f.packets);

    assert.ok(!output.includes(code), "the wire does not echo the submitted code");
    assert.ok(
        !/private-fingerprint|private\/work|once=private/.test(output),
        "the wire omits raw CLI data",
    );
});

test("controller shutdown stops the owned runner and does not save Off", async (t) => {
    const f = await fixture(t);

    await f.action("runner.link", { server, code, trusted: true });
    await f.action("runner.enable", { enabled: true });
    await f.close();
    assert.equal(f.commands.at(-1), "stop");
    assert.equal(f.policy().enabled, true);
});
