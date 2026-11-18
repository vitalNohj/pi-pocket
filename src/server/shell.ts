/**
 * Commands people run themselves from the message box, as in Pi's terminal app: `!git status` runs in the session's
 * folder and Pi sees what it printed; `!!git status` shows only to the people here. Each command is a background task,
 * so it shows in Running now and can be stopped there. A restart while one runs does not run it again: it may have
 * done part of its work, so its entry says it was cut off. The entry goes in as a write submission, which Pi Durable
 * queues while Pi works and places where a message can go.
 *
 * With Lancet Guard on, a command from anyone but who is in charge of the session's computer is judged first. One the
 * guard asks about waits, as a call of Pi's does, for who is in charge to allow it (`PocketApp.cannotAllow`); anyone who
 * can steer can deny it. A denied command does not run, and Pi is not told of it.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
    type ConversationId,
    defineTask,
    type EntryDraft,
    type Task,
    type TaskId,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { THIS_SERVER } from "./access.ts";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { ShellRequestsDoc } from "./docs.ts";
import { SHELL_ENTRY, type ShellData } from "./entry-format.ts";
import { describe, HttpError } from "./errors.ts";
import { ownRequest } from "./requests.ts";

const TASK = "pocket.shell";
/** How long a command may run. */
const TIMEOUT_SECONDS = 600;
/** How much of what a command printed is kept: its end, where results and errors usually are. */
const TAIL_CHARS = 30_000;
const MAX_COMMAND = 4000;
/** Terminal escape codes (colors, cursor moves): some tools print them even when nobody reads a terminal. */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** A command as typed: what its entry keeps. */
type Typed = { command: string; by: string; name: string; context: boolean };
/** `held`: why the guard asks about this command; it waits for an answer before it runs. */
export type ShellInput = Typed & { held?: { reason: string; score?: number } };
/** An approval's answer, as a command's memo keeps it. */
type Answer = { allow: boolean; by: string };

/** The id of the approval a held command waits on. */
const approvalId = (taskId: number): string => `${taskId}:shell`;

const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;

/** What Pi gets for a command, as Pi's terminal app words it. */
function shellMessage(data: ShellData, speaker: (text: string) => string): string {
    const notes: string[] = [];

    if (data.clipped) {
        notes.push("Only the end of the output is shown.");
    }

    if (data.status === "timeout") {
        notes.push(
            `The command did not finish within ${TIMEOUT_SECONDS / 60} minutes and was stopped.`,
        );
    } else if (data.status === "interrupted") {
        notes.push(
            "The command was cut off by a server restart; it may have done part of its work.",
        );
    } else if (data.status === "stopped") {
        notes.push("The command was stopped before it finished.");
    } else if (data.status === "failed") {
        notes.push("The command could not run.");
    } else if (data.code !== undefined && data.code !== 0) {
        notes.push(`Command exited with code ${data.code}`);
    }

    const output = data.output.trim() === "" ? "(no output)" : data.output.replace(/\s+$/, "");

    return speaker(
        `Ran \`${data.command}\`\n\`\`\`\n${output}\n\`\`\`${notes.length === 0 ? "" : `\n\n${notes.join("\n")}`}`,
    );
}

/** How many request ids of finished commands a conversation keeps, to run a retried `!` request once. A running command's is always kept. */
const KEEP_REQUESTS = 100;

export class Shell {
    readonly #app: PocketApp;
    readonly task: Task<ShellInput, { phase: "run" }, null, object>;
    /** What each running command printed so far, so a stopped one keeps it. Lost with a restart, as the command is. */
    readonly #tails = new Map<number, { output: string; clipped: boolean }>();

    constructor(app: PocketApp) {
        this.#app = app;
        this.task = defineTask<ShellInput, { phase: "run" }, null>({
            name: TASK,
            version: 1,
            initial: () => ({ phase: "run" }),
            phases: {
                run: async (task, runtime, context) => {
                    const taskId = Number(task.id);
                    const { held, ...input } = task.input;
                    // Set before the command starts: finding it set means a restart cut the command off.
                    const started = await runtime.memo<number>("started", context);
                    let data: ShellData | undefined;

                    if (started !== undefined) {
                        data = { ...input, output: "", status: "interrupted", taskId };
                    } else if (held !== undefined) {
                        // It waits here, before it counts as started: a restart while it waits asks again, and one
                        // after the answer does not.
                        let answer = await runtime.memo<Answer>("approval", context);

                        if (answer === undefined) {
                            const scored =
                                typeof held.score === "number"
                                    ? ` (score ${held.score.toFixed(2)})`
                                    : "";
                            const asked = await this.#app.approvals.request(
                                {
                                    id: approvalId(taskId),
                                    conversationId: runtime.conversationId,
                                    taskId: task.id,
                                    tool: "bash",
                                    subject: input.command,
                                    reason: `${held.reason}${scored}`,
                                    ...(held.score === undefined ? {} : { score: held.score }),
                                    createdAt: Date.now(),
                                    typedBy: input.by,
                                },
                                context,
                            );

                            answer = await runtime.memo<Answer>(
                                "approval",
                                { allow: asked.allow, by: asked.by },
                                context,
                            );
                        }

                        data = this.#refused(
                            runtime.conversationId,
                            { ...input, taskId },
                            held,
                            answer,
                        );
                    }

                    if (data === undefined) {
                        await runtime.memo("started", Date.now(), context);
                        // A workspace URI whose provider is off has no environment: the command fails, as Pi's do.
                        const env = await runtime.env(context).then(
                            (found) => ({ found }),
                            (error: unknown) => ({ error: describe(error) }),
                        );

                        data =
                            "error" in env
                                ? { ...input, output: env.error, status: "failed", taskId }
                                : await this.#run(input, taskId, env.found, context);
                    }

                    await this.#record(runtime.conversationId, data, context);
                    this.#tails.delete(taskId);
                    await runtime.commit(() => finished, context);
                },
            },
            abort: async (task, runtime, context) => {
                // Recorded once: a command that already wrote its entry keeps it. A stopped one keeps what it printed.
                const taskId = Number(task.id);
                const tail = this.#tails.get(taskId);
                const { held, ...input } = task.input;
                // Stopped while it waited for its answer: it never ran, so Pi is not told of it.
                const waited =
                    held !== undefined &&
                    (await runtime.memo<number>("started", context)) === undefined;

                this.#tails.delete(taskId);
                await this.#record(
                    runtime.conversationId,
                    {
                        ...input,
                        ...(waited ? { context: false } : {}),
                        output: waited
                            ? "Stopped while it waited for approval. It did not run."
                            : (tail?.output ?? ""),
                        ...(tail?.clipped ? { clipped: true } : {}),
                        status: "stopped",
                        taskId,
                    },
                    context,
                );
                await runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "aborted" } }),
                    context,
                );
            },
        });
    }

    /**
     * Why a command the guard held does not run after its answer, as its entry, or undefined when it may run: it was
     * denied, or its person may no longer run commands here. Pi is told of neither: nothing ran.
     */
    #refused(
        id: ConversationId,
        input: Typed & { taskId: number },
        held: NonNullable<ShellInput["held"]>,
        answer: Answer,
    ): ShellData | undefined {
        const app = this.#app;

        if (!answer.allow) {
            return {
                ...input,
                context: false,
                output: `Lancet Guard asked before this command (${held.reason}), and ${answer.by} denied it. It did not run.`,
                status: "denied",
            };
        }

        // Time passed while it waited: it runs only for someone who may still run commands here.
        const user = app.config.userById(input.by);
        let why: string | undefined;

        if (user === undefined) {
            why = "they are no longer on this server";
        } else {
            try {
                app.requireSee(user, id);
                app.requireSteer(user, id);

                const meta = app.sessionMeta(app.rootOf(id));

                if (meta !== undefined) {
                    app.requireRunnerAccess(meta);
                }
            } catch (error) {
                why = describe(error);
            }
        }

        return why === undefined
            ? undefined
            : {
                  ...input,
                  context: false,
                  output: `${answer.by} allowed this command, but ${input.name} can no longer run commands here: ${why}. It did not run.`,
                  status: "failed",
              };
    }

    async #run(
        input: Typed,
        taskId: number,
        env: ExecutionEnv | undefined,
        context: Context,
    ): Promise<ShellData> {
        const base = { ...input, taskId };

        if (env === undefined) {
            return {
                ...base,
                output: "This session has no folder to run commands in.",
                status: "failed",
            };
        }

        let output = "";
        let clipped = false;
        const result = await env.exec(
            input.command,
            {
                timeout: TIMEOUT_SECONDS,
                onOutput: (text) => {
                    output += text;

                    if (output.length > TAIL_CHARS * 2) {
                        output = output.slice(-TAIL_CHARS);
                        clipped = true;
                    }

                    this.#tails.set(taskId, {
                        output: output.slice(-TAIL_CHARS),
                        clipped: clipped || output.length > TAIL_CHARS,
                    });
                },
            },
            context,
        );

        if (output.length > TAIL_CHARS) {
            output = output.slice(-TAIL_CHARS);
            clipped = true;
        }

        const tail = clipped ? { clipped: true } : {};

        if (!result.ok) {
            const timeout = result.error.code === "timeout";

            return {
                ...base,
                ...tail,
                output: timeout ? output : `${output}\n${result.error.message}`.trim(),
                status: timeout ? "timeout" : "failed",
            };
        }

        return { ...base, ...tail, output, code: result.value.exitCode, status: "done" };
    }

    /** Write a command's entry, once per command whatever runs it again. */
    async #record(id: ConversationId, raw: ShellData, context: Context): Promise<void> {
        const app = this.#app;
        const data = { ...raw, output: raw.output.replace(ANSI, "") };
        const entry: EntryDraft = {
            kind: SHELL_ENTRY,
            data,
            ...(data.context
                ? {
                      model: [
                          {
                              role: "user",
                              content: [
                                  {
                                      type: "text",
                                      text: shellMessage(data, (text) =>
                                          app.commands.messageText({ name: data.name }, text),
                                      ),
                                  },
                              ],
                              timestamp: Date.now(),
                          } as Message,
                      ],
                  }
                : {}),
        };
        // A command Pi sees is the person's, like a message: Pi works for them from there, so they cannot allow the
        // calls it leads to where approvals need someone else. One Pi does not see is nobody's.
        const requestId = data.context
            ? ownRequest(data.by, `shell-${data.taskId}`)
            : `shell:${data.taskId}`;
        const conversation = await app.conversation(id);

        await conversation.submit({ type: "write", entry, requestId }, context);
    }

    /**
     * Run a command someone typed. With Lancet Guard on, a command from anyone but who is in charge of the session's
     * computer (`access.ts` `inCharge`: the owner here, a runner's linker there) is judged first: one the guard blocks is
     * refused here, and one it asks about is stored and waits for who is in charge to allow it.
     */
    async start(
        id: ConversationId,
        user: User,
        request: { command?: unknown; context?: unknown; requestId?: unknown },
    ): Promise<{ taskId: number }> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        // On another computer, only while its starter may still use it: say so now, not after queuing the command.
        const meta = app.sessionMeta(app.rootOf(id));

        if (meta !== undefined) {
            app.requireRunnerAccess(meta);
        }

        await app.conversation(id);
        const command = typeof request.command === "string" ? request.command.trim() : "";

        if (command === "") {
            throw new HttpError(400, "Say which command to run, such as !git status.");
        }

        if (command.length > MAX_COMMAND) {
            throw new HttpError(413, `Commands are limited to ${MAX_COMMAND} characters.`);
        }

        // A command is stored and shown as typed, and runs from what is stored: one that holds a value an extension hides
        // (`host.hide`) would keep it in the transcript. The extension's variable carries the value instead.
        if (app.hidden.replace(command, id) !== command) {
            throw new HttpError(
                400,
                "This command holds a hidden value, which would be stored and shown. Use the variable that carries it instead, such as $NAME.",
            );
        }

        let held: ShellInput["held"];

        if (!app.policy.inCharge(user, app.runnerOf(id) ?? THIS_SERVER) && app.guardOn()) {
            const judged = await app.guard.judge("bash", { command }, app.cwdOf(id));

            if (judged?.decision.action === "block") {
                throw new HttpError(
                    403,
                    `Lancet Guard blocked this command: ${judged.decision.reason}.`,
                );
            }

            if (judged?.decision.action === "ask") {
                const { reason, score } = judged.decision;

                held = { reason, ...(score === undefined ? {} : { score }) };
            }
        }

        const input: ShellInput = {
            command,
            by: user.id,
            name: user.name,
            context: request.context !== false,
            ...(held === undefined ? {} : { held }),
        };
        // The command and its request id go in one commit: a request sent again finds its command, after a restart too.
        const key =
            typeof request.requestId === "string" && request.requestId !== ""
                ? `${user.id}:${request.requestId.slice(0, 64)}`
                : undefined;
        const taskId = await app.harness.commit(
            async (tx) => {
                const requests = await tx.doc(ShellRequestsDoc, id);
                const known = key === undefined ? undefined : requests.items[key];

                if (known !== undefined) {
                    return known;
                }

                // Past the most kept, the oldest finished ones make room; a command still running keeps its request id,
                // however many follow. Tasks are read before the new one is made: a commit reads tables before it writes.
                const finished: string[] = [];
                const extra =
                    key === undefined ? 0 : Object.keys(requests.items).length + 1 - KEEP_REQUESTS;

                for (const [old, oldTask] of Object.entries(requests.items)) {
                    if (finished.length >= extra) {
                        break;
                    }

                    const record = await tx.task(oldTask as unknown as TaskId);

                    if (record === undefined || record.state.status === "terminal") {
                        finished.push(old);
                    }
                }

                const created = Number(
                    await tx.createTask(this.task, input, {
                        ownership: { kind: "conversation" },
                        background: true,
                        conversationId: id,
                    }),
                );

                if (key !== undefined) {
                    for (const old of finished) {
                        delete requests.items[old];
                    }

                    requests.items[key] = created;
                }

                return created;
                // The guard's judgement took time: the command is stored only for who still drives the session.
            },
            app.admission(id, user),
        );

        return { taskId };
    }

    /** Stop a command that is still running. Anyone who can steer may: stopping is the safe direction. */
    async stop(id: ConversationId, user: User, taskId: number): Promise<void> {
        const app = this.#app;

        app.requireSteer(user, id);
        const task = Number.isInteger(taskId)
            ? await app.harness.getTask(taskId as unknown as TaskId, BACKGROUND_CONTEXT)
            : undefined;

        if (task === undefined || task.kind !== TASK || task.conversationId !== id) {
            throw new HttpError(404, "No such command here.");
        }

        if (task.state.status === "terminal") {
            return;
        }

        await app.harness.abortTask(task.id, BACKGROUND_CONTEXT);
    }

    /** What a running command has printed so far (its end), or undefined when it printed nothing or is not running. */
    printed(taskId: number): string | undefined {
        return this.#tails.get(taskId)?.output.replace(ANSI, "");
    }

    /** The command a running task runs, for Running now. */
    async describe(taskId: TaskId): Promise<string | undefined> {
        const task = await this.#app.harness.getTask(taskId, BACKGROUND_CONTEXT);

        return task?.kind === TASK ? (task.input as ShellInput).command : undefined;
    }

    /** Whether a command waits for someone to allow it, and so has not started. */
    waits(taskId: TaskId): boolean {
        const id = approvalId(Number(taskId));

        return this.#app.approvals.all().some((each) => each.id === id);
    }
}
