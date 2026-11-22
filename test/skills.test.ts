// Pi's skills: the places a session finds them, which of a name wins, project trust, and that it matches Pi's CLI.
import {
    addPerson,
    type App,
    cleanUp,
    fakeTab,
    home,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
    DefaultResourceLoader,
    ProjectTrustStore,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createHandler } from "../src/server/http.ts";
import {
    loadSessionSkills,
    readProjectTrust,
    saveProjectTrust,
    type SkillSources,
    type TrustChoice,
} from "../src/server/skills.ts";
import type { TrustRequestView } from "../src/server/trust-requests.ts";

/** The system prompt of the newest request to Pi, its sections as JSON. */
let prompt = "";

const route: FauxResponseStep = (context) => {
    prompt = JSON.stringify(
        (context.messages as { role: string; sections?: Record<string, string> }[])
            .filter((message) => message.role === "system")
            .map((message) => message.sections ?? {}),
    );

    return fauxAssistantMessage([fauxText(`echo: ${lastText(context as never).text}`)]);
};

let app: App | undefined;

/** The app, opened by the first test that needs it. */
const started = async () =>
    (app ??= await openApp(scriptedModel(route), join(root, "skills-data")));

after(async () => {
    await app?.close();
    cleanUp();
});

/** A skill folder `name` in `folder`, described as `description`. */
function skill(folder: string, name: string, description = `The ${name} skill.`): void {
    mkdirSync(join(folder, name), { recursive: true });
    writeFileSync(
        join(folder, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\nThe steps of ${name}.\n`,
    );
}

/**
 * A home folder with Pi's folder in it, and a git repository in it whose session folder is `repo/app`. Skills in every
 * place: `.agents/skills` above the repository (never read), in it, and in the session's folder; the project's
 * `.pi/skills`; a folder named in Pi's settings; Pi's `skills/`; and the home folder's `.agents/skills`.
 */
function fixture() {
    const base = realpathSync(mkdtempSync(join(root, "skills-")));
    const own = join(base, "home");
    const agentDir = join(own, ".pi", "agent");
    const outside = join(own, "code");
    const repo = join(outside, "repo");
    const cwd = join(repo, "app");
    const extra = join(base, "extra");

    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    skill(join(outside, ".agents", "skills"), "outside");
    skill(join(repo, ".agents", "skills"), "repo-wide");
    skill(join(cwd, ".agents", "skills"), "here");
    skill(join(cwd, ".pi", "skills"), "pi-project");
    skill(extra, "from-settings");
    skill(join(agentDir, "skills"), "pi-user");
    skill(join(own, ".agents", "skills"), "everywhere");

    const sources: SkillSources = {
        agentDir,
        home: own,
        settingsPaths: [extra],
        defaultProjectTrust: "ask",
    };

    return { base, home: own, agentDir, repo, cwd, extra, sources };
}

const names = (cwd: string, sources: SkillSources) =>
    loadSessionSkills(cwd, sources)
        .map((each) => each.name)
        .sort();

test("a project's .agents/skills load only when Pi trusts the project", () => {
    const { agentDir, repo, cwd, sources } = fixture();
    const always: SkillSources = { ...sources, defaultProjectTrust: "always" };
    const never: SkillSources = { ...sources, defaultProjectTrust: "never" };
    const projectOnes = ["here", "repo-wide"];
    const has = (list: string[]) => projectOnes.every((name) => list.includes(name));
    const lacks = (list: string[]) => projectOnes.every((name) => !list.includes(name));

    // Nobody decided: Pi would ask, and Pi Pocket cannot. The rest still load.
    assert.ok(lacks(names(cwd, sources)));
    assert.deepEqual(names(cwd, sources), ["everywhere", "from-settings", "pi-project", "pi-user"]);
    assert.ok(has(names(cwd, always)), "defaultProjectTrust: always trusts an undecided project");
    assert.ok(lacks(names(cwd, never)));
    // Told no, as by defaultProjectTrust "never", its .pi/skills stay out too, as in Pi.
    assert.ok(!names(cwd, never).includes("pi-project"));

    // A decision for the repository counts for the folders in it, and wins over the default.
    new ProjectTrustStore(agentDir).set(repo, true);
    assert.ok(has(names(cwd, sources)));
    assert.ok(has(names(cwd, never)));
    new ProjectTrustStore(agentDir).set(cwd, false);
    assert.ok(lacks(names(cwd, always)), "the nearest decision wins");
    assert.ok(!names(cwd, always).includes("pi-project"), "a saved no keeps .pi/skills out too");
});

test("an unreadable trust store trusts no project", () => {
    const { agentDir, cwd, sources } = fixture();

    writeFileSync(join(agentDir, "trust.json"), "{ not json");
    assert.ok(!names(cwd, { ...sources, defaultProjectTrust: "always" }).includes("here"));
});

test("a skill linked into two places is listed once", () => {
    const { home: own, agentDir, cwd, sources } = fixture();

    // As Omarchy installs its skills: links in both ~/.pi/agent/skills and ~/.agents/skills to one folder.
    skill(join(own, "shared-skills"), "linked");
    symlinkSync(join(own, "shared-skills", "linked"), join(agentDir, "skills", "linked"));
    symlinkSync(join(own, "shared-skills", "linked"), join(own, ".agents", "skills", "linked"));
    assert.equal(names(cwd, sources).filter((name) => name === "linked").length, 1);
});

/** The skills Pi's CLI loads in `cwd`: its resource loader, with `home` as the home folder. */
async function cliSkills(cwd: string, home: string, agentDir: string, trusted: boolean) {
    const before = process.env.HOME;

    process.env.HOME = home;

    try {
        const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
        const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });

        await loader.reload();

        return loader.getSkills().skills;
    } finally {
        if (before === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = before;
        }
    }
}

test("a session has the skills Pi's CLI has in the same folder, the same one of each name", async () => {
    const { home: own, agentDir, repo, cwd, extra, sources } = fixture();
    const found = (skills: { name: string; filePath: string }[]) =>
        skills
            .map(({ name, filePath }) => ({ name, filePath }))
            .sort((a, b) => a.name.localeCompare(b.name));

    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [extra] }));
    // Names in several places, so the comparison covers which one wins.
    skill(join(own, ".agents", "skills"), "pi-user", "The home folder's, shadowed by Pi's own.");
    skill(join(agentDir, "skills"), "from-settings", "Pi's folder's, shadowed by the settings'.");
    skill(join(repo, ".agents", "skills"), "here", "The repository's, shadowed by the nearer one.");
    skill(join(cwd, ".agents", "skills"), "pi-project", "Shadowed by the project's .pi/skills.");

    // Untrusted, the CLI skips the project's .pi/skills too, which Pi Pocket keeps: compare without it.
    const untrusted = loadSessionSkills(cwd, sources).filter((each) => each.name !== "pi-project");

    assert.deepEqual(found(untrusted), found(await cliSkills(cwd, own, agentDir, false)));
    new ProjectTrustStore(agentDir).set(cwd, true);
    assert.deepEqual(
        found(loadSessionSkills(cwd, sources)),
        found(await cliSkills(cwd, own, agentDir, true)),
    );
    // Told not to trust it: exactly the CLI's, .pi/skills left out as well.
    new ProjectTrustStore(agentDir).set(cwd, false);
    assert.deepEqual(
        found(loadSessionSkills(cwd, sources)),
        found(await cliSkills(cwd, own, agentDir, false)),
    );
});

test("the skills setting's exclusions, inclusions, and relative paths work as in Pi's CLI", async () => {
    const { base, home: own, agentDir, cwd, sources } = fixture();
    const [theirs, mine, plus] = ["theirs", "mine", "plus"].map((name) => join(base, name)) as [
        string,
        string,
        string,
    ];
    const found = (skills: { name: string; filePath: string }[]) =>
        skills
            .map(({ name, filePath }) => ({ name, filePath }))
            .filter((each) => each.name !== "pi-project")
            .sort((a, b) => a.name.localeCompare(b.name));

    skill(theirs, "teach", "Theirs, taken out by -path.");
    skill(mine, "teach", "Mine.");
    skill(plus, "off");
    skill(plus, "back");
    skill(join(agentDir, "relative"), "from-agent-dir");
    skill(join(agentDir, "skills"), "auto-off");

    const settingsPaths = [
        theirs,
        mine,
        plus,
        "relative",
        `-${join(theirs, "teach")}`,
        "!**/plus/**",
        `+${join(plus, "back")}`,
        "!**/skills/auto-off/**",
        `-${join(own, ".agents", "skills", "everywhere", "SKILL.md")}`,
    ];

    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: settingsPaths }));

    const ours = found(loadSessionSkills(cwd, { ...sources, settingsPaths }));

    assert.deepEqual(ours, found(await cliSkills(cwd, own, agentDir, false)));
    assert.deepEqual(
        ours
            .map((each) => each.name)
            .filter((name) => !["pi-user", "from-settings"].includes(name)),
        ["back", "from-agent-dir", "teach"],
    );
});

test("a session lists them as /skill: commands and in its system prompt", async () => {
    const project = realpathSync(mkdtempSync(join(root, "skills-project-")));

    mkdirSync(join(project, ".git"));
    skill(join(home, ".agents", "skills"), "everywhere");
    skill(join(project, ".agents", "skills"), "here");
    new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR!).set(project, true);
    const app = await started();
    const id = await newSession(app, project);

    assert.deepEqual(
        app
            .skillCommands(id)
            .map((each) => each.name)
            .sort(),
        ["everywhere", "here"],
    );
    await say(app, id, "hello");
    assert.match(prompt, /- everywhere: The everywhere skill\./);
    assert.match(prompt, /- here: The here skill\./);
    // The prompt is JSON here, so a Windows path is in it with each backslash doubled.
    assert.ok(
        prompt.includes(
            JSON.stringify(join(project, ".agents", "skills", "<name>", "SKILL.md")).slice(1, -1),
        ),
    );
    await say(app, id, "/skill:here do the thing");
    assert.match((await modelTexts(app, id)).join("\n"), /<skill name=\\"here\\" location=/);
});

/** Pi's own answers to "trust this project?", from the CLI's code (the package does not export it). */
async function piTrustOptions(cwd: string) {
    const index = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const manager = (await import(
        pathToFileURL(join(dirname(index), "core", "trust-manager.js")).href
    )) as {
        getProjectTrustOptions: (cwd: string) => {
            label: string;
            updates: { path: string; decision: boolean | null }[];
        }[];
    };

    return manager.getProjectTrustOptions(cwd);
}

test("each answer saves what Pi's /trust saves, and decides which skills load", async () => {
    const { cwd, sources } = fixture();
    const options = await piTrustOptions(cwd);
    const piLabel: Record<TrustChoice, (label: string) => boolean> = {
        trust: (label) => label === "Trust",
        "trust-parent": (label) => label.startsWith("Trust parent folder"),
        distrust: (label) => label === "Do not trust",
    };
    const has = (agentDir: string) =>
        loadSessionSkills(cwd, { ...sources, agentDir }).some((each) => each.name === "here");

    for (const choice of ["trust", "trust-parent", "distrust"] as const) {
        // Both stores start with decisions for this folder and the one above it, which an answer may replace.
        const ours = realpathSync(mkdtempSync(join(root, "trust-ours-")));
        const pis = realpathSync(mkdtempSync(join(root, "trust-pi-")));
        const before = [
            { path: cwd, decision: false },
            { path: dirname(cwd), decision: false },
        ];

        new ProjectTrustStore(ours).setMany(before);
        new ProjectTrustStore(pis).setMany(before);
        saveProjectTrust(cwd, ours, choice);
        new ProjectTrustStore(pis).setMany(
            options.find((option) => piLabel[choice](option.label))!.updates,
        );
        assert.equal(
            readFileSync(join(ours, "trust.json"), "utf8"),
            readFileSync(join(pis, "trust.json"), "utf8"),
            choice,
        );
        assert.equal(has(ours), choice !== "distrust", choice);
        assert.equal(readProjectTrust(cwd, { ...sources, agentDir: ours }).ask, false);
    }
});

test("a folder reached through a link is trusted as the folder it is", () => {
    const { base, agentDir, repo, cwd, sources } = fixture();
    const link = join(base, "link");

    symlinkSync(cwd, link);
    assert.equal(readProjectTrust(link, sources).folder, cwd);
    saveProjectTrust(link, agentDir, "trust");
    assert.deepEqual(readProjectTrust(cwd, sources).saved, { path: cwd, trusted: true });
    assert.ok(names(link, sources).includes("here"));
    // The folder above is the real one's, not the link's.
    assert.equal(readProjectTrust(link, sources).parent, repo);
    saveProjectTrust(link, agentDir, "trust-parent");
    assert.deepEqual(readProjectTrust(cwd, sources).saved, { path: repo, trusted: true });
});

test("who is in charge answers through the API, anyone else learns only that it waits, and Pi has the skills from its next message", async () => {
    const app = await started();
    const project = realpathSync(mkdtempSync(join(root, "skills-asking-")));

    mkdirSync(join(project, ".git"));
    skill(join(project, ".agents", "skills"), "waiting");
    const id = await newSession(app, project);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const guest = await addPerson(app, "Guest", "guest");
    const call = (token: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/c/${id}/trust`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    try {
        await say(app, id, "first");
        assert.doesNotMatch(prompt, /- waiting: The waiting skill\./);
        assert.ok(!app.skillCommands(id).some((each) => each.name === "waiting"));

        const asked = await call(app.config.ownerToken);

        assert.equal(asked.status, 200);
        assert.equal(((await asked.json()) as { ask: boolean }).ask, true);
        // Someone who sees the session and is not in charge of its computer: that it waits and for whom, and nothing of
        // the project (its skills may be in folders above the one they were given).
        const waits = await call(guest.token);

        assert.equal(waits.status, 200);
        assert.deepEqual(await waits.json(), { waiting: true, by: "Owner", asked: false });

        const refused = await call(guest.token, { choice: "trust" });

        assert.equal(refused.status, 403);
        assert.match(
            ((await refused.json()) as { error: string }).error,
            /^Only Owner, who is in charge of this server, decides which projects Pi trusts there\.$/,
        );
        assert.equal((await call(app.config.ownerToken, { choice: "maybe" })).status, 400);
        assert.equal(new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR!).get(project), null);

        const answered = await call(app.config.ownerToken, { choice: "trust" });

        assert.equal(answered.status, 200);
        assert.deepEqual(
            [(await answered.json()) as { trusted: boolean; ask: boolean }].map(
                ({ trusted, ask }) => ({ trusted, ask }),
            ),
            [{ trusted: true, ask: false }],
        );
        assert.equal(new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR!).get(project), true);
        assert.ok(app.skillCommands(id).some((each) => each.name === "waiting"));
        // At once, not when the prompt's copy of the skills grows stale.
        await say(app, id, "second");
        assert.match(prompt, /- waiting: The waiting skill\./);
        assert.deepEqual(await (await call(guest.token)).json(), {
            waiting: false,
            by: "Owner",
            asked: false,
        });
    } finally {
        server.closeAllConnections();
        server.close();
        app.config.removeUser(guest.user.id);
    }
});

test("someone who prompts in a session whose project waits tells who is in charge, once; they decide in the session or put it away", async () => {
    const app = await started();
    const projects = ["skills-told-", "skills-put-away-"].map((prefix) =>
        realpathSync(mkdtempSync(join(root, prefix))),
    );

    for (const project of projects) {
        mkdirSync(join(project, ".git"));
        skill(join(project, ".agents", "skills"), "waiting");
    }

    const first = await newSession(app, projects[0]);
    const second = await newSession(app, projects[1]);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    // Both see the two sessions; only Gale prompts.
    const gale = await addPerson(app, "Gale", "guest");
    const vera = await addPerson(app, "Vera", "viewer");
    const call = (token: string, path: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const ownerTab = fakeTab(undefined, owner(app));
    const galeTab = fakeTab(undefined, gale.user);
    const heard = (tab: typeof ownerTab) =>
        tab.events
            .filter((each) => each.event === "trust-requests")
            .map((each) => each.data as unknown as TrustRequestView[]);

    await app.attach(ownerTab.client);
    await app.attach(galeTab.client);

    try {
        // A viewer reads that it waits, and tells no one: they make Pi do nothing here.
        assert.deepEqual(await (await call(vera.token, `c/${first}/trust`)).json(), {
            waiting: true,
            by: "Owner",
            asked: false,
        });
        assert.equal((await call(vera.token, `c/${first}/trust`, { ask: true })).status, 403);
        // A read tells no one either.
        assert.deepEqual(app.trustRequests.list(owner(app)), []);

        const told = await call(gale.token, `c/${first}/trust`, { ask: true });

        assert.equal(told.status, 200);
        assert.deepEqual(await told.json(), { waiting: true, by: "Owner", asked: true });
        // Again, and from the owner's own tab: the one request stands.
        await call(gale.token, `c/${first}/trust`, { ask: true });
        await call(app.config.ownerToken, `c/${first}/trust`, { ask: true });

        const [request, ...more] = app.trustRequests.list(owner(app));

        assert.deepEqual(more, []);
        assert.deepEqual(
            { ...request, id: "" },
            {
                id: "",
                computer: "this-server",
                computerName: "this server",
                folder: projects[0],
                session: String(first),
                title: app.sessionMeta(first)?.title ?? "New session",
                person: gale.user.id,
                name: "Gale",
            },
        );
        // Only who is in charge is shown it: in the welcome of a new tab, and in the open ones.
        assert.deepEqual(
            (await app.hello(owner(app))).trustRequests.map((each) => each.id),
            [request!.id],
        );
        assert.deepEqual((await app.hello(gale.user)).trustRequests, []);
        assert.deepEqual(heard(ownerTab).at(-1), [request]);
        assert.deepEqual(heard(galeTab).at(-1), [], "told that something changed, shown nothing");
        assert.equal(
            (await call(gale.token, `trust-requests/${request!.id}`, { dismiss: true })).status,
            404,
        );

        // Decided in the session: the request ends, and the tab that waited hears, to read its trust again.
        const before = heard(galeTab).length;

        assert.equal(
            (await call(app.config.ownerToken, `c/${first}/trust`, { choice: "distrust" })).status,
            200,
        );
        assert.deepEqual(app.trustRequests.list(owner(app)), []);
        assert.ok(heard(galeTab).length > before);
        assert.deepEqual(await (await call(gale.token, `c/${first}/trust`)).json(), {
            waiting: false,
            by: "Owner",
            asked: false,
        });

        // Put away without deciding: the project still waits, and who is in charge is not asked again.
        await call(gale.token, `c/${second}/trust`, { ask: true });

        const [other] = app.trustRequests.list(owner(app));

        assert.equal(other?.folder, projects[1]);
        assert.equal(
            (await call(app.config.ownerToken, `trust-requests/${other!.id}`, { nothing: true }))
                .status,
            400,
        );
        assert.equal(
            (await call(app.config.ownerToken, `trust-requests/${other!.id}`, { dismiss: true }))
                .status,
            200,
        );
        assert.deepEqual(app.trustRequests.list(owner(app)), []);
        assert.deepEqual(
            await (await call(gale.token, `c/${second}/trust`, { ask: true })).json(),
            { waiting: true, by: "Owner", asked: true },
        );
        assert.deepEqual(app.trustRequests.list(owner(app)), []);

        // The asker is made a viewer: a request of theirs ends with their prompting, and may be asked again by another.
        const third = realpathSync(mkdtempSync(join(root, "skills-no-longer-")));

        mkdirSync(join(third, ".git"));
        skill(join(third, ".agents", "skills"), "waiting");

        // Started after Gale was added: new sessions here are shared with the people chosen (`addPerson`).
        const last = await newSession(app, third);

        assert.equal(
            (await call(gale.token, `c/${last}/trust`, { ask: true })).status,
            200,
            "Gale sees the new session",
        );
        assert.equal(app.trustRequests.list(owner(app))[0]?.folder, third);
        app.setAccess(owner(app), gale.user.id, { role: "viewer" });
        assert.deepEqual(app.trustRequests.list(owner(app)), []);
        assert.equal(app.trustRequests.asked("this-server", third), false);
    } finally {
        app.detach(ownerTab.client);
        app.detach(galeTab.client);
        server.closeAllConnections();
        server.close();
        app.config.removeUser(gale.user.id);
        app.config.removeUser(vera.user.id);
    }
});

test("the app reads Pi's settings: its default trust, and its skill paths", async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const project = realpathSync(mkdtempSync(join(root, "skills-settings-")));
    const extra = realpathSync(mkdtempSync(join(root, "skills-settings-extra-")));

    mkdirSync(join(project, ".git"));
    skill(join(project, ".agents", "skills"), "by-default");
    skill(extra, "from-pi-settings");
    writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProjectTrust: "always", skills: [extra] }),
    );
    // Opened after the settings are written: an app reads Pi's settings when it opens.
    const other = await openApp(scriptedModel(route), join(root, "skills-settings-data"));

    try {
        const id = await newSession(other, project);
        const commands = other.skillCommands(id).map((each) => each.name);

        assert.ok(commands.includes("by-default"), "trusted by defaultProjectTrust");
        assert.ok(commands.includes("from-pi-settings"), "found through Pi's skill paths");
        assert.deepEqual(
            [other.projectTrust(id, owner(other))].map(({ trusted, ask }) => ({ trusted, ask })),
            [{ trusted: true, ask: false }],
        );
    } finally {
        await other.close();
        rmSync(join(agentDir, "settings.json"), { force: true });
    }
});

test("a project told Don't trust offers none of its own .pi/prompts, as it loads none of its .pi/skills", async () => {
    const on = await started();
    const folder = realpathSync(mkdtempSync(join(root, "prompts-trust-")));

    mkdirSync(join(folder, ".git"));
    mkdirSync(join(folder, ".pi", "prompts"), { recursive: true });
    writeFileSync(join(folder, ".pi", "prompts", "release-notes.md"), "Write the release notes.\n");
    const id = await newSession(on, folder);
    const offered = () => on.promptTemplates(id).map((each) => each.name);

    assert.ok(offered().includes("release-notes"), "undecided: offered, as before");
    on.setProjectTrust(id, owner(on), "distrust");
    assert.ok(!offered().includes("release-notes"), "Don't trust: not offered");
    on.setProjectTrust(id, owner(on), "trust");
    assert.ok(offered().includes("release-notes"), "trusted: offered");
});
