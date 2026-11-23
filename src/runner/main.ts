/**
 * `pi-pocket runner`: starts the runner (the package `pi-pocket-runner`, `packages/runner/` in the repository) when it
 * is here. Pi Pocket's server never loads it. Keep this file at this path: a program that runs the runner, such as the
 * desktop app, looks for it to know that this Pi Pocket can run one.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** What the runner's entry gives: its `main`, with how it was started (`packages/runner/src/invoked.ts`). */
type RunnerEntry = {
    main: (
        argv: string[],
        invoked: { command: string; words: readonly string[]; install: string },
    ) => Promise<void>;
};

/** The runner's package, as npm installs it beside Pi Pocket. */
const PACKAGE = "pi-pocket-runner";

/**
 * Where the runner is. First the folder beside this Pi Pocket (a checkout, or an install of the repository itself): it
 * is this Pi Pocket's own code, and a `node_modules` that several checkouts share can link another checkout's. Else
 * the installed package.
 */
function runnerSpecifier(): string {
    const beside = new URL("../../packages/runner/main.js", import.meta.url);

    return existsSync(fileURLToPath(beside)) ? beside.href : `${PACKAGE}/main`;
}

/** Whether `error` says that the runner's package is not installed, and nothing else. */
function missing(error: unknown): boolean {
    const { code, message } = error as { code?: unknown; message?: unknown };

    return (
        code === "ERR_MODULE_NOT_FOUND" &&
        typeof message === "string" &&
        message.includes(`'${PACKAGE}'`)
    );
}

export async function main(argv: string[]): Promise<void> {
    // In a variable, so that `tsc` does not need the package to be installed.
    const specifier = runnerSpecifier();
    let runner: RunnerEntry;

    try {
        runner = (await import(specifier)) as RunnerEntry;
    } catch (error) {
        if (!missing(error)) {
            throw error;
        }

        console.error(`The runner is not installed. Install it with: npm install -g ${PACKAGE}`);
        process.exit(1);
    }

    await runner.main(argv, {
        command: "pi-pocket runner",
        words: ["runner"],
        install: "pi-pocket@latest",
    });
}
