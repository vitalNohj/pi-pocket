/**
 * A throwaway Pi Pocket for checking a change by hand: the code in this folder, a data folder of its own (a temporary
 * one, deleted on exit), and a scripted model that answers "echo: …" and costs nothing; a message "run: COMMAND" makes it
 * call bash with COMMAND; `call: TOOL JSON` calls another tool with those arguments. It says what the tool said.
 * It prints sign-in links for an owner and a guest, and takes
 * runners (`pi-pocket runner`) as the real server does. Web files and extension modules reload as they do in the real server; other server changes
 * need this process restarted.
 *
 *   node test/serve.ts [port] [host]     (defaults: 8899 and 127.0.0.2)
 *
 * The default host is its own loopback address: browsers keep cookies per host, not per port, so signing in here
 * does not sign a browser out of a Pi Pocket on 127.0.0.1 or localhost.
 */
// helpers.ts first: it points Pi's folder at a temporary one before anything from src/ loads.
import {
    addPerson,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import { newIdentity } from "../src/server/runner-link/secure-link.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { APP_ROOT } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { watchTree } from "../src/server/reload.ts";

const port = Number(process.argv[2] ?? 8899);
const host = process.argv[3] ?? "127.0.0.2";
const app = await openApp(
    scriptedModel((context) => {
        const { role, text } = lastText(context as never);
        const command = /(?:^|] )run: ([\s\S]+)/.exec(text)?.[1];
        const tool = /(?:^|] )call: (\w+) ([\s\S]+)/.exec(text);

        if (role === "toolResult") {
            return fauxAssistantMessage([fauxText(`tool said:\n${text}`)]);
        }

        if (role === "user" && tool !== null) {
            return fauxAssistantMessage([fauxToolCall(tool[1]!, JSON.parse(tool[2]!))], {
                stopReason: "toolUse",
            });
        }

        return role === "user" && command !== undefined
            ? fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" })
            : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    }),
);

// PI_POCKET_TEST_LINK_BAN=<address>: start with that address banned from linking, as its third lockout leaves it, to
// look at the Runners sheet's ban list.
if (process.env.PI_POCKET_TEST_LINK_BAN) {
    app.config.runnerLinkLimits = {
        blocks: [],
        bans: [{ address: process.env.PI_POCKET_TEST_LINK_BAN, since: Date.now() - 3_600_000 }],
    };
}

const server = createServer(createHandler({ app, listen: { host, port }, restart: () => {} }));

// Runners (`pi-pocket runner`), as `src/server/main.ts` takes them.
server.on("upgrade", (request, socket, head) => {
    if (!app.runners.upgrade(request, socket, head)) {
        socket.destroy();
    }
});
const stopWatching = watchTree(join(APP_ROOT, "web"), (file) => app.reloadClients(file));

// Extension modules reload when saved, as in the real server (`app.close()` stops this).
app.loader.watch();
// Theme folders too.
app.themes.watch();

await new Promise<void>((resolve) => server.listen(port, host, resolve));
// Something to look at: a session with one exchange in it.
const session = await newSession(app);

await say(app, session, "Hello from the copy");
const guest = await addPerson(app, "Guest", "guest");
const base = `http://${host}:${port}`;

// PI_POCKET_TEST_PEOPLE=1: more people, as invites leave them, and a linked computer that is not connected, to look at
// the People sheet and the Runners sheet: a viewer nobody chose yet, someone invited to that one session, and a
// computer the guest linked, which the owner only reads.
if (process.env.PI_POCKET_TEST_PEOPLE) {
    const viewer = app.config.addUser("Vera", "viewer");
    const one = app.config.addUser("Sam", "viewer", [String(session)]);
    const first = app.config.users.find((each) => each.role === "owner");

    app.config.addRunner("Laptop", first?.id ?? "", newIdentity().publicKey);
    app.config.addRunner("Guest's desktop", guest.user.id, newIdentity().publicKey);
    console.log(`  viewer, not chosen: ${base}/login?token=${encodeURIComponent(viewer.token)}`);
    console.log(`  invited to one session: ${base}/login?token=${encodeURIComponent(one.token)}`);
}

// PI_POCKET_TEST_WORK=1: a repository with two worktrees, and sessions that worked in them, to look at the Work map.
if (process.env.PI_POCKET_TEST_WORK) {
    const repo = join(root, "shop");
    const run = (cwd: string, ...args: string[]) =>
        execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
            cwd,
        });

    mkdirSync(repo, { recursive: true });
    run(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "cart.ts"), "export {};\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-qm", "Start the shop");
    run(repo, "worktree", "add", "-q", join(root, "shop-checkout"), "-b", "feat/checkout");
    run(repo, "worktree", "add", "-q", join(root, "shop-search"), "-b", "feat/search");
    writeFileSync(join(root, "shop-checkout", "pay.ts"), "export {};\n");
    run(join(root, "shop-checkout"), "add", "-A");
    run(join(root, "shop-checkout"), "commit", "-qm", "Pay at checkout");
    writeFileSync(join(root, "shop-search", "draft.md"), "wip\n");

    for (const [title, folder, steps] of [
        ["Checkout flow", "shop-checkout", ["edit pay.ts", "read cart.ts in main"]],
        ["Search box", "shop-search", ["edit draft.md", "read pay.ts in checkout"]],
        ["Shop review", "shop", ["read cart.ts"]],
    ] as const) {
        const id = await newSession(app, join(root, folder));

        await app.commands.updateSession(id, owner(app), { title });

        for (const step of steps) {
            const target = step.endsWith("in main")
                ? join(repo, "cart.ts")
                : step.endsWith("in checkout")
                  ? join(root, "shop-checkout", "pay.ts")
                  : join(root, folder, step.split(" ")[1]!);

            await say(
                app,
                id,
                step.startsWith("edit")
                    ? `call: write ${JSON.stringify({ path: target, content: "changed\n" })}`
                    : `call: read ${JSON.stringify({ path: target })}`,
            );
        }
    }
}

console.log(`A copy of Pi Pocket, with its own data in ${root}`);
console.log(`  owner: ${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
console.log(`  guest: ${base}/login?token=${encodeURIComponent(guest.token)}`);
console.log(`Ctrl+C, or kill ${process.pid}, stops it and deletes its data.`);

const stop = async () => {
    stopWatching();
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
    process.exit(0);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
