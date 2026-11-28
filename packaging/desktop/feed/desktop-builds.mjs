// The updater trusts only successful push runs of this workflow in the public fork.
// Pull request builds and workflow dispatches are available to testers, not to this feed.
const source = "/repos/vitalNohj/pi-pocket";
const website = "https://github.com/vitalNohj/pi-pocket";
const builds = `${source}/actions/workflows/desktop-builds.yml/runs`;
const versionPattern =
    /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})-desktop\.([1-9]\d{0,8})$/;

export const installerLimit = 128 * 1024 * 1024;
export const sha256Pattern = /^[a-f0-9]{64}$/;

// Only fixed messages or validated numbers belong in errors that Settings displays.
export class DesktopUpdateError extends Error {}

function parseVersion(version) {
    return typeof version === "string" ? versionPattern.exec(version)?.slice(1).map(Number) : null;
}

export function isDesktopVersion(version) {
    return Boolean(parseVersion(version));
}

export function isNewerDesktopVersion(candidate, current) {
    const next = parseVersion(candidate);
    const now = parseVersion(current);

    if (!next || !now || next[3] <= now[3]) {
        return false;
    }

    for (let i = 0; i < 3; i++) {
        if (next[i] !== now[i]) {
            return next[i] > now[i];
        }
    }

    return true;
}

export function installerName(platform, version) {
    if (!isDesktopVersion(version) || !["win32", "darwin"].includes(platform)) {
        throw new Error("This build does not support desktop updates.");
    }

    return `Pi-Pocket-Desktop-Update-${version}.${platform === "win32" ? "exe" : "pkg"}`;
}

async function githubJson(path) {
    const response = await fetch(new URL(path, "https://api.github.com"), {
        headers: { Accept: "application/vnd.github+json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        throw new DesktopUpdateError(
            `GitHub could not check for desktop builds (HTTP ${response.status}).`,
        );
    }

    return response.json();
}

function positiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}

export async function checkDesktopUpdate(current, platform, request = githubJson) {
    if (!isDesktopVersion(current) || !["win32", "darwin"].includes(platform)) {
        return { phase: "disabled", current };
    }

    const { workflow_runs: runs } = await request(
        `${builds}?branch=desktop-native&event=push&status=success&per_page=1`,
    );
    const run = runs?.[0];

    if (!run) {
        return { phase: "unavailable", current };
    }

    if (
        !positiveInteger(run.id) ||
        !positiveInteger(run.run_number) ||
        run.event !== "push" ||
        run.head_branch !== "desktop-native" ||
        run.head_repository?.full_name !== "vitalNohj/pi-pocket" ||
        run.conclusion !== "success"
    ) {
        throw new DesktopUpdateError(
            "GitHub did not return a successful desktop-native push build.",
        );
    }

    const { artifacts } = await request(`${source}/actions/runs/${run.id}/artifacts?per_page=100`);
    const extension = platform === "win32" ? "exe" : "pkg";
    const prefix = "Pi-Pocket-Desktop-Update-";
    const matches = (artifacts ?? []).flatMap((artifact) => {
        const name = artifact.name;

        if (
            typeof name !== "string" ||
            !name.startsWith(prefix) ||
            !name.endsWith(`.${extension}`)
        ) {
            return [];
        }

        const version = name.slice(prefix.length, -(extension.length + 1));

        return !artifact.expired && parseVersion(version)?.[3] === run.run_number
            ? [{ artifact, version }]
            : [];
    });

    if (matches.length !== 1) {
        return { phase: "unavailable", current };
    }

    const { artifact, version } = matches[0];

    if (!isNewerDesktopVersion(version, current)) {
        return { phase: "current", current, version };
    }

    const sha256 = artifact.digest?.startsWith("sha256:") ? artifact.digest.slice(7) : "";

    if (
        !sha256Pattern.test(sha256) ||
        !positiveInteger(artifact.id) ||
        !positiveInteger(artifact.size_in_bytes) ||
        artifact.size_in_bytes > installerLimit
    ) {
        throw new DesktopUpdateError(
            "GitHub did not provide a valid desktop installer digest and size.",
        );
    }

    return {
        phase: "available",
        current,
        version,
        sha256,
        size: artifact.size_in_bytes,
        // GitHub requires sign-in to download Actions artifacts, even in a public repository.
        // The app never handles GitHub credentials or follows an arbitrary URL from the API.
        downloadUrl: `${website}/actions/runs/${run.id}/artifacts/${artifact.id}`,
    };
}
