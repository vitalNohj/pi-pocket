export const boolean = (value) => typeof value === "boolean";
export const choice =
    (...values) =>
    (value) =>
        values.includes(value);
export const integer = (min, max) => (value) =>
    Number.isInteger(value) && value >= min && value <= max;

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
            badge: 0,
            visible: false,
            hung: false,
        },
        window: { focused: false, loginEnabled: null, idle: false, suspended: false },
        runner: { status: "unlinked", label: "Not linked", working: false },
        updates: { status: "unavailable", available: false },
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
                startHidden: true,
                titleBar: existingInstall ? "system" : "seamless",
                showMenuBar: false,
                links: "app",
                developerTools: false,
                shortcutEnabled: false,
            },
            appearance: { transparent: false, opacity: 82 },
            notifications: { enabled: true, sound: true, approve: "full", commandLimit: 120 },
            runner: { enabled: false },
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
    },
    appearance: { transparent: boolean, opacity: integer(0, 100) },
    notifications: {
        enabled: boolean,
        sound: boolean,
        approve: choice("full", "always", "never"),
        commandLimit: integer(20, 2000),
    },
    runner: { enabled: boolean },
    updates: { checkAtStartup: boolean },
    dictation: { anywhere: boolean },
    server: {},
};
