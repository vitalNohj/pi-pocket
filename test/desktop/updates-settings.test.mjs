import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopController } from "../../packaging/desktop/controller/index.mjs";
import { registerDesktopUpdates } from "../../packaging/desktop/controller/updates/settings-actions.mjs";
import { updateFixture } from "./update-fixture.mjs";

const current = "0.30.1-desktop.9";
const next = "0.30.1-desktop.10";
const bytes = Buffer.from("fixture installer");
const trayLabel = "Update ready - restart to apply";

async function harness(t, { version = current } = {}) {
    const fixture = await updateFixture("win32", next, bytes);
    const folder = await mkdtemp(join(tmpdir(), "pp-settings-update-"));
    const cache = join(folder, "cache");
    const selected = join(folder, "browser copy.exe");
    const hosts = [];
    const results = new Map();
    const states = [];
    let reply = null;
    let id = 0;

    t.after(fixture.close);
    t.after(() => rm(folder, { force: true, recursive: true }));

    async function make() {
        const desktop = new DesktopController({
            folder,
            platform: "windows",
            version,
            existingInstall: false,
            write(packet) {
                if (packet.type === "result") {
                    results.set(packet.id, packet);
                }

                if (packet.type === "state") {
                    states.push(packet.state);
                }

                if (packet.type === "host") {
                    hosts.push(packet);
                    void desktop.receive({
                        id: ++id,
                        command: "host.result",
                        value: {
                            id: packet.id,
                            ok: true,
                            value: packet.action === "updates.openDownload" ? true : reply,
                        },
                    });
                }
            },
        });
        const begin = await registerDesktopUpdates(desktop, {
            version,
            platform: "win32",
            folder: cache,
            request: fixture.request,
        });

        await desktop.load();
        await desktop.receive({ id: ++id, command: "subscribe" });
        t.after(() => desktop.close());

        return { desktop, begin };
    }

    const { desktop, begin } = await make();

    return {
        fixture,
        cache,
        selected,
        hosts,
        states,
        make,
        begin,
        select: (file) => {
            reply = file;
        },
        state: () => desktop.snapshot(),
        async action(action, data) {
            const request = ++id;

            await desktop.receive({
                id: request,
                command: "action",
                value: { id: `updates.${action}`, data },
            });

            return results.get(request);
        },
    };
}

const tray = (state) => state.menus.tray.find((item) => item.label === trayLabel);

async function absent(file) {
    await assert.rejects(readFile(file), { code: "ENOENT" });
}

test("Settings checks, downloads and verifies before Apply stages the app update", async (t) => {
    const h = await harness(t);
    const pending = join(h.cache, "pending.json");
    const currentArtifact = h.fixture.artifact.name;

    h.fixture.run.run_number = 9;
    h.fixture.artifact.name = currentArtifact.replace("desktop.10", "desktop.9");
    assert.equal(h.state().version, current);
    await h.action("check");
    assert.deepEqual(h.state().updates, { status: "current", latest: current, message: null });
    assert.equal(tray(h.state()), undefined);

    h.fixture.run.run_number = 10;
    h.fixture.artifact.name = currentArtifact;
    await h.action("check");
    assert.deepEqual(h.state().updates, { status: "available", latest: next, message: null });
    assert.equal(tray(h.state()), undefined);
    await h.action("apply");
    await absent(pending);
    assert.equal(h.hosts.length, 0);

    await h.action("download");
    assert.deepEqual(h.hosts.at(-1).data, {
        url: "https://github.com/vitalNohj/pi-pocket/actions/runs/456/artifacts/789",
    });
    assert.equal(h.state().updates.status, "downloading");
    await h.action("selectInstaller"); // A cancelled picker remains on the download step.
    assert.equal(h.state().updates.status, "downloading");
    assert.equal(tray(h.state()), undefined);

    await writeFile(h.selected, bytes);
    h.select(h.selected);
    await h.action("selectInstaller");
    assert.equal(h.state().updates.status, "ready");
    assert.equal(tray(h.state()), undefined);
    assert(!JSON.stringify(h.state()).includes(h.selected));
    assert(h.states.some((state) => state.updates.status === "verifying"));
    await absent(pending);
    const reopened = await h.make();

    assert.equal(reopened.desktop.snapshot().updates.status, "ready");
    await h.action("apply");
    assert.equal(JSON.parse(await readFile(pending, "utf8")).version, next);
    assert.equal(h.state().updates.status, "staged");
    assert.deepEqual(tray(h.state()).data, { section: "updates" });
    assert.deepEqual(
        h.hosts.map(({ action }) => action),
        ["updates.openDownload", "updates.pickInstaller", "updates.pickInstaller"],
    );
    assert.equal((await h.make()).desktop.snapshot().updates.status, "staged");
});

test("Settings cannot supply an installer path or URL; wrong bytes cannot become pending", async (t) => {
    const h = await harness(t);

    await h.action("check");
    assert.equal((await h.action("download", { url: "https://untrusted.invalid" })).ok, false);
    await h.action("download");
    assert.equal((await h.action("selectInstaller", { path: h.selected })).ok, false);
    await writeFile(h.selected, Buffer.alloc(bytes.length, 0));
    h.select(h.selected);
    await h.action("selectInstaller");
    assert.match(h.state().updates.message, /SHA-256/);
    assert.equal(h.state().updates.status, "failed");
    await h.action("apply");
    await absent(join(h.cache, "pending.json"));
    assert.equal(tray(h.state()), undefined);

    await h.action("check");
    await h.action("download");
    await writeFile(h.selected, bytes.subarray(1));
    await h.action("selectInstaller");
    assert.match(h.state().updates.message, /wrong size/);
    await absent(join(h.cache, "verified.json"));
});

test("a cached installer that changes after verification fails Apply", async (t) => {
    const h = await harness(t);

    await h.action("check");
    await h.action("download");
    await writeFile(h.selected, bytes);
    h.select(h.selected);
    await h.action("selectInstaller");
    const { sha256 } = JSON.parse(await readFile(join(h.cache, "verified.json"), "utf8"));

    await writeFile(
        join(h.cache, `${sha256}-${h.fixture.artifact.name}`),
        Buffer.alloc(bytes.length, 0),
    );
    await h.action("apply");
    assert.equal(h.state().updates.status, "failed");
    assert.match(h.state().updates.message, /SHA-256/);
    await absent(join(h.cache, "pending.json"));
    assert.equal(tray(h.state()), undefined);
});

test("a disabled install does not call the feed or native update host", async (t) => {
    const h = await harness(t, { version: "0.30.1" });

    h.begin();
    await h.action("check");
    await h.action("download");
    assert.equal(h.state().updates.status, "disabled");
    assert.equal(h.hosts.length, 0);
});
