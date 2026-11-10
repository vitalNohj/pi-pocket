// What the server tests share: an isolated Pi install and data folder, a scripted model, and small helpers. Import
// this before anything from src/: it points Pi's config at a temporary folder first.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import type { Attachment } from "../src/server/commands.ts";
import type { User } from "../src/server/config.ts";
import type { FolderRequestView } from "../src/server/folder-requests.ts";
import type { LimitTuning } from "../src/server/limit-gate.ts";
import { STEP_MS, totp } from "../src/server/totp.ts";
import type { Client } from "../src/server/room.ts";

export const context = BACKGROUND_CONTEXT;

export const root = mkdtempSync(join(tmpdir(), "pi-pocket-test-"));
// Isolate from the real Pi install: its auth, settings, skills, and Lancet Guard.
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_POCKET_GUARD = "off";
// And from the real data folder, for code that reads its default rather than the app's own `dataDir`.
process.env.PI_POCKET_DIR = join(root, "pocket");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
/** The folder test sessions work in. */
export const work = join(root, "work");
mkdirSync(work);
/**
 * The home folder the app finds `~/.agents/skills` in, for the same isolation. Beside `root`, not in it: a folder above
 * home is too broad to save (`broadFolder`), and `addPerson` saves `root`.
 */
export const home = mkdtempSync(join(tmpdir(), "pi-pocket-test-home-"));

const { PocketApp } = await import("../src/server/app.ts");
const { SessionsDoc } = await import("../src/server/docs.ts");

export type App = Awaited<ReturnType<typeof PocketApp.open>>;

/** The text of the newest message a model request carries, and who sent it. */
export function lastText(context: { messages: readonly { role: string; content: unknown }[] }): {
    role: string;
    text: string;
} {
    const last = context.messages.findLast((message) => message.role !== "system")!;
    const content =
        typeof last.content === "string"
            ? [{ type: "text", text: last.content }]
            : (last.content as { type: string; text?: string }[]);

    return {
        role: last.role,
        text: content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join(""),
    };
}

/** Echoes the last message: enough for tests that do not care what Pi says. */
export const echo: FauxResponseStep = (context) =>
    fauxAssistantMessage([fauxText(`echo: ${lastText(context as never).text}`)]);

/** A scripted provider, "faux", that answers every request with `route`. */
export function scriptedModel(route: FauxResponseStep = echo) {
    const faux = fauxProvider({
        tokensPerSecond: 2000,
        models: [
            { id: "faux-1" },
            { id: "faux-2" },
            { id: "faux-vision", input: ["text", "image"] },
            { id: "faux-native" },
        ],
    });

    // A model whose provider takes tool changes in the messages, as Claude 4.8 and 5 and later do.
    Object.assign(faux.getModel("faux-native")!, {
        compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
    });

    // Plenty: a test file of many subagents (each of whose turns takes one) used 200 up.
    faux.setResponses(Array.from({ length: 1000 }, () => route));

    return faux;
}

/** Open the app on `dataDir` with the scripted model. Opening the same folder again is a restart; `now` moves its clock. */
/**
 * Open the app for a test. The owner is never asked for an approval (`config.ts` `approvalDays` 0), so tests of
 * something else start sessions on runners without waiting; tests of approvals set the time they need.
 */
export async function openApp(
    model: ReturnType<typeof scriptedModel>,
    dataDir = join(root, "data"),
    now?: () => number,
    limits?: Partial<LimitTuning>,
): Promise<App> {
    const app = await PocketApp.open({
        dataDir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(model.provider),
        home,
        ...(now === undefined ? {} : { now }),
        ...(limits === undefined ? {} : { limits }),
    });
    const first = app.config.users.find((each) => each.role === "owner");

    if (first !== undefined && first.approvalDays === undefined) {
        app.config.updateUser(first.id, { approvalDays: 0 });
    }

    return app;
}

/**
 * For tests of something else than approvals: once `addPerson` added someone, a request of anyone whose approval time is
 * "never" (as `addPerson` sets) is allowed by the owner at once, as if they tapped Allow.
 */
const allowing = new WeakSet<App>();

function allowNeverAsked(app: App): void {
    if (allowing.has(app)) {
        return;
    }

    allowing.add(app);

    const ask = app.folderRequests.ask.bind(app.folderRequests);

    app.folderRequests.ask = (person, question, signal, code) => {
        const asked = ask(person, question, signal, code);
        const current = app.config.userById(person.id);

        if (current?.approvalDays === 0 && current.role !== "owner") {
            const request = app.folderRequests
                .list(owner(app))
                .findLast((each) => each.person === person.id);

            if (request !== undefined) {
                void app.folderRequests
                    .approve(owner(app), request.id, { method: "owner" })
                    .catch(() => {});
            }
        }

        return asked;
    };
}

/** Wait until `check` holds, polling. */
export async function until(
    check: () => Promise<boolean> | boolean,
    what: string,
    timeoutMs = 10_000,
): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

/** Record `dollars` more of model usage in a conversation, the way a model response does: the scripted model costs nothing. */
export async function recordCost(app: App, id: ConversationId, dollars: number): Promise<void> {
    await app.harness.commit(async (tx) => {
        const usage = await tx.doc(UsageDoc, id);

        usage.models["faux/faux-1"] ??= {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        usage.models["faux/faux-1"].cost.output += dollars;
        usage.models["faux/faux-1"].cost.total += dollars;
    }, context);
}

export const owner = (app: App) => app.config.users.find((user) => user.role === "owner")!;

/**
 * Answer folder requests (`folder-requests.ts`) as they come, in the owner's name: `answer` says yes (true), no
 * (false), or leaves it waiting (undefined). Each request is kept in `asked`. Returns a stop function.
 */
export function answerRequests(
    app: App,
    answer: (request: FolderRequestView) => boolean | undefined,
    asked: FolderRequestView[] = [],
): () => void {
    const seen = new Set<string>();
    const timer = setInterval(() => {
        for (const request of app.folderRequests.list(owner(app))) {
            if (seen.has(request.id)) {
                continue;
            }

            seen.add(request.id);
            asked.push(request);

            const yes = answer(request);

            if (yes === true) {
                void app.folderRequests
                    .approve(owner(app), request.id, { method: "owner" })
                    .catch(() => {});
            } else if (yes === false) {
                app.folderRequests.deny(owner(app), request.id);
            }
        }
    }, 10);

    return () => clearInterval(timer);
}

/**
 * Approve session `id` (`folder-approvals.ts`) as who is in charge would with Allow: for tests of something else than
 * approvals, where a person who is not in charge then steers it. It never ends: its last user's time is "never".
 */
export function approveSession(
    app: App,
    id: ConversationId,
    user: Pick<User, "id"> = owner(app),
): void {
    const root = String(app.rootOf(id));

    app.folderApprovals.approve(
        root,
        { computer: app.runnerOf(id) ?? "this-server", folder: app.cwdOf(id) },
        "owner",
        owner(app).id,
        user,
    );
}

/**
 * Link an authenticator to `person`'s account, as they would under their name (`approval-methods.ts`): steering needs
 * one. Returns its secret, for codes.
 */
export function linkAuthenticator(app: App, person: Pick<User, "id" | "name">): string {
    const { secret } = app.authenticators.begin(person.id, person.name);

    app.authenticators.confirm(person.id, totp(secret, Math.floor(app.now() / STEP_MS)));

    return secret;
}

/**
 * Add a person with what everyone with access to the whole server had before the access policy (`access.ts`): chosen
 * for this server, with every session here shared with them, the ones there are now and the ones started later, the test
 * folder given to them, and approvals that never end once used by them (approval time "never"): every session here gets
 * a live approval as they use it (`approveSession` for one that has none). A person invited to `sessions` gets only
 * those, as `addUser` gives. For tests of something else than who may see what; the policy's own tests choose, share,
 * and approve by hand.
 */
export async function addPerson(
    app: App,
    name: string,
    role: User["role"],
    sessions?: string[],
): Promise<{ user: User; token: string }> {
    const added = app.config.addUser(name, role, sessions);

    if (sessions !== undefined || role === "owner") {
        return added;
    }

    app.config.setServerUsers([...(app.config.server.users ?? []), added.user.id]);
    app.config.setComputerSettings(undefined, { shareNew: true });
    app.config.setGivenFolders(undefined, added.user.id, [realpathSync(root)]);
    app.config.updateUser(added.user.id, { approvalDays: 0 });
    allowNeverAsked(app);

    const shared: string[] = [];

    await app.harness.commit(async (tx) => {
        for (const [id, meta] of Object.entries((await tx.doc(SessionsDoc)).items)) {
            if (meta.pip === undefined && meta.runner === undefined) {
                meta.sharedWith = [...new Set([...(meta.sharedWith ?? []), added.user.id])];
                shared.push(id);
            }
        }
    }, context);

    // Each session here gets an approval that never ends while they use it: their time is "never".
    for (const id of shared) {
        if (!app.folderApprovals.live(id)) {
            approveSession(app, Number(id) as unknown as ConversationId, added.user);
        }
    }

    return added;
}

/** A session in `cwd` with the scripted model, no thinking. */
export async function newSession(app: App, cwd = work): Promise<ConversationId> {
    // New sessions start with a model someone picked, and none when nobody did: as if the owner picked this one before.
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const { id } = await app.commands.createSession(owner(app), { cwd });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

export async function loadTools(app: App, id: ConversationId, ...names: string[]): Promise<void> {
    await (
        await app.conversation(id)
    ).configure(
        { modelTools: { remove: [], add: names.map((name) => ({ name })) } } as never,
        context,
    );
}

/**
 * Offer `subagent` in each session that `app` starts from now on, as if Pi had loaded it: it waits for tool search
 * (`tool-search.ts`), and the scripted Pi of these tests calls it at once.
 */
export function offerSubagents(app: App): void {
    const create = app.commands.createSession.bind(app.commands);

    app.commands.createSession = async (...args: Parameters<typeof create>) => {
        const created = await create(...args);

        await loadTools(app, created.id, "subagent");

        return created;
    };
}

/** Send a message as the owner and wait for Pi's answer. */
export async function say(
    app: App,
    id: ConversationId,
    text: string,
    attachments?: Attachment[],
): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
        ...(attachments === undefined ? {} : { attachments }),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

/** The texts of a conversation's entries as the model sees them, oldest first. */
export async function modelTexts(app: App, id: ConversationId): Promise<string[]> {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return view.messages.map((message) => JSON.stringify(message.content));
}

/** A browser tab as the app sees it, recording every event it is sent. Attach it with `app.attach(tab.client)`. */
export function fakeTab(id: ConversationId | undefined, user: User, protocol = 2) {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const client: Client = {
        id: `tab-${crypto.randomUUID()}`,
        connection: `connection-${crypto.randomUUID()}`,
        user,
        conversationId: id,
        protocol,
        sentEntries: new Set<number>(),
        orderKey: "",
        send: (event: string, data: unknown) =>
            events.push({ event, data: data as Record<string, unknown> }),
    };
    const last = (event: string) => events.findLast((each) => each.event === event)?.data;
    /** A view field as a browser has it: updates leave out the fields that did not change. */
    const field = (name: string) =>
        events.findLast((each) => each.event === "view" && name in each.data)?.data[name];

    return { client, events, last, field };
}

/** Remove the temporary folder: call from `after`, once the app is closed. */
export function cleanUp(): void {
    // A browser's helper processes can still write to its profile here for a moment after it closes: retry, and a
    // folder that stays only warns, so a slow exit does not fail the file.
    for (const folder of [root, home]) {
        try {
            rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch (error) {
            console.warn(`Could not remove ${folder}: ${(error as Error).message}`);
        }
    }
}
