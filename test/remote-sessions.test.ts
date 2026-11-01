// Sessions on another computer, end to end (`src/server/runners.ts`, `src/runner/`): the app links a computer, its runner
// connects over a real WebSocket to a real pi-env daemon, and Pi's tools in a session there run there. Here the "other
// computer" is this one, in a folder of its own that the server's sessions never use.
import assert from "node:assert/strict";
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
import { Runner } from "../src/runner/runner.ts";
import { REMOTE_EXTENSIONS } from "../src/server/runners.ts";
import {
    type App,
    cleanUp,
    context,
    lastText,
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

        for (const name of ["read", "write", "edit", "bash"]) {
            assert.ok(tools.includes(name), `${name} is offered`);
        }

        for (const name of [
            "background",
            "browser",
            "artifact",
            "subagent",
            "design_preview",
            "memory",
        ]) {
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
