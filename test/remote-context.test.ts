/**
 * A session on another computer gets its folder's context files and skills from that computer, its trust decisions
 * by computer and path, and the files people attach or name with @ there. The "other computer" is a real runner and
 * pi-env daemon on this machine, with its own home folder, so nothing comes from the server's.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, posix } from "node:path";
import { after, before, describe, it } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
    fauxAssistantMessage,
    fauxText,
    type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { Runner } from "../src/runner/runner.ts";
import { attachedFile } from "../src/server/commands.ts";
import { readFolder, savedTrust, scanSettings, TRUST_FILE } from "../src/server/remote-context.ts";
import {
    type App,
    cleanUp,
    context,
    modelTexts,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

/** The other computer: its home folder, and a project in a repository there. */
const remoteHome = join(root, "remote-home");
const repo = join(root, "there", "repo");
const folder = join(repo, "app");
let app: App;
let server: Server;
let runner: Runner;
let runnerId: string;
let id: number;
let sections: Record<string, string> = {};
const serverHome = process.env.HOME;

const route: FauxResponseStep = (context) => {
    sections = Object.assign(
        {},
        ...(context.messages as { role: string; sections?: Record<string, string> }[])
            .filter((message) => message.role === "system")
            .map((message) => message.sections ?? {}),
    ) as Record<string, string>;

    return fauxAssistantMessage([fauxText("ok")]);
};

function skill(dir: string, name: string, description: string, body: string): void {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
        join(dir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    );
}

before(async () => {
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(root, "there", "AGENTS.md"), "Above the repository: shown too.\n");
    writeFileSync(join(repo, "AGENTS.md"), "Repository rules from the laptop.\n");
    writeFileSync(join(repo, "CLAUDE.md"), "Not read: AGENTS.md comes first.\n");
    writeFileSync(join(folder, "CLAUDE.md"), "\uFEFFApp folder notes.\n");
    writeFileSync(join(folder, "notes.txt"), "a note on the laptop\n");
    skill(join(folder, ".pi", "skills"), "own-skill", "The project's own skill.", "Own steps.");
    skill(join(repo, ".agents", "skills"), "team-skill", "A shared team skill.", "Team steps.");
    skill(
        join(remoteHome, ".agents", "skills"),
        "laptop-skill",
        "Only on the laptop.",
        "Laptop steps.",
    );

    // The daemon's home folder is the "other computer's": it takes HOME from the runner.
    process.env.HOME = remoteHome;
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
        cwd: remoteHome,
        log: () => {},
        retryMs: [50, 100, 200],
        settings: () => ({ confirm: false }),
        ask: () => Promise.resolve({ allow: true }),
    });
    runner.start();
    await until(() => app.runners.list()[0]?.online === true, "the runner to connect");
    id = (await app.commands.createSession(owner(app), { cwd: folder, runner: runnerId }))
        .id as unknown as number;
});

after(async () => {
    process.env.HOME = serverHome;
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("a session on another computer", () => {
    it("shows the context files of its folder and the folders above it there, topmost first", async () => {
        await say(app, id as never, "hello");

        const shown = sections.project_context ?? "";
        const order = [
            join(root, "there", "AGENTS.md"),
            join(repo, "AGENTS.md"),
            join(folder, "CLAUDE.md"),
        ].map((path) => shown.indexOf(`<file path="${path}">`));

        assert.ok(
            order.every((at) => at >= 0),
            shown,
        );
        assert.deepEqual(
            [...order].sort((a, b) => a - b),
            order,
        );
        assert.match(shown, /Repository rules from the laptop\.\n<\/file>/);
        assert.match(shown, /<file path="[^"]+">\nApp folder notes\.\n<\/file>/);
        assert.doesNotMatch(shown, /Not read/);
    });

    it("lists the skills there: the project's own and the computer's, not the untrusted shared ones", async () => {
        const skills = sections.skills ?? "";

        assert.match(skills, /own-skill: The project's own skill\./);
        assert.match(skills, /laptop-skill: Only on the laptop\./);
        assert.match(
            skills,
            new RegExp(`In ${join(remoteHome, ".agents", "skills")}/<name>/SKILL\\.md:`),
        );
        assert.doesNotMatch(skills, /team-skill/);

        const names = app.skillCommands(id as never).map((each) => each.name);

        assert.ok(names.includes("own-skill") && names.includes("laptop-skill"), String(names));
        assert.ok(!names.includes("team-skill"));
    });

    it("asks whether to trust the project, and keeps the answer by computer and path", async () => {
        const trust = app.projectTrust(id as never, owner(app));

        assert.equal(trust.folder, folder);
        assert.equal(trust.parent, repo);
        assert.equal(trust.ask, true);
        assert.deepEqual(trust.folders, [join(repo, ".agents", "skills")]);
        assert.deepEqual(
            trust.skills.map((each) => each.name),
            ["team-skill"],
        );

        const after = app.setProjectTrust(id as never, owner(app), "trust-parent");

        assert.equal(after.trusted, true);
        assert.deepEqual(after.saved, { path: repo, trusted: true });

        const saved = JSON.parse(readFileSync(join(app.dataDir, TRUST_FILE), "utf8")) as unknown;

        assert.deepEqual(saved, { [runnerId]: { [repo]: true } });
        assert.equal(savedTrust(app.dataDir, "another-computer", folder, posix), null);

        // Pi's own store names this server's folders: nothing of the laptop's goes there.
        const piTrust = join(getAgentDir(), "trust.json");

        assert.ok(!existsSync(piTrust) || !readFileSync(piTrust, "utf8").includes(repo));
        assert.ok(app.skillCommands(id as never).some((each) => each.name === "team-skill"));
    });

    it("runs a skill there as /skill:name, with its file read there", async () => {
        await say(app, id as never, "/skill:team-skill tidy up");

        const sent =
            (await modelTexts(app, id as never)).findLast((text) => text.includes("tidy up")) ?? "";

        assert.match(
            sent,
            /<skill name=\\"team-skill\\" location=\\"[^"\\]+team-skill\/SKILL\.md\\">/,
        );
        assert.match(sent, /Team steps\./);
        assert.match(sent, /tidy up/);
    });

    it("finds the same with folder listings as with one shell command", async () => {
        const env = app.runners.env(runnerId, folder);
        const shell = await readFolder(env, folder);

        scanSettings.shell = false;

        try {
            const listed = await readFolder(env, folder);
            const brief = (scan: typeof shell) => ({
                folder: scan.folder,
                context: scan.context,
                own: scan.own,
                agents: scan.agents,
                user: scan.user,
                files: scan.files.map((file) => file.path).sort(),
            });

            assert.deepEqual(brief(listed), brief(shell));
            assert.equal(shell.files.length, 3);
        } finally {
            scanSettings.shell = true;
        }
    });

    it("copies attached files there and lists their paths there", async () => {
        const uploads = app.workspace.uploadDirectory(id as never);
        const stored = join(uploads, "abc-12345678-plan.txt");

        writeFileSync(stored, "the plan\n");
        await say(app, id as never, "read the plan", [
            { path: stored, name: "plan.txt", mime: "text/plain", size: 9 },
        ]);

        const copy = join(remoteHome, ".pi-pocket", "uploads", String(id), "abc-12345678-plan.txt");
        const sent = (await modelTexts(app, id as never)).at(-2) ?? "";

        assert.equal(readFileSync(copy, "utf8"), "the plan\n");
        assert.ok(sent.includes(`- ${copy} (plan.txt, text/plain, 9 bytes)`), sent);
        assert.doesNotMatch(sent, new RegExp(uploads.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

        // Taking the message back finds the copy here again.
        assert.deepEqual(attachedFile(`- ${copy} (plan.txt, text/plain, 9 bytes)`, uploads), [
            { path: stored, name: "plan.txt", mime: "text/plain", size: 9 },
        ]);
    });

    it("sends the files a message names with @, read there", async () => {
        const { submissionId } = await app.commands.submit(id as never, owner(app), {
            text: "look at @notes.txt",
            requestId: crypto.randomUUID(),
            inlineFiles: true,
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);

        const sent = (await modelTexts(app, id as never)).at(-2) ?? "";

        assert.ok(sent.includes(`<file name=\\"${join(folder, "notes.txt")}\\">`), sent);
        assert.match(sent, /a note on the laptop/);
    });

    it("refuses attachments while the computer is offline, and still answers without them", async () => {
        await runner.stop();
        await until(() => app.runners.list()[0]?.online === false, "the runner to go");

        const uploads = app.workspace.uploadDirectory(id as never);
        const stored = join(uploads, "abc-87654321-later.txt");

        writeFileSync(stored, "later\n");
        await assert.rejects(
            say(app, id as never, "read this", [
                { path: stored, name: "later.txt", mime: "text/plain", size: 6 },
            ]),
            /could not be copied to Laptop/,
        );

        // A turn needs no context files to go: they are left as last read, or out.
        await say(app, id as never, "hello again");
        assert.match(sections.environment ?? "", /copied to that computer/);
    });
});
