import { runnerActivity, runnerAddress, runnerIdentity, runnerLog } from "./output.mjs";

const LABELS = {
    checking: "Checking link",
    unlinked: "Not linked",
    disabled: "Disabled",
    connecting: "Runner running; connection not confirmed",
    connected: "Connected",
    offline: "Offline; trying again",
    retrying: "Runner stopped; trying again",
    ended: "Link ended",
    unavailable: "Runner unavailable",
    error: "Runner needs attention",
};
const STOP_WARNING =
    "Stopping the runner can interrupt commands. Its background tasks stop even when the runner is idle.";
const REPAIR = "Install the current Pi Pocket desktop build again to restore the bundled runner.";
const LINK_AGAIN =
    "On the server, open Menu → Access → Settings, select this computer and choose Link again.";

class RunnerError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// All callers see one lane of commands and one owned start process. The timer restarts a failed process, not a
// failed connection: a live runner reconnects without losing its background tasks.
export class RunnerController {
    #start;
    #publish;
    #savePolicy;
    #schedule;
    #cancel;
    #now;
    #policy;
    #child;
    #command;
    #stopping;
    #timer;
    #attempt = 0;
    #closed = false;
    #state = { status: "checking", linked: false, working: false, workingFolders: 0, busy: false };
    #log = [];

    constructor({
        start,
        publish,
        policy,
        savePolicy,
        schedule = setTimeout,
        cancel = clearTimeout,
        now = Date.now,
    }) {
        this.#start = start;
        this.#publish = publish;
        this.#policy = { enabled: policy?.enabled === true, ended: policy?.ended === true };
        this.#savePolicy = savePolicy;
        this.#schedule = schedule;
        this.#cancel = cancel;
        this.#now = now;
    }

    get state() {
        return {
            ...this.#state,
            label: this.#state.working ? "Working now" : LABELS[this.#state.status],
            enabled: this.#policy.enabled,
            running: this.#child !== undefined,
            log: this.#log.slice(-40),
        };
    }

    #set(patch) {
        Object.assign(this.#state, patch);

        if (!this.#closed) {
            this.#publish(this.state);
        }
    }

    #logLine(message) {
        this.#log.push(message);

        if (this.#log.length > 200) {
            this.#log.shift();
        }
    }

    async #run(request, receive = () => {}) {
        const command = this.#start(request, receive);

        this.#command = command;

        try {
            return await command.done;
        } finally {
            this.#command = undefined;
        }
    }

    async #operation(operation) {
        if (this.#closed || this.#state.busy) {
            throw new RunnerError(
                "runner.busy",
                "Wait for the current runner operation to finish.",
            );
        }

        this.#set({ busy: true });

        try {
            await operation();
        } finally {
            this.#set({ busy: false });
        }
    }

    #save(patch) {
        const next = { ...this.#policy, ...patch };

        try {
            this.#savePolicy(next);
        } catch {
            throw new RunnerError(
                "runner.save",
                "The app could not save the runner setting. Check access to the desktop settings folder.",
            );
        }

        this.#policy = next;
    }

    async #inspect() {
        const lines = [];
        let invalid = false;
        const code = await this.#run({ action: "status" }, (line, stdout) => {
            if (stdout && lines.length < 2) {
                lines.push(line);
            }

            invalid ||= !stdout && line.includes("is not a valid link file");
        });
        const identity = code === 0 ? runnerIdentity(lines) : undefined;

        if (this.#closed) {
            return;
        }

        if (identity === undefined) {
            this.#set({
                status: code === 125 ? "unavailable" : "error",
                linked: false,
                name: null,
                server: null,
                message:
                    code === 125
                        ? REPAIR
                        : invalid
                          ? `The saved link is not valid. ${LINK_AGAIN}`
                          : "Could not read the saved runner link. Repair Pi Pocket or link again.",
            });

            return;
        }

        this.#set({
            status: !identity ? "unlinked" : this.#policy.ended ? "ended" : "disabled",
            message: identity && this.#policy.ended ? LINK_AGAIN : null,
            linked: identity !== null,
            name: identity?.name ?? null,
            server: identity?.server ?? null,
        });
    }

    #cancelRetry() {
        if (this.#timer !== undefined) {
            this.#cancel(this.#timer);
            this.#timer = undefined;
        }
    }

    #launch() {
        if (
            this.#closed ||
            this.#child ||
            !this.#state.linked ||
            !this.#policy.enabled ||
            this.#policy.ended
        ) {
            return;
        }

        const started = this.#now();
        const child = this.#start({ action: "start" }, (line, stdout) => {
            if (this.#child !== child || !stdout) {
                return;
            }

            const activity = runnerActivity(line);

            if (activity) {
                this.#set(activity);

                return;
            }

            const entry = runnerLog(line, this.#state.server);

            if (entry) {
                this.#logLine(entry.message);
                this.#set(entry);
            }
        });

        this.#child = child;
        this.#set({ status: "connecting", message: null, working: false, workingFolders: 0 });
        void child.done.then((code) => {
            if (this.#child !== child || this.#closed) {
                return;
            }

            this.#child = undefined;
            const idle = { working: false, workingFolders: 0 };

            if (code === 3) {
                let message = LINK_AGAIN;

                try {
                    this.#save({ ended: true });
                } catch {
                    this.#policy.ended = true;
                    message += " The app could not save this status for the next launch.";
                }

                this.#logLine("The server ended the link.");
                this.#set({ ...idle, status: "ended", message });

                return;
            }

            if (code === 125) {
                this.#set({ ...idle, status: "unavailable", message: REPAIR });

                return;
            }

            if (this.#now() - started >= 60_000) {
                this.#attempt = 0;
            }

            const seconds = Math.min(2 ** this.#attempt++, 60);
            const message = `The runner stopped. Trying again in ${seconds} s.`;

            this.#logLine(message);
            this.#set({ ...idle, status: "retrying", message });
            this.#timer = this.#schedule(() => {
                this.#timer = undefined;
                this.#launch();
            }, seconds * 1000);
        });
    }

    async #stop() {
        this.#cancelRetry();
        const child = this.#child;

        // Keep ownership until it ends, but ignore its last output and exit after a manual stop.
        this.#child = undefined;
        this.#set({ working: false, workingFolders: 0 });
        this.#stopping ??= child?.stop();
        await this.#stopping;
        this.#stopping = undefined;
        this.#attempt = 0;
    }

    #confirm(confirmed, always = false) {
        if (confirmed !== true && (always || this.#child)) {
            const active = this.#state.working ? "The runner is working now. " : "";

            throw new RunnerError("runner.confirm", active + STOP_WARNING);
        }
    }

    async boot() {
        await this.#operation(async () => {
            await this.#inspect();
            this.#launch();
        });
    }

    async link({ server, code, allowHttp = false, confirmed = false, trusted = false }) {
        server = runnerAddress(server);
        code = typeof code === "string" ? code.trim() : "";

        if (
            !server ||
            !/^[\dA-Z]{4}(?:-[\dA-Z]{4}){2}$/i.test(code) ||
            typeof allowHttp !== "boolean"
        ) {
            throw new RunnerError(
                "runner.input",
                "Enter the full HTTP or HTTPS server address and a code such as ABCD-EFGH-JKLM.",
            );
        }

        if (trusted !== true) {
            throw new RunnerError(
                "runner.trust",
                "Confirm that you trust this server to run commands as your OS user without a sandbox.",
            );
        }

        await this.#operation(async () => {
            this.#confirm(confirmed);
            // Do not stop the old process or change policy during a failed link attempt.
            let refusal = false;
            const result = await this.#run(
                { action: "link", server, code, allowHttp },
                (line, stdout) => {
                    refusal ||=
                        !stdout && line.includes("Anything else needs https://, or --allow-http.");
                },
            );

            if (this.#closed) {
                return;
            }

            if (result !== 0) {
                const message =
                    result === 125
                        ? REPAIR
                        : result === 124
                          ? "Linking took too long. Check the server address and try a new code."
                          : refusal
                            ? "This server needs HTTPS. Allow plain HTTP only on a network you trust."
                            : "Could not link. Check the server address, its version and the one-time code.";

                this.#logLine(message);

                throw new RunnerError("runner.link", message);
            }

            await this.#stop();

            if (!this.#closed) {
                this.#save({ ended: false });
                this.#log = [];
                await this.#inspect();
                this.#launch();
            }
        });
    }

    async setEnabled(enabled, confirmed) {
        if (typeof enabled !== "boolean") {
            throw new RunnerError("runner.input", "Choose whether to enable the runner.");
        }

        await this.#operation(async () => {
            if (enabled === this.#policy.enabled) {
                return;
            }

            if (enabled && (!this.#state.linked || this.#policy.ended)) {
                throw new RunnerError(
                    "runner.notLinked",
                    this.#policy.ended ? LINK_AGAIN : "Link this computer first.",
                );
            }

            if (!enabled) {
                this.#confirm(confirmed);
            }

            this.#save({ enabled });

            if (enabled) {
                this.#launch();
            } else {
                await this.#stop();

                if (this.#state.linked && !this.#policy.ended) {
                    this.#set({ status: "disabled", message: null });
                }
            }
        });
    }

    async reconnect(confirmed) {
        await this.#operation(async () => {
            if (this.#policy.ended || !this.#policy.enabled || !this.#state.linked) {
                throw new RunnerError(
                    "runner.notEnabled",
                    this.#policy.ended ? LINK_AGAIN : "Link and enable the runner first.",
                );
            }

            this.#confirm(confirmed);
            await this.#stop();
            this.#launch();
        });
    }

    async unlink(confirmed) {
        await this.#operation(async () => {
            this.#confirm(confirmed, true);
            await this.#stop();

            if (this.#closed) {
                return;
            }

            const result = await this.#run({ action: "unlink" });

            if (this.#closed) {
                return;
            }

            if (result !== 0) {
                this.#launch();

                throw new RunnerError(
                    "runner.unlink",
                    "Could not remove the saved link. The link has not changed.",
                );
            }

            this.#save({ enabled: false, ended: false });
            this.#log = [];
            this.#set({
                status: "unlinked",
                linked: false,
                name: null,
                server: null,
                message:
                    "To cancel this computer’s key, also remove it on the server in Menu → Access → Settings.",
            });
        });
    }

    async close() {
        this.#closed = true;
        await Promise.all([this.#stop(), this.#command?.stop()]);
    }
}
