// Compare the first-view transcript on the wire with the original eager projection and selection.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    offerSubagents,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { after, before, test } from "node:test";
import {
    fauxAssistantMessage,
    fauxThinking,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
    AssistantEntry,
    CompactionEntry,
    type ConversationId,
    SystemEntry,
    ToolResultEntry,
    UserEntry,
} from "@earendil-works/pi-durable";
import { AuthorsDoc, SubagentsDoc } from "../src/server/docs.ts";
import { presentationOptions } from "../src/server/entry-presentation.ts";
import {
    type ClientEntry,
    firstEntries,
    lightEntry,
    projectEntry,
    turnStart,
} from "../src/server/projection.ts";
import type { Client, Room } from "../src/server/room.ts";
import { fingerprint } from "../web/text-hash.js";

let app: App;

before(async () => {
    app = await openApp(
        scriptedModel((request) => {
            const said = lastText(request as never).text;

            if (said === "delegate this") {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("subagent", {
                            action: "spawn",
                            name: "reviewer",
                            message: "Review this.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage(
                said.startsWith("[subagent reviewer answered") ? "report acknowledged" : "reviewed",
            );
        }),
    );
    offerSubagents(app);
});

after(async () => {
    await app?.close();
    cleanUp();
});

const text = (text: string) => ({ type: "text" as const, text });
const user = (value: string) => ({
    role: "user" as const,
    content: [text(value)],
    timestamp: 1000,
});
const large = "a lot of output\n".repeat(24_000);

async function seed(on: App, id: ConversationId, count: number, label: string, heavy = false) {
    return on.harness.commit(async (tx) => {
        const authors = await tx.doc(AuthorsDoc, id);
        const ids = [];

        await tx.appendEntry(SystemEntry, id, {
            model: [{ role: "system", content: "", timestamp: 1000 }],
        });

        for (let n = 0; n < count; n++) {
            const request = await tx.appendEntry(UserEntry, id, {
                model: [user(n === 0 ? "MEMO " + label : label + " " + n)],
            });

            ids.push(request.id);

            if (n > 0) {
                authors.entries[String(request.id)] = owner(on).id;
            }

            if (heavy && (n === 0 || n === count - 1)) {
                const call = fauxToolCall(
                    "write",
                    { path: "sample.txt", content: large },
                    { id: "out-" + n },
                );

                await tx.appendEntry(AssistantEntry, id, {
                    model: [
                        fauxAssistantMessage([fauxThinking("consider ".repeat(400)), call], {
                            stopReason: "toolUse",
                        }),
                    ],
                });
                await tx.appendEntry(ToolResultEntry, id, {
                    model: [
                        {
                            role: "toolResult",
                            toolCallId: call.id,
                            toolName: call.name,
                            content: [text(large)],
                            isError: false,
                            timestamp: 1100,
                        },
                    ],
                    data: { diagnostics: [] },
                });
            }

            await tx.appendEntry(AssistantEntry, id, {
                model: [fauxAssistantMessage("answer " + n)],
            });
        }

        return ids;
    }, context);
}

function eagerEntries(on: App, room: Room): ClientEntry[] {
    const presentations = on.webs.presentations();

    return room.value!.entries.flatMap((record) => {
        const entry = projectEntry(
            record,
            false,
            presentationOptions(presentations, room.authors, Number(record.id)),
        );

        return entry === undefined ? [] : [entry];
    });
}

/** The old path: project every body, then select the order suffix and the entries to send. */
function eagerFirst(
    all: ClientEntry[],
    protocol: number,
    build: string,
    have: Client["have"],
    mayLighten: boolean,
) {
    const order = all.map(({ id }) => id);
    const fits =
        have !== undefined &&
        have.count > 0 &&
        have.from <= have.count &&
        have.count <= order.length &&
        have.key === fingerprint(order.slice(0, have.count).join(","));
    const kept = protocol >= 6 && fits && have.build === build ? have.count : 0;
    const refresh = protocol >= 7 && have !== undefined && have.build !== build;
    const first = protocol >= 4 ? firstEntries(all) : 0;
    const from = refresh ? (fits ? Math.min(first, have.from) : 0) : first;
    const light = mayLighten && !refresh && protocol >= 5;
    const sent = new Set(kept === 0 ? [] : order.slice(have!.from, kept));
    const entries: ClientEntry[] = [];
    const whole: ClientEntry[] = [];

    for (const [i, entry] of all.entries()) {
        if (sent.has(entry.id)) {
            continue;
        }

        const lighter = i >= from && light ? lightEntry(entry) : null;

        if (lighter === null) {
            sent.add(entry.id);
        } else {
            whole.push(entry);
        }

        if (i >= from) {
            entries.push(lighter ?? entry);
        }
    }

    return {
        wire: { entries, order: order.slice(kept), ...(kept ? { orderFrom: kept } : {}) },
        whole,
    };
}

/** Compare serialized bytes, including property order and missing (not empty) orderFrom. */
function checkFirst(
    data: Record<string, unknown>,
    expected: ReturnType<typeof eagerFirst>["wire"],
) {
    const {
        conversation,
        entries: _entries,
        order: _order,
        orderFrom: _from,
        full,
        ...common
    } = data;

    assert.equal(
        JSON.stringify(data),
        JSON.stringify({ full: true, conversation, ...expected, ...common }),
    );
}

const firstView = (tab: ReturnType<typeof fakeTab>) =>
    tab.events.find(({ event }) => event === "view")!.data;
const haveOf = (order: number[], build: string, from = 0, count = order.length) => ({
    from,
    count,
    build,
    key: fingerprint(order.slice(0, count).join(",")),
});

async function compare(id: ConversationId, head?: "compaction" | "reset", heavy = false) {
    // First-view GET reads without creating a watched room. After it, the SSE tab opens its own cold room.
    const http = await app.firstView(owner(app), id, undefined);

    assert.equal(app.openRoom(id), undefined);
    const room = await app.room(id);

    try {
        const all = eagerEntries(app, room);
        const order = all.map(({ id }) => id);
        const from = firstEntries(all);
        const build = app.build;
        const stale = haveOf(order, build + "-old", Math.max(0, from - 6));

        assert.ok(all.length > 0);

        if (head !== undefined) {
            assert.equal(all[0]!.kind, head);
        }

        if (head === "compaction") {
            assert.ok(
                all[0]!.id > all[1]!.id,
                "the summary leads the active order, not the ID order",
            );
        }

        checkFirst(http.view, eagerFirst(all, 7, build, undefined, false).wire);

        for (const [protocol, have] of [
            [7, undefined], // first materialization in this room
            [7, haveOf(order, build, from)],
            [6, haveOf(order, build, from, order.length - 1)],
            [7, { ...haveOf(order, build, from), key: "wrong order" }],
            [7, stale],
            [7, { ...stale, key: "stale order" }],
            [4, undefined],
            [3, undefined],
        ] as const) {
            const tab = fakeTab(id, owner(app), protocol);
            const eager = eagerFirst(all, protocol, build, have, true);

            tab.client.have = have;
            await app.attach(tab.client);

            try {
                checkFirst(firstView(tab), eager.wire);

                if (heavy && protocol === 7 && have === undefined) {
                    assert.ok(eager.whole.length > 0, "the tool turn must produce light entries");
                }

                await setImmediate();
                const updates = tab.events.filter(({ event }) => event === "view").slice(1);

                assert.equal(
                    JSON.stringify(updates.flatMap(({ data }) => data.entries)),
                    JSON.stringify(eager.whole),
                );
            } finally {
                app.detach(tab.client);
            }
        }
    } finally {
        app.releaseRoom(room);
    }
}

test("first views match eager projection byte for byte", async (t) => {
    await t.test("short", async () => {
        const id = await newSession(app);

        await seed(app, id, 3, "short");
        await compare(id);
    });
    await t.test("long", async () => {
        const id = await newSession(app);

        await seed(app, id, 105, "long");
        await compare(id);
    });
    await t.test("compaction", async () => {
        const id = await newSession(app);
        const ids = await seed(app, id, 110, "before compaction");

        await app.harness.commit(
            (tx) =>
                tx.appendEntry(CompactionEntry, id, {
                    head: ids[40]!,
                    model: [user("what happened before")],
                    data: { reason: "manual" },
                }),
            context,
        );
        await compare(id, "compaction");
    });
    await t.test("reset", async () => {
        const id = await newSession(app);

        await seed(app, id, 8, "before reset");
        await app.commands.reset(id, owner(app), "Continue with this new context.");
        await seed(app, id, 55, "after reset");
        await compare(id, "reset");
    });
    await t.test("fork", async () => {
        const id = await newSession(app);

        await seed(app, id, 60, "source");
        const records = (await (await app.conversation(id)).context(context)).entries;
        const { id: fork } = await app.commands.fork(id, owner(app), {
            entryId: Number(records.at(-3)!.id),
        });

        await seed(app, fork, 3, "fork");
        await compare(fork);
    });
    await t.test("subagents", async () => {
        const id = await newSession(app);

        await say(app, id, "delegate this");
        const agents = await app.harness.snapshot(SubagentsDoc, id, context);
        const child = agents?.agents.reviewer?.conversationId;

        assert.ok(child, "the model spawned a real subagent");
        const parent = await app.conversation(id);

        // The subagent's report starts a second turn in its parent. Both transcripts must be settled for the oracle.
        await until(
            async () => lastText(await parent.context(context)).text === "report acknowledged",
            "the parent to answer the subagent report",
        );
        await Promise.all([compare(id), compare(child)]);
    });
    await t.test("huge tool outputs", async () => {
        const id = await newSession(app);

        await seed(app, id, 70, "large outputs", true);
        await compare(id, undefined, true);
    });
});

test("scroll-back projects the requested rows and their complete turns before an old tab asks for everything", async () => {
    const id = await newSession(app);

    await seed(app, id, 100, "scroll", true);
    const room = await app.room(id);
    const tab = fakeTab(id, owner(app), 7);
    const old = fakeTab(id, owner(app), 3);

    try {
        const all = eagerEntries(app, room);
        const start = firstEntries(all);
        const before = all[start]!.id;
        const earlier = all.slice(0, start);
        const result = room.value!.entries.find((entry) => ToolResultEntry.is(entry))!.model![0]!;
        const content = result.content;
        let reads = 0;

        Object.defineProperty(result, "content", {
            get() {
                reads++;

                return content;
            },
        });
        assert.ok(start > 0);
        await app.attach(tab.client);
        checkFirst(firstView(tab), eagerFirst(all, 7, app.build, undefined, true).wire);
        assert.equal(reads, 0, "opening does not project the older tool result");
        assert.deepEqual(
            room.entriesBefore(before, { rows: 12 }),
            earlier.slice(firstEntries(earlier, 12)),
        );
        assert.equal(reads, 0, "a page that does not reach the tool result does not project it");
        assert.deepEqual(
            room.entriesBefore(before, { from: all[3]!.id }),
            earlier.slice(turnStart(earlier, 3)),
        );
        assert.ok(reads > 0, "scrolling to that turn projects the result");
        const cached = reads;

        assert.deepEqual(room.entriesBefore(before, { from: before }), []);
        assert.deepEqual(room.entriesBefore(-1), []);
        await app.attach(old.client);
        checkFirst(firstView(old), eagerFirst(all, 3, app.build, undefined, false).wire);
        assert.deepEqual(room.entriesBefore(before), earlier);
        assert.equal(reads, cached, "the old tab and another scroll reuse the projection");
    } finally {
        app.detach(tab.client);
        app.detach(old.client);
        app.releaseRoom(room);
    }
});

test("reload with have and reconnect after restart accept the order but only send new bodies", async () => {
    const data = join(root, "open-read-restart");
    let on = await openApp(scriptedModel(), data);

    try {
        const id = await newSession(on);

        await seed(on, id, 55, "old");
        const original = await on.firstView(owner(on), id, undefined);

        assert.ok("order" in original.view);
        const order = original.view.order;
        const have = haveOf(order, original.build, order.indexOf(original.view.entries[0]!.id));
        const reload = await on.firstView(owner(on), id, have);

        checkFirst(reload.view, { entries: [], order: [], orderFrom: order.length });
        assert.equal(on.openRoom(id), undefined);
        await seed(on, id, 1, "added while away");
        await on.close();
        on = await openApp(scriptedModel(), data);
        const tab = fakeTab(id, owner(on), 7);

        tab.client.have = have;
        await on.attach(tab.client);
        const room = await on.openRoom(id)!;
        const all = eagerEntries(on, room);

        checkFirst(firstView(tab), eagerFirst(all, 7, on.build, have, true).wire);
        assert.deepEqual(
            firstView(tab).order,
            all.slice(order.length).map(({ id }) => id),
        );
        assert.equal((firstView(tab).entries as ClientEntry[]).length, 2);
        on.detach(tab.client);
    } finally {
        await on.close();
    }
});

test("presentation changes replace skipped entries kept by a tab, and messages still page only people’s inputs", async () => {
    const id = await newSession(app);
    const [memo] = await seed(app, id, 50, "entry kept by tab");
    const kind = "x.open-read.memo";
    const custom = await app.harness.commit(
        (tx) =>
            tx.appendEntry(id, {
                kind,
                model: [user("input from a module")],
                data: { summary: "one line" },
            }),
        context,
    );
    const room = await app.room(id);
    const all = eagerEntries(app, room);
    const oldOrder = all.map(({ id }) => id);
    const tab = fakeTab(id, owner(app), 7);
    const module = "open-read.ts";

    tab.client.have = haveOf(oldOrder, app.build);

    try {
        await app.attach(tab.client);
        assert.deepEqual(firstView(tab).entries, []);
        const staged = app.webs.stage(module, root, "Open read test");

        staged.web.presentEntry({ kind, label: "Memo", userPrefix: "MEMO " });
        app.webs.commit(staged.part);
        await until(
            () =>
                (tab.last("view")?.entries as ClientEntry[]).some(
                    (entry) =>
                        entry.kind === "user" &&
                        entry.id === Number(memo) &&
                        entry.presentation?.prefixed === true,
                ),
            "an earlier kept entry to update",
        );
        const presented = eagerEntries(app, room);
        const people = presented.filter(
            (entry) =>
                entry.kind === "user" &&
                (entry.presentation === undefined || entry.presentation.prefixed === true),
        );

        assert.ok(
            presented.some((entry) => entry.id === Number(custom.id) && entry.kind === "user"),
        );
        assert.deepEqual(room.userMessages(undefined, 3), {
            messages: people.slice(-3),
            before: people.at(-3)!.id,
        });
        assert.deepEqual(room.userMessages(people[1]!.id, 3), {
            messages: people.slice(0, 1),
            before: null,
        });
        assert.equal(room.userMessages(Number(custom.id), 3), null);
    } finally {
        app.webs.remove(module);
        app.detach(tab.client);
        app.releaseRoom(room);
    }
});
