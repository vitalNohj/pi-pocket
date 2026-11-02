// Sessions on another computer, end to end (`src/server/runners.ts`, `src/runner/`): the app links a computer, its runner
// connects over a real WebSocket to a real pi-env daemon, and Pi's tools in a session there run there. Here the "other
// computer" is this one, in a folder of its own that the server's sessions never use.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import { AgentDoc } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import { ExtensionRequest } from "../src/server/extension-request.ts";
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
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

    if (text.includes("spawn runner subagent")) {
        return call("subagent", {
            action: "spawn",
            name: "remote-probe",
            message: "run runner directory probe",
        });
    }

    if (text.includes("start runner team")) {
        return call("team", { action: "start", message: "run runner directory probe" });
    }

    if (text.includes("run runner directory probe")) {
        return call("bash", { command: "pwd" });
    }

    if (text.includes("long runner codemode")) {
        return call("codemode", { code: 'text("remote-output-".repeat(6000));' });
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
    await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };

    server = createServer((request, response) => response.writeHead(404).end());
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

        for (const name of ["read", "write", "edit", "bash", "subagent", "team", "codemode"]) {
            assert.ok(tools.includes(name), `${name} is offered`);
        }

        for (const name of ["background", "browser", "artifact", "design_preview", "memory"]) {
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

    it("spawns a subagent with only remote extensions and runs its tools on the computer", async () => {
        await say(app, id as never, "spawn runner subagent");
        const spawned = (await app.harness.snapshot(SubagentsDoc, id as never, context))?.agents[
            "remote-probe"
        ];

        assert.ok(spawned, "the subagent was spawned");
        const child = spawned.conversationId;

        await until(
            async () => (await lastToolText(Number(child))).includes(there) && !app.isBusy(child),
            "the subagent's remote directory probe",
        );
        assert.equal(app.runnerOf(child), runnerId);
        assert.equal(app.cwdOf(child), there);
        const childAgent = await (await app.conversation(child)).agent(context);
        const parentAgent = await (await app.conversation(id as never)).agent(context);
        const remoteTools = new Set(parentAgent.callable.map((tool) => tool.name));

        for (const tool of childAgent.callable) {
            assert.ok(remoteTools.has(tool.name), `${tool.name} comes from a remote extension`);
        }

        for (const extension of childAgent.extensions) {
            assert.ok(
                (REMOTE_EXTENSIONS as readonly string[]).includes(extension.name),
                `${extension.name} is a remote extension`,
            );
        }

        for (const name of ["subagent", "team", "ask"]) {
            assert.ok(
                !childAgent.callable.some((tool) => tool.name === name),
                `${name} is removed`,
            );
        }
    });

    it("starts a team on the same computer and asks before creating its linked session", async () => {
        asked.length = 0;
        await say(app, id as never, "start runner team");
        const linked = app.sessions(owner(app)).findLast((each) => each.linkedFrom?.id === id);

        assert.ok(linked, "the team started a linked session");
        assert.equal(app.sessionMeta(linked.id as never)?.runner, runnerId);
        assert.equal(app.cwdOf(linked.id as never), there);
        assert.deepEqual(
            (await app.harness.snapshot(AgentDoc, linked.id as never, context))?.extensions,
            [...REMOTE_EXTENSIONS],
        );
        assert.deepEqual(
            asked.map((each) => [each.kind, each.person, each.folder]),
            [["new", owner(app).name, there]],
        );
        await until(
            async () =>
                (await lastToolText(linked.id)).includes(there) && !app.isBusy(linked.id as never),
            "the linked session's remote directory probe",
        );

        for (const cwd of ["", "   "]) {
            const { session } = await app.linkedSessions.start(
                id as never,
                { cwd, message: "hello" },
                crypto.randomUUID(),
            );

            assert.equal(app.cwdOf(session), there, `blank cwd ${JSON.stringify(cwd)}`);
            assert.equal(app.runnerOf(session), runnerId);
        }
    });

    it("checks an explicit team folder on the computer, and refuses a denied start", async () => {
        const before = app.sessions(owner(app)).length;

        asked.length = 0;
        await assert.rejects(
            app.linkedSessions.start(
                id as never,
                { cwd: join(there, "missing-team-folder"), message: "hello" },
                crypto.randomUUID(),
            ),
            /missing-team-folder is not a folder on Laptop/,
        );
        assert.equal(asked.length, 0, "an invalid folder never asks");
        answer = () => Promise.resolve({ allow: false, reason: "Team start denied." });

        try {
            await assert.rejects(
                app.linkedSessions.start(id as never, { message: "hello" }, crypto.randomUUID()),
                /Team start denied/,
            );
            assert.equal(asked.length, 1, "the computer was asked");
            assert.equal(app.sessions(owner(app)).length, before, "no linked session was made");
        } finally {
            answer = () => Promise.resolve({ allow: true });
        }
    });

    it("keeps the runner for a human team start and restricts starts to the computer's linker", async () => {
        const actor = new ExtensionRequest(app, owner(app).id, "owner", id as never);

        actor.bindSource((await app.agentState(id as never))!);

        try {
            const { session } = await app.linkedSessions
                .forRequest(id as never, actor)
                .start({ cwd: there, message: "hello" }, crypto.randomUUID());

            assert.equal(app.runnerOf(session), runnerId);
            assert.equal(app.cwdOf(session), there);
        } finally {
            actor.close();
        }

        const other = app.config.users.find((each) => each.name === "Co-owner")!;

        await app.setSharedRunnerSessions(owner(app), true);

        try {
            const { submissionId } = await app.commands.submit(id as never, other, {
                text: "hello from a co-owner",
                requestId: crypto.randomUUID(),
            });

            await (await app.harness.submission(submissionId, context))!.wait(context);
            const before = app.sessions(owner(app)).length;

            asked.length = 0;
            await assert.rejects(
                app.linkedSessions.start(id as never, { message: "hello" }, crypto.randomUUID()),
                /Only the person who linked this computer can start sessions on it/,
            );
            assert.equal(asked.length, 0, "a non-linker cannot ask the computer");
            assert.equal(app.sessions(owner(app)).length, before);
        } finally {
            await app.setSharedRunnerSessions(owner(app), false);
            await say(app, id as never, "hello from the linker");
        }
    });

    it("starts a server team without assigning a runner or asking the computer", async () => {
        const source = await newSession(app);

        asked.length = 0;
        await say(app, source, "start runner team");
        const linked = app.sessions(owner(app)).findLast((each) => each.linkedFrom?.id === source);

        assert.ok(linked);
        assert.equal(app.sessionMeta(linked.id as never)?.runner, undefined);
        assert.equal(app.cwdOf(linked.id as never), app.cwdOf(source));
        assert.equal(asked.length, 0);
    });

    it("does not save truncated codemode output in a file the remote session cannot read", async () => {
        const directory = join(root, "codemode-output");
        const previous = process.env.TMPDIR;

        mkdirSync(directory);
        process.env.TMPDIR = directory;

        try {
            await say(app, id as never, "long runner codemode");
            const result = await lastToolText(id);

            assert.match(result, /Warning: output truncated/);
            assert.ok(
                result.includes(
                    "[Full output not saved: this session runs on another computer. Make the script return less, or write the output to a file there.]",
                ),
            );
            assert.doesNotMatch(result, /Full output:|pi-pocket-codemode-/);
            assert.deepEqual(
                readdirSync(directory),
                [],
                "no output file was written on the server",
            );
        } finally {
            if (previous === undefined) {
                delete process.env.TMPDIR;
            } else {
                process.env.TMPDIR = previous;
            }
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
