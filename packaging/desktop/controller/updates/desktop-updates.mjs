import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
    checkDesktopUpdate,
    installerLimit,
    installerName,
    isDesktopVersion,
    isNewerDesktopVersion,
    sha256Pattern,
} from "../../feed/desktop-builds.mjs";

export const stateFolderName = "desktop-update-cache";
const pendingFile = "pending.json";
const handoffFile = "applying.json";
const lockTime = 10 * 60 * 1000;

async function readRecord(folder, name) {
    try {
        const file = join(folder, name);

        if ((await stat(file)).size <= 4096) {
            return JSON.parse(await readFile(file, "utf8"));
        }
    } catch {
        // A missing or interrupted record does not prevent an ordinary launch.
    }

    return null;
}

async function writeRecord(folder, name, value) {
    const temp = await mkdtemp(join(folder, ".record-"));

    try {
        await writeFile(join(temp, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
        await rename(join(temp, name), join(folder, name));
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}

function recordIsValid(update, current, platform) {
    return (
        update &&
        isNewerDesktopVersion(update.version, current) &&
        sha256Pattern.test(update.sha256) &&
        Number.isSafeInteger(update.size) &&
        update.size > 0 &&
        update.size <= installerLimit &&
        update.platform === platform
    );
}

function cachedInstaller(folder, update) {
    return join(folder, `${update.sha256}-${installerName(update.platform, update.version)}`);
}

async function verifyInstaller(file, { size, sha256 }) {
    const information = await lstat(file);

    if (!information.isFile() || information.size !== size) {
        throw new Error("The desktop installer has the wrong size.");
    }

    const hash = createHash("sha256");
    let bytes = 0;

    for await (const chunk of createReadStream(file)) {
        bytes += chunk.length;

        if (bytes > size) {
            throw new Error("The desktop installer has the wrong size.");
        }

        hash.update(chunk);
    }

    if (bytes !== size || hash.digest("hex") !== sha256) {
        throw new Error("The desktop installer does not match GitHub's SHA-256.");
    }
}

function waitForCommand(executable, args, { timeout = 30_000 } = {}) {
    return new Promise((done, fail) => {
        const child = spawn(executable, args, {
            stdio: "ignore",
            windowsHide: true,
            timeout,
        });

        child.once("error", fail);
        child.once("exit", (code) => {
            if (code === 0) {
                done();
            } else {
                fail(
                    new Error(
                        `The desktop update command did not finish (exit ${code ?? "timeout"}).`,
                    ),
                );
            }
        });
    });
}

// The selected file comes from the system file picker, not from the server page. Always check the
// pinned feed again before trusting its bytes. No filename or installer flags come from the picker.
export async function stageDesktopUpdate(current, platform, selected, folder, request) {
    const candidate = await checkDesktopUpdate(current, platform, request);

    if (candidate.phase !== "available") {
        throw new Error("There is no newer desktop build to stage. Check again first.");
    }

    const { version, sha256, size } = candidate;
    const update = { version, sha256, size, platform };
    const source = resolve(selected);
    const information = await lstat(source);

    if (!information.isFile() || information.size !== size) {
        throw new Error("Choose the matching installer downloaded from GitHub.");
    }

    await mkdir(folder, { mode: 0o700, recursive: true });
    const temp = await mkdtemp(join(folder, ".download-"));
    const file = join(temp, installerName(platform, version));

    try {
        if (process.platform === "darwin") {
            // Keep extended attributes (including download quarantine) on the browser's package.
            await waitForCommand("/bin/cp", ["-p", source, file]);
        } else {
            await copyFile(source, file);
        }

        await verifyInstaller(file, update);
        const old = await readRecord(folder, pendingFile);

        await rename(file, cachedInstaller(folder, update));
        await writeRecord(folder, pendingFile, update);

        if (recordIsValid(old, current, platform) && old.sha256 !== sha256) {
            await rm(cachedInstaller(folder, old), { force: true });
        }
    } finally {
        await rm(temp, { recursive: true, force: true });
    }

    return { phase: "staged", current, version };
}

function layout(app) {
    if (process.platform === "win32" && basename(app) === "Pi Pocket.exe") {
        return { install: dirname(app), app };
    }

    if (process.platform === "darwin") {
        const install = join(homedir(), "Library", "Application Support", "Pi Pocket");

        if (
            [
                join(homedir(), "Applications", "Pi Pocket.app"),
                join(install, "Pi Pocket.app"),
            ].includes(app)
        ) {
            return { install, app };
        }
    }

    throw new Error("Desktop updates are not available from this install location.");
}

function runDetached(executable, args) {
    return new Promise((done, fail) => {
        const child = spawn(executable, args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });

        child.once("error", fail);
        child.once("spawn", () => {
            child.unref();
            done();
        });
    });
}

async function reserveHandoff(folder) {
    const lock = join(folder, handoffFile);
    const info = await stat(lock).catch(() => null);

    if (info && Date.now() - info.mtimeMs < lockTime) {
        return false;
    }

    if (info) {
        await rm(lock, { force: true });
    }

    try {
        await writeFile(lock, "{}\n", { flag: "wx", mode: 0o600 });

        return true;
    } catch (error) {
        if (error.code === "EEXIST") {
            return false;
        }

        throw error;
    }
}

// Run before starting an owned server, or only when the host can quit without stopping one.
// The detached helper waits for this app PID, not for any server or runner processes.
async function handoff(current, app, folder, args) {
    const locked = await stat(join(folder, handoffFile)).catch(() => null);

    if (locked && Date.now() - locked.mtimeMs < lockTime) {
        return { phase: "busy", current };
    }

    const update = await readRecord(folder, pendingFile);

    if (!recordIsValid(update, current, process.platform)) {
        return { phase: "idle", current };
    }

    if (!(await reserveHandoff(folder))) {
        return { phase: "busy", current };
    }

    try {
        await runDetached(process.execPath, [
            fileURLToPath(import.meta.url),
            "finish",
            current,
            app,
            ...args,
        ]);
    } catch (error) {
        await rm(join(folder, handoffFile), { force: true });

        throw error;
    }

    return { phase: "handoff", current, version: update.version };
}

function processExists(pid) {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return error.code !== "ESRCH";
    }
}

async function finish(current, { app, install }, folder, pidText, hidden) {
    const pid = Number(pidText);

    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
        throw new Error("A desktop update needs the app's process ID.");
    }

    const update = await readRecord(folder, pendingFile);
    const result = { phase: "error", current, version: update?.version };
    let exited = false;
    let file;

    try {
        for (let elapsed = 0; elapsed < 20_000 && processExists(pid); elapsed += 100) {
            await setTimeout(100);
        }

        exited = !processExists(pid);

        if (!exited) {
            throw new Error("Pi Pocket did not close. Check for the desktop update again.");
        }

        if (!recordIsValid(update, current, process.platform)) {
            throw new Error("No verified desktop update is staged.");
        }

        file = cachedInstaller(folder, update);
        await verifyInstaller(file, update);

        if (process.platform === "win32") {
            await waitForCommand(
                file,
                [
                    "/VERYSILENT",
                    "/SUPPRESSMSGBOXES",
                    "/SP-",
                    "/NORESTART",
                    `/DIR=${install}`,
                    `/LOG=${join(folder, "setup.log")}`,
                ],
                { timeout: 180_000 },
            );
        } else {
            await waitForCommand(
                "/usr/sbin/installer",
                ["-pkg", file, "-target", "CurrentUserHomeDirectory"],
                { timeout: 180_000 },
            );
        }

        result.phase = "applied";
    } catch (error) {
        result.message = error.message;
    } finally {
        // Consume the attempt even if the OS would not install it. Do not loop on every app start.
        await rm(join(folder, pendingFile), { force: true });
        await writeRecord(folder, "last-result.json", result);
        await rm(join(folder, handoffFile), { force: true });
    }

    if (result.phase === "applied") {
        await rm(file, { force: true }).catch(() => {});
    }

    if (exited) {
        const args = hidden ? ["--hidden"] : [];

        if (process.platform === "win32") {
            await runDetached(app, args);
        } else {
            await waitForCommand("/usr/bin/open", [
                "-a",
                app,
                ...(hidden ? ["--args", ...args] : []),
            ]);
        }
    }

    return result;
}

async function main([command, current, app, ...args]) {
    if (!isDesktopVersion(current)) {
        return { phase: "disabled", current };
    }

    const location = layout(resolve(app));
    const folder = join(location.install, stateFolderName);

    switch (command) {
        case "check":
            return checkDesktopUpdate(current, process.platform);
        case "stage":
            return stageDesktopUpdate(current, process.platform, args[0], folder);

        case "state": {
            const update = await readRecord(folder, pendingFile);
            const last = await readRecord(folder, "last-result.json");

            return recordIsValid(update, current, process.platform)
                ? { phase: "staged", current, version: update.version }
                : { phase: "idle", current, last };
        }

        case "handoff":
            return handoff(current, location.app, folder, args);
        case "finish":
            return finish(current, location, folder, args[0], args[1] === "--hidden");
        default:
            throw new Error("Unknown desktop update command.");
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        console.log(JSON.stringify(await main(process.argv.slice(2))));
    } catch (error) {
        console.log(JSON.stringify({ phase: "error", message: error.message }));
        process.exitCode = 1;
    }
}
