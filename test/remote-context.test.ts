/**
 * A session on another computer gets its folder's context files and skills from that computer, its trust decisions
 * by computer and path, and the files people attach or name with @ there. The "other computer" is a real runner and
 * pi-env daemon on this machine, with its own home folder, so nothing comes from the server's.
 */
import assert from "node:assert/strict";
import { linkInProcess } from "../src/runner/secure-link.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { after, before, describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { err, ExecutionError, FileError, type FileInfo, ok } from "@earendil-works/pi-durable/env";
import { Runner, type RunnerOptions } from "../src/runner/runner.ts";
import { attachedFile } from "../src/server/commands.ts";
import { attachmentsHeading, splitAttachments } from "../src/server/entry-format.ts";
import {
    parseScan,
    powershellScanCommand,
    readFolder,
    type RemoteEnv,
    savedTrust,
    scanSettings,
    TRUST_FILE,
    withScanScope,
} from "../src/server/remote-context.ts";
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
let runnerOptions: RunnerOptions;
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

    // "write PATH: TEXT" writes it with Pi's write tool, on the computer the session runs on.
    const last = context.messages.at(-1) as { role: string; content: unknown };
    const asked =
        last.role === "user"
            ? /write (\S+): (.+)$/.exec(
                  typeof last.content === "string"
                      ? last.content
                      : (last.content as { type: string; text?: string }[])
                            .map((part) => part.text ?? "")
                            .join(""),
              )
            : null;

    if (asked !== null) {
        return fauxAssistantMessage(
            [fauxToolCall("write", { path: asked[1]!, content: `${asked[2]}\n` })],
            { stopReason: "toolUse" },
        );
    }

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
    const linked = linkInProcess((request) => app.runners.redeem(request), code);

    runnerId = linked.id;
    runnerOptions = {
        link: { server: `http://127.0.0.1:${port}`, ...linked },
        version: "test",
        cwd: remoteHome,
        log: () => {},
        retryMs: [50, 100, 200],
        settings: () => ({ confirm: false }),
        ask: () => Promise.resolve({ allow: true }),
    };
    runner = new Runner(runnerOptions);
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

const scanData = (script: string): { marker: string; cwd: string; home: string } => {
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)?.[1];

    assert.ok(encoded, "the script must take encoded data");

    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
};

function windowsFixture() {
    const root = "C:\\";
    const repo = root + "Code";
    const cwd = repo + "\\Café's project";
    const home = root + "Users\\Renée Cho";
    const own = cwd + "\\.pi\\skills";
    const agents = repo + "\\.agents\\skills";
    const user = home + "\\.agents\\skills";
    const make = (path: string, kind: FileInfo["kind"]): FileInfo => ({
        path,
        name: win32.basename(path),
        kind,
        size: 0,
        mtimeMs: 0,
    });
    const dir = (path: string) => make(path, "directory");
    const file = (path: string) => make(path, "file");
    const texts = new Map([
        [cwd + "\\CLAUDE.MD", "\uFEFFCafé rules.\r\n"],
        [repo + "\\AGENTS.override.md", "Override.\n"],
        [own + "\\one.md", "\uFEFFOwn skill.\n"],
        [agents + "\\alpha\\SKILL.md", "Team skill.\n"],
        [user + "\\user.md", "User skill.\n"],
    ]);
    const listings = new Map([
        [root, [dir(root + ".agents")]],
        [
            repo,
            [
                dir(repo + "\\.git"),
                dir(repo + "\\.agents"),
                file(repo + "\\AGENTS.override.md"),
                file(repo + "\\AGENTS.md"),
            ],
        ],
        [cwd, [dir(cwd + "\\.pi"), file(cwd + "\\CLAUDE.MD")]],
        [own, [file(own + "\\one.md")]],
        [agents, [dir(agents + "\\alpha")]],
        [
            agents + "\\alpha",
            [file(agents + "\\alpha\\SKILL.md"), dir(agents + "\\alpha\\ignored")],
        ],
        [user, [file(user + "\\user.md")]],
    ]);
    const accesses: string[] = [];
    const env = {
        connection: { info: async () => ({ os: "windows", home }) },
        canonicalPath: async (path: string) => ok(path),
        async listDir(path: string) {
            accesses.push(path);
            const entries = listings.get(path);

            return entries === undefined ? err(new FileError("not_found", path)) : ok(entries);
        },
        async readTextFile(path: string) {
            accesses.push(path);
            const text = texts.get(path);

            return text === undefined ? err(new FileError("permission_denied", path)) : ok(text);
        },
    } as unknown as RemoteEnv;
    // A PowerShell transcript is LF-framed, even when the file itself uses CRLF.
    const transcript = (marker: string) =>
        [
            ["folder", "", cwd],
            ["context", "", cwd + "\\CLAUDE.MD"],
            ["context", "", repo + "\\AGENTS.override.md"],
            ["own", "", own],
            ["skill", own, own + "\\one.md"],
            ["agents", "", agents],
            ["skill", agents, agents + "\\alpha\\SKILL.md"],
            ["user", "", user],
            ["skill", user, user + "\\user.md"],
            ["end", "", ""],
        ]
            .map(
                ([kind, place, path]) =>
                    `\n${marker}\t${kind}\t${place}\t${path}\n${texts.get(path!) ?? ""}`,
            )
            .join("");

    return { accesses, cwd, home, repo, env, transcript };
}

const brief = ({
    folder,
    context,
    own,
    agents,
    user,
    files,
}: Awaited<ReturnType<typeof readFolder>>) => ({ folder, context, own, agents, user, files });

describe("Windows context scan", () => {
    it("keeps paths out of the PowerShell source, including quotes and an empty home", () => {
        const cwd = 'C:\\Café\'s "quoted" $($dir)';
        const marker = "marker";
        const [command, ...args] = powershellScanCommand(marker, cwd, "");

        assert.equal(command, "powershell.exe");
        assert.deepEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-Command"]);
        assert.ok(!args[3]!.includes(cwd));
        assert.ok(!args[3]!.includes("$($dir)"));
        assert.deepEqual(scanData(args[3]!), { marker, cwd, home: "" });
    });

    it("reads the same ordered records as listings, with one exec and a fresh marker", async () => {
        const { env, cwd, home, accesses, transcript } = windowsFixture();
        const marks: string[] = [];

        env.exec = async (argv, options, context) => {
            assert.ok(Array.isArray(argv));
            assert.ok(options);
            assert.equal(options.cwd, cwd);
            const data = scanData(argv[4]!);

            assert.deepEqual(data, { marker: data.marker, cwd, home });
            marks.push(data.marker);
            const stdout = transcript(data.marker);

            options.onOutput?.("ignored", context, { stream: "stderr" });
            options.onOutput?.(stdout.slice(0, 18), context, { stream: "stdout" });
            options.onOutput?.(stdout.slice(18), context, { stream: "stdout" });

            return ok({ exitCode: 0 });
        };

        const fast = await readFolder(withScanScope(env, cwd), cwd);

        assert.equal(marks.length, 1);
        assert.deepEqual(accesses, []);
        assert.equal(fast.context[1]?.content, "Café rules.\r\n");
        assert.equal(fast.files[0]?.text, "Own skill.\n");
        assert.deepEqual(brief(await readFolder(env, cwd)), brief(fast));
        assert.notEqual(marks[0], marks[1]);
        scanSettings.shell = false;

        try {
            assert.deepEqual(brief(await readFolder(env, cwd)), brief(fast));
            assert.equal(marks.length, 2);
        } finally {
            scanSettings.shell = true;
        }
    });

    it("uses listings after a failed start, a nonzero exit, incomplete output, or a thrown error", async () => {
        const { env, cwd, accesses, transcript } = windowsFixture();
        const listed = brief(await readFolder(env, cwd));

        withScanScope(env, cwd);
        const failures = ["start", "exit", "partial", "throw"];

        for (const failure of failures) {
            accesses.length = 0;

            env.exec = async (argv, options, context) => {
                if (failure === "start") {
                    return err(new ExecutionError("spawn_error", "not installed"));
                }

                if (failure === "throw") {
                    throw new Error("lost command");
                }

                assert.ok(Array.isArray(argv));
                const out = transcript(scanData(argv[4]!).marker);

                options?.onOutput?.(failure === "partial" ? out.slice(0, -3) : out, context, {
                    stream: "stdout",
                });

                return ok({ exitCode: failure === "exit" ? 1 : 0 });
            };

            assert.deepEqual(brief(await readFolder(env, cwd)), listed, failure);
            assert.ok(accesses.includes(cwd), failure);
        }
    });

    it("reads ready context and user skills while an ancestor list and the real path are pending", async () => {
        const { env, cwd, home, repo, accesses } = windowsFixture();
        const release = Promise.withResolvers<void>();
        const list = env.listDir;

        env.listDir = async (path, context) => {
            if (path === repo) {
                await release.promise;
            }

            return list(path, context);
        };

        env.canonicalPath = async () => {
            await release.promise;

            return ok(cwd);
        };

        const pending = readFolder(env, cwd);

        try {
            await setImmediate();
            assert.ok(accesses.includes(win32.join(cwd, "CLAUDE.MD")));
            assert.ok(accesses.includes(win32.join(cwd, ".pi", "skills", "one.md")));
            assert.ok(accesses.includes(win32.join(home, ".agents", "skills", "user.md")));
            assert.ok(!accesses.includes(win32.join(repo, ".agents", "skills")));
        } finally {
            release.resolve();
        }

        const scan = await pending;

        assert.equal(scan.files.length, 3);
        assert.equal(scan.context.length, 2);
        assert.ok(!accesses.includes(win32.join(repo, "AGENTS.md")));
        assert.ok(!accesses.includes("C:\\.agents\\skills"));
    });

    it("does not run a scan command in a worktree with a different scope", async () => {
        const { env, cwd, repo } = windowsFixture();
        const parentContext = repo + "\\AGENTS.override.md";
        const original = env.readTextFile;

        env.readTextFile = (path, context) =>
            path === parentContext
                ? Promise.resolve(err(new FileError("permission_denied", path)))
                : original(path, context);
        env.exec = () => assert.fail("cannot scan a folder with a different approved scope");
        const scan = await readFolder(withScanScope(env, "D:\\Approved"), cwd);

        assert.deepEqual(
            scan.context.map(({ path }) => path),
            [cwd + "\\CLAUDE.MD"],
        );
    });

    it(
        "runs the script on a fixture, if pwsh is installed",
        {
            skip:
                spawnSync("sh", ["-c", "command -v pwsh"]).status !== 0
                    ? "pwsh is not installed"
                    : false,
        },
        async () => {
            const cwd = join(folder, "Café's project");

            mkdirSync(cwd, { recursive: true });
            writeFileSync(join(cwd, "AGENTS.md"), "\uFEFFRésumé.\r\n");
            const own = join(cwd, ".pi", "skills");

            skill(own, "extra", "Description", "Follow these steps.");
            writeFileSync(join(own, "large.md"), "x".repeat(256 * 1024 + 8));
            const marker = "ps-test-marker";
            const run = (home: string) =>
                spawnSync("pwsh", powershellScanCommand(marker, cwd, home).slice(1), {
                    cwd,
                    env: { ...process.env, HOME: remoteHome },
                    encoding: "utf8",
                });
            const actual = run(remoteHome);

            assert.equal(actual.status, 0, actual.stderr);
            const parsed = parseScan(actual.stdout, marker);

            assert.ok(parsed);
            const env = app.runners.env(runnerId, cwd, app.runnerScope(id as never));

            scanSettings.shell = false;

            try {
                const listed = await readFolder(env, cwd);
                const order = (scan: ReturnType<typeof parseScan>) =>
                    scan?.files.map(({ path }) => path).sort();

                assert.deepEqual(
                    brief({ ...listed, ...parsed, files: [] }),
                    brief({ ...listed, files: [] }),
                );
                assert.deepEqual(order(parsed), order(listed));
                assert.equal(
                    parsed.files.find(({ path }) => path.endsWith("large.md"))?.text.length,
                    256 * 1024,
                );
            } finally {
                scanSettings.shell = true;
            }

            const homeless = run("");

            assert.equal(homeless.status, 0, homeless.stderr);
            assert.deepEqual(parseScan(homeless.stdout, marker)?.user, []);
            symlinkSync(join(repo, "AGENTS.md"), join(cwd, "AGENTS.override.md"));
            const linked = run(remoteHome);

            assert.notEqual(linked.status, 0, linked.stderr);
            assert.equal(parseScan(linked.stdout, marker), undefined);
            assert.ok(!linked.stdout.includes("Repository rules from the laptop."));
        },
    );
});

describe("a session on another computer", () => {
    it("does not run a PowerShell scan without its session's folder permission", async () => {
        const scope = app.runnerScope(id as never);
        const unscoped = app.runners.env(runnerId, folder);
        const scoped = app.runners.env(runnerId, folder, scope);
        const run = (env: RemoteEnv, cwd: string) =>
            env.exec(powershellScanCommand("refused", cwd, remoteHome), { cwd }, context);
        const [missingPermission, outsideFolder] = await Promise.all([
            run(unscoped, folder),
            run(scoped, join(root, "there")),
        ]);

        assert.ok(!missingPermission.ok);
        assert.match(missingPermission.error.message, /session permission.*required/i);
        assert.ok(!outsideFolder.ok);
        assert.match(outsideFolder.error.message, /outside the session's approved folder/i);
    });
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
        // The session's own environment: its runner refuses a read that names no approved session.
        const env = app.runners.env(runnerId, folder, app.runnerScope(id as never));
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

    it("reads a context file Pi writes there at the next request, not 30 seconds later", async () => {
        await say(app, id as never, "hello");
        assert.doesNotMatch(sections.project_context ?? "", /Written by Pi just now/);

        // A turn that writes AGENTS.md: the next request has it, though the last reading is not 30 s old.
        const sub = join(folder, "AGENTS.md");
        const before = existsSync(sub) ? readFileSync(sub, "utf8") : undefined;

        try {
            await say(app, id as never, `write ${sub}: Written by Pi just now.`);
            await say(app, id as never, "hello again");

            assert.match(sections.project_context ?? "", /Written by Pi just now/);
        } finally {
            if (before === undefined) {
                rmSync(sub, { force: true });
            } else {
                writeFileSync(sub, before);
            }
        }
    });

    it("copies attached files there and lists their paths there", async () => {
        const uploads = app.workspace.uploadDirectory(id as never);
        const stored = join(uploads, "abc-12345678-plan.txt");

        writeFileSync(stored, "the plan\n");
        await say(app, id as never, "read the plan", [
            { path: stored, name: "plan.txt", mime: "text/plain", size: 9 },
        ]);

        const copy = join(
            tmpdir(),
            "pi-pocket-uploads",
            app.runnerScope(id as never).id,
            "abc-12345678-plan.txt",
        );
        const sent = (await modelTexts(app, id as never)).at(-2) ?? "";

        assert.equal(readFileSync(copy, "utf8"), "the plan\n");
        assert.ok(sent.includes(`- ${copy} (plan.txt, text/plain, 9 bytes)`), sent);
        // The files are on that computer, and the message says so.
        assert.ok(sent.includes("Attached files (copied to Laptop):"), sent);
        assert.doesNotMatch(sent, /saved on the server/);
        assert.deepEqual(splitAttachments(`read the plan${attachmentsHeading("Laptop")}- x`), [
            "read the plan",
            "- x",
            attachmentsHeading("Laptop"),
        ]);
        assert.doesNotMatch(sent, new RegExp(uploads.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

        // Taking the message back finds the copy here again.
        assert.deepEqual(attachedFile(`- ${copy} (plan.txt, text/plain, 9 bytes)`, uploads), [
            { path: stored, name: "plan.txt", mime: "text/plain", size: 9 },
        ]);
    });

    it("copies images too, and archiving removes the copies there", async () => {
        const uploads = app.workspace.uploadDirectory(id as never);
        const image = join(uploads, "def-12345678-shot.png");
        const folder = join(tmpdir(), "pi-pocket-uploads", app.runnerScope(id as never).id);

        writeFileSync(image, "not really a png");
        await say(app, id as never, "look at this", [
            { path: image, name: "shot.png", mime: "image/png", size: 16 },
        ]);

        assert.equal(
            readFileSync(join(folder, "def-12345678-shot.png"), "utf8"),
            "not really a png",
        );
        assert.equal(existsSync(join(folder, "abc-12345678-plan.txt")), true);

        await app.commands.updateSession(id as never, owner(app), { archived: true });
        await until(() => !existsSync(folder), "the copies there to go");
        await app.commands.updateSession(id as never, owner(app), { archived: false });
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

    it("a message sent while the computer is offline waits, and goes on when it is back, its files copied there", async () => {
        await runner.stop();
        await until(() => app.runners.list()[0]?.online === false, "the runner to go");

        const uploads = app.workspace.uploadDirectory(id as never);
        const stored = join(uploads, "abc-87654321-later.txt");
        const copy = join(
            tmpdir(),
            "pi-pocket-uploads",
            app.runnerScope(id as never).id,
            "abc-87654321-later.txt",
        );
        const before = (await modelTexts(app, id as never)).length;

        writeFileSync(stored, "later\n");

        // Sent at once, with the path there; Pi does not start until the computer is back.
        const { submissionId } = await app.commands.submit(id as never, owner(app), {
            text: "read this",
            requestId: crypto.randomUUID(),
            attachments: [{ path: stored, name: "later.txt", mime: "text/plain", size: 6 }],
        });
        const done = (await app.harness.submission(submissionId, context))!.wait(context);
        let answered = false;

        void done.then(() => (answered = true));
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(answered, false);
        assert.equal(existsSync(copy), false);

        runner = new Runner(runnerOptions);
        runner.start();
        await done;

        const texts = await modelTexts(app, id as never);
        const sent = texts.at(-2) ?? "";

        assert.ok(texts.length > before);
        assert.ok(sent.includes(`- ${copy} (later.txt, text/plain, 6 bytes)`), sent);
        assert.equal(readFileSync(copy, "utf8"), "later\n");
        // Its context came from the folder there, read once it was back.
        assert.match(sections.project_context ?? "", /Repository rules from the laptop/);
    });
});
