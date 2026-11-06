/**
 * `pi-pocket runner service`: keep the runner running as a systemd user service (Linux), for a computer nobody sits
 * at, such as a build server.
 *
 * With nobody at the computer, nobody can answer the question before a session or a folder: the only way to approve
 * one is a code from an authenticator (`totp.ts`), typed in Pi Pocket. So the service needs an authenticator on this
 * computer: installing it refuses without one, and the service itself refuses to start without one (it exits with
 * `SERVICE_NEEDS_TOTP`, which systemd does not restart). Saved folders alone are not enough: they approve new sessions
 * there only when stop-asking is on, and a folder outside them could then never be approved.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** The systemd user unit. */
export const UNIT = "pi-pocket-runner.service";

/** `runner start --service` exits with this when no authenticator is set up: systemd does not start it again. */
export const SERVICE_NEEDS_TOTP = 4;

/** What a service needs, and how to get it, when this computer has no authenticator. */
export const NEEDS_TOTP =
    "A service runs with nobody at this computer, so only a code from an authenticator app, typed in Pi Pocket, can approve its sessions and folders. Set one up first, in a terminal here:\n  pi-pocket runner totp setup\nThen run: pi-pocket runner service";

/** Where the unit file goes: the user's systemd folder. */
export function unitPath(env: NodeJS.ProcessEnv = process.env): string {
    return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", UNIT);
}

/** Whether this computer can run the service: Linux with systemd. */
export function canService(): boolean {
    return process.platform === "linux" && spawnSync("systemctl", ["--version"]).status === 0;
}

/** Whether the service runs now. */
export function serviceActive(): boolean {
    return (
        process.platform === "linux" &&
        spawnSync("systemctl", ["--user", "is-active", "--quiet", UNIT]).status === 0
    );
}

const quote = (value: string) => `"${value.replace(/(["\\])/g, "\\$1")}"`;

/**
 * The unit: this Node, this Pi Pocket, this link file, and this PATH (the tools sessions run find what this shell
 * finds). `noRestart`: exit codes after which starting again would not help.
 */
export function serviceUnit(options: {
    node: string;
    launcher: string;
    file: string;
    path: string;
    noRestart: readonly number[];
}): string {
    return [
        "[Unit]",
        "Description=Pi Pocket runner: run session tools on this computer",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        // `--service`: no terminal to ask on; it refuses to start without an authenticator.
        `ExecStart=${quote(options.node)} ${quote(options.launcher)} runner start --service --config ${quote(options.file)}`,
        `Environment=${quote(`PATH=${options.path}`)}`,
        "Restart=on-failure",
        "RestartSec=5",
        `RestartPreventExitStatus=${options.noRestart.join(" ")}`,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
}
