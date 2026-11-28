import { open } from "node:fs/promises";
import { isRecord, onlyKeys } from "../protocol/index.mjs";
import { boolean, effects, shortcut } from "../protocol/state.mjs";

// Import the previous native Window Options file once, before the first app snapshot.
// Only its explicit fields override desktop.json; other sections are left alone.
export async function importWindowPreferences(file, preferences, rules) {
    let old;

    try {
        const handle = await open(file, "r");

        try {
            if (!(await handle.stat()).isFile()) {
                return;
            }

            const buffer = Buffer.alloc(4097);
            const { bytesRead } = await handle.read(buffer);

            if (bytesRead < buffer.length) {
                old = JSON.parse(
                    buffer
                        .subarray(0, bytesRead)
                        .toString("utf8")
                        .replace(/^\uFEFF/, ""),
                );
            }
        } finally {
            await handle.close();
        }
    } catch {
        return; // The legacy file is optional. A bad file cannot prevent startup.
    }

    if (!isRecord(old)) {
        return;
    }

    const fields = {
        window: {
            titleBar: old.titleBar,
            closeToTray: old.closeToTray,
            startHidden: old.startHidden,
            showMenuBar: old.showMenuBar,
            developerTools: old.developerTools,
            links: boolean(old.externalPages) ? (old.externalPages ? "browser" : "app") : undefined,
            shortcutEnabled: old.globalShortcut,
        },
        appearance: { transparent: old.seeThrough, opacity: old.opacity, material: old.material },
    };

    for (const [section, values] of Object.entries(fields)) {
        for (const [key, value] of Object.entries(values)) {
            if (rules[section][key](value)) {
                preferences[section][key] = value;
            }
        }
    }
}

export const loginSetting = (data) => onlyKeys(data, ["enabled"]) && boolean(data.enabled);
export const shortcutSetting = (data) =>
    onlyKeys(data, ["enabled", "shortcut"]) && boolean(data.enabled) && shortcut(data.shortcut);

export const validWindowStatus = (data) =>
    onlyKeys(data, ["effect", "shortcutActive"]) &&
    (data.effect === undefined || effects.includes(data.effect)) &&
    (data.shortcutActive === undefined || boolean(data.shortcutActive));

export const validWindowTheme = (data) =>
    onlyKeys(data, ["dark", "background", "panel", "text", "accent"]) &&
    boolean(data.dark) &&
    [data.background, data.panel, data.text, data.accent].every(
        (color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color),
    );
