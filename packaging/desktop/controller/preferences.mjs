import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord, MAX_PACKET_BYTES } from "../protocol/index.mjs";

export async function readPreferences(file, defaults, rules) {
    const preferences = structuredClone(defaults);
    const warnings = [];
    let stored;

    try {
        const handle = await open(file, "r");

        try {
            if (!(await handle.stat()).isFile()) {
                throw new Error("Not a settings file");
            }

            const buffer = Buffer.alloc(MAX_PACKET_BYTES + 1);
            const { bytesRead } = await handle.read(buffer);

            if (bytesRead === buffer.length) {
                throw new Error("Settings file too large");
            }

            stored = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error.code === "ENOENT") {
            return { preferences, warnings, missing: true };
        }

        return {
            preferences,
            warnings: ["Desktop settings could not be read. Defaults are in use."],
            missing: false,
        };
    }

    if (!isRecord(stored) || stored.schemaVersion !== 1 || !isRecord(stored.preferences)) {
        return {
            preferences,
            warnings: ["Desktop settings have an unsupported format. Defaults are in use."],
            missing: false,
        };
    }

    for (const [section, fields] of Object.entries(rules)) {
        const values = stored.preferences[section];

        if (values === undefined) {
            continue;
        }

        if (!isRecord(values)) {
            warnings.push(`Desktop settings: ${section} uses defaults.`);
            continue;
        }

        for (const [key, valid] of Object.entries(fields)) {
            if (Object.hasOwn(values, key)) {
                if (valid(values[key])) {
                    preferences[section][key] = values[key];
                } else {
                    warnings.push(`Desktop settings: ${section}.${key} uses its default.`);
                }
            }
        }
    }

    return { preferences, warnings, missing: false };
}

export function patchPreferences(previous, patch, rules) {
    if (!isRecord(patch)) {
        return null;
    }

    const next = structuredClone(previous);

    for (const [section, fields] of Object.entries(patch)) {
        if (!Object.hasOwn(rules, section) || !isRecord(fields)) {
            return null;
        }

        for (const [key, value] of Object.entries(fields)) {
            if (!Object.hasOwn(rules[section], key) || !rules[section][key](value)) {
                return null;
            }

            next[section][key] = value;
        }
    }

    return next;
}

export async function savePreferences(file, preferences) {
    const content = `${JSON.stringify({ schemaVersion: 1, preferences }, null, 4)}\n`;

    if (Buffer.byteLength(content) > MAX_PACKET_BYTES) {
        throw new Error("Settings file too large");
    }

    const temp = `${file}.${randomUUID()}.tmp`;

    await mkdir(dirname(file), { recursive: true, mode: 0o700 });

    try {
        await writeFile(temp, content, { flag: "wx", mode: 0o600 });
        await rename(temp, file);
    } finally {
        await rm(temp, { force: true }).catch(() => {});
    }
}
