import { root, say, until } from "./helpers.ts";
import {
    changeRow,
    changesLab,
    changesPanel,
    changesPlace,
    changesSession,
    composer,
    measureChange,
    menu,
    send,
    type ChangesTiming,
} from "./changes-refresh-fixture.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false };
let lab: Awaited<ReturnType<typeof changesLab>>;
let browsers: Browsers;
let page: BrowserPage;

before(async () => {
    if (chromium === undefined) {
        return;
    }

    lab = await changesLab();
    browsers = new Browsers({
        dataDir: join(root, "changes-ui"),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1280, height: 850, scale: 1, mobile: false });
    await page.navigate(lab.login);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    await lab?.close();
});

const check = async (expression: string) => (await page.evaluate(expression)) === "true";
const expressionFor = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
const has = (selector: string) => check(`!!${expressionFor(selector)}`);
const appView = `(await import("/store.js")).store.state.view`;

async function tap(selector: string) {
    await until(() => has(selector), selector);
    await page.evaluate(`${expressionFor(selector)}.click()`);
}

async function open(id: ConversationId) {
    await page.evaluate(`(await import("/store.js")).navigate(${Number(id)})`);
    await until(() => check(`${appView}.conversation?.id === ${Number(id)}`), "the session's view");

    if (!(await has(changesPanel))) {
        await tap(menu);
        await tap(changesPlace);
    }

    await until(
        () =>
            check(
                `${expressionFor(changesPanel)}?.textContent.includes("No uncommitted changes") === true`,
            ),
        "the clean Changes list",
    );
}

async function turn(id: ConversationId, file: string) {
    const before = await page.evaluate(`${appView}.order.at(-1)`);

    await say(lab.app, id, `write ${file}`);
    await until(
        () =>
            check(`await (async () => {
            const view = ${appView};
            const last = view.order.at(-1);
            const entry = view.entries.get(last);
            return !view.live.busy && String(last) !== ${JSON.stringify(before)} &&
                entry?.kind === "assistant" && entry.stopReason !== "toolUse";
        })()`),
        `the browser's idle view after writing ${file}`,
    );
}

/** Hold a real snapshot after Git has read it, so it cannot already include files written while it waits. */
function trackLists(t: TestContext) {
    type Call = { id: ConversationId; active: number; ready: boolean; release: () => void };
    const calls: Call[] = [];
    const read = lab.app.workspace.changes.bind(lab.app.workspace);
    const hold = new Set<ConversationId>();
    const active = new Map<ConversationId, number>();

    t.mock.method(lab.app.workspace, "changes", async (...args: Parameters<typeof read>) => {
        const [id] = args;
        const count = (active.get(id) ?? 0) + 1;
        const gate = Promise.withResolvers<void>();
        const call = { id, active: count, ready: false, release: gate.resolve };
        const delayed = hold.delete(id);

        calls.push(call);
        active.set(id, count);

        try {
            const snapshot = await read(...args);

            call.ready = true;

            if (delayed) {
                await gate.promise;
            }

            return snapshot;
        } finally {
            active.set(id, (active.get(id) ?? 1) - 1);
        }
    });
    t.after(() => calls.forEach((call) => call.release()));

    const forSession = (id: ConversationId) => calls.filter((call) => call.id === id);

    return { hold, forSession };
}

test("Changes shows a tool's new row well before the old 1200 ms quiet wait", real, async () => {
    const id = await changesSession(lab.app, ["fast.txt"]);

    await open(id);
    await page.type({ selector: composer }, "write fast.txt");
    await until(() => has(send), "Send to enable");
    const timing = JSON.parse(
        await page.evaluate(`JSON.stringify(await ${measureChange("fast.txt")})`),
    ) as ChangesTiming;

    assert.ok(
        timing.idleToRow < 900,
        `idle to row: ${Math.round(timing.idleToRow)} ms (idle to request: ${Math.round(timing.idleToRequest)} ms)`,
    );
});

test("several tool turns behind one Changes read need just one trailing read", real, async (t) => {
    const files = ["first.txt", "second.txt", "third.txt", "fourth.txt"];
    const id = await changesSession(lab.app, files);

    await open(id);
    const { hold, forSession } = trackLists(t);

    hold.add(id);
    await turn(id, files[0]!);
    await until(() => forSession(id)[0]?.ready === true, "the first held Changes snapshot");

    for (const file of files.slice(1)) {
        await turn(id, file);
    }

    // Let the quiet timer expire while the first snapshot is still held.
    await wait(1400);
    assert.equal(forSession(id).length, 1, "one list read while its result is held");
    forSession(id)[0]!.release();

    await until(
        () => has(changeRow("fourth.txt")),
        "the last change to show without a manual refresh",
    );

    for (const file of files) {
        assert.equal(await has(changeRow(file)), true, file);
    }

    assert.deepEqual(
        forSession(id).map((call) => call.active),
        [1, 1],
    );
});

test("switching away and back keeps a newer change behind an older response", real, async (t) => {
    const a = await changesSession(lab.app, ["old.txt", "while-away.txt"]);
    const b = await changesSession(lab.app, ["new.txt"]);

    await open(a);
    const { hold, forSession } = trackLists(t);

    hold.add(a);
    await turn(a, "old.txt");
    await until(() => forSession(a)[0]?.ready === true, "session A's old snapshot");
    await open(b);
    await turn(b, "new.txt");
    await until(
        () => has(changeRow("new.txt")),
        "session B to refresh while session A's read waits",
    );
    assert.equal(await has(changeRow("old.txt")), false);
    await say(lab.app, a, "write while-away.txt");
    await page.evaluate(`(await import("/store.js")).navigate(${Number(a)})`);
    await until(() => check(`${appView}.conversation?.id === ${Number(a)}`), "back in session A");

    if (!(await has(changesPanel))) {
        await tap(menu);
        await tap(changesPlace);
    }

    await wait(1400);
    forSession(a)[0]!.release();
    await until(() => has(changeRow("while-away.txt")), "the newer change after returning to A");
    assert.deepEqual(
        forSession(a).map((call) => call.active),
        [1, 1],
    );
    assert.equal(await has(changeRow("new.txt")), false);
});

test("a tool turn does not scan Changes while the Files tab is selected", real, async (t) => {
    const id = await changesSession(lab.app, ["hidden.txt"]);

    await open(id);
    await tap('.files-tabs [role="tab"]:first-child');
    const { forSession } = trackLists(t);

    await turn(id, "hidden.txt");
    await wait(1400);
    assert.equal(forSession(id).length, 0, "no scan for the hidden Changes tab");
    await tap('.files-tabs [role="tab"]:last-child');
    await until(
        () => has(changeRow("hidden.txt")),
        "the change to show when the Changes tab opens",
    );
});
