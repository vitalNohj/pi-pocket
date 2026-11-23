// The work map: which sessions worked in which git worktrees, from the paths in their tool calls, for the owner only.
import {
    addPerson,
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";

const repo = join(root, "shop");
const checkout = join(root, "shop-checkout");
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
        cwd,
        encoding: "utf8",
    });

/** `write PATH` writes a file, `read PATH` reads one, `run COMMAND` runs it; a tool's result ends the turn. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const [verb, rest = ""] = text.replace(/^\[[^\]]*\] /, "").split(/ (.*)/s);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    if (verb === "write") {
        return fauxAssistantMessage([fauxToolCall("write", { path: rest, content: "x\n" })], {
            stopReason: "toolUse",
        });
    }

    if (verb === "read") {
        return fauxAssistantMessage([fauxToolCall("read", { path: rest })], {
            stopReason: "toolUse",
        });
    }

    if (verb === "run") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: rest })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;

before(async () => {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "cart.ts"), "export {};\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "Start");
    git(repo, "worktree", "add", "-q", checkout, "-b", "feat/checkout");
    writeFileSync(join(checkout, "pay.ts"), "export {};\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "-qm", "Pay");
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a session is on the map in each worktree it read or changed, with the repository's git facts", async () => {
    const writer = await newSession(app, checkout);
    const reader = await newSession(app, root);

    await say(app, writer, `write ${join(checkout, "pay.ts")}`);
    await say(app, writer, `read ${join(repo, "cart.ts")}`);
    await say(app, reader, `run ls ${join(checkout, "pay.ts")}`);
    // A relative path is in the session's own folder.
    await say(app, writer, "read pay.ts");

    const map = await app.workMaps.map();
    const shop = map.repos.find((each) => each.main === realpathSync(repo));

    assert.ok(shop, "the repository is on the map");
    assert.equal(shop.base, "main");
    assert.deepEqual(
        shop.worktrees.map((wt) => [wt.branch, wt.isMain, wt.ahead, wt.behind]),
        [
            ["main", true, 0, 0],
            ["feat/checkout", false, 1, 0],
        ],
    );

    const touches = (id: number) =>
        Object.fromEntries(
            map.sessions
                .find((session) => session.id === id)!
                .touches.map((touch) => [touch.wt, [touch.r, touch.w]]),
        );

    assert.deepEqual(touches(Number(writer)), {
        [realpathSync(checkout)]: [1, 1],
        [realpathSync(repo)]: [1, 0],
    });
    assert.deepEqual(touches(Number(reader)), { [realpathSync(checkout)]: [1, 0] });

    // Only what came since is read again.
    await say(app, reader, `run rm ${join(checkout, "pay.ts")}`);
    const again = await app.workMaps.map();
    const reread = again.sessions.find((session) => session.id === Number(reader))!;

    assert.deepEqual(
        reread.touches.map((touch) => [touch.r, touch.w]),
        [[1, 1]],
    );
});

test("only the owner may see the map", async () => {
    const guest = await addPerson(app, "Guest", "guest");
    const base = `http://127.0.0.1`;
    const { createHandler } = await import("../src/server/http.ts");
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    const ask = async (token: string) => {
        const { createServer } = await import("node:http");
        const server = createServer(handler);

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

        try {
            const port = (server.address() as { port: number }).port;
            const login = await fetch(`${base}:${port}/login?token=${encodeURIComponent(token)}`, {
                redirect: "manual",
            });
            const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

            return (await fetch(`${base}:${port}/api/work-map`, { headers: { cookie } })).status;
        } finally {
            server.closeAllConnections();
            server.close();
        }
    };

    assert.equal(await ask(app.config.ownerToken), 200);
    assert.equal(await ask(guest.token), 403);
});
