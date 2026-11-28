import {
    checkDesktopUpdate,
    DesktopUpdateError,
    isDesktopVersion,
    isNewerDesktopVersion,
} from "../../feed/desktop-builds.mjs";
import { onlyKeys } from "../../protocol/index.mjs";
import {
    applyDesktopUpdate,
    desktopUpdateState,
    lastUpdateError,
    prepareDesktopUpdate,
} from "./desktop-updates.mjs";

const noData = (data) => data === undefined;
const downloadLink =
    /^https:\/\/github\.com\/vitalNohj\/pi-pocket\/actions\/runs\/[1-9]\d*\/artifacts\/[1-9]\d*$/;

export async function registerDesktopUpdates(desktop, { version, platform, folder, request }) {
    const enabled =
        Boolean(folder) && isDesktopVersion(version) && ["win32", "darwin"].includes(platform);
    let status;
    let latest = null;
    let working = false;
    let candidate;

    function publish(phase, message = null) {
        status = phase;
        desktop.setSlice("updates", { status, latest, message });
    }

    if (enabled) {
        const saved = await desktopUpdateState(version, platform, folder);
        const failure = lastUpdateError(saved.last, version);

        latest =
            saved.version ??
            (failure && isNewerDesktopVersion(saved.last.version, version)
                ? saved.last.version
                : null);
        publish(failure ? "failed" : saved.phase, failure);
    } else {
        publish("disabled", "This installation is not on the desktop-native test build channel.");
    }

    desktop.registerHostCommand(
        "updates.openDownload",
        (data) =>
            onlyKeys(data, ["url"]) && typeof data.url === "string" && downloadLink.test(data.url),
    );
    desktop.registerHostCommand("updates.pickInstaller", noData);

    async function attempt(fallback, operation) {
        if (!enabled || working) {
            return;
        }

        working = true;

        try {
            await operation();
        } catch (error) {
            publish("failed", error instanceof DesktopUpdateError ? error.message : fallback);
        } finally {
            working = false;
        }
    }

    function check() {
        if (status === "ready" || status === "staged") {
            return;
        }

        return attempt(
            "Pi Pocket could not check GitHub. Check your connection and try again.",
            async () => {
                candidate = undefined;
                publish("checking");
                const result = await checkDesktopUpdate(version, platform, request);

                latest = result.version ?? null;
                candidate = result.phase === "available" ? result : undefined;
                publish(
                    result.phase,
                    result.phase === "unavailable"
                        ? "No desktop installer is available on GitHub. Check again later."
                        : null,
                );
            },
        );
    }

    desktop.registerAction("updates.check", noData, check);
    desktop.registerAction("updates.download", noData, () => {
        if (status !== "available") {
            return;
        }

        return attempt("Pi Pocket could not open the download link in your browser.", async () => {
            publish("opening");
            const opened = await desktop.callHost("updates.openDownload", {
                url: candidate.downloadUrl,
            });

            if (opened !== true) {
                throw new Error("Browser did not open");
            }

            publish("downloading");
        });
    });
    desktop.registerAction("updates.selectInstaller", noData, () => {
        if (status !== "downloading") {
            return;
        }

        return attempt(
            "Pi Pocket could not read or save the installer. Check that the file is available and try again.",
            async () => {
                publish("selecting");
                const selected = await desktop.callHost(
                    "updates.pickInstaller",
                    undefined,
                    300_000,
                );

                if (selected === null) {
                    publish("downloading");

                    return;
                }

                publish("verifying");
                await prepareDesktopUpdate(version, platform, candidate, selected, folder);
                candidate = undefined;
                publish("ready");
            },
        );
    });
    desktop.registerAction("updates.apply", noData, () => {
        if (status !== "ready") {
            return;
        }

        return attempt(
            "Pi Pocket could not stage the update. Check and download it again.",
            async () => {
                publish("staging");
                await applyDesktopUpdate(version, platform, folder);
                publish("staged");
            },
        );
    });

    return () => {
        if (status === "idle" && desktop.snapshot().preferences.updates.checkAtStartup) {
            void check();
        }
    };
}
