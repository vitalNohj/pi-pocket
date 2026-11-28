import { join } from "node:path";
import { isText, onlyKeys } from "../../protocol/index.mjs";
import { RunnerController, RunnerError } from "./index.mjs";
import { runnerPolicy } from "./policy.mjs";
import { installedRunner } from "./process.mjs";
import { DESKTOP_RUNNER_SOURCE } from "./source.mjs";

const optionalFlag = (value) => value === undefined || typeof value === "boolean";
const confirmation = (data) =>
    data === undefined || (onlyKeys(data, ["confirmed"]) && optionalFlag(data.confirmed));

export function registerRunner(desktop, folder, adapter) {
    const stateDir = join(folder, "runner");
    const publish = (snapshot) => desktop.setSlice("runner", snapshot);
    const runner = new RunnerController({
        ...(adapter ?? { start: installedRunner({ stateDir }), ...runnerPolicy(stateDir) }),
        publish,
    });

    publish({ ...runner.state, source: DESKTOP_RUNNER_SOURCE });

    function action(name, validate, run) {
        desktop.registerAction(`runner.${name}`, validate, async (data) => {
            try {
                await run(data);
            } catch (error) {
                // Only the runner controller's fixed messages are safe for wire replies.
                if (error instanceof RunnerError) {
                    throw { code: error.code, message: error.message };
                }

                throw error;
            }
        });
    }

    action(
        "link",
        (data) =>
            onlyKeys(data, ["server", "code", "trusted", "allowHttp", "confirmed"]) &&
            isText(data.server, 2048) &&
            isText(data.code, 32) &&
            typeof data.trusted === "boolean" &&
            optionalFlag(data.allowHttp) &&
            optionalFlag(data.confirmed),
        (data) => runner.link(data),
    );
    action(
        "enable",
        (data) =>
            onlyKeys(data, ["enabled", "confirmed"]) &&
            typeof data.enabled === "boolean" &&
            optionalFlag(data.confirmed),
        (data) => runner.setEnabled(data.enabled, data.confirmed),
    );
    action("reconnect", confirmation, (data) => runner.reconnect(data?.confirmed));
    action("unlink", confirmation, (data) => runner.unlink(data?.confirmed));

    return runner;
}
