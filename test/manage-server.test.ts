import {
    addPerson,
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import type { Lesson } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import type { MemoryView } from "../src/server/memory.ts";
import type { SpendSummary } from "../src/server/spend.ts";

let app: App;
let server: Server;
let address: string;
let session: ConversationId;
let manager: User;
let guest: User;
let restarts = 0;
const tokens = new Map<string, string>();
const noRight = "Only someone who manages Pi Pocket can do that.";

type Request = [path: string, body?: unknown, method?: string];

async function person(name: string, role: User["role"] = "guest", sessions?: string[]) {
    const { user, token } = await addPerson(app, name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

const give = (user: User, on = true) =>
    app.setRight(owner(app), { person: user.id, right: "managesServer", on });

async function call(user: User, [path, body, method]: Request) {
    const response = await fetch(`${address}/api/${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        signal: AbortSignal.timeout(20_000),
        headers: {
            authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: (await response.json()) as unknown };
}

async function done<T = unknown>(user: User, request: Request): Promise<T> {
    const answer = await call(user, request);

    assert.equal(answer.status, 200, `${user.name} ${request[0]}: ${JSON.stringify(answer.body)}`);

    return answer.body as T;
}

async function refused(user: User, request: Request, error = noRight, status = 403) {
    assert.deepEqual(
        await call(user, request),
        { status, body: { error } },
        `${user.name} ${request[0]}`,
    );
}

/** Try a valid request without the permission first, then with it. */
async function managed<T = unknown>(...request: Request): Promise<T> {
    await refused(guest, request);

    return done<T>(manager, request);
}

const extension = "manager-settings";
const extensionFile = `${extension}.ts`;
const themeList = (user: User) =>
    done<Pick<Awaited<ReturnType<App["hello"]>>, "themes">>(user, ["themes"]);

before(async () => {
    const data = join(root, "data");
    const themes = join(data, "themes", "broken-look");
    const extensions = join(data, "extensions");

    mkdirSync(themes, { recursive: true });
    writeFileSync(join(themes, "theme.json"), JSON.stringify({ themeApi: 1, name: "Broken Look" }));
    writeFileSync(join(themes, "theme.css"), `a { background: url(../outside.png); }\n`);
    mkdirSync(extensions, { recursive: true });
    writeFileSync(
        join(extensions, extensionFile),
        `export default (_host, web) => {
    web.settings([{ name: "flag", label: "Flag", type: "boolean", default: false }]);
    web.command("manager-test-global", { description: "Server command", scope: "global", handler() {} });
    web.route("GET", "private", () => ({ ok: true }), { access: "owner" });
};`,
    );
    app = await openApp(scriptedModel(), data);
    manager = await person("Manager");
    guest = await person("Guest");
    give(manager);
    session = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => restarts++ }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
    if (server !== undefined) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    await app?.close();
    cleanUp();
});

test("themes and app icon: managers can see problems and change the shared look", async () => {
    const broken = (themes: Awaited<ReturnType<typeof themeList>>["themes"]) =>
        themes.find((theme) => theme.id === "broken-look");

    assert.ok(broken((await themeList(manager)).themes)?.problem);
    assert.equal(broken((await themeList(guest)).themes)?.problem, undefined);
    await managed("app-icon", { colors: "112233.445566.778899.aabbcc.ddeeff" }, "PUT");
    const { id } = await managed<{ id: string }>("themes/duplicate", {
        from: "pocket",
        name: "Manager's look",
    });

    // A live change tells each open tab the list its person reads: with a theme's problem only for who manages Pi Pocket.
    const tabs = [manager, guest].map((user) => fakeTab(undefined, user));

    for (const tab of tabs) {
        await app.attach(tab.client);
    }

    try {
        await managed(`themes/${id}/fonts`, { mono: "Pocket Fira Code" }, "PUT");

        const told = (tab: (typeof tabs)[number]) =>
            broken(tab.last("themes") as unknown as Parameters<typeof broken>[0]);

        assert.ok(told(tabs[0]!)?.problem, "the manager's tab hears the problem");
        assert.ok(told(tabs[1]!), "a guest's tab hears of the theme");
        assert.equal(told(tabs[1]!)?.problem, undefined, "and not its problem");
    } finally {
        for (const tab of tabs) {
            app.detach(tab.client);
        }
    }

    assert.ok((await managed<{ cwd: string }>(`themes/${id}/edit`)).cwd.endsWith(id));
    const choice = { look: id, colors: "tokyo-night" };

    await managed("themes/default", { default: choice }, "PUT");
    assert.deepEqual(app.config.themeDefault, choice);
    await done(manager, ["themes/default", { default: null }, "PUT"]);
    await managed(`themes/${id}`, undefined, "DELETE");
    assert.ok(!(await themeList(manager)).themes.some((theme) => theme.id === id));
});

test("extensions: managers see details and can enable, configure, and reload a module", async () => {
    const info = await managed<Awaited<ReturnType<App["extensions"]>>>(
        `extensions/${extensionFile}`,
        {
            enabled: true,
        },
    );

    assert.ok(info.dropIns);
    assert.ok(info.modules.find((module) => module.file === extensionFile)?.path);
    const restricted = await done<typeof info>(guest, ["extensions"]);

    assert.equal(restricted.dropIns, undefined);
    assert.equal(
        restricted.modules.find((module) => module.file === extensionFile)?.path,
        undefined,
    );
    await managed(`extensions/${extensionFile}/reload`, {});
    const settings = `extension-settings/${extension}`;

    await managed(settings, { flag: true }, "PUT");
    assert.deepEqual((await done<{ values: unknown }>(manager, [settings])).values, { flag: true });
    await refused(guest, [settings], "That module has no settings here.", 404);
    assert.throws(() => app.setExtensionSettings(guest, extension, { flag: false }), {
        status: 403,
        message: noRight,
    });
    // Managing the extension does not grant use of its owner-only endpoints.
    await done(owner(app), [`x/${extension}/private`]);
    await refused(manager, [`x/${extension}/private`], "Unknown extension route", 404);
});

test("providers: managers get full sign-in details and can manage shared credentials", async (t) => {
    const check = t.mock.method(app.providers, "checkAll", async () => {});
    const list = t.mock.method(app.providers, "list");
    const login = t.mock.method(app.providers, "startLogin", () => "test-flow");
    const logout = t.mock.method(app.providers, "logout", async () => {});

    await done(guest, ["providers"]);
    assert.equal(check.mock.callCount(), 0);
    assert.deepEqual(list.mock.calls[0]?.arguments, [false]);
    await done(manager, ["providers"]);
    assert.equal(check.mock.callCount(), 1);
    assert.deepEqual(list.mock.calls[1]?.arguments, [true]);
    assert.deepEqual(await managed("custom-providers"), []);
    assert.deepEqual(await managed("providers/faux/login", { type: "api_key" }), {
        flowId: "test-flow",
    });
    await managed("providers/faux/logout", {});
    assert.equal(login.mock.callCount(), 1);
    assert.equal(logout.mock.callCount(), 1);
});

test("models: only managers can request a shared refresh", async (t) => {
    // No network or model changes: the test is about reaching the shared refresh.
    const refresh = t.mock.method(app.providers.modelRefresh, "refresh", async () => ({
        refreshed: true,
    }));

    assert.deepEqual(await managed("models/refresh", {}), { refreshed: true });
    assert.equal(refresh.mock.callCount(), 1);
});

test("restart: only managers can request a supervised restart", async (t) => {
    // openApp is unsupervised. The HTTP handler uses the test callback instead of restarting.
    Object.defineProperty(app, "supervised", { value: true });
    t.after(() => Object.defineProperty(app, "supervised", { value: false }));
    await managed("restart", {});
    await until(() => restarts === 1, "one restart request");
});

test("server setters: managers can change task expiry, guard settings, and model settings", async (t) => {
    const directory = app.guard.directory;

    Object.defineProperty(app.guard, "directory", { value: root });
    t.after(() => Object.defineProperty(app.guard, "directory", { value: directory }));
    t.mock.method(app.guard, "model", async () => ({ state: "ready" as const, detail: "Ready" }));

    await managed("guard/model", {});
    await managed("tasks-expire", { on: true });
    assert.equal(app.config.server.tasksExpire, true);
    const defaultModel = { provider: "faux", modelId: "faux-2", thinkingLevel: "off" };

    for (const patch of [
        { approvalRule: "others" },
        { limitWaitHours: 12 },
        { pipCompactAt: 60_000 },
        { defaultModel },
        { subagentModels: ["faux/faux-2"] },
    ]) {
        await managed("settings", patch);
    }

    assert.equal(app.config.approvalRule, "others");
    assert.equal(app.config.limitWaitHours, 12);
    assert.equal(app.pipCompaction.compactAt, 60_000);
    assert.deepEqual(app.config.defaultModel, defaultModel);
    assert.deepEqual(app.config.subagentModels, ["faux/faux-2"]);
    assert.deepEqual(await managed("subagent-models", { model: "faux/faux-1", allowed: true }), {
        subagentModels: ["faux/faux-2", "faux/faux-1"],
    });
});

test("spend: managers set session and guest limits, but only the owner sets a manager's limit", async () => {
    const other = await person("Other manager");
    const first = owner(app);
    const budget = (person: User, amount: number | null): Request => [
        "spend",
        { person: person.id, budget: amount },
    ];

    give(other);
    const summary = await managed<SpendSummary>("spend", { session, budget: 4 });

    assert.equal(summary.sessions.find((each) => each.id === Number(session))?.budget, 4);
    assert.equal(typeof summary.total, "number");
    assert.ok(summary.people.some((each) => each.id === other.id));
    const personal = await done<SpendSummary>(guest, ["spend"]);

    assert.equal(personal.total, undefined);
    assert.deepEqual(
        personal.people.map((each) => each.id),
        [guest.id],
    );
    await refused(guest, budget(guest, 5));
    await done(manager, budget(guest, 5));
    assert.equal(app.config.userById(guest.id)?.budget, 5);
    await done(first, budget(manager, 3));
    await done(first, budget(other, 2));

    for (const target of [manager, other]) {
        await refused(
            manager,
            budget(target, null),
            "Only the owner can change the spend limit of someone who manages Pi Pocket.",
        );
    }

    assert.equal(app.config.userById(manager.id)?.budget, 3);
    assert.equal(app.config.userById(other.id)?.budget, 2);

    // The rows say which limits are not this reader's to change, so the sheet offers no way to.
    const locked = async (reader: User) =>
        (await done<SpendSummary>(reader, ["spend"])).people
            .filter((each) => each.locked === true)
            .map((each) => each.id)
            .sort();

    assert.deepEqual(await locked(manager), [first.id, manager.id, other.id].sort());
    assert.deepEqual(await locked(first), [first.id]);
    assert.deepEqual(await locked(guest), []);
    await refused(first, budget(first, 1), "The owner has no spend limit", 400);
    await done(first, budget(manager, null));
});

test("memory: managers' writes take effect, Pi's wait, and only managers approve", async () => {
    const path = `c/${session}/memory`;
    const soon = { scope: "session", text: "Manager's lesson." };
    const own = await done<Lesson>(manager, [path, soon]);
    const proposed = await done<Lesson>(guest, [path, { ...soon, text: "Guest's lesson." }]);
    const pi = await app.memory.add(
        session,
        work,
        { userId: manager.id, byPi: true, name: "Pi" },
        {
            scope: "session",
            text: "Pi's lesson.",
        },
    );

    assert.equal(own.pending, undefined);
    assert.equal(proposed.pending, true);
    assert.equal(pi.pending, true);
    const regular = await done<MemoryView>(guest, [path]);
    const review = await done<MemoryView>(manager, [path]);

    assert.equal(regular.owner, false);
    assert.ok(!regular.lessons.some((lesson) => lesson.id === pi.id));
    assert.equal(review.owner, true);
    assert.ok(review.lessons.some((lesson) => lesson.id === pi.id && lesson.pending));
    await refused(
        guest,
        [`${path}/${proposed.id}/approve`, { text: proposed.text }],
        "Only someone who manages Pi Pocket can approve lessons.",
    );
    assert.equal(
        (await done<Lesson>(manager, [`${path}/${pi.id}/approve`, { text: pi.text }])).pending,
        undefined,
    );
    await refused(
        guest,
        [`${path}/${own.id}`, { text: "Other words." }],
        "Only someone who manages Pi Pocket, or whoever saved it, can change or forget this lesson.",
    );
    const edit = await done<Lesson>(manager, [
        `${path}/${proposed.id}`,
        { text: "Approved with an edit." },
    ]);

    assert.equal(edit.pending, undefined);
    assert.equal(edit.text, "Approved with an edit.");
    // Manage Pi Pocket does not grant a PiP or remove the requirement to review from one's private PiP.
    await refused(
        guest,
        [`${path}?pending=all`],
        "Only someone who manages Pi Pocket can review all pending lessons.",
    );
    await refused(
        manager,
        [`${path}?pending=all`],
        "Review all pending lessons from your private PiP.",
    );
});

test("keep warm: managers read and change the server's settings, not the session right", async () => {
    await managed("keep-warm");
    const { settings } = await managed<{ settings: { hours: number } }>("keep-warm", { hours: 2 });

    assert.equal(settings.hours, 2);
    assert.equal(app.config.keepWarm.hours, 2);
    assert.equal(app.policy.keepsWarm(manager), false);
});

test("hello: only managers see the management fields, and other owner fields stay private", async (t) => {
    const first = owner(app);

    app.config.updateUser(first.id, { setupDismissed: undefined });
    await app.setExtensionEnabled(first, extensionFile, true);
    app.setTasksExpire(first, true);
    await app.setSubagentModels(first, ["faux/faux-2"]);
    const me = (user: User) => done<Awaited<ReturnType<App["hello"]>>>(user, ["me"]);
    const mine = await me(manager);
    const common = await me(guest);
    const owners = await me(first);

    assert.equal(mine.user.rights.managesServer, true);
    assert.equal(mine.tasksExpire, true);
    assert.equal(mine.server.refreshModels, true);
    assert.deepEqual(mine.server.subagentModels, ["faux/faux-2"]);
    assert.ok(mine.themes.find((theme) => theme.id === "broken-look")?.problem);
    assert.equal(common.tasksExpire, undefined);
    assert.equal(common.server.refreshModels, false);
    assert.equal(common.server.subagentModels, undefined);
    assert.equal(common.themes.find((theme) => theme.id === "broken-look")?.problem, undefined);
    assert.equal(owners.user.setup, true);
    assert.equal(mine.user.setup, undefined);
    assert.ok(
        owners.server.extensionCommands.some((command) => command.name === "manager-test-global"),
    );
    assert.ok(!mine.server.extensionCommands.some((command) => command.scope === "global"));
    assert.deepEqual(owners.runners, []);
    assert.equal(mine.runners, undefined);
    assert.equal(mine.server.pip, false);

    const problem = "Test: the themes could not be read.";

    t.mock.getter(app.themes, "failure", () => problem);

    for (const user of [manager, guest]) {
        const tab = fakeTab(undefined, user);

        t.after(() => app.detach(tab.client));
        await app.attach(tab.client);
        assert.equal(
            tab.events.some(({ event, data }) => event === "notice" && data.message === problem),
            user === manager,
        );
        tab.events.length = 0;
        await app.allowSubagentModel(first, "faux/faux-1", true);
        assert.equal(
            tab.events.some(({ event }) => event === "hello"),
            user === manager,
        );
        await app.allowSubagentModel(first, "faux/faux-1", false);
    }
});

test("viewers, one-session users, and a manager whose right was taken back are refused", async () => {
    for (const user of [
        await person("Viewer", "viewer"),
        await person("One session", "guest", [String(session)]),
    ]) {
        // A stale right on a record does not mean its person can hold it.
        app.config.updateUser(user.id, { rights: ["managesServer"] });
        assert.equal(app.policy.managesServer(user), false);
        await refused(user, ["keep-warm"]);
    }

    await done(manager, ["keep-warm"]);
    give(manager, false);
    assert.throws(() => app.keepWarm.overview(manager), { status: 403, message: noRight });
    await refused(manager, ["keep-warm"]);
    await refused(manager, ["extensions/" + extensionFile + "/reload", {}]);
});
