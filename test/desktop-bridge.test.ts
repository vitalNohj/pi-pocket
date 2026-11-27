import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(
    new URL("../packaging/desktop/bridge/bootstrap.js", import.meta.url),
    "utf8",
);
const origin = "https://pocket.test";

type Packet = Record<string, unknown>;
type Host = {
    subscribe(listener: (packet: Packet) => void, supported?: string[]): void;
    invoke(id: string): boolean;
    setAccount(active: boolean): void;
    setBadge(count: number): void;
    setPinned(pins: Packet[]): void;
    notify(notice: Packet): void;
};

function fixture(
    options: {
        frame?: boolean;
        origin?: string;
        basePath?: string;
        path?: string;
        events?: string[];
    } = {},
) {
    const { frame, origin: effective = origin, basePath = "", path = "/s/2", events } = options;
    const outgoing: Packet[] = [];
    const incoming: Packet[] = [];
    let receive: ((packet: Packet) => void) | undefined;
    const window: {
        top?: object;
        origin: string;
        pocketHost?: Host;
    } = { origin: effective };

    window.top = frame ? {} : window;
    runInNewContext(script.replace("/* POCKET_BRIDGE_ARGUMENTS */", "config, transport"), {
        window,
        location: { origin, protocol: "https:", pathname: path },
        config: {
            origin,
            basePath,
            kind: "test",
            items: [{ id: "settings", label: "Desktop Settings…" }],
        },
        transport: {
            send: (packet: Packet) => outgoing.push(structuredClone(packet)),
            listen: (next: (packet: Packet) => void) => {
                receive = next;
            },
        },
    });
    const { pocketHost: host } = window;

    host?.subscribe((packet: Packet) => incoming.push(structuredClone(packet)), events);

    return { host, outgoing, incoming, send: (packet: Packet) => receive?.(packet) };
}

test("the desktop bootstrap is confined to the top-level Pi Pocket page at the effective origin", () => {
    assert.equal(fixture({ frame: true }).host, undefined);
    assert.equal(fixture({ origin: "null" }).host, undefined);
    assert.equal(fixture({ origin: "https://sign-in.test" }).host, undefined);
    assert.equal(fixture({ path: "/login" }).host, undefined);
    assert.equal(fixture({ path: "/preview" }).host, undefined);
    assert.ok(fixture().host);
});

test("the bootstrap allows only Pi Pocket pages under the configured base path", () => {
    const basePath = "/gateway/pocket";

    assert.ok(fixture({ basePath, path: basePath }).host);
    assert.ok(fixture({ basePath, path: `${basePath}/` }).host);
    assert.ok(fixture({ basePath, path: `${basePath}/s/2` }).host);

    for (const path of [
        "/",
        "/s/2",
        `${basePath}/preview`,
        `${basePath}-other/s/2`,
        `${basePath}%2Fs/2`,
    ]) {
        assert.equal(fixture({ basePath, path }).host, undefined, path);
    }
});

test("a secondary caches only its snapshot; promotion, auth reset and document replacement update the lease", () => {
    const { host, outgoing, incoming, send } = fixture({
        events: ["primary", "newSession", "open", "approve"],
    });

    assert.ok(host);
    assert.equal(host.invoke("settings"), false);
    send({ type: "bind", key: "lease-1", visible: true });
    assert.deepEqual(outgoing.shift(), {
        type: "subscribe",
        key: "lease-1",
        auth: 0,
        events: ["primary", "newSession", "open", "approve"],
    });
    assert.equal(host.invoke("unknown"), false);
    host.setAccount(true);
    host.setBadge(2);
    host.setPinned([{ id: 7, title: "Build", state: "waiting", label: "Waiting for you" }]);
    host.notify({ tag: "ignored", url: "/s/7" });
    assert.deepEqual(
        outgoing.map(({ type }) => type),
        ["account"],
    );
    send({ type: "primary", key: "lease-1", primary: true });
    assert.deepEqual(
        outgoing.map(({ type }) => type),
        ["account", "badge", "pinned"],
    );
    host.notify({
        tag: "approval-1",
        url: "/s/7",
        approval: { id: "1", call: "x".repeat(8500), may: true },
    });
    const notice = outgoing.at(-1)?.notice as { approval: { call: string; cut: boolean } };

    assert.equal(notice.approval.call.length, 8192);
    assert.equal(notice.approval.cut, true);
    send({ type: "newSession", key: "lease-1", auth: 1 });
    assert.deepEqual(incoming.at(-1), { type: "newSession" });
    host.setAccount(false);
    send({ type: "open", key: "lease-1", auth: 1, url: "/s/7" });
    assert.deepEqual(incoming.at(-1), { type: "newSession" });
    send({ type: "bind", key: "lease-2" });
    host.setAccount(true);
    send({ type: "primary", key: "lease-2", primary: true });
    assert.deepEqual(
        outgoing.slice(-3).map(({ type, key }) => [type, key]),
        [
            ["subscribe", "lease-2"],
            ["account", "lease-2"],
            ["account", "lease-2"],
        ],
    );
    send({ type: "open", key: "lease-1", auth: 3, url: "/s/7" });
    assert.deepEqual(incoming.at(-1), { type: "primary" });
    send({ type: "open", key: "lease-2", auth: 3, url: "/s/7" });
    assert.deepEqual(incoming.at(-1), { type: "open", url: "/s/7" });
});

test("a legacy page subscribes without an events list and never receives a new or actionable approval event", () => {
    const { host, outgoing, incoming, send } = fixture();

    send({ type: "bind", key: "legacy" });
    assert.deepEqual(outgoing[0]?.events, ["visibility", "open", "approve"]);
    send({ type: "primary", key: "legacy", primary: true });
    host?.setBadge(1);
    assert.equal(outgoing.at(-1)?.count, 1);
    send({ type: "newSession", key: "legacy", auth: 0 });
    send({ type: "approve", key: "legacy", auth: 0, id: "test", allow: true });
    assert.deepEqual(incoming, [{ type: "visibility" }]);
    send({ type: "open", key: "legacy", auth: 0, url: "/" });
    assert.deepEqual(incoming.at(-1), { type: "open", url: "/" });
});
