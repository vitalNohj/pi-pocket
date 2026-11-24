// The projects on a computer and their trust, for the Access sheet's grid (`src/server/projects.ts`):
// `GET /api/runners/:id/projects` and `POST /api/runners/:id/trust`, only for who is in charge of that computer.
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import {
    addPerson,
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { THIS_SERVER } from "../src/server/access.ts";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import type { ProjectsView } from "../src/server/projects.ts";
import { TRUST_FILE, trustFile } from "../src/server/remote-context.ts";

let app: App;
let server: Server;
let address: string;
const tokens = new Map<string, string>();
let alex: User;
let vera: User;
let manager: User;
let host: User;
/** A runner Host linked, and one the owner linked. */
let laptop: string;
let desk: string;
let betaSession: Awaited<ReturnType<typeof newSession>>;

/** Three projects: alpha with a worktree outside it, beta, and a folder in no repository. */
const projects = join(root, "projects");
const alpha = join(projects, "alpha");
const alphaSub = join(alpha, "src");
const outside = join(root, "worktrees", "alpha-feature");
const beta = join(projects, "beta");
const plain = join(root, "plain");

function git(cwd: string, ...args: string[]): void {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        stdio: "ignore",
    });
}

function repository(folder: string): void {
    mkdirSync(folder, { recursive: true });
    git(folder, "init", "-q", "-b", "main");
    writeFileSync(join(folder, "README.md"), "x\n");
    git(folder, "add", ".");
    git(folder, "commit", "-q", "-m", "first");
}

async function person(name: string, role: User["role"]): Promise<User> {
    const { user, token } = await addPerson(app, name, role);

    tokens.set(user.id, token);

    return user;
}

async function call<T = unknown>(
    user: User,
    path: string,
    body?: unknown,
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
            authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: (await response.json()) as T };
}

const trustStore = () => new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR!);

before(async () => {
    repository(alpha);
    mkdirSync(alphaSub);
    mkdirSync(join(root, "worktrees"));
    git(alpha, "worktree", "add", "-q", "-b", "feature", outside);
    repository(beta);
    // A project skill in beta: Pi asks whether to trust it.
    mkdirSync(join(beta, ".agents", "skills", "waiting"), { recursive: true });
    writeFileSync(
        join(beta, ".agents", "skills", "waiting", "SKILL.md"),
        "---\nname: waiting\ndescription: The waiting skill.\n---\n\nSteps.\n",
    );
    mkdirSync(plain);

    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])));

    for (const cwd of [alpha, alphaSub, outside, plain]) {
        await newSession(app, cwd);
    }

    betaSession = await newSession(app, beta);

    // An archived session is in no project: its folder would show one nobody works in.
    const archived = join(root, "archived-repo");

    repository(archived);
    await app.commands.updateSession(await newSession(app, archived), owner(app), {
        archived: true,
    });

    alex = await person("Alex", "guest");
    vera = await person("Vera", "viewer");
    manager = await person("Manager", "guest");
    app.setRight(owner(app), { person: manager.id, right: "managesRunners", on: true });

    const linked = app.config.addUser("Host", "guest");

    host = linked.user;
    tokens.set(host.id, linked.token);
    laptop = app.config.addRunner("Laptop", host.id, newIdentity().publicKey).id;
    app.config.setUsers(laptop, [owner(app).id, alex.id, vera.id]);
    desk = app.config.addRunner("Desk", owner(app).id, newIdentity().publicKey).id;
    app.config.setUsers(desk, [alex.id]);

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await app?.close();
    cleanUp();
});

test("who is in charge of a computer reads its projects; anyone else gets 404", async () => {
    const here = `runners/${THIS_SERVER}/projects`;

    // In: the owner and a user who manages runners, on this server; a runner's linker, and a runner manager on one the
    // owner linked.
    for (const [by, path] of [
        [owner(app), here],
        [manager, here],
        [host, `runners/${laptop}/projects`],
        [manager, `runners/${desk}/projects`],
    ] as const) {
        const answer = await call<ProjectsView>(by, path);

        assert.equal(answer.status, 200, `${by.name} ${path}`);
        assert.ok(Array.isArray(answer.body.projects));
    }

    // Refused: a chosen user, a viewer, the owner on a runner someone else linked, a runner's manager on it, and a
    // computer that does not exist.
    for (const [by, path] of [
        [alex, here],
        [vera, here],
        [owner(app), `runners/${laptop}/projects`],
        [manager, `runners/${laptop}/projects`],
        [alex, `runners/${desk}/projects`],
        [owner(app), "runners/nowhere/projects"],
    ] as const) {
        assert.equal((await call(by, path)).status, 404, `${by.name} ${path}`);
    }
});

test("a project is a repository with its worktrees; a folder in no repository and an archived session are in none", async () => {
    const { body } = await call<ProjectsView>(owner(app), `runners/${THIS_SERVER}/projects`);

    assert.equal(body.defaultProjectTrust, "ask");
    assert.deepEqual(
        body.projects.map(({ root, name, folders }) => ({ root, name, folders })),
        [
            { root: alpha, name: "alpha", folders: [alpha, alphaSub, outside].sort() },
            { root: beta, name: "beta", folders: [beta] },
        ],
    );
    // Trust: the root first, then each folder outside it; nothing decided yet.
    assert.deepEqual(body.projects[0]!.trust, [
        { folder: alpha, parent: projects, trusted: false, saved: null },
        { folder: outside, parent: join(root, "worktrees"), trusted: false, saved: null },
    ]);
});

test("trust for 2 folders is 1 save; the folder above shows as 'through' on 2 projects; 'trust-parent' takes 1 folder", async () => {
    const path = `runners/${THIS_SERVER}/trust`;

    try {
        // Refused: anyone not in charge, and nothing is saved.
        for (const by of [alex, vera]) {
            const refused = await call(by, path, { folders: [alpha], choice: "trust" });

            assert.equal(refused.status, 404, by.name);
        }

        assert.equal(trustStore().get(alpha), null);

        // "trust-parent" with 2 folders, a folder with no folder above, a bad choice: 400.
        assert.equal(
            (await call(owner(app), path, { folders: [alpha, outside], choice: "trust-parent" }))
                .status,
            400,
        );
        assert.equal(
            (await call(owner(app), path, { folders: ["/"], choice: "trust-parent" })).status,
            400,
        );
        assert.equal(
            (await call(owner(app), path, { folders: [alpha], choice: "maybe" })).status,
            400,
        );

        // A project row: its root and the worktree outside it, in 1 call.
        const both = await call<ProjectsView>(owner(app), path, {
            folders: [alpha, outside],
            choice: "trust",
        });

        assert.equal(both.status, 200);
        assert.equal(trustStore().get(alpha), true);
        assert.equal(trustStore().get(outside), true);
        assert.deepEqual(
            both.body.projects[0]!.trust!.map((each) => each.saved),
            [
                { path: alpha, trusted: true },
                { path: outside, trusted: true },
            ],
        );

        // "Trust the folder above it" on alpha: the parent is trusted and alpha's own decision goes. Beta is in the
        // same parent: both show the decision "through" it.
        const parent = await call<ProjectsView>(owner(app), path, {
            folders: [alpha],
            choice: "trust-parent",
        });

        assert.deepEqual(trustStore().getEntry(projects), { path: projects, decision: true });
        // Alpha's own decision went: the nearest one is the parent's.
        assert.deepEqual(trustStore().getEntry(alpha), { path: projects, decision: true });
        assert.deepEqual(
            parent.body.projects.map((each) => each.trust![0]!.saved),
            [
                { path: projects, trusted: true },
                { path: projects, trusted: true },
            ],
        );

        // The worktree outside with another decision: the project is mixed.
        const mixed = await call<ProjectsView>(owner(app), path, {
            folders: [outside],
            choice: "distrust",
        });

        assert.deepEqual(
            mixed.body.projects[0]!.trust!.map((each) => each.trusted),
            [true, false],
        );
    } finally {
        trustStore().setMany(
            [projects, alpha, outside].map((each) => ({ path: each, decision: null })),
        );
    }
});

test("on a runner: 1 call for 2 folders is 1 write, and 'trust-parent' removes the folder's own decision", async () => {
    const path = `runners/${laptop}/trust`;
    const file = join(app.dataDir, TRUST_FILE);
    const write = trustFile.write;
    let writes = 0;

    trustFile.write = (dataDir, text) => {
        writes++;
        write(dataDir, text);
    };

    try {
        // Refused: the owner (Host linked it), a user chosen there, a viewer there.
        for (const by of [owner(app), alex, vera]) {
            assert.equal(
                (await call(by, path, { folders: ["/srv/app"], choice: "trust" })).status,
                404,
                by.name,
            );
        }

        assert.equal(writes, 0);

        assert.equal(
            (await call(host, path, { folders: ["/srv/app", "/data/wt/app-x"], choice: "trust" }))
                .status,
            200,
        );
        assert.equal(writes, 1);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
            [laptop]: { "/srv/app": true, "/data/wt/app-x": true },
        });

        assert.equal(
            (await call(host, path, { folders: ["/srv/app"], choice: "trust-parent" })).status,
            200,
        );
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
            [laptop]: { "/srv": true, "/data/wt/app-x": true },
        });
        assert.equal(
            (await call(host, path, { folders: ["/srv", "/data"], choice: "trust-parent" })).status,
            400,
        );
        assert.equal(
            (await call(host, path, { folders: ["relative"], choice: "trust" })).status,
            400,
        );
    } finally {
        trustFile.write = write;
        rmSync(file, { force: true });
    }
});

test("trust that cannot be saved: 409 for decisions that cannot be read, 500 with its cause for a failed write", async () => {
    const path = `runners/${laptop}/trust`;
    const file = join(app.dataDir, TRUST_FILE);
    const write = trustFile.write;

    try {
        // Decisions that cannot be read: 409, and nothing is written over them.
        writeFileSync(file, "{ not json");
        const unreadable = await call<{ error: string }>(host, path, {
            folders: ["/srv/app"],
            choice: "trust",
        });

        assert.equal(unreadable.status, 409);
        assert.match(unreadable.body.error, /cannot be read/);
        assert.equal(readFileSync(file, "utf8"), "{ not json");

        // A store that reads, and a write that fails: 500, with the write's own cause, not "cannot be read".
        rmSync(file, { force: true });

        trustFile.write = () => {
            throw new Error("ENOSPC: no space left on device");
        };

        const failed = await call<{ error: string }>(host, path, {
            folders: ["/srv/app"],
            choice: "trust",
        });

        assert.equal(failed.status, 500);
        assert.equal(
            failed.body.error,
            "The trust decision could not be saved: ENOSPC: no space left on device",
        );
        assert.doesNotMatch(failed.body.error, /cannot be read/);
    } finally {
        trustFile.write = write;
        rmSync(file, { force: true });
    }
});

test("trust set from the grid ends the request of a session that waits in a folder it covers", async () => {
    const id = betaSession;

    try {
        // Alex prompts in beta's session; the owner hears of it once.
        assert.deepEqual(app.askProjectTrust(id, alex), {
            waiting: true,
            by: "Owner",
            asked: true,
        });
        assert.equal(app.trustRequests.list(owner(app)).length, 1);

        // Not from someone who is not in charge: the request stands.
        assert.equal(
            (
                await call(alex, `runners/${THIS_SERVER}/trust`, {
                    folders: [projects],
                    choice: "trust",
                })
            ).status,
            404,
        );
        assert.equal(app.trustRequests.list(owner(app)).length, 1);

        // The owner trusts the folder above beta, from the grid: the request ends, and beta no longer waits.
        assert.equal(
            (
                await call(owner(app), `runners/${THIS_SERVER}/trust`, {
                    folders: [projects],
                    choice: "trust",
                })
            ).status,
            200,
        );
        assert.deepEqual(app.trustRequests.list(owner(app)), []);
        assert.deepEqual(app.trustFor(id, alex), { waiting: false, by: "Owner", asked: false });
    } finally {
        trustStore().setMany([{ path: projects, decision: null }]);
    }
});

test("someone who loses Manage runners while the projects are read gets 404, and no project names", async () => {
    const memory = app.memory;
    const project = memory.project;

    let began = (): void => {};

    const reading = new Promise<void>((resolve) => {
        began = resolve;
    });

    let release = (): void => {};

    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    memory.project = async function (...args: Parameters<typeof project>) {
        began();
        await gate;

        return project.apply(memory, args);
    } as typeof project;

    try {
        const answer = call<ProjectsView>(manager, `runners/${THIS_SERVER}/projects`);

        await reading;
        app.setRight(owner(app), { person: manager.id, right: "managesRunners", on: false });
        release();
        const { status, body } = await answer;

        assert.equal(status, 404, `answered: ${JSON.stringify(body).slice(0, 200)}`);
    } finally {
        Reflect.deleteProperty(memory, "project");
        release();
        app.setRight(owner(app), { person: manager.id, right: "managesRunners", on: true });
    }
});

test("Don't trust on a project row also ends the trust of a folder inside it that a session trusted", async () => {
    try {
        // A session in alpha/src was trusted from its own trust sheet: the same store.
        app.setFolderTrust(owner(app), THIS_SERVER, [alphaSub], "trust");
        assert.equal(trustStore().get(alphaSub), true);

        // The project's row lists that folder after its root and the worktree outside it: with nothing decided for the
        // root, the grid says Mixed, and not "Not decided".
        const before = await call<ProjectsView>(owner(app), `runners/${THIS_SERVER}/projects`);
        const listed = before.body.projects.find((each) => each.root === alpha)!.trust!;

        assert.deepEqual(
            listed.map((each) => [each.folder, each.trusted]),
            [
                [alpha, false],
                [outside, false],
                [alphaSub, true],
            ],
        );

        // The grid's project row sends every folder its row lists (`access-grid.js` `TrustMenu`).
        const answer = await call<ProjectsView>(owner(app), `runners/${THIS_SERVER}/trust`, {
            folders: listed.map((each) => each.folder),
            choice: "distrust",
        });

        assert.equal(answer.status, 200);
        const row = answer.body.projects.find((each) => each.root === alpha)!;

        assert.ok(
            row.trust!.every((each) => each.trusted === false),
            "the grid says Not trusted",
        );
        assert.equal(
            trustStore().get(alphaSub),
            false,
            "the session in alpha/src still loads the project's skills",
        );
    } finally {
        trustStore().setMany(
            [alpha, alphaSub, outside].map((each) => ({ path: each, decision: null })),
        );
    }
});
