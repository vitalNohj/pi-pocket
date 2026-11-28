import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopController } from "../../packaging/desktop/controller/index.mjs";
import {
    probeServer,
    serverAddress,
} from "../../packaging/desktop/controller/connection/probe.mjs";
import { fixture } from "./fixture.mjs";

async function desktop(t, existingInstall = false, folder = undefined) {
    if (!folder) {
        folder = await mkdtemp(join(tmpdir(), "desktop-controller-"));
        t.after(() => rm(folder, { recursive: true, force: true }));
    }

    const messages = [];
    const hosts = [];
    const controller = new DesktopController({
        folder,
        platform: "windows",
        version: "1.0.0",
        existingInstall,
        write(packet) {
            messages.push(packet);

            if (packet.type === "host") {
                hosts.push(packet.action);
                const local = {
                    status: "running",
                    owned: true,
                    verified: true,
                    address: "http://127.0.0.1:3469",
                };

                if (packet.action === "local.stop" || packet.action === "local.inspect") {
                    Object.assign(local, { status: "stopped", owned: false, verified: false });
                    delete local.address;
                }

                void controller.receive({
                    id: 2000 + packet.id,
                    command: "host.result",
                    value: { id: packet.id, ok: true, value: local },
                });
            }
        },
    });

    t.after(() => controller.close());
    await controller.load();
    let id = 0;

    const call = async (command, value) => {
        const request = ++id;

        await controller.receive({ id: request, command, value });
        const result = messages.find((packet) => packet.type === "result" && packet.id === request);

        assert(result);

        if (!result.ok) {
            const error = new Error(result.error.message);

            error.code = result.error.code;

            throw error;
        }

        return result.value;
    };

    const action = (id, data) => call("action", { id, data });

    return { controller, folder, call, action, hosts };
}

test("a new install starts on Home and upgrades keep local startup", async (t) => {
    const fresh = await desktop(t);

    await fresh.controller.begin();
    assert.deepEqual(fresh.hosts, ["local.inspect"]);
    assert.equal(fresh.controller.snapshot().home.active, null);
    assert.equal(fresh.controller.snapshot().preferences.window.titleBar, "seamless");

    const migration = await desktop(t, true);

    await migration.controller.begin();
    assert.deepEqual(migration.hosts, ["local.open"]);
    assert.equal(migration.controller.snapshot().home.active.mode, "local");
    assert.equal(migration.controller.snapshot().preferences.window.titleBar, "system");
    await migration.action("home.local.stop");
    assert.equal(migration.controller.snapshot().home.active, null);
});

test("only the current document/account feed populates the tray and Dock pins", async (t) => {
    const { controller, call, action, hosts } = await desktop(t, true);

    await controller.begin();
    const generation = controller.snapshot().home.active.generation;
    const feed = "decafbad-abcd-4321-8c43-aaaaaaaaaaaa";
    const report = (event, data) => call("host.report", { event, data: { generation, ...data } });
    const pin = (id, title, state, label) => ({ id, title, state, label, url: `/s/${id}` });
    const open = (id, source = feed) => action("window.pinned", { id, feed: source });

    await report("pins", {
        feed,
        items: [
            pin("7", "Test & display", "waiting", "Waiting for you"),
            pin("4", "Installer", "working", "Working"),
            pin("01", "Bad ID", "working", "Working"),
            pin("9007199254740992", "Out of range", "working", "Working"),
            { ...pin("8", "Wrong route", "seen", "Seen"), url: "/other" },
        ],
    });
    await report("badge", { count: 3 });
    await report("page", { committedOrigin: "http://127.0.0.1:3469" });
    const { tray, dock } = controller.snapshot().menus;
    const group = (menu) => menu.find(({ label }) => label === "Pinned Sessions");

    assert.deepEqual(group(tray).items, [
        {
            id: "window.pinned",
            label: "◆ Test & display — Waiting for you",
            enabled: true,
            data: { id: "7", feed },
        },
        {
            id: "window.pinned",
            label: "◐ Installer — Working",
            enabled: true,
            data: { id: "4", feed },
        },
    ]);
    assert.deepEqual(group(dock), group(tray));
    assert.equal(tray[0].label, "Open Pi Pocket (3 need you)");
    await assert.rejects(open("8"), { code: "unavailable" });
    await open("4");
    assert.equal(hosts.at(-1), "window.pinned");

    await report("pins", { feed: null, items: [] });
    await report("badge", { count: 0 });
    assert.equal(group(controller.snapshot().menus.tray), undefined);
    assert.equal(controller.snapshot().menus.tray[0].label, "Open Pi Pocket");
    await report("pins", {
        feed: "decafbad-abcd-4321-8c43-bbbbbbbbbbbb",
        items: [pin("4", "Same ID, new account", "seen", "Seen")],
    });
    await assert.rejects(open("4"), { code: "unavailable" });
    await assert.rejects(report("pins", { generation: generation + 1, feed, items: [] }), {
        code: "invalid",
    });
});

test("notification preferences save and OS status is separate from them", async (t) => {
    const current = await desktop(t);
    const notifications = { enabled: false, sound: false, approve: "always", commandLimit: 20 };
    const report = (data) => current.call("host.report", { event: "notifications", data });

    assert.equal(current.controller.snapshot().preferences.notifications.approve, "full");
    await current.call("patchPreferences", { notifications });
    await report({ permission: "blocked" });
    await assert.rejects(report({ permission: "invalid" }), { code: "invalid" });
    await assert.rejects(report({ decision: "private command content" }), { code: "invalid" });
    await assert.rejects(
        current.action("notifications.systemSettings", { url: "https://example.invalid" }),
        { code: "invalid" },
    );

    for (const patch of [{ commandLimit: 19 }, { commandLimit: 2001 }, { approve: "permitted" }]) {
        await assert.rejects(current.call("patchPreferences", { notifications: patch }), {
            code: "invalid",
        });
    }

    assert.equal(current.controller.snapshot().notifications.permission, "blocked");
    assert.deepEqual(
        (await desktop(t, false, current.folder)).controller.snapshot().preferences.notifications,
        notifications,
    );
});

test("preference patches are atomic and survive an offline reopen", async (t) => {
    const initial = await desktop(t);

    await initial.call("patchPreferences", { window: { showMenuBar: true } });
    await assert.rejects(
        initial.call("patchPreferences", {
            window: { showMenuBar: false },
            home: { mode: "remote" },
        }),
        { code: "invalid" },
    );
    const reopened = await desktop(t, false, initial.folder);

    assert.equal(reopened.controller.snapshot().preferences.window.showMenuBar, true);
    const file = join(initial.folder, "desktop.json");
    const saved = JSON.parse(await readFile(file, "utf8"));

    saved.preferences.window.titleBar = "bogus";
    await writeFile(file, JSON.stringify(saved));
    const warning = (await desktop(t, false, initial.folder)).controller.snapshot();

    assert.equal(warning.preferences.window.titleBar, "seamless");
    assert.equal(warning.preferences.window.showMenuBar, true);
    assert.match(warning.warnings[0], /window\.titleBar/);
});

test("address normalization rejects secrets and keeps IPv6 and subpaths", () => {
    assert.equal(serverAddress(" HTTP://[0:0::1]:80/pocket/ "), "http://[::1]/pocket/");
    assert.equal(
        serverAddress("https://POCKET.example:443/pocket"),
        "https://pocket.example/pocket",
    );

    for (const rejected of [
        "http://user:password@server",
        "http://@server",
        "http://server/#code",
        "http://server/login?once=code",
        "file:///app/",
        "https:\\server",
    ]) {
        assert.equal(serverAddress(rejected), null);
    }
});

test("checks do not change the active connection, and Retry keeps the page generation", async (t) => {
    const remote = await fixture();

    t.after(() => remote.close());
    const { controller, call, action, hosts } = await desktop(t);

    await call("patchPreferences", { home: { failureThreshold: 1, healthInterval: 0 } });
    assert.equal((await action("home.check", { address: remote.address })).kind, "pocket");
    assert.equal(controller.snapshot().preferences.home.mode, null);
    const first = await action("home.connect", { address: remote.address });

    assert.equal(first.mode, "remote");
    assert.equal(controller.snapshot().home.active.address, remote.address);
    assert.equal(
        controller.snapshot().menus.tray.some(({ id }) => id === "home.local.restart"),
        false,
    );
    assert(!hosts.some((host) => host.startsWith("local.")));
    assert(
        remote.requests.every(
            ({ path, authenticated }) => path.startsWith("/pocket/") && !authenticated,
        ),
    );

    remote.setMode("down");
    await assert.rejects(action("home.connect", { address: remote.address }), {
        code: "not-pocket",
    });
    assert.equal(controller.snapshot().home.active.generation, first.generation);
    await action("home.retry");
    assert.equal(controller.snapshot().home.active.status, "reconnecting");
    remote.setMode("pocket");
    await action("home.retry");
    assert.equal(controller.snapshot().home.active.status, "connected");
    assert.equal(controller.snapshot().home.active.generation, first.generation);
});

test("a saved address never bypasses confirmation for an HTML preview", async (t) => {
    const remote = await fixture();

    t.after(() => remote.close());
    const { action, folder } = await desktop(t);

    await action("home.connect", { address: remote.address });
    remote.setMode("sso");

    const reopened = await desktop(t, false, folder);

    await reopened.controller.begin();
    assert.equal(reopened.controller.snapshot().home.active, null);
    assert.equal(reopened.controller.snapshot().home.check.status, "preview");
    await assert.rejects(reopened.action("home.retry"), { code: "preview" });
    assert.equal(reopened.controller.snapshot().home.active, null);
    assert.equal(
        (await reopened.action("home.preview", { address: remote.address })).kind,
        "preview",
    );

    const afterPreview = await desktop(t, false, folder);

    await afterPreview.controller.begin();
    assert.equal(afterPreview.controller.snapshot().home.active, null);
    remote.setMode("pocket");
    await afterPreview.action("home.retry");
    assert.equal(afterPreview.controller.snapshot().home.active.kind, "pocket");
});

test("legacy manifest, explicit HTML preview, and allowed redirects are separate paths", async (t) => {
    const legacy = await fixture({ mode: "legacy" });
    const sso = await fixture({ mode: "sso" });

    t.after(() => legacy.close());
    t.after(() => sso.close());
    const { controller, action } = await desktop(t);

    assert.equal((await action("home.connect", { address: legacy.address })).kind, "legacy");
    await assert.rejects(action("home.preview", { address: sso.address }), { code: "invalid" });
    await assert.rejects(action("home.connect", { address: sso.address }), { code: "preview" });
    const preview = await action("home.preview", { address: sso.address });

    assert.equal(preview.kind, "preview");
    assert.equal(
        controller.snapshot().menus.tray.find(({ id }) => id === "window.newSession").enabled,
        false,
    );

    const redirect = createServer((_request, response) =>
        response.writeHead(302, { Location: sso.address }).end(),
    );

    await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    t.after(() => redirect.close());
    const address = `http://127.0.0.1:${redirect.address().port}`;

    await assert.rejects(probeServer(address, { probeTimeout: 2, allowedOrigins: [] }), {
        code: "origin",
    });
    assert.equal(
        (await probeServer(address, { probeTimeout: 2, allowedOrigins: [sso.origin] })).kind,
        "preview",
    );
});
