import { join } from "node:path";
import {
    HOST_COMMANDS,
    isId,
    isRecord,
    isSection,
    isText,
    menuModel,
    onlyKeys,
    packet,
} from "../protocol/index.mjs";
import { initialState, preferenceRules } from "../protocol/state.mjs";
import {
    allowedOrigins,
    connectionError,
    probeServer,
    serverAddress,
    signInOrigin,
} from "./connection/probe.mjs";
import { diagnostics } from "./diagnostics/log.mjs";
import { patchPreferences, readPreferences, savePreferences } from "./preferences.mjs";

const localStates = ["stopped", "starting", "running", "error"];
const unavailable = () => connectionError("unavailable", "This action is not available yet.");
const invalid = () => connectionError("invalid", "Check the values and try again.");
const noData = (data) => data === undefined;
const optionalSection = (data) =>
    data === undefined || (onlyKeys(data, ["section"]) && isSection(data.section));
const pinId = (id) => typeof id === "string" && /^\d{1,20}$/.test(id);

function validLocal(data) {
    return (
        onlyKeys(data, ["status", "owned", "verified", "address", "message"]) &&
        localStates.includes(data.status) &&
        typeof data.owned === "boolean" &&
        typeof data.verified === "boolean" &&
        (data.status !== "running"
            ? data.address === undefined
            : Boolean(signInOrigin(data.address))) &&
        (data.message === undefined || isText(data.message, 1024))
    );
}

function cleanPin(item) {
    return isRecord(item) &&
        pinId(item.id) &&
        isText(item.title, 160) &&
        isText(item.label, 40) &&
        ["waiting", "limited", "working", "failed", "fresh", "seen"].includes(item.state) &&
        item.url === `/s/${item.id}`
        ? { id: item.id, title: item.title, label: item.label, state: item.state, url: item.url }
        : null;
}

export class DesktopController {
    #state;
    #file;
    #write;
    #log;
    #subscribed = false;
    #pending = new Map();
    #actions = new Map();
    #commands = new Map();
    #rules = structuredCloneRules();
    #saving = Promise.resolve();
    #id = 0;
    #generation = 0;
    #switched = null;
    #checks = null;
    #checkingPage = null;
    #timer = null;
    #failures = 0;
    #localOpening = false;
    #closed = false;

    constructor({ folder, platform, version, existingInstall, write }) {
        this.#state = initialState(platform, version, existingInstall);
        this.#file = join(folder, "desktop.json");
        this.#write = write;
        this.#log = diagnostics(folder);

        for (const action of HOST_COMMANDS) {
            this.registerHostCommand(action, noData);
        }

        this.registerHostCommand("settings.open", optionalSection);
        this.registerHostCommand(
            "window.pinned",
            (data) => onlyKeys(data, ["id"]) && pinId(data.id),
        );
        this.registerHostCommand(
            "window.preferences",
            (data) =>
                onlyKeys(data, Object.keys(this.#rules.window)) &&
                Object.entries(data).every(([key, value]) => this.#rules.window[key](value)),
        );

        for (const action of HOST_COMMANDS.filter(
            (action) => !action.startsWith("local.") || action === "local.log",
        )) {
            if (action === "window.preferences") {
                continue;
            }

            this.registerAction(action, this.#commands.get(action), (data) =>
                this.#windowAction(action, data),
            );
        }

        const address = (data) =>
            onlyKeys(data, ["address"]) && Boolean(serverAddress(data.address));

        this.registerAction("home.check", address, (data) =>
            this.#check(serverAddress(data.address)),
        );
        this.registerAction("home.connect", address, (data) =>
            this.#connect(serverAddress(data.address)),
        );
        this.registerAction("home.preview", address, (data) =>
            this.#connect(serverAddress(data.address), true),
        );
        this.registerAction("home.retry", noData, () => this.#retry());
        this.registerAction("home.local.open", noData, () => this.#localOpen());
        this.registerAction("home.local.stop", noData, () => this.#localStop());
        this.registerAction("home.local.restart", noData, () => this.#localRestart());
    }

    async load() {
        const rules = {
            ...this.#rules,
            home: {
                ...this.#rules.home,
                mode: (mode) => [null, "local", "remote"].includes(mode),
                remoteAddress: (address) => address === "" || serverAddress(address) !== null,
            },
        };
        const saved = await readPreferences(this.#file, this.#state.preferences, rules);
        const prefs = saved.preferences.home;

        prefs.remoteAddress = serverAddress(prefs.remoteAddress) || "";
        prefs.allowedOrigins = this.#origins(prefs.allowedOrigins);

        if (prefs.mode === "remote" && !prefs.remoteAddress) {
            prefs.mode = null;
            saved.warnings.push("The saved server address is invalid. Choose a server on Home.");
        }

        this.#state.preferences = saved.preferences;
        this.#state.warnings = saved.warnings;

        if (saved.missing) {
            await savePreferences(this.#file, this.#state.preferences).catch(() => {
                this.#state.warnings.push("Desktop settings could not be saved.");
            });
        }

        this.#log("controller.start");
    }

    async begin() {
        const { mode, remoteAddress, connectAtStartup } = this.#state.preferences.home;

        try {
            if (mode === "local") {
                await this.#localOpen();
            } else {
                void this.callHost("local.inspect")
                    .then((local) => this.#local(local))
                    .catch(() => {});

                if (mode === "remote" && connectAtStartup) {
                    // A saved HTML preview was already explicitly accepted. It still must pass today's probe.
                    await this.#connect(remoteAddress, true, true);
                }
            }
        } catch (error) {
            this.#log("home.start", error.code || "error");
        }
    }

    registerAction(name, validate, run) {
        this.#actions.set(name, { validate, run });
    }

    registerHostCommand(name, validate) {
        this.#commands.set(name, validate);
    }

    registerPreference(section, key, defaultValue, validate) {
        if (!isSection(section) || !validate(defaultValue)) {
            throw new Error("Invalid desktop preference definition");
        }

        this.#rules[section][key] = validate;
        this.#state.preferences[section][key] = defaultValue;
    }

    setSlice(section, delta) {
        if (
            !["runner", "updates", "dictation", "notifications", "window"].includes(section) ||
            !isRecord(delta)
        ) {
            throw new Error("Invalid desktop state slice");
        }

        Object.assign(this.#state[section], delta);
        this.#publish();
    }

    snapshot() {
        return structuredClone({ ...this.#state, menus: menuModel(this.#state) });
    }

    #publish() {
        this.#state.revision++;

        if (this.#subscribed) {
            this.#write(packet("state", { state: this.snapshot() }));
        }
    }

    callHost(action, data, wait = 15000) {
        if (this.#closed || this.#pending.size >= 24 || !this.#commands.get(action)?.(data)) {
            return Promise.reject(unavailable());
        }

        this.#id = (this.#id % 2147483647) + 1;
        const id = this.#id;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(
                    connectionError(
                        "host-timeout",
                        "The app did not complete this action in time.",
                    ),
                );
            }, wait).unref();

            this.#pending.set(id, { timer, resolve, reject });
            this.#write(packet("host", { id, action, ...(data === undefined ? {} : { data }) }));
        });
    }

    async receive({ id, command, value }) {
        try {
            let result;

            switch (command) {
                case "subscribe":
                case "getState":
                    if (value !== undefined) {
                        throw invalid();
                    }

                    if (command === "subscribe") {
                        this.#subscribed = true;
                    }

                    result = this.snapshot();
                    break;

                case "action": {
                    if (!onlyKeys(value, ["id", "data"])) {
                        throw invalid();
                    }

                    const action = this.#actions.get(value.id);

                    if (!action) {
                        throw unavailable();
                    }

                    if (!action.validate(value.data)) {
                        throw invalid();
                    }

                    result = await action.run(value.data);
                    break;
                }

                case "patchPreferences":
                    await this.#patch(value);
                    result = this.snapshot();
                    break;
                case "host.report":
                    if (
                        !onlyKeys(value, ["event", "data"]) ||
                        !this.#report(value.event, value.data)
                    ) {
                        throw invalid();
                    }

                    break;
                case "host.result":
                    this.#hostResult(value);
                    break;
            }

            this.#write(packet("result", { id, ok: true, value: result ?? null }));
        } catch (error) {
            const safe =
                isRecord(error) && isText(error.code, 40) && isText(error.message, 1024)
                    ? error
                    : unavailable();

            this.#write(packet("result", { id, ok: false, error: safe }));
        }
    }

    #hostResult(data) {
        if (
            !onlyKeys(data, ["id", "ok", "value", "error"]) ||
            !isId(data.id) ||
            typeof data.ok !== "boolean"
        ) {
            throw invalid();
        }

        const pending = this.#pending.get(data.id);

        if (!pending) {
            return;
        }

        this.#pending.delete(data.id);
        clearTimeout(pending.timer);

        if (data.ok) {
            pending.resolve(data.value);
        } else if (
            onlyKeys(data.error, ["code", "message"]) &&
            isText(data.error.code, 40) &&
            isText(data.error.message, 1024)
        ) {
            pending.reject(connectionError(data.error.code, data.error.message));
        } else {
            pending.reject(unavailable());
        }
    }

    async #windowAction(action, data) {
        const active = this.#state.home.active;

        if (
            ["window.newSession", "window.newWindow", "window.reload"].includes(action) &&
            !active
        ) {
            throw connectionError("no-page", "Open a Pi Pocket server first.");
        }

        if (
            action === "window.pinned" &&
            !this.#state.page.pins.some((pin) => pin.id === data.id)
        ) {
            throw unavailable();
        }

        return this.callHost(action, data);
    }

    #report(event, data) {
        const page = this.#state.page;
        const window = this.#state.window;

        if (event === "local") {
            return this.#local(data);
        }

        if (event === "visibility" && typeof data === "boolean") {
            page.visible = data;
        } else if (event === "focus" && typeof data === "boolean") {
            window.focused = data;
        } else if (
            event === "power" &&
            onlyKeys(data, ["idle", "suspended"]) &&
            typeof data.idle === "boolean" &&
            typeof data.suspended === "boolean"
        ) {
            window.idle = data.idle;
            window.suspended = data.suspended;
        } else if (
            event === "platform" &&
            onlyKeys(data, ["loginEnabled"]) &&
            typeof data.loginEnabled === "boolean"
        ) {
            window.loginEnabled = data.loginEnabled;
        } else if (isRecord(data) && this.#state.home.active?.generation === data.generation) {
            if (
                event === "page" &&
                onlyKeys(data, ["generation", "committedOrigin", "hung"]) &&
                (data.committedOrigin === null || signInOrigin(data.committedOrigin)) &&
                (data.hung === undefined || typeof data.hung === "boolean")
            ) {
                page.committedOrigin = data.committedOrigin;

                if (data.hung === undefined) {
                    page.pins = [];
                    page.badge = 0;
                }

                page.hung = data.hung ?? false;
            } else if (event === "pins" && Array.isArray(data.items) && data.items.length <= 20) {
                page.pins = data.items.map(cleanPin).filter(Boolean);
            } else if (
                event === "badge" &&
                Number.isInteger(data.count) &&
                data.count >= 0 &&
                data.count <= 2147483647
            ) {
                page.badge = data.count;
            } else {
                return false;
            }
        } else {
            return false;
        }

        this.#publish();

        return true;
    }

    #local(data) {
        if (!validLocal(data)) {
            return false;
        }

        this.#state.home.local = data;
        this.#publish();

        return true;
    }

    #origins(origins) {
        return [...new Set(origins.map(signInOrigin))];
    }

    #save(transform) {
        const result = this.#saving.then(async () => {
            const next = transform(this.#state.preferences);

            if (!next) {
                throw invalid();
            }

            try {
                await savePreferences(this.#file, next);
            } catch {
                throw connectionError("save", "Desktop settings could not be saved.");
            }

            this.#state.preferences = next;
            this.#state.warnings = [];
            this.#publish();
        });

        this.#saving = result.catch(() => {});

        return result;
    }

    async #patch(patch) {
        await this.#save((previous) => {
            const next = patchPreferences(previous, patch, this.#rules);

            if (next) {
                next.home.allowedOrigins = this.#origins(next.home.allowedOrigins);
            }

            return next;
        });

        if (Object.hasOwn(patch, "window")) {
            void this.callHost("window.preferences", this.#state.preferences.window).catch(
                () => {},
            );
        }

        if (Object.hasOwn(patch, "home")) {
            this.#monitor();
        }
    }

    async #check(address) {
        this.#checks?.abort();
        const check = new AbortController();

        this.#checks = check;

        try {
            return await this.#probe(address, check);
        } finally {
            if (this.#checks === check) {
                this.#checks = null;
            }
        }
    }

    async #probe(address, attempt) {
        const report = (data) => {
            if (!attempt.signal.aborted) {
                this.#state.home.check = { address, ...data };
                this.#publish();
            }
        };

        report({ status: "checking", message: "Checking the server…" });

        try {
            const match = await probeServer(address, this.#state.preferences.home, attempt.signal);

            report({ status: match.kind, message: match.message });

            return match;
        } catch (error) {
            report({ status: "error", message: error.message, code: error.code });
            this.#log("home.probe", error.code);

            throw error;
        }
    }

    #switchAttempt() {
        this.#switched?.abort();
        this.#checks?.abort();
        this.#switched = new AbortController();

        return this.#switched;
    }

    async #connect(address, preview = false, startup = false) {
        const check = this.#state.home.check;

        if (preview && !startup && (check?.address !== address || check?.status !== "preview")) {
            throw invalid();
        }

        const attempt = this.#switchAttempt();
        const match = await this.#probe(address, attempt);

        if (match.kind === "preview" && !preview) {
            throw connectionError("preview", "Confirm that you want to open this sign-in webpage.");
        }

        return this.#activate(attempt, "remote", address, match);
    }

    async #activate(attempt, mode, address, { kind, bridge }) {
        const checkCanceled = () => {
            if (attempt.signal.aborted || this.#closed) {
                throw connectionError("canceled", "A different connection was selected.");
            }
        };

        await this.#save((previous) => {
            checkCanceled();

            return {
                ...previous,
                home: {
                    ...previous.home,
                    mode,
                    remoteAddress: mode === "remote" ? address : previous.home.remoteAddress,
                },
            };
        });
        checkCanceled();
        this.#failures = 0;
        this.#state.home.active = {
            mode,
            address,
            kind,
            bridge,
            status: "connected",
            generation: ++this.#generation,
            allowedOrigins:
                mode === "remote" ? [...this.#state.preferences.home.allowedOrigins] : [],
        };
        Object.assign(this.#state.page, {
            generation: this.#generation,
            committedOrigin: null,
            pins: [],
            badge: 0,
            hung: false,
        });
        this.#publish();
        this.#monitor();

        return this.#state.home.active;
    }

    async #localOpen() {
        if (this.#localOpening) {
            throw connectionError("busy", "Pi Pocket is still starting.");
        }

        const attempt = this.#switchAttempt();

        this.#localOpening = true;
        this.#local({ status: "starting", owned: this.#state.home.local.owned, verified: false });

        try {
            const config = await this.callHost("local.open", undefined, 370000);

            if (!this.#local(config) || config.status !== "running") {
                throw connectionError(
                    "local",
                    config?.message || "Pi Pocket on this computer did not start.",
                );
            }

            return await this.#activate(attempt, "local", config.address, {
                kind: "pocket",
                bridge: 1,
            });
        } catch (error) {
            if (this.#state.home.local.status === "starting") {
                this.#local({
                    status: "error",
                    owned: false,
                    verified: false,
                    message: error.message,
                });
            }

            throw error;
        } finally {
            this.#localOpening = false;
        }
    }

    async #localStop() {
        if (!this.#state.home.local.owned || this.#localOpening) {
            throw unavailable();
        }

        const local = await this.callHost("local.stop", undefined, 30000);

        if (!this.#local(local) || local.status !== "stopped") {
            throw unavailable();
        }

        if (this.#state.home.active?.mode === "local") {
            this.#state.home.active = null;
            Object.assign(this.#state.page, { pins: [], badge: 0, committedOrigin: null });
            this.#publish();
            this.#monitor();
        }
    }

    #localRestart() {
        if (!this.#state.home.local.verified) {
            throw unavailable();
        }

        return this.callHost("local.restart");
    }

    #monitor(delay) {
        clearTimeout(this.#timer);
        this.#checkingPage?.abort();
        const active = this.#state.home.active;
        const interval = this.#state.preferences.home.healthInterval;

        if (this.#closed || !active || !interval) {
            return;
        }

        this.#timer = setTimeout(
            () => void this.#health(active).catch(() => {}),
            delay ?? interval * 1000,
        ).unref();
    }

    async #health(active) {
        clearTimeout(this.#timer);
        this.#checkingPage?.abort();
        const test = new AbortController();
        const prefs = this.#state.preferences.home;
        const current = () => this.#state.home.active === active && !test.signal.aborted;

        this.#checkingPage = test;
        let delay;

        try {
            const match = await probeServer(
                active.address,
                { ...prefs, allowedOrigins: active.allowedOrigins },
                test.signal,
            );

            if (!current()) {
                return;
            }

            if (match.kind === "preview" && active.kind !== "preview") {
                throw connectionError("identity", "The server no longer identifies as Pi Pocket.");
            }

            this.#failures = 0;

            if (active.kind === "preview" && match.kind !== "preview") {
                const generation = ++this.#generation;

                Object.assign(active, { kind: match.kind, bridge: match.bridge, generation });
                this.#state.page.generation = generation;
            }

            active.status = "connected";
            active.message = match.message;
            this.#publish();
        } catch (error) {
            if (!current()) {
                return;
            }

            this.#failures++;

            if (this.#failures >= prefs.failureThreshold) {
                active.status = "reconnecting";
                active.message = error.message;
                this.#log("home.health", error.code || "network");
                this.#publish();
                delay =
                    Math.min(
                        prefs.maxBackoff,
                        prefs.healthInterval *
                            2 ** Math.min(6, this.#failures - prefs.failureThreshold),
                    ) *
                    (750 + Math.random() * 250);
            }
        } finally {
            if (current()) {
                this.#monitor(delay);
            }
        }
    }

    async #retry() {
        this.#failures = 0;
        const active = this.#state.home.active;

        if (active?.mode === "remote") {
            await this.#health(active);
        } else if (this.#state.preferences.home.remoteAddress) {
            await this.#connect(this.#state.preferences.home.remoteAddress, true, true);
        } else {
            throw unavailable();
        }
    }

    close() {
        this.#closed = true;
        this.#checks?.abort();
        this.#switched?.abort();
        this.#monitor();

        for (const { timer, reject } of this.#pending.values()) {
            clearTimeout(timer);
            reject(unavailable());
        }

        this.#pending.clear();
    }
}

function structuredCloneRules() {
    return {
        ...Object.fromEntries(
            Object.entries(preferenceRules).map(([key, rules]) => [key, { ...rules }]),
        ),
        home: { ...preferenceRules.home, allowedOrigins },
    };
}
