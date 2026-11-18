/**
 * Push notifications: who hears about what, and when. Pi finished, Pi needs approval, mentions, and chat messages go
 * to the people who take part in a session, unless they are looking at it or turned that kind off.
 * Each goes through Web Push to their subscribed devices, and over the live connection to their
 * embedders (`notifyEmbedders`).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { AuthorsDoc, ChatDoc } from "./docs.ts";
import { describe } from "./errors.ts";
import { entryText, projectEntry, snippet } from "./projection.ts";
import { span, type WaitView } from "./limit-gate.ts";
import { DEFAULT_PREFS, type EmbedderMessage, type PushMessage, type PushPrefs } from "./push.ts";
import type { Lockout } from "./approval-methods.ts";
import type { FolderRequestView } from "./folder-requests.ts";
import type { TrustRequestView } from "./trust-requests.ts";

const context = BACKGROUND_CONTEXT;

/** How long a run must stay finished before "Pi finished" is pushed: a queued follow-up often starts right away. */
const DONE_DELAY_MS = 3000;
/**
 * A call is offered for allowing from a notification only when all of it shows there, collapsed: one short line. A
 * longer one could hide its risky part below the fold; it opens the app instead. Denying is always offered.
 */
const MAX_NOTIFIED_CALL = 120;
/** Characters that break a line, are invisible, or reorder text: a call with any of them may not read as it runs. */
const DISGUISING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export class Alerts {
    readonly #app: PocketApp;
    readonly #doneTimers = new Map<ConversationId, NodeJS.Timeout>();
    /** Approvals already announced, so each one is pushed once. */
    #approvalIds = new Set<string>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * Push to one person about a conversation, unless they cannot see it, turned that kind off, or
     * are looking at it. `call` is an approval's whole call, for embedders, which show it as
     * their settings say.
     */
    async push(
        userId: string,
        id: ConversationId,
        kind: keyof PushPrefs,
        message: PushMessage,
        urgency: "normal" | "high" = "normal",
        call?: { text: string; may: boolean },
    ): Promise<void> {
        const app = this.#app;
        const store = app.pushStore;
        const user = app.config.userById(userId);

        if (user === undefined || !app.canSee(user, id)) {
            return;
        }

        if (!(store?.prefs(userId) ?? DEFAULT_PREFS)[kind] || app.watching(userId, id)) {
            return;
        }

        const { approval, ...rest } = message;
        const embedded: EmbedderMessage = { ...rest, urgency };

        if (approval !== undefined) {
            embedded.approval = {
                ...approval,
                may: call?.may ?? approval.allow,
                call: call?.text ?? message.body,
            };
        }

        app.notifyEmbedders(userId, embedded);

        if (store === undefined || store.subscriptions(userId).length === 0) {
            return;
        }

        // Push services want a real contact; Apple rejects placeholders. A tunnel's https address will do.
        const subject = app.access?.url?.startsWith("https://") ? app.access.url : undefined;

        await store.notify(userId, message, {
            urgency,
            ...(subject === undefined ? {} : { subject }),
        });
    }

    /**
     * Too many wrong codes locked out someone's authenticator (`approval-methods.ts`): the owner hears at once, in their
     * open tabs and as a push, whoever it was, themselves too. It names the person, not what they asked for.
     */
    lockout(lockout: Lockout): void {
        const app = this.#app;
        const person = app.config.userById(lockout.person);
        const who =
            person === undefined ? "Someone" : person.role === "owner" ? "You" : person.name;
        const whose = person?.role === "owner" ? "your" : "their";
        const time = span(lockout.until - app.now());
        const again =
            lockout.count > 1
                ? ` This is lockout ${String(lockout.count)} today: each one lasts longer.`
                : "";
        const body = `${who} entered 5 wrong authenticator codes. Codes for ${whose} account are refused for ${time}.${again}`;

        app.ownerNotice("warning", body);

        const owner = app.config.users.find((each) => each.role === "owner");
        const store = app.pushStore;

        if (owner === undefined || !(store?.prefs(owner.id) ?? DEFAULT_PREFS).security) {
            return;
        }

        const message = {
            title: "Authenticator codes locked out",
            body,
            url: "/",
            tag: `lockout-${lockout.person}`,
        } satisfies PushMessage;

        app.notifyEmbedders(owner.id, { ...message, urgency: "high" });

        // Push services want a real contact; Apple rejects placeholders. A tunnel's https address will do.
        const subject = app.access?.url?.startsWith("https://") ? app.access.url : undefined;

        void store
            ?.notify(owner.id, message, {
                urgency: "high",
                ...(subject === undefined ? {} : { subject }),
            })
            .catch((error: unknown) => app.log(`push failed: ${describe(error)}`));
    }

    /**
     * Someone asks for a session's approval (`folder-requests.ts`): to start one, or to renew a locked one. Who is in
     * charge of its computer (`inCharge`: the owner here, a runner's linker there) hears at once, in their open tabs
     * (where they allow or deny it) and as a push. Not for their own requests. `where` names a runner.
     */
    folderRequest(
        request: Pick<FolderRequestView, "id" | "person" | "name" | "folder"> &
            Partial<Pick<FolderRequestView, "kind" | "title">>,
        inCharge: string,
        where?: string,
    ): void {
        if (inCharge === request.person) {
            return;
        }

        const place = `${request.folder}${where === undefined ? "" : ` on ${where}`}`;

        this.#pushFolders(inCharge, {
            title: request.kind === "renew" ? "Renew a session" : "New session",
            body:
                request.kind === "renew"
                    ? `${request.name} asks to go on in “${request.title ?? "a session"}” (${place}).`
                    : `${request.name} asks to start a session in ${place}.`,
            url: "/",
            tag: `folder-${request.id}`,
        });
    }

    /**
     * A project waits for a trust decision in someone's session (`trust-requests.ts`): who is in charge of its computer
     * hears once, in their open tabs (a card that opens the session) and as a push. `where` names a runner.
     */
    trustRequest(
        request: Pick<TrustRequestView, "id" | "person" | "name" | "folder" | "session" | "title">,
        inCharge: string,
        where?: string,
    ): void {
        if (inCharge === request.person) {
            return;
        }

        this.#pushFolders(inCharge, {
            title: "Trust a project",
            body: `${request.name}'s session “${request.title}” waits for you to trust ${request.folder}${where === undefined ? "" : ` on ${where}`}.`,
            url: `/s/${request.session}`,
            tag: `trust-${request.id}`,
        });
    }

    /**
     * Session `title`'s approval ended while its tasks run on ("Tasks expire with the session"): its starter and who is in
     * charge hear each day of its week of grace, until it is renewed or its tasks pause. `days` are left.
     */
    tasksEnding(people: readonly string[], session: string, title: string, days: number): void {
        for (const person of new Set(people)) {
            this.#pushFolders(person, {
                title: "Renew a session",
                body:
                    days > 0
                        ? `“${title}” needs renewing: its tasks pause in ${days} day${days === 1 ? "" : "s"}.`
                        : `“${title}” was not renewed: its tasks paused until it is.`,
                url: `/s/${session}`,
                tag: `tasks-${session}`,
            });
        }
    }

    /** A push to `person` for approvals, while they allow them (`folders` pref), and to their embedding apps. */
    #pushFolders(person: string, message: Omit<PushMessage, "approval">): void {
        const app = this.#app;
        const store = app.pushStore;

        if (!(store?.prefs(person) ?? DEFAULT_PREFS).folders) {
            return;
        }

        app.notifyEmbedders(person, { ...message, urgency: "high" });

        // Push services want a real contact; Apple rejects placeholders. A tunnel's https address will do.
        const subject = app.access?.url?.startsWith("https://") ? app.access.url : undefined;

        void store
            ?.notify(person, message, {
                urgency: "high",
                ...(subject === undefined ? {} : { subject }),
            })
            .catch((error: unknown) => app.log(`push failed: ${describe(error)}`));
    }

    /**
     * A run started or ended. "Pi finished" goes out once it has stayed finished for a moment. `failure`: the run failed
     * with this line (`app.ts` `failureText`), also when no answer of Pi's says so, as when its compaction failed.
     */
    runChanged(id: ConversationId, busy: boolean, failure?: string): void {
        clearTimeout(this.#doneTimers.get(id));
        this.#doneTimers.delete(id);

        if (busy || this.#app.sessionMeta(id) === undefined || this.#quiet()) {
            return;
        }

        const timer = setTimeout(() => {
            this.#doneTimers.delete(id);
            void this.#pushDone(id, failure).catch((error: unknown) =>
                this.#app.log(`push failed: ${describe(error)}`),
            );
        }, DONE_DELAY_MS);

        timer.unref();
        this.#doneTimers.set(id, timer);
    }

    async #pushDone(id: ConversationId, failure?: string): Promise<void> {
        const app = this.#app;

        if (app.isBusy(id)) {
            return;
        }

        const conversation = await app.harness.conversation(id, context);

        if (conversation === undefined) {
            return;
        }

        const page = await conversation.entries({}, 12, undefined, context);
        const last = page.items
            .map((entry) => projectEntry(entry))
            .find((entry) => entry?.kind === "assistant");

        // A run that failed before any answer (its compaction failed, its model is gone) leaves the last answer as it
        // was: the failure says what happened, not that answer.
        if (
            failure === undefined &&
            (last?.kind !== "assistant" || last.stopReason === "aborted")
        ) {
            return;
        }

        const title = await app.conversationTitle(id);
        const failed = failure !== undefined || last?.stopReason === "error";
        const answer = last?.kind === "assistant" ? last : undefined;
        // PiP's answers open its panel, over whatever the app shows, rather than a session.
        const pip = app.sessionMeta(id)?.pip !== undefined;
        const message: PushMessage = {
            title: pip
                ? title
                : failed
                  ? `Pi stopped with an error · ${title}`
                  : `Pi finished · ${title}`,
            body: snippet(
                failure ??
                    (failed
                        ? (answer?.error ?? "The model request failed.")
                        : (answer === undefined ? "" : entryText(answer)) || "Done."),
                400,
            ),
            url: pip ? "/?pip=1" : `/s/${String(id)}`,
            tag: `done-${String(id)}`,
        };

        for (const userId of await this.participants(id)) {
            // Their PiP follows this run and tells them what came of it: one notification, not two.
            if (!pip && (await app.pip.reportsOn(id, userId).catch(() => false))) {
                continue;
            }

            // A failure waits for a person: it goes out at once, also to a phone that saves its battery.
            void this.push(userId, id, "done", message, failed ? "high" : "normal");
        }
    }

    /**
     * A run began to wait a long while for its provider's limit to clear: one push to the people in its session, who may
     * want to come back at the time, or stop it. When the run ends, "Pi finished" goes as always.
     */
    limitWait(conversationId: number, view: WaitView): void {
        const app = this.#app;
        const id = conversationId as unknown as ConversationId;
        const root = app.rootOf(id);

        if (this.#quiet() || app.sessionMeta(root) === undefined) {
            return;
        }

        void (async () => {
            const title = await app.conversationTitle(root);
            const who = app.sessionMeta(root)?.pip === undefined ? "" : "PiP: ";
            const message: PushMessage = {
                title: `Waiting for a usage limit · ${who}${title}`,
                body: snippet(
                    `${view.reason}. Pi tries again in ${span(view.until - Date.now())} and goes on by itself. Open the session to try now or stop.`,
                    400,
                ),
                url: app.sessionMeta(root)?.pip === undefined ? `/s/${String(root)}` : "/?pip=1",
                tag: `limit-${String(root)}`,
            };

            for (const userId of await this.participants(root)) {
                const user = app.config.userById(userId);

                if (user !== undefined && user.role !== "viewer") {
                    void this.push(userId, root, "limit", message);
                }
            }
        })().catch((error: unknown) => app.log(`push failed: ${describe(error)}`));
    }

    /**
     * Work passed a hard limit: a notice in the tabs of who is in charge of the session's computer, and one push to
     * them; they decide what follows. That is the owner on this server and a runner's linker on a runner (`access.ts`
     * `inChargeOf`): the owner does not see a session on a runner someone else linked, so they are not told of it.
     */
    ownerAlert(conversationId: ConversationId, title: string, body: string): void {
        const app = this.#app;
        const root = app.rootOf(conversationId);
        const ownerId = app.policy.inChargeOf(String(root));

        app.noticeTo(ownerId, "warning", `${title}: ${body}`);

        if (this.#quiet() || app.sessionMeta(root) === undefined) {
            return;
        }

        void (async () => {
            const message: PushMessage = {
                title: `${title} · ${await app.conversationTitle(root)}`,
                body: snippet(body, 400),
                url: `/s/${String(root)}`,
                tag: `stalled-${String(root)}`,
            };

            await this.push(ownerId, root, "stalled", message);
        })().catch((error: unknown) => app.log(`push failed: ${describe(error)}`));
    }

    /** New approvals go out to everyone in the session who can answer them. */
    announceApprovals(): void {
        const app = this.#app;
        const pending = app.approvals.all();
        const fresh = pending.filter((approval) => !this.#approvalIds.has(approval.id));

        this.#approvalIds = new Set(pending.map((approval) => approval.id));

        if (this.#quiet()) {
            return;
        }

        for (const approval of fresh) {
            void (async () => {
                const root = app.rootOf(approval.conversationId);
                const title = await app.conversationTitle(root);
                const call = `${approval.tool}: ${approval.subject}`;
                const shown =
                    !DISGUISING.test(approval.subject) && call.length <= MAX_NOTIFIED_CALL;
                let people = await this.participants(root);

                if (people.size === 0) {
                    people = new Set(app.config.users.map((each) => each.id));
                }

                // A command someone typed: who is in charge of the computer allows it, here or not; its person knows.
                const typist =
                    approval.typedBy === undefined
                        ? undefined
                        : (app.config.userById(approval.typedBy)?.name ?? "Someone");

                if (approval.typedBy !== undefined) {
                    people = new Set(people).add(app.policy.inChargeOf(String(root)));
                    people.delete(approval.typedBy);
                }

                for (const userId of people) {
                    const user = app.config.userById(userId);

                    if (user === undefined || user.role === "viewer") {
                        continue;
                    }

                    // An ask goes to the person who answers it, and is answered in the app: its fields need typing.
                    if (approval.form !== undefined) {
                        if (app.cannotAllow(user, approval) === undefined) {
                            void this.push(
                                userId,
                                approval.conversationId,
                                "approval",
                                {
                                    title: `Pi asks you · ${title}`,
                                    body: snippet(
                                        !approval.form.fields.some((field) => field.choices)
                                            ? approval.form.title
                                            : `${approval.form.title}: ${approval.reason}`,
                                        400,
                                    ),
                                    url: `/s/${String(approval.conversationId)}`,
                                    tag: `approval-${approval.id}`,
                                },
                                "high",
                            );
                        }

                        continue;
                    }

                    const may = app.cannotAllow(user, approval) === undefined;
                    const message: PushMessage = {
                        title:
                            typist === undefined
                                ? `Pi needs approval · ${title}`
                                : `${typist}'s command needs approval · ${title}`,
                        body: snippet(call, 400),
                        url: `/s/${String(approval.conversationId)}`,
                        tag: `approval-${approval.id}`,
                        approval: { id: approval.id, allow: shown && may },
                    };

                    void this.push(userId, approval.conversationId, "approval", message, "high", {
                        text: call,
                        may,
                    });
                }
            })().catch((error: unknown) => app.log(`push failed: ${describe(error)}`));
        }
    }

    /**
     * Nobody can get a notification: push is off on this server, and no embedder is connected.
     */
    #quiet(): boolean {
        return this.#app.pushStore === undefined && !this.#app.hasEmbedders();
    }

    /** People who take part in a session: whoever started it, wrote to Pi, or chatted there. */
    async participants(id: ConversationId): Promise<Set<string>> {
        const app = this.#app;
        const root = app.rootOf(id);
        const people = new Set<string>();
        const createdBy = app.sessionMeta(root)?.createdBy;

        if (createdBy !== undefined) {
            people.add(createdBy);
        }

        for (const userId of Object.values(
            (await app.harness.snapshot(AuthorsDoc, root, context))?.entries ?? {},
        )) {
            people.add(userId);
        }

        for (const message of (await app.harness.snapshot(ChatDoc, root, context))?.messages ??
            []) {
            if (message.kind !== "event") {
                people.add(message.userId);
            }
        }

        return people;
    }

    close(): void {
        for (const timer of this.#doneTimers.values()) {
            clearTimeout(timer);
        }

        this.#doneTimers.clear();
    }
}
