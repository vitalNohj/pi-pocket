// Sessions on another computer, end to end (`src/server/runners.ts`, `src/runner/`): the app links a computer, its runner
// connects over a real WebSocket to a real pi-env daemon, and Pi's tools in a session there run there. Here the "other
// computer" is this one, in a folder of its own that the server's sessions never use.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { Runner, type SessionAnswer, type SessionQuestion } from "../src/runner/runner.ts";
import { REMOTE_EXTENSIONS } from "../src/server/runners.ts";
import { createHandler } from "../src/server/http.ts";
import type { Lesson } from "../src/server/docs.ts";
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

/** The remote computer's folder: the server's own sessions work in `work`, never here. */
const there = join(root, "there");
let app: App;
let server: Server;
let runner: Runner;
let runnerId: string;
/** The system sections of the newest request to the model. */
let sections: Record<string, string> = {};

const route: FauxResponseStep = (context) => {
    const { role, text } = lastText(context as never);

    sections = Object.assign(
        {},
        ...(context.messages as { role: string; sections?: Record<string, string> }[])
            .filter((message) => message.role === "system")
            .map((message) => message.sections ?? {}),
    ) as Record<string, string>;

    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.includes("write the note")) {
        return call("write", { path: "note.txt", content: "made on the runner\n" });
    }

    if (text.includes("run pwd")) {
        return call("bash", { command: "pwd && cat note.txt" });
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

/** The runner's settings, as its link file would hold them. */
const runnerSettings: { confirm?: boolean } = {};

/** What the computer was asked, and how its person answers: yes, unless a test says otherwise. */
const asked: SessionQuestion[] = [];
let answer: (question: SessionQuestion) => Promise<SessionAnswer> = () =>
    Promise.resolve({ allow: true });

/** The newest tool result's text in a conversation. */
async function lastToolText(id: number): Promise<string> {
    const view = await (await app.harness.conversation(id as never, context))!.context(context);
    const result = view.messages.findLast((message) => message.role === "toolResult");

    return JSON.stringify(result?.content ?? "");
}

before(async () => {
    mkdirSync(there, { recursive: true });
    app = await openApp(scriptedModel(route));
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as AddressInfo;
    const { code } = app.runners.makeCode("Laptop", owner(app).id);
    const linked = app.runners.redeem(code);

    runnerId = linked.id;
    runner = new Runner({
        link: { server: `http://127.0.0.1:${port}`, ...linked },
        version: "test",
        cwd: there,
        log: () => {},
        retryMs: [50, 100, 200],
        settings: () => runnerSettings,
        // The person at the computer: asked before each session, answering as `answer` says.
        ask: (question) => {
            asked.push(question);

            return answer(question);
        },
    });
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "the runner to connect");
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("a session on another computer", () => {
    let id: number;

    it("starts in a folder there, owner only, and keeps the computer", async () => {
        const created = await app.commands.createSession(owner(app), {
            cwd: there,
            runner: runnerId,
        });

        id = created.id;
        assert.equal(app.runnerOf(created.id), runnerId);
        assert.equal(app.sessionMeta(created.id)?.runner, runnerId);
        assert.match(app.sessionMeta(created.id)?.title ?? "", /on Laptop$/);

        await assert.rejects(
            app.commands.createSession(owner(app), { cwd: join(there, "nope"), runner: runnerId }),
            /is not a folder on Laptop/,
        );
        await assert.rejects(
            app.commands.createSession(owner(app), { cwd: there, runner: "nobody" }),
            /not linked to this server/,
        );
        await assert.rejects(
            app.commands.createSession(owner(app), {
                cwd: there,
                runner: runnerId,
                worktree: true,
            }),
            /Worktrees are not available for sessions on another computer/,
        );
    });

    it("runs Pi's tools there, and tells Pi where it is", async () => {
        await say(app, id as never, "write the note");
        assert.equal(readFileSync(join(there, "note.txt"), "utf8"), "made on the runner\n");
        assert.ok(!existsSync(join(root, "work", "note.txt")));

        await say(app, id as never, "run pwd");
        assert.match(await lastToolText(id), /made on the runner/);
        assert.ok((await lastToolText(id)).includes(there));

        assert.match(sections.environment ?? "", /on the computer "Laptop"/);
        assert.match(
            sections.environment ?? "",
            /run on that computer, not on the Pi Pocket server/,
        );
        assert.equal(sections.project_context, undefined);
    });

    it("offers only the tools that work there", async () => {
        const tools = (await (await app.conversation(id as never)).agent(context)).tools.map(
            (tool) => tool.name,
        );

        for (const name of ["read", "write", "edit", "bash", "memory"]) {
            assert.ok(tools.includes(name), `${name} is offered`);
        }

        for (const name of ["background", "browser", "artifact", "subagent", "design_preview"]) {
            assert.ok(!tools.includes(name), `${name} is not offered`);
        }
    });

    it("refuses what reads this server's disk", async () => {
        await assert.rejects(app.workspace.changes(id as never, owner(app)), /runs on Laptop/);
        await assert.rejects(app.workspace.fileList(id as never, owner(app)), /runs on Laptop/);
        assert.equal(app.workspace.head(id as never), undefined);
    });

    it("is its creator's alone: others on the server neither see nor start, fork, or prompt one", async () => {
        const { user: other } = app.config.addUser("Someone", "guest");
        const { user: anotherOwner } = app.config.addUser("Co-owner", "owner");

        for (const person of [other, anotherOwner]) {
            assert.equal(app.canSee(person, id as never), false, `${person.name} cannot see it`);
            assert.ok(
                !app.sessions(person).some((each) => each.id === Number(id)),
                `${person.name}'s list has no such session`,
            );
            assert.throws(() => app.requireSee(person, id as never), /not shared with you/);
            await assert.rejects(
                app.commands.createSession(person, { cwd: there, runner: runnerId }),
                /Only the person who linked this computer/,
            );
            await assert.rejects(
                app.commands.fork(id as never, person, {}),
                /not shared|Only the person/,
            );
        }

        assert.equal(app.canSee(owner(app), id as never), true);
    });

    it("follows the usual rules when the owner shares them, but starting one stays the linker's", async () => {
        const other = app.config.users.find((each) => each.name === "Co-owner")!;

        await assert.rejects(
            app.setSharedRunnerSessions(
                app.config.users.find((each) => each.name === "Someone")!,
                true,
            ),
            /Only the owner/,
        );
        await app.setSharedRunnerSessions(owner(app), true);

        try {
            assert.equal(app.canSee(other, id as never), true);
            assert.ok(app.sessions(other).some((each) => each.id === Number(id)));
            await assert.rejects(
                app.commands.createSession(other, { cwd: there, runner: runnerId }),
                /Only the person who linked this computer/,
            );
            await assert.rejects(
                app.commands.fork(id as never, other, {}),
                /Only the person who linked/,
            );
        } finally {
            await app.setSharedRunnerSessions(owner(app), false);
        }

        assert.equal(app.canSee(other, id as never), false);
        assert.equal(app.config.sharedRunnerSessions, false);
    });

    it("keeps the computer in a fork", async () => {
        const fork = await app.commands.fork(id as never, owner(app), {});

        assert.equal(app.runnerOf(fork.id), runnerId);
    });

    it("asks the computer first, and does not start a session its person denies", async () => {
        asked.length = 0;
        answer = () =>
            Promise.resolve({ allow: false, reason: "The person at this computer denied it." });

        try {
            const before = app.sessions(owner(app)).length;

            await assert.rejects(
                app.commands.createSession(owner(app), { cwd: there, runner: runnerId }),
                /denied it/,
            );
            await assert.rejects(app.commands.fork(id as never, owner(app), {}), /denied it/);
            assert.equal(app.sessions(owner(app)).length, before, "no session was made");
            assert.deepEqual(
                asked.map((each) => [each.kind, each.person, each.folder]),
                [
                    ["new", "Owner", there],
                    ["fork", "Owner", there],
                ],
            );
        } finally {
            answer = () => Promise.resolve({ allow: true });
        }
    });

    it("starts sessions without asking when its person turned asking off", async () => {
        asked.length = 0;
        answer = () => Promise.reject(new Error("must not be asked"));

        try {
            runnerSettings.confirm = false;
            await app.commands.createSession(owner(app), { cwd: there, runner: runnerId });
            assert.equal(asked.length, 0);
        } finally {
            runnerSettings.confirm = true;
            answer = () => Promise.resolve({ allow: true });
        }
    });

    it("keeps lessons on their computer and offers approved lessons from other copies to add", async () => {
        const localFolder = join(root, "local-memory");
        const remoteFolder = join(root, "runner-memory");

        for (const [folder, url] of [
            [localFolder, "git@github.com:Acme/Memory.git"],
            [remoteFolder, "https://github.com/acme/memory.git"],
        ]) {
            mkdirSync(folder!, { recursive: true });
            execFileSync("git", ["init", "-q"], { cwd: folder });
            execFileSync("git", ["remote", "add", "origin", url!], { cwd: folder });
        }

        const local = (await app.commands.createSession(owner(app), { cwd: localFolder })).id;
        const remote = (
            await app.commands.createSession(owner(app), { cwd: remoteFolder, runner: runnerId })
        ).id;
        const localProject = (await app.memory.project(local, localFolder))!;
        const remoteProject = (await app.memory.project(remote, remoteFolder))!;

        assert.match(remoteProject.key, new RegExp(`^runner:${runnerId}:`));
        assert.equal(localProject.key, join(localFolder, ".git"));
        assert.equal(remoteProject.runner, runnerId);
        assert.equal(localProject.repo?.toLowerCase(), remoteProject.repo?.toLowerCase());
        const localLesson = await app.memory.remember(local, owner(app), {
            text: "Build with make check.",
        });
        const remoteLesson = await app.memory.remember(remote, owner(app), {
            text: "Keep commands on the runner.",
        });

        await app.memory.remember(local, owner(app), { text: "Shared lesson." });
        await app.memory.remember(remote, owner(app), { text: "  Shared lesson.  " });
        await app.memory.remember(local, owner(app), { text: "Already pending there." });
        const pi = { userId: owner(app).id, byPi: true, name: "Pi" };

        await app.memory.add(remote, remoteFolder, pi, {
            text: "Already pending there.",
            scope: "project",
        });
        await app.memory.add(local, localFolder, pi, {
            text: "Unapproved source.",
            scope: "project",
        });
        assert.ok(
            (await app.memory.inForce(remote, remoteFolder)).lessons.some(
                (lesson) => lesson.id === remoteLesson.id,
            ),
        );
        assert.ok(
            !(await app.memory.inForce(local, localFolder)).lessons.some(
                (lesson) => lesson.id === remoteLesson.id,
            ),
        );
        assert.ok(
            !(await app.memory.inForce(remote, remoteFolder)).lessons.some(
                (lesson) => lesson.id === localLesson.id,
            ),
        );

        const view = await app.memory.view(remote, owner(app));

        assert.deepEqual(
            view.others?.map((other) => [
                other.project,
                other.name,
                other.computer,
                other.lessons.map((lesson) => lesson.id),
            ]),
            [[localProject.key, localProject.name, "this server", [localLesson.id]]],
        );
        const localView = await app.memory.view(local, owner(app));

        assert.deepEqual(
            localView.others?.map((other) => [
                other.computer,
                other.lessons.map((lesson) => lesson.id),
            ]),
            [["Laptop", [remoteLesson.id]]],
        );
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/c/${remote}/memory`;
        const copy = (lesson: string) =>
            fetch(url, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${app.config.ownerToken}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ copy: lesson }),
            });

        for (const invalid of [remoteLesson.id, "missing"]) {
            const rejected = await copy(invalid);

            assert.equal(rejected.status, 404);
            assert.match(
                await rejected.text(),
                /That lesson is not in another copy of this repository\./,
            );
        }

        const response = await copy(localLesson.id);

        assert.equal(response.status, 200);
        const copied = (await response.json()) as Lesson;

        assert.notEqual(copied.id, localLesson.id);
        assert.equal(copied.text, localLesson.text);
        assert.equal(copied.project, remoteProject.key);
        assert.equal(copied.pending, undefined);
        assert.equal(copied.from?.conversationId, remote);
        assert.equal((await app.memory.view(remote, owner(app))).others, undefined);
        assert.equal((await copy(localLesson.id)).status, 404);

        await say(app, remote, "check my saved lessons");
        assert.match(sections.memory ?? "", /Keep commands on the runner/);
        assert.match(sections.memory ?? "", /Build with make check/);
    });

    it("starts PR watches using the runner's origin and branch but gh on the server", async () => {
        const folder = join(root, "runner-watch");

        mkdirSync(folder, { recursive: true });
        execFileSync("git", ["init", "-q", "-b", "runner-branch"], { cwd: folder });
        execFileSync(
            "git",
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
            { cwd: folder },
        );
        execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], {
            cwd: folder,
        });
        const session = (
            await app.commands.createSession(owner(app), { cwd: folder, runner: runnerId })
        ).id;
        const previous = app.watches.gh;
        const calls: { args: string[]; cwd?: string }[] = [];

        // The same server-side gh seam as triggers.test.ts, never a gh command sent to the runner.
        app.watches.gh = async (args, cwd) => {
            calls.push({ args, cwd });

            if (args[0] === "api") {
                return args[1] === "user"
                    ? "me\n"
                    : JSON.stringify({ full_name: "acme/app", permissions: { push: true } });
            }

            return JSON.stringify({
                number: 23,
                url: "https://github.com/acme/app/pull/23",
                title: "Runner PR",
                state: "OPEN",
                headRefName: "runner-branch",
            });
        };

        try {
            await loadTools(app, session, "watch_pr");
            const tools = (await (await app.conversation(session)).agent(context)).tools.map(
                (tool) => tool.name,
            );

            assert.ok(tools.includes("watch_pr"));

            for (const pr of [undefined, "23", "https://github.com/acme/app/pull/23"]) {
                calls.length = 0;
                await app.watches.start(session, owner(app).id, {
                    ...(pr === undefined ? {} : { pr }),
                    byPi: true,
                });
                const call = calls.find(({ args }) => args[0] === "pr" && args[1] === "view")!;

                assert.equal(call.cwd, undefined, "server gh never receives the runner's folder");
                assert.equal(call.args[call.args.indexOf("--repo") + 1], "acme/app");
                assert.equal(call.args[call.args.indexOf("--") + 1], pr ?? "runner-branch");
                await app.watches.stop(session);
            }
        } finally {
            await app.watches.stop(session);
            app.watches.gh = previous;
        }
    });

    it("fails a tool, not the server, when the computer is offline", async () => {
        await runner.stop();
        await until(() => app.runners.list()[0]?.online === false, "the runner to go");
        writeFileSync(join(there, "note.txt"), "changed while away\n");

        await say(app, id as never, "run pwd");
        assert.match(await lastToolText(id), /Laptop is offline/);
    });
});

it("runs with exactly the remote extensions", () => {
    assert.ok(REMOTE_EXTENSIONS.includes("coding-tools"));
    assert.ok(!(REMOTE_EXTENSIONS as readonly string[]).includes("pocket-background"));
});
