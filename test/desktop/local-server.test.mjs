import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopController } from "../../packaging/desktop/controller/index.mjs";
import { localDefaults } from "../../packaging/desktop/controller/local-server/settings.mjs";
import { fixture } from "./fixture.mjs";

async function portListener() {
    const server = createServer();

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    return { port: server.address().port, close: () => new Promise((done) => server.close(done)) };
}

async function profile(t, { borrow = false } = {}) {
    const folder = await mkdtemp(join(tmpdir(), "pocket-local-"));
    const cwd = join(folder, "Project café");
    const data = join(folder, "New data 日本語");
    const listener = await portListener();
    const port = listener.port;
    const settings = { cwd, data, port, access: "local" };
    const commands = [];
    const results = new Map();
    const address = `http://127.0.0.1:${port}`;
    let running = borrow ? { status: "running", owned: false, verified: true, address } : null;
    let picked = null;
    let id = 0;

    await listener.close();
    await mkdir(cwd);
    t.after(() => rm(folder, { recursive: true, force: true }));

    const controller = new DesktopController({
        folder,
        platform: "windows",
        version: "0.0.0-dev",
        existingInstall: false,
        write(packet) {
            if (packet.type === "result") {
                results.set(packet.id, packet);
            } else if (packet.type === "host") {
                commands.push(packet);
                let value = null;

                if (packet.action === "local.inspect") {
                    value = running ?? { status: "stopped", owned: false, verified: false };
                } else if (packet.action === "local.open") {
                    const actual = packet.data.settings;

                    value = running = {
                        status: "running",
                        owned: true,
                        verified: true,
                        address: `http://127.0.0.1:${actual.port}`,
                        settings: actual,
                    };
                } else if (packet.action === "local.pickFolder") {
                    value = picked;
                }

                void controller.receive({
                    id: packet.id + 10000,
                    command: "host.result",
                    value: { id: packet.id, ok: true, value },
                });
            }
        },
    });

    t.after(() => controller.close());
    await controller.load();

    async function call(command, value) {
        const request = ++id;

        await controller.receive({ id: request, command, value });
        const result = results.get(request);

        assert(result);

        if (!result.ok) {
            throw Object.assign(new Error(result.error.message), { code: result.error.code });
        }

        return result.value;
    }

    return {
        controller,
        folder,
        settings,
        commands,
        patch: (patch) => call("patchPreferences", { server: patch }),
        action: (id, data) => call("action", { id, ...(data === undefined ? {} : { data }) }),
        choose: (folder) => {
            picked = folder;
        },
    };
}

test("local launch uses only validated saved settings and does not create data when saving", async (t) => {
    const { controller, folder, settings, patch, action, commands, choose } = await profile(t);
    const initial = controller.snapshot().preferences.server;

    assert.equal(initial.access, "local");
    assert.deepEqual(initial, localDefaults());

    for (const invalid of [
        { port: 65536 },
        { port: 0 },
        { port: 1.5 },
        { port: "8787" },
        { access: "custom" },
        { data: "relative" },
    ]) {
        await assert.rejects(patch(invalid), { code: "invalid" });
    }

    await assert.rejects(patch({ cwd: join(folder, "missing") }), { code: "folder" });
    await writeFile(join(folder, "a file"), "not a directory");
    await assert.rejects(patch({ data: join(folder, "a file") }), { code: "folder" });

    const picker = () => action("server.pickFolder", { kind: "data", folder: settings.data });

    assert.equal(await picker(), null);
    choose(settings.data);
    assert.equal(await picker(), settings.data);
    assert.deepEqual(controller.snapshot().preferences.server, initial);
    await patch(settings);
    await assert.rejects(readFile(join(settings.data, "config.json")), { code: "ENOENT" });
    assert.deepEqual(
        JSON.parse(await readFile(join(folder, "desktop.json"), "utf8")).preferences.server,
        settings,
    );
    await action("home.local.open");
    assert.deepEqual(commands.at(-1).data, { settings, replace: false });
    assert.deepEqual(controller.snapshot().home.local.settings, settings);
});

test("applying saved settings replaces only an owned launcher and leaves a remote page open", async (t) => {
    const { controller, settings, patch, action, commands } = await profile(t);
    const remote = await fixture();

    t.after(() => remote.close());
    await patch(settings);
    await action("home.local.open");
    await action("home.connect", { address: remote.address });
    const active = controller.snapshot().home.active;
    const occupied = await portListener();

    t.after(() => occupied.close());
    await patch({ port: occupied.port });
    const calls = commands.length;

    await assert.rejects(action("home.local.apply"), { code: "port-in-use" });
    assert.equal(commands.length, calls);
    assert.deepEqual(controller.snapshot().home.local.settings, settings);
    await patch({ port: settings.port, access: "lan" });
    await action("home.local.apply");
    assert.deepEqual(commands.at(-1).data, {
        settings: { ...settings, access: "lan" },
        replace: true,
    });
    assert.deepEqual(controller.snapshot().home.active, active);
});

test("saving settings for future launches cannot apply them to a borrowed server", async (t) => {
    const { controller, settings, patch, action, commands } = await profile(t, { borrow: true });

    await patch(settings);
    await action("home.local.open");
    assert.equal(controller.snapshot().home.local.owned, false);
    await patch({ access: "lan" });
    await assert.rejects(action("home.local.apply"), { code: "unavailable" });
    await assert.rejects(action("home.local.stop"), { code: "unavailable" });
    assert.deepEqual(
        commands.map(({ action }) => action),
        ["local.inspect"],
    );
});
