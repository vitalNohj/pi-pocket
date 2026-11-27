export const boolean = (value) => typeof value === "boolean";
export const choice =
    (...values) =>
    (value) =>
        values.includes(value);
export const integer = (min, max) => (value) =>
    Number.isInteger(value) && value >= min && value <= max;

export const effects = ["available", "unsupported", "page", "full-screen"];
export const materials = {
    windows: ["acrylic", "mica"],
    macos: ["window", "sidebar", "dark", "full-screen"],
};

// Canonical modifier order is shared with the Settings recorder. Require a non-Shift modifier.
export const shortcut = (value) =>
    typeof value === "string" &&
    /^(Ctrl\+)?(Alt\+)?(Meta\+)?(Shift\+)?[A-Z0-9]$/.test(value) &&
    /^(Ctrl|Alt|Meta)\+/.test(value);

export function initialState(platform, version, existingInstall) {
    return {
        revision: 0,
        platform,
        version,
        warnings: [],
        home: {
            active: null,
            local: { status: "stopped", owned: false, verified: false },
            check: null,
        },
        page: {
            generation: 0,
            committedOrigin: null,
            pins: [],
            pinFeed: null,
            badge: 0,
            visible: false,
            hung: false,
        },
        window: {
            focused: false,
            loginEnabled: null,
            shortcutActive: null,
            effect: "page",
            theme: null,
            idle: false,
            suspended: false,
        },
        runner: { status: "checking", label: "Checking link", working: false },
        updates: { status: "disabled", latest: null, message: null },
        dictation: { status: "unavailable", recording: false, canDictate: false, canCopy: false },
        notifications: { permission: "unknown" },
        preferences: {
            home: {
                mode: existingInstall ? "local" : null,
                remoteAddress: "",
                connectAtStartup: true,
                allowedOrigins: [],
                healthInterval: 10,
                failureThreshold: 3,
                maxBackoff: 30,
                probeTimeout: 4,
            },
            window: {
                closeToTray: true,
                startHidden: existingInstall,
                titleBar: existingInstall ? "system" : "seamless",
                showMenuBar: false,
                links: "app",
                developerTools: false,
                shortcutEnabled: false,
                shortcut: platform === "macos" ? "Meta+Shift+P" : "Ctrl+Shift+P",
            },
            appearance: {
                transparent: false,
                opacity: 82,
                material: materials[platform][0],
                trayStyle: "system",
            },
            notifications: { enabled: true, sound: true, approve: "full", commandLimit: 120 },
            runner: {},
            updates: { checkAtStartup: true },
            dictation: { anywhere: false },
            server: {},
        },
    };
}

// The controller also supports validated feature fields registered by installed code, never by a view.
export const preferenceRules = {
    home: {
        connectAtStartup: boolean,
        healthInterval: integer(0, 300),
        failureThreshold: integer(1, 10),
        maxBackoff: integer(1, 300),
        probeTimeout: integer(1, 30),
    },
    window: {
        closeToTray: boolean,
        startHidden: boolean,
        titleBar: choice("seamless", "system"),
        showMenuBar: boolean,
        links: choice("app", "browser"),
        developerTools: boolean,
        shortcutEnabled: boolean,
        shortcut,
    },
    appearance: {
        transparent: boolean,
        opacity: integer(0, 100),
        trayStyle: choice("system", "pocket"),
    },
    notifications: {
        enabled: boolean,
        sound: boolean,
        approve: choice("full", "always", "never"),
        commandLimit: integer(20, 2000),
    },
    runner: {},
    updates: { checkAtStartup: boolean },
    dictation: { anywhere: boolean },
    server: {},
};
