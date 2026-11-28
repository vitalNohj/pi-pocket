// The private controller pipe and the separate, narrower Desktop Settings API.
export const VERSION = 1;
export const MAX_PACKET_BYTES = 64 * 1024;
export const SETTINGS_COMMANDS = Object.freeze([
    "getState",
    "subscribe",
    "patchPreferences",
    "action",
]);

export const SECTIONS = Object.freeze([
    "home",
    "runner",
    "updates",
    "dictation",
    "window",
    "appearance",
    "notifications",
    "server",
]);

export const WINDOW_ACTIONS = Object.freeze([
    "window.open",
    "window.newSession",
    "window.newWindow",
    "window.reload",
    "window.back",
    "window.forward",
    "window.actualSize",
    "window.zoomIn",
    "window.zoomOut",
    "window.fullScreen",
    "window.devTools",
    "window.close",
    "window.minimize",
    "window.pinned",
    "settings.open",
    "settings.back",
    "app.quit",
    "help.repository",
    "help.documentation",
    "help.releases",
    "logs.open",
    "preferences.open",
    "local.log",
    "notifications.refresh",
    "notifications.systemSettings",
]);

export const HOST_EVENTS = Object.freeze([
    "local",
    "page",
    "pins",
    "badge",
    "focus",
    "visibility",
    "power",
    "platform",
    "notifications",
]);

export const HOST_COMMANDS = Object.freeze([
    ...WINDOW_ACTIONS,
    "local.inspect",
    "local.open",
    "local.stop",
    "local.restart",
    "window.preferences",
]);

export const isRecord = (value) =>
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
export const isId = (value) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
export const isText = (value, limit) => typeof value === "string" && value.length <= limit;
export const isSection = (value) => SECTIONS.includes(value);
export const onlyKeys = (object, keys) =>
    isRecord(object) && Object.keys(object).every((key) => keys.includes(key));

function bounded(value, depth = 0) {
    if (depth > 10) {
        return false;
    }

    if (Array.isArray(value)) {
        return value.length <= 128 && value.every((item) => bounded(item, depth + 1));
    }

    if (isRecord(value)) {
        return (
            Object.keys(value).length <= 64 &&
            Object.entries(value).every(
                ([key, item]) =>
                    key.length <= 64 &&
                    !["__proto__", "prototype", "constructor"].includes(key) &&
                    bounded(item, depth + 1),
            )
        );
    }

    return (
        value === null ||
        typeof value === "boolean" ||
        Number.isFinite(value) ||
        isText(value, 4096)
    );
}

export function parseRequest(text) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_PACKET_BYTES) {
        return null;
    }

    try {
        const value = JSON.parse(text);
        const commands = [...SETTINGS_COMMANDS, "host.report", "host.result"];

        return onlyKeys(value, ["v", "id", "command", "value"]) &&
            value.v === VERSION &&
            isId(value.id) &&
            commands.includes(value.command) &&
            bounded(value)
            ? value
            : null;
    } catch {
        return null;
    }
}

export const packet = (type, fields) => ({ v: VERSION, type, ...fields });

export const PIN_GLYPHS = Object.freeze({
    waiting: "◆",
    limited: "◈",
    working: "◐",
    failed: "✕",
    fresh: "●",
    seen: "○",
});

export function menuModel(state) {
    const { active, local } = state.home;
    const { pins, pinFeed, badge } = state.page;
    const page = Boolean(active);
    const item = (id, label, enabled = true, data) => ({
        id,
        label,
        enabled,
        ...(data ? { data } : {}),
    });
    const settings = item("settings.open", "Desktop Settings…");
    const session = item("window.newSession", "New Session", page && active.kind !== "preview");
    const newWindow = item("window.newWindow", "New Window", page);
    const pinned =
        active?.kind === "pocket" && pinFeed && pins.length > 0
            ? [
                  {
                      label: "Pinned Sessions",
                      items: pins.map(({ id, title, state, label }) =>
                          item(
                              "window.pinned",
                              `${PIN_GLYPHS[state]} ${title || `Session ${id}`} — ${label}`,
                              true,
                              { id, feed: pinFeed },
                          ),
                      ),
                  },
              ]
            : [];
    const { status, working } = state.runner;
    const runnerLabel = working
        ? "Working now"
        : status === "connected"
          ? "Connected"
          : ["connecting", "offline", "retrying"].includes(status)
            ? "Connecting"
            : "Off";
    const runner = item("settings.open", `Runner: ${runnerLabel}`, true, { section: "runner" });
    const tray = [
        item("window.open", badge ? `Open Pi Pocket (${badge} need you)` : "Open Pi Pocket"),
        session,
        newWindow,
        item("window.reload", state.page.hung ? "Reload (page not responding)" : "Reload", page),
        ...pinned,
        { separator: true },
        runner,
        item(
            "dictation.toggle",
            state.dictation.recording ? "Stop Dictation" : "Dictate",
            state.dictation.canDictate,
        ),
        item("dictation.copyLast", "Copy Last Dictation", state.dictation.canCopy),
        ...(active?.mode === "local" && local?.verified
            ? [item("home.local.restart", "Restart Server")]
            : []),
        ...(state.updates.available
            ? [item("settings.open", "Desktop App Update…", true, { section: "updates" })]
            : []),
        settings,
        { separator: true },
        item("app.quit", "Quit Pi Pocket"),
    ];

    return { tray, dock: [session, newWindow, ...pinned, settings] };
}

// pocketHost (docs/embedders.md) is independent of the Settings API. Retain the optional event subscription.
export const PAGE_CAPABILITIES = Object.freeze([
    "menu",
    "visibility",
    "badge",
    "notify",
    "pinned",
    "open",
    "newSession",
]);
export const PAGE_DEFAULT_EVENTS = Object.freeze(["visibility", "open", "approve"]);
export const PAGE_SETTINGS_ITEM = Object.freeze({
    id: "server-settings",
    label: "Desktop Settings…",
});
