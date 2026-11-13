// A real Pocket server, runner, and pi-env. Pi files stay outside every project folder. The server decides who may
// list, preview, and continue (`access.ts`); the runner opens only a listed Pi file inside the new session's folder.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { parseControl, type RunnerPiSession } from "../src/runner/protocol.ts";
import { Runner } from "../src/runner/runner.ts";
import { linkInProcess } from "../src/runner/secure-link.ts";
import { createHandler } from "../src/server/http.ts";
import type { User } from "../src/server/config.ts";
import type { PiSessionSummary } from "../src/server/pi-sessions.ts";
import { readPiSession } from "../src/server/pi-session-files.ts";

const project = join(root, "checkout-project");
const otherProject = join(root, "other-project");
const sessions = join(root, "computer-pi-files");
const files = new Map<string, { path: string; id: string }>();
let app: App;
let server: Server;
let runner: Runner;
let runnerId: string;
let address: string;

function save(name: string, cwd = project): { path: string; id: string } {
    const manager = SessionManager.inMemory(cwd);

    manager.appendSessionInfo(name);
    manager.appendModelChange("faux", "faux-1");
    manager.appendMessage({
        role: "user",
        content: "private-body-needle: check the cart",
        timestamp: 1,
    });
    manager.appendMessage(fauxAssistantMessage("private-reply-needle: use integer cents"));
    const path = join(sessions, `${name}.jsonl`);

    mkdirSync(sessions, { recursive: true });
    writeFileSync(
        path,
        [manager.getHeader(), ...manager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
    );

    return { path, id: manager.getHeader()!.id };
}

function file(name: string): { path: string; id: string } {
    return files.get(name)!;
}

async function request<T = Record<string, unknown>>(
    route: string,
    body?: unknown,
    signal: AbortSignal = AbortSignal.timeout(20_000),
    token?: string,
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/pi-sessions${route}`, {
        method: body === undefined ? "GET" : "POST",
        signal,
        headers: {
            authorization: `Bearer ${token ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: (await response.json()) as T };
}

const preview = (name: string, signal?: AbortSignal) =>
    request<{
        last: { role: string; text: string }[];
        model: string;
        cwdExists: boolean;
        modelHere: boolean;
        error?: string;
    }>(
        `/preview?${new URLSearchParams({ path: file(name).path, runner: runnerId })}`,
        undefined,
        signal,
    );
const list = (q = "") =>
    request<{ sessions: (PiSessionSummary & { id: string })[] }>(
        `?${new URLSearchParams({ runner: runnerId, q })}`,
    );

before(async () => {
    mkdirSync(project);
    mkdirSync(otherProject);

    for (const name of ["Checkout total", "Code preview", "Continue history", "Expiry history"]) {
        files.set(name, save(name));
    }

    app = await openApp(scriptedModel());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { code } = app.runners.makeCode("Test laptop", owner(app).id);
    const linked = linkInProcess((each) => app.runners.redeem(each), code);

    runnerId = linked.id;
    runner = new Runner({
        link: { server: address, ...linked },
        version: "test",
        cwd: project,
        piSessionDir: sessions,
        log: () => {},
        retryMs: [50, 100],
    });
    runner.start();
    await until(() => app.runners.link(runnerId).online, "the runner to connect");
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

/** A session the server approved on the computer: its scope, as the runner sees it in each request. */
async function approved(folder = project): Promise<{ id: string; folder: string }> {
    const id = await app.commands.createSession(owner(app), { cwd: folder, runner: runnerId });
    const meta = app.sessionMeta(id.id)!;

    return { id: meta.runnerPermission!, folder };
}

test("the list sends only metadata, newest first; search does not read message bodies", async () => {
    const result = await list();

    assert.equal(result.status, 200);
    assert.equal(result.body.sessions.length, files.size);
    const item = result.body.sessions.find((each) => each.path === file("Checkout total").path)!;

    assert.deepEqual(Object.keys(item).sort(), [
        "cwd",
        "id",
        "messages",
        "modified",
        "path",
        "title",
    ]);
    assert.equal(item.id, file("Checkout total").id);
    assert.equal(item.title, "Checkout total");
    assert.equal(item.cwd, project);
    assert.equal(item.messages, 2);
    assert.equal(typeof item.modified, "number");
    assert.ok(
        result.body.sessions.every(
            (each, index, all) => index === 0 || all[index - 1]!.modified >= each.modified,
        ),
    );
    assert.doesNotMatch(JSON.stringify(result.body), /private-body-needle|private-reply-needle/);
    assert.equal((await list("private-body-needle")).body.sessions.length, 0);
    assert.equal((await list("Checkout total")).body.sessions.length, 1);
    assert.equal((await list("checkout-project")).body.sessions.length, files.size);
});

test("a preview returns that one session's model and last messages", async () => {
    const result = await preview("Checkout total");

    assert.equal(result.status, 200);
    assert.equal(result.body.last.length, 2);
    assert.match(result.body.last[1]!.text, /private-reply-needle/);
    assert.equal(result.body.model, "faux/faux-1");
    assert.equal(result.body.modelHere, true);
    assert.equal(result.body.cwdExists, true);
});

test("closing the HTTP request of a preview ends it", async () => {
    const controller = new AbortController();
    const pending = preview("Code preview", controller.signal);

    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal((await preview("Code preview")).status, 200, "the next one still works");
});

test("preview and open refuse a file Pi does not list, even for a session approved there", async () => {
    const link = app.runners.link(runnerId);
    const path = join(root, "unlisted.jsonl");

    writeFileSync(path, readFileSync(file("Checkout total").path));
    const scope = await approved();

    for (const request of [
        { op: "preview" as const, path, person: "Owner" },
        { op: "open" as const, path, session: scope.id, folder: project, person: "Owner" },
        { op: "preview" as const, path: "/etc/passwd", person: "Owner" },
    ]) {
        await assert.rejects(link.piSessions(request), /Pi has no such session on Test laptop/);
    }
});

test("continue starts a new session in its folder, imports history, and scopes the one readable file", async () => {
    const source = file("Continue history");
    const whole = readFileSync(source.path, "utf8");
    const local = join(process.env.PI_CODING_AGENT_DIR!, "sessions", "--project--");

    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "same-id.jsonl"), whole);
    await app.commands.continuePiSession(owner(app), join(local, "same-id.jsonl"));
    assert.equal(
        (await list()).body.sessions.find((each) => each.path === source.path)!.pocket,
        undefined,
        "a local continuation does not mark a session on this computer as continued",
    );
    const result = await request<{ id: ConversationId }>("/continue", {
        path: source.path,
        runner: runnerId,
    });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    const id = result.body.id;
    const meta = app.sessionMeta(id)!;

    assert.equal(meta.runner, runnerId);
    assert.deepEqual(meta.fromPi, { session: source.id, count: 2 });
    assert.ok(meta.runnerPermission);
    assert.ok(app.folderApprovals.get(String(id)), "it is approved as any new session");
    const conversation = (await app.harness.conversation(id, context))!;
    const entries = await conversation.entries({}, 500, undefined, context);

    assert.equal(
        entries.items.filter((entry) => ["pi.user", "pi.assistant"].includes(entry.kind)).length,
        readPiSession(whole).entries.length,
    );
    assert.match(JSON.stringify(entries.items), /private-reply-needle/);
    assert.equal((await conversation.agent(context)).cwd, project);
    assert.equal(readFileSync(source.path, "utf8"), whole);
    assert.deepEqual(
        (await list()).body.sessions.find((each) => each.path === source.path)!.pocket,
        { id, behind: false },
    );
    const scope = { id: meta.runnerPermission!, folder: project };
    const env = app.runners.env(runnerId, project, scope);

    assert.equal((await env.readTextFile(source.path, context)).ok, true);
    assert.equal((await env.readTextFile(file("Checkout total").path, context)).ok, false);
    assert.equal((await env.writeFile(source.path, "changed", context)).ok, false);
    const other = app.runners.env(runnerId, project, { ...scope, id: randomUUID() });

    assert.equal(
        (await other.readTextFile(source.path, context)).ok,
        false,
        "another session in the same folder does not get the file",
    );
    assert.equal(readFileSync(source.path, "utf8"), whole);
});

test("open refuses a session whose real folder does not contain the Pi cwd", async () => {
    const link = app.runners.link(runnerId);
    const path = file("Checkout total").path;
    const scope = await approved(otherProject);

    await assert.rejects(
        link.piSessions({
            op: "open",
            path,
            session: scope.id,
            folder: otherProject,
            person: "Owner",
        }),
        /outside the session's folder/,
    );
});

test("open also allows the companion files Pocket names beside the Pi file, and no other", async () => {
    const link = app.runners.link(runnerId);
    const scope = await approved();
    const { path } = save("Companion history");
    const beside = `${path}.acp.json`;
    const other = `${path}.unregistered.json`;

    writeFileSync(beside, '{"blocks":[]}');
    writeFileSync(other, "not asked for");

    const result = await link.piSessions({
        op: "open",
        path,
        session: scope.id,
        folder: project,
        person: "Owner",
        companions: [".acp.json", ".missing.json"],
    });
    const env = app.runners.env(runnerId, project, scope);

    assert.deepEqual(result.companions, [`${result.path}.acp.json`], "only the one that exists");
    assert.equal((await env.readTextFile(`${result.path}.acp.json`, context)).ok, true);
    assert.equal(
        (await env.readTextFile(other, context)).ok,
        false,
        "one nobody named stays closed",
    );
    assert.equal(
        parseControl(
            JSON.stringify({
                type: "pi-sessions",
                id: "x",
                op: "open",
                path,
                session: scope.id,
                folder: project,
                person: "Owner",
                companions: ["/../../etc/passwd"],
            }),
        ),
        undefined,
        "a suffix that is a path is refused",
    );
});

test("the extra readable file expires after 5 minutes", async () => {
    const link = app.runners.link(runnerId);
    const scope = await approved();
    const result = await link.piSessions({
        op: "open",
        path: file("Expiry history").path,
        session: scope.id,
        folder: project,
        person: "Owner",
    });
    const env = app.runners.env(runnerId, project, scope);

    assert.equal((await env.readTextFile(result.path!, context)).ok, true);
    const now = Date.now;

    try {
        Date.now = () => now() + 5 * 60_000 + 1;
        assert.equal((await env.readTextFile(result.path!, context)).ok, false);
    } finally {
        Date.now = now;
    }
});

test("only a person who may start sessions on the computer can list, preview, or continue its Pi sessions", async () => {
    const { user, token } = app.config.addUser("Invited", "guest");
    const other: User = app.config.addUser("Other owner", "owner").user;
    const routes = ["", `/preview?path=${encodeURIComponent(file("Checkout total").path)}`];
    const statuses = async (who: string) => [
        ...(await Promise.all(
            routes.map(
                async (route) =>
                    (
                        await request(
                            `${route}${route.includes("?") ? "&" : "?"}runner=${runnerId}`,
                            undefined,
                            undefined,
                            who,
                        )
                    ).status,
            ),
        )),
    ];

    assert.deepEqual(await statuses(token), [403, 403]);
    assert.equal(
        (
            await request(
                "/continue",
                { path: file("Checkout total").path, runner: runnerId },
                undefined,
                token,
            )
        ).status,
        403,
    );
    assert.equal(app.policy.mayStart(other, runnerId), false);
    app.config.setRunnerUsers(runnerId, [user.id]);
    // Chosen, with no folder given: the list is empty, and a preview names nothing of theirs.
    assert.deepEqual(await statuses(token), [200, 404]);
    app.config.setGivenFolders(runnerId, user.id, [project]);
    assert.deepEqual(await statuses(token), [200, 200]);
});

test("a person given one folder sees and previews only Pi's sessions in it, and no one else's continuation", async () => {
    const elsewhere = save("Elsewhere plan", otherProject);
    const inside = file("Checkout total");
    const { user, token } = app.config.addUser("Given one", "guest");

    app.config.setRunnerUsers(runnerId, [
        ...(app.config.runnerById(runnerId)?.users ?? []),
        user.id,
    ]);
    app.config.setGivenFolders(runnerId, user.id, [project]);

    // The owner continues the session in the given folder, privately: the guest's list must not name it.
    const continued = await request<{ id: ConversationId }>("/continue", {
        path: inside.path,
        runner: runnerId,
    });

    assert.equal(continued.status, 200, JSON.stringify(continued.body));
    assert.equal(app.canSee(user, continued.body.id), false);

    try {
        const mine = await request<{ sessions: PiSessionSummary[] }>(
            `?${new URLSearchParams({ runner: runnerId })}`,
            undefined,
            undefined,
            token,
        );
        const paths = mine.body.sessions.map((each) => each.path);

        assert.equal(mine.status, 200);
        assert.ok(paths.includes(inside.path), "a session in the given folder is listed");
        assert.ok(!paths.includes(elsewhere.path), "one outside it is not");
        assert.equal(
            mine.body.sessions.find((each) => each.path === inside.path)!.pocket,
            undefined,
            "the owner's private continuation is not named",
        );
        // The owner, in charge there, sees both, and their own continuation.
        const all = (await list()).body.sessions;

        assert.ok(all.some((each) => each.path === elsewhere.path));
        assert.equal(all.find((each) => each.path === inside.path)!.pocket?.id, continued.body.id);

        const previewOf = (path: string) =>
            request(
                `/preview?${new URLSearchParams({ path, runner: runnerId })}`,
                undefined,
                undefined,
                token,
            );

        assert.equal((await previewOf(inside.path)).status, 200);
        assert.equal((await previewOf(elsewhere.path)).status, 404);
    } finally {
        app.config.setGivenFolders(runnerId, user.id, []);
        rmSync(elsewhere.path);
    }
});

test("Pi session control messages reject oversized lists, invalid operations, and non-finite metadata", () => {
    const session: RunnerPiSession = {
        path: "/pi/a.jsonl",
        id: "id",
        title: "Title",
        cwd: "/work",
        modified: 1,
        messages: 2,
    };
    const message = { type: "pi-sessions-result", id: "a", ok: true, sessions: [session] };

    assert.ok(parseControl(JSON.stringify(message)));
    assert.equal(
        parseControl(JSON.stringify({ ...message, sessions: Array(301).fill(session) })),
        undefined,
    );
    assert.equal(
        parseControl(JSON.stringify({ ...message, sessions: [{ ...session, messages: -1 }] })),
        undefined,
    );
    assert.equal(
        parseControl(
            JSON.stringify({ ...message, sessions: [{ ...session, title: "x".repeat(81) }] }),
        ),
        undefined,
    );
    assert.equal(
        parseControl(
            JSON.stringify({
                type: "pi-sessions",
                id: "a",
                person: "Owner",
                op: "delete",
                path: session.path,
            }),
        ),
        undefined,
    );
    assert.equal(
        parseControl(
            JSON.stringify({
                ...message,
                preview: { model: null, last: [{ role: "toolResult", text: "x" }] },
            }),
        ),
        undefined,
    );
});

test("a Pi session request fails immediately when the computer is offline", async () => {
    await runner.stop();
    await until(() => !app.runners.link(runnerId).online, "server to see the offline computer");
    const started = Date.now();
    const result = await list();

    assert.equal(result.status, 409);
    assert.ok(Date.now() - started < 2000);
});
