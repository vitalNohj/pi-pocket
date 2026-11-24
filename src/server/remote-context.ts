/**
 * What a session on another computer (`runners.ts`) learns of its folder there, read through that computer's
 * environment and never from this server's disk:
 *
 * - The project's context files: the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`
 *   in the folder and each folder above it, as Pi reads them here. This server's own global file (in Pi's folder) comes
 *   first, as for a session here: it holds the person's own instructions.
 * - Pi's skills there: the project's `.pi/skills/`, its `.agents/skills/` folders up to the repository's root (only while
 *   the project is trusted), then `~/.pi/agent/skills/` and `~/.agents/skills/` of that computer.
 *
 * One scan finds all of it (`scanFolder`): one command prints the files, so a slow link pays for one round trip.
 * When that fails, folder listings run side by side. A scan is
 * kept for 30 seconds per computer and folder, as the prompt keeps what it reads here. Trust decisions for folders there
 * are this server's (`remote-trust.json` in its data folder), by computer and path: they never mix with Pi's trust store,
 * whose paths are this server's.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, posix, win32 } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import {
    createSyntheticSourceInfo,
    parseFrontmatter,
    type Skill,
} from "@earendil-works/pi-coding-agent";
import type { ExecutionEnv, FileError, FileInfo } from "@earendil-works/pi-durable/env";
import { isConnectionLost, type RemoteInfo } from "@earendil-works/pi-env";
import { limitParallel } from "./folder-access.ts";
import {
    decides,
    type ProjectTrust,
    type Saved,
    type SkillSources,
    type TrustChoice,
} from "./skills.ts";

/** An environment on another computer: a `RunnerEnv` (or the harness's wrapper of one). */
export type RemoteEnv = ExecutionEnv & {
    readonly connection: { info(): Promise<RemoteInfo> };
    /** The runner checks requests against this folder, which can differ from cwd for a worktree. */
    readonly scope?: { folder: string } | undefined;
};

export type PathKit = typeof posix;

/** The context file names Pi looks for in each folder, first found wins (Pi's `loadProjectContextFiles`). */
const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const STALE_MS = 30_000;
/** The most bytes read of one context or skill file. */
const MAX_FILE = 256 * 1024;
/** The most text one scan may print. */
const MAX_OUTPUT = 8 * 1024 * 1024;
const SCAN_TIMEOUT_S = 20;
/** How deep a skill folder is searched, as links may loop. */
const MAX_DEPTH = 8;
const context = BACKGROUND_CONTEXT;

/** What a scan found of a folder on another computer. */
export type FolderScan = {
    /** When it was read. */
    at: number;
    /** That computer's path rules. */
    paths: PathKit;
    /** Its home folder. */
    home: string;
    /** The folder, links resolved: what its trust decision is saved for. */
    folder: string;
    /** Its context files, the topmost folder's first. */
    context: { path: string; content: string }[];
    /** Its `.pi/skills/`, when there is one. */
    own?: string;
    /** Its `.agents/skills/` folders, nearest first, up to the repository's root, without the home folder's. */
    agents: string[];
    /** The home folder's skill places that exist. */
    user: string[];
    /** The skill files in those places (`place` is the one each is in), in Pi's order. */
    files: { place: string; path: string; text: string }[];
};

type Found = Omit<FolderScan, "at" | "paths" | "home">;

/** The path rules of a computer with this operating system. */
export function pathsFor(os: string | undefined): PathKit {
    return os === "windows" ? win32 : posix;
}

/** For tests: whether a scan may use one shell command, or only folder listings. */
export const scanSettings = { shell: true };

/** Each folder's last scan, the one being read, and how often it was forgotten (a scan that began before is stale). */
const scans = new Map<
    string,
    { value?: FolderScan; running?: Promise<FolderScan>; forgotten?: number }
>();

const keyOf = (env: RemoteEnv, cwd: string) => `${env.id}\0${cwd}`;

/**
 * The folder `cwd` on another computer, read again when the last scan is older than 30 seconds. Throws when the computer
 * cannot be reached.
 */
export function scanFolder(env: RemoteEnv, cwd: string): Promise<FolderScan> {
    const entry = scans.get(keyOf(env, cwd));

    if (entry?.value !== undefined && Date.now() - entry.value.at < STALE_MS) {
        return Promise.resolve(entry.value);
    }

    return refresh(env, cwd);
}

/** The last scan of the folder, at once, or undefined before the first; an old or missing one is read again meanwhile. */
export function knownScan(env: RemoteEnv, cwd: string): FolderScan | undefined {
    const value = scans.get(keyOf(env, cwd))?.value;

    if (value === undefined || Date.now() - value.at >= STALE_MS) {
        refresh(env, cwd).catch(() => {});
    }

    return value;
}

/**
 * Forget what was read of the folders on the computer of `env` that a file at `path` there is context or a skill for:
 * the next turn reads them again. A context file or `SKILL.md` that Pi writes counts from its next request, not 30
 * seconds later (a subagent started at once must see it).
 */
export function changedThere(env: RemoteEnv, path: string): void {
    const name = path.split(/[\\/]/).pop() ?? "";

    if (!CANDIDATES.includes(name) && name !== "SKILL.md") {
        return;
    }

    const prefix = `${env.id}\0`;

    for (const [key, entry] of scans) {
        if (key.startsWith(prefix)) {
            entry.value = undefined;
            entry.running = undefined;
            entry.forgotten = (entry.forgotten ?? 0) + 1;
        }
    }
}

/**
 * The folder read again. A computer that is offline is waited for (`runners.ts`): what calls this runs in a turn, which
 * starts only when the computer is back. Undefined when the reading fails.
 */
export async function latestScan(env: RemoteEnv, cwd: string): Promise<FolderScan | undefined> {
    try {
        return await scanFolder(env, cwd);
    } catch {
        return undefined;
    }
}

function refresh(env: RemoteEnv, cwd: string): Promise<FolderScan> {
    const key = keyOf(env, cwd);
    const entry = scans.get(key) ?? {};

    if (entry.running !== undefined) {
        return entry.running;
    }

    const forgotten = entry.forgotten;
    const running = readFolder(env, cwd).finally(() => {
        if (entry.running === running) {
            entry.running = undefined;
        }
    });

    entry.running = running;
    scans.set(key, entry);
    running.then(
        (value) => {
            // Read before a file there changed (`changedThere`): it may miss it, so it is not kept.
            if (entry.forgotten === forgotten) {
                entry.value = value;
            }
        },
        () => {},
    );

    return running;
}

/** The folder `cwd` on another computer, read now (no cache). Throws when the computer cannot be reached. */
export async function readFolder(env: RemoteEnv, cwd: string): Promise<FolderScan> {
    const info = await env.connection.info();
    const paths = pathsFor(info.os);
    const folder = paths.resolve(cwd);
    const home = info.home ? paths.resolve(info.home) : "";
    const at = Date.now();
    let found: Found | undefined;

    if (scanSettings.shell) {
        if (info.os !== "windows") {
            found = await shellScan(env, folder, home);
        } else if (env.scope?.folder === folder) {
            // A worktree or a subagent can run elsewhere. Its ancestors need not be in the approved scope.
            found = await powershellScan(env, folder, home);
        }
    }

    // Try listings only if the command could not scan the folder.
    found ??= await listingScan(env, paths, folder, home);

    return { at, paths, home, ...found };
}

/**
 * The scan as one POSIX `sh` command: each record is a line `<marker> TAB kind TAB place TAB path` after a newline, and
 * a file's text follows its record. The marker is new each time, so no file can end a record early.
 */
const SCRIPT = String.raw`
N=$1 cwd=$2 home=$3 max=$4
mark() { printf '\n%s\t%s\t%s\t%s\n' "$N" "$1" "$2" "$3"; }
show() { mark "$1" "$2" "$3"; head -c "$max" "$3" 2>/dev/null; }
walk() {
    if [ -f "$2/SKILL.md" ]; then show skill "$1" "$2/SKILL.md"; return 0; fi
    [ "$4" -lt ${MAX_DEPTH} ] || return 0
    for e in "$2"/*; do
        [ -e "$e" ] || continue
        case "\${e##*/}" in node_modules) continue ;; esac
        if [ -d "$e" ]; then walk "$1" "$e" 0 $(($4 + 1))
        elif [ "$3" = 1 ] && [ -f "$e" ]; then
            case "$e" in *.md) show skill "$1" "$e" ;; esac
        fi
    done
}
real=$(cd "$cwd" 2>/dev/null && pwd -P) || real=$cwd
mark folder "" "$real"
d=$cwd git=
while :; do
    p=\${d%/}
    for c in ${CANDIDATES.join(" ")}; do
        if [ -f "$p/$c" ]; then show context "" "$p/$c"; break; fi
    done
    if [ -z "$git" ] && [ -e "$p/.git" ]; then git=$d; fi
    [ -n "$p" ] || break
    d=\${p%/*}; [ -n "$d" ] || d=/
done
p=\${cwd%/}
if [ -d "$p/.pi/skills" ]; then mark own "" "$p/.pi/skills"; walk "$p/.pi/skills" "$p/.pi/skills" 1 0; fi
d=$cwd
while :; do
    p=\${d%/}
    f=$p/.agents/skills
    if { [ -z "$home" ] || [ "$f" != "\${home%/}/.agents/skills" ]; } && [ -d "$f" ]; then mark agents "" "$f"; walk "$f" "$f" 1 0; fi
    if [ "$d" = "$git" ] || [ -z "$p" ]; then break; fi
    d=\${p%/*}; [ -n "$d" ] || d=/
done
if [ -n "$home" ]; then
    for f in "\${home%/}/.pi/agent/skills" "\${home%/}/.agents/skills"; do
        if [ -d "$f" ]; then mark user "" "$f"; walk "$f" "$f" 1 0; fi
    done
fi
mark end "" ""
`.replace(/\\\$/g, "$");

function shellScan(env: RemoteEnv, cwd: string, home: string): Promise<Found | undefined> {
    const marker = randomUUID();

    return commandScan(env, cwd, marker, [
        "sh",
        "-c",
        SCRIPT,
        "sh",
        marker,
        cwd,
        home,
        String(MAX_FILE),
    ]);
}

/** Windows PowerShell takes source after `-Command`, not literal argv values. Encode the scan data. */
export function powershellScanCommand(marker: string, cwd: string, home: string): string[] {
    const data = Buffer.from(JSON.stringify({ marker, cwd, home }), "utf8").toString("base64");
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$data = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')))
$cwd = $data.cwd
$userHome = $data.home
[string]$lf = [char]10
[string]$tab = [char]9
$directory = [IO.FileAttributes]::Directory
$ordinal = [StringComparison]::Ordinal

function Mark($kind, $place, $path) {
    [Console]::Write($lf + $data.marker + $tab + $kind + $tab + $place + $tab + $path + $lf)
}
function Check-Attributes($attributes) {
    if (($attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Device)) -ne 0) {
        throw 'Use the normal path checks for a link or device.'
    }
}
function Get-ScanDirectory($path) {
    try { $attributes = [IO.File]::GetAttributes($path) }
    catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return }
    Check-Attributes $attributes
    if (($attributes -band $directory) -ne 0) { [IO.DirectoryInfo]::new($path) }
}
function Check-Chain($path) {
    if ([IO.Path]::DirectorySeparatorChar -eq [char]92 -and $path -cnotmatch '^[A-Z]:\\') {
        throw 'Use the normal path checks for a non-standard drive path.'
    }
    for ($dir = [IO.DirectoryInfo]::new($path); $null -ne $dir; $dir = $dir.Parent) {
        Check-Attributes ([IO.File]::GetAttributes($dir.FullName))
        if ($null -ne $dir.Parent) {
            $names = $dir.Parent.GetFileSystemInfos($dir.Name)
            if ($names.Length -ne 1 -or !$names[0].Name.Equals($dir.Name, $ordinal)) {
                throw 'Use the normal path checks for an alternate spelling.'
            }
        }
    }
}
function Show-File($kind, $place, $file) {
    Check-Attributes $file.Attributes
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        $reader = [IO.BinaryReader]::new($stream)
        $text = [Text.Encoding]::UTF8.GetString($reader.ReadBytes(${MAX_FILE}))
    } finally { $stream.Dispose() }
    Mark $kind $place $file.FullName
    [Console]::Write($text)
}
function Walk-Skills($place, $dir, $depth) {
    $children = $dir.GetFileSystemInfos()
    foreach ($entry in $children) {
        if ($entry.Name.Equals('SKILL.md', $ordinal)) {
            Check-Attributes $entry.Attributes
            if (($entry.Attributes -band $directory) -eq 0) {
                Show-File 'skill' $place $entry
                return
            }
        }
    }
    if ($depth -ge ${MAX_DEPTH}) { return }
    foreach ($entry in $children) {
        $name = $entry.Name
        if ($name.StartsWith('.', $ordinal) -or $name.Equals('node_modules', $ordinal)) { continue }
        Check-Attributes $entry.Attributes
        if (($entry.Attributes -band $directory) -ne 0) { Walk-Skills $place $entry ($depth + 1) }
        elseif ($depth -eq 0 -and $name.EndsWith('.md', $ordinal)) { Show-File 'skill' $place $entry }
    }
}
function Show-Skills($kind, $base, $parts) {
    $dir = $base
    foreach ($name in $parts) {
        $dir = Get-ScanDirectory ([IO.Path]::Combine($dir.FullName, $name))
        if ($null -eq $dir) { return }
    }
    Mark $kind '' $dir.FullName
    Walk-Skills $dir.FullName $dir 0
}

Check-Chain $cwd
$homeAgents = ''
if ($userHome -ne '') {
    $homeAgents = [IO.Path]::Combine($userHome, '.agents', 'skills')
    if ([IO.Directory]::Exists($userHome)) {
        # The runner permits user skills under its real home, not under a different daemon's home.
        $profileHome = if ([IO.Path]::DirectorySeparatorChar -eq [char]92) { $env:USERPROFILE } else { $env:HOME }
        if (!$userHome.Equals($profileHome, $ordinal)) { throw 'Use the normal path checks for this home.' }
        Check-Chain $userHome
    }
}
Mark 'folder' '' $cwd
$projectAgents = [Collections.Generic.List[IO.DirectoryInfo]]::new()
$inRepo = $true
$own = $null
for ($dir = [IO.DirectoryInfo]::new($cwd); $null -ne $dir; $dir = $dir.Parent) {
    $entries = [Collections.Generic.Dictionary[string,IO.FileSystemInfo]]::new([StringComparer]::Ordinal)
    foreach ($entry in $dir.GetFileSystemInfos()) { $entries.Add($entry.Name, $entry) }
    foreach ($name in @('${CANDIDATES.join("', '")}')) {
        if ($entries.ContainsKey($name)) {
            $file = $entries[$name]
            Check-Attributes $file.Attributes
            if (($file.Attributes -band $directory) -eq 0) {
                Show-File 'context' '' $file
                break
            }
        }
    }
    if ($dir.FullName.Equals($cwd, $ordinal) -and $entries.ContainsKey('.pi')) { $own = $dir }
    if ($inRepo -and $entries.ContainsKey('.agents') -and
        !([IO.Path]::Combine($dir.FullName, '.agents', 'skills').Equals($homeAgents, $ordinal))) {
        $projectAgents.Add($dir)
    }
    if ($entries.ContainsKey('.git')) { $inRepo = $false }
}
if ($null -ne $own) { Show-Skills 'own' $own @('.pi', 'skills') }
foreach ($dir in $projectAgents) { Show-Skills 'agents' $dir @('.agents', 'skills') }
if ($userHome -ne '' -and [IO.Directory]::Exists($userHome)) {
    $dir = [IO.DirectoryInfo]::new($userHome)
    Show-Skills 'user' $dir @('.pi', 'agent', 'skills')
    Show-Skills 'user' $dir @('.agents', 'skills')
}
Mark 'end' '' ''
`;

    return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script];
}

function powershellScan(env: RemoteEnv, cwd: string, home: string): Promise<Found | undefined> {
    const marker = randomUUID();

    return commandScan(env, cwd, marker, powershellScanCommand(marker, cwd, home));
}

async function commandScan(
    env: RemoteEnv,
    cwd: string,
    marker: string,
    argv: string[],
): Promise<Found | undefined> {
    const run = withCancel(context);
    let out = "";
    let tooMuch = false;
    let incomplete = false;
    let found: Found | undefined;

    try {
        const result = await env.exec(
            argv,
            {
                // In the session's folder, under its usual runner permission (`docs/runners.md`).
                cwd,
                timeout: SCAN_TIMEOUT_S,
                onOutput: (text, _context, { stream, skipped }) => {
                    if (stream !== "stdout" || tooMuch) {
                        return;
                    }

                    // pi-env decodes each chunk. Fall back if output was skipped or a UTF-8 character was cut.
                    if (skipped || text.startsWith("�") || text.endsWith("�")) {
                        incomplete = true;
                    }

                    if (out.length + text.length > MAX_OUTPUT) {
                        tooMuch = true;
                        run.cancel();
                    } else {
                        out += text;
                    }
                },
            },
            run.context,
        );

        if (!tooMuch && !incomplete && result.ok && result.value.exitCode === 0) {
            found = parseScan(out, marker);
        }
    } catch {
        // A command that could not run, or was refused, leaves listings as the fallback.
    }

    // This is a read limit, not a reason to try the same unbounded output by another route.
    if (tooMuch) {
        throw new Error(`The skill and context files in ${cwd} are too large to read.`);
    }

    return found;
}

/** The records of a shell scan; undefined when it did not finish. */
export function parseScan(out: string, marker: string): Found | undefined {
    const found: Found = { folder: "", context: [], agents: [], user: [], files: [] };
    let ended = false;

    for (const piece of out.split(`\n${marker}\t`).slice(1)) {
        const newline = piece.indexOf("\n");

        if (newline === -1) {
            return undefined;
        }

        const fields = piece.slice(0, newline).split("\t");
        const [kind, place, path] = fields;

        if (ended || fields.length !== 3 || place === undefined || path === undefined) {
            return undefined;
        }

        const text = stripBom(piece.slice(newline + 1));

        if (kind === "folder") {
            found.folder = path;
        } else if (kind === "context") {
            found.context.unshift({ path, content: text });
        } else if (kind === "own") {
            found.own = path;
        } else if (kind === "agents") {
            found.agents.push(path);
        } else if (kind === "user") {
            found.user.push(path);
        } else if (kind === "skill") {
            found.files.push({ place, path, text });
        } else if (kind === "end" && place === "" && path === "" && text === "") {
            ended = true;
        } else {
            return undefined;
        }
    }

    return ended && found.folder !== "" ? found : undefined;
}

/** The scan as listings of folders, side by side where they can be: for a computer without a working command scan. */
async function listingScan(
    env: RemoteEnv,
    paths: PathKit,
    cwd: string,
    home: string,
): Promise<Found> {
    // A lost link is not "no such file": it fails the scan, so no empty one is kept.
    const failed = (error: FileError) => {
        if (isConnectionLost((error as { cause?: unknown }).cause)) {
            throw error;
        }

        return undefined;
    };

    // Limit the individual requests, not a walk that can wait for more reads of its own.
    const run = limitParallel(8);
    const list = (dir: string) =>
        run(async () => {
            const listed = await env.listDir(dir, context);

            return listed.ok ? listed.value : failed(listed.error);
        });
    const read = (path: string) =>
        run(async () => {
            const text = await env.readTextFile(path, context);

            return text.ok ? stripBom(text.value.slice(0, MAX_FILE)) : failed(text.error);
        });

    const readContext = async (folder: string, entries: FileInfo[] | undefined) => {
        // Do not open the next name unless the higher-priority file is absent or cannot be read.
        for (const name of CANDIDATES) {
            const entry = entries?.find((entry) => entry.name === name);

            if (entry === undefined || entry.kind === "directory") {
                continue;
            }

            const path = paths.join(folder, name);
            const content = await read(path);

            if (content !== undefined) {
                return [{ path, content }];
            }
        }

        return [];
    };

    const readSkill = async (place: string, path: string) => {
        const text = await read(path);

        return text === undefined ? [] : [{ place, path, text }];
    };

    // A folder with SKILL.md is one skill; else read top-level .md files and look in non-hidden folders.
    const walk = async (
        place: string,
        dir = place,
        depth = 0,
    ): Promise<Found["files"] | undefined> => {
        const entries = await list(dir);

        if (entries === undefined) {
            return undefined;
        }

        if (entries.some((entry) => entry.name === "SKILL.md" && entry.kind !== "directory")) {
            return readSkill(place, paths.join(dir, "SKILL.md"));
        }

        if (depth >= MAX_DEPTH) {
            return [];
        }

        const inner = await Promise.all(
            entries
                .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
                .map(async (entry) => {
                    const path = paths.join(dir, entry.name);

                    if (entry.kind !== "file") {
                        // For a link, the listing says if it points to a folder or should be tried as a file.
                        const below = await walk(place, path, depth + 1);

                        if (below !== undefined || entry.kind === "directory") {
                            return below ?? [];
                        }
                    }

                    return depth === 0 && entry.name.endsWith(".md") ? readSkill(place, path) : [];
                }),
        );

        return inner.flat();
    };

    const skillsAt = async (place: string) => {
        const files = await walk(place);

        return files === undefined ? [] : [{ place, files }];
    };

    const ancestors: string[] = [];

    for (let current = cwd; ; current = paths.dirname(current)) {
        ancestors.push(current);

        if (paths.dirname(current) === current) {
            break;
        }
    }

    const real = run(() => env.canonicalPath(cwd, context));
    const listings = ancestors.map(list);
    const homeAgents = home === "" ? "" : paths.join(home, ".agents", "skills");
    const userAt = home === "" ? [] : [paths.join(home, ".pi", "agent", "skills"), homeAgents];

    const agentsFrom = async (index: number): Promise<Awaited<ReturnType<typeof skillsAt>>> => {
        if (index === ancestors.length) {
            return [];
        }

        const entries = await listings[index];
        const place = paths.join(ancestors[index]!, ".agents", "skills");
        const [here, above] = await Promise.all([
            place !== homeAgents && entries?.some((entry) => entry.name === ".agents")
                ? skillsAt(place)
                : [],
            // Only read an ancestor's skills after ruling out a repository boundary below it.
            entries?.some((entry) => entry.name === ".git") ? [] : agentsFrom(index + 1),
        ]);

        return [...here, ...above];
    };

    const [folder, contextFiles, own, agents, user] = await Promise.all([
        real,
        Promise.all(
            listings.map((pending, index) =>
                pending.then((entries) => readContext(ancestors[index]!, entries)),
            ),
        ),
        listings[0]!.then((entries) =>
            entries?.some((entry) => entry.name === ".pi")
                ? skillsAt(paths.join(cwd, ".pi", "skills"))
                : [],
        ),
        agentsFrom(0),
        Promise.all(userAt.map(skillsAt)).then((skills) => skills.flat()),
    ]);

    return {
        folder: folder.ok ? folder.value : (failed(folder.error) ?? cwd),
        context: contextFiles.flat().reverse(),
        ...(own[0] === undefined ? {} : { own: own[0].place }),
        agents: agents.map(({ place }) => place),
        user: user.map(({ place }) => place),
        files: [...own, ...agents, ...user].flatMap(({ files }) => files),
    };
}

function stripBom(text: string): string {
    return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** A skill file as Pi reads one (`loadSkillFromFile`): none without a description. */
function skillOf(
    file: { path: string; text: string },
    paths: PathKit,
    scope: "user" | "project",
): Skill | undefined {
    let frontmatter: Record<string, unknown>;

    try {
        frontmatter = parseFrontmatter(file.text).frontmatter;
    } catch {
        return undefined;
    }

    const description = frontmatter.description;

    if (typeof description !== "string" || description.trim() === "") {
        return undefined;
    }

    const baseDir = paths.dirname(file.path);
    const name =
        typeof frontmatter.name === "string" && frontmatter.name !== ""
            ? frontmatter.name
            : paths.basename(baseDir);

    return {
        name,
        description,
        filePath: file.path,
        baseDir,
        sourceInfo: createSyntheticSourceInfo(file.path, { source: "remote", scope, baseDir }),
        disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    };
}

/**
 * The skills a session in the scanned folder loads (the first of each name), and whether its project is trusted, as
 * `skills.ts` decides for a folder here: `.pi/skills/` loads unless the project is distrusted, `.agents/skills/` only
 * while it is trusted. `saved` is `savedTrust`'s answer; `defaultProjectTrust` is Pi's setting.
 */
export function remoteProject(
    scan: FolderScan,
    saved: Saved | null | undefined,
    defaultProjectTrust: SkillSources["defaultProjectTrust"],
): { skills: Skill[]; trust: ProjectTrust } {
    const skillsIn = (places: readonly string[], scope: "user" | "project") =>
        places.flatMap((place) =>
            scan.files.flatMap((file) => {
                const skill = file.place === place ? skillOf(file, scan.paths, scope) : undefined;

                return skill === undefined ? [] : [skill];
            }),
        );
    const own = skillsIn(scan.own === undefined ? [] : [scan.own], "project");
    const agents = skillsIn(scan.agents, "project");
    const decision = decides(saved, { defaultProjectTrust });
    const loaded = [
        ...(decision === "distrusted" ? [] : own),
        ...(decision === "trusted" ? agents : []),
        ...skillsIn(scan.user, "user"),
    ];
    const names = new Set<string>();
    const skills = loaded.filter((skill) => !names.has(skill.name) && names.add(skill.name));
    const brief = (list: Skill[]) => list.map(({ name, description }) => ({ name, description }));
    const parent = scan.paths.dirname(scan.folder);

    return {
        skills,
        trust: {
            folder: scan.folder,
            ...(parent === scan.folder ? {} : { parent }),
            saved: saved ?? null,
            defaultProjectTrust,
            trusted: decision === "trusted",
            folders: scan.agents,
            skills: brief(agents),
            ownSkills: brief(own),
            // A project's settings there are not read: they need no trust.
            settings: false,
            ask: agents.length > 0 && saved === null && defaultProjectTrust === "ask",
            ...(saved === undefined ? { unreadable: true as const } : {}),
        },
    };
}

/**
 * `remoteProject` for a folder on computer `runner`, with its trust decision from this server's data folder and Pi's
 * global `defaultProjectTrust`. (Project settings there are not read, so none of them can change it.)
 */
export function projectThere(
    scan: FolderScan,
    runner: string,
    dirs: { dataDir: string; agentDir: string },
): { skills: Skill[]; trust: ProjectTrust } {
    return remoteProject(
        scan,
        savedTrust(dirs.dataDir, runner, scan.folder, scan.paths),
        defaultTrust(dirs.agentDir),
    );
}

/** The context files of a session there, as the prompt shows them: this server's global one first. */
export function contextText(agentDir: string, scan: FolderScan): string | undefined {
    const files = [...globalContext(agentDir), ...scan.context];

    if (files.length === 0) {
        return undefined;
    }

    return files
        .map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`)
        .join("\n\n");
}

/** Pi's global context file on this server, in its folder (`agentDir`), as `loadProjectContextFiles` finds it. */
function globalContext(agentDir: string): { path: string; content: string }[] {
    for (const name of CANDIDATES) {
        const path = join(agentDir, name);

        try {
            if (statSync(path).isFile()) {
                return [{ path, content: stripBom(readFileSync(path, "utf8")) }];
            }
        } catch {
            // Not there: the next name.
        }
    }

    return [];
}

/** Pi's `defaultProjectTrust` setting on this server, from its global settings. */
export function defaultTrust(agentDir: string): SkillSources["defaultProjectTrust"] {
    try {
        const value = (
            JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
                defaultProjectTrust?: unknown;
            }
        ).defaultProjectTrust;

        return value === "always" || value === "never" ? value : "ask";
    } catch {
        return "ask";
    }
}

/** The text of a file there, as for a skill's instructions. */
export async function readRemoteText(env: RemoteEnv, path: string): Promise<string> {
    const text = await env.readTextFile(path, context);

    if (!text.ok) {
        throw text.error;
    }

    return text.value;
}

/** Where a session's attached files go on a computer: `<temp>/pi-pocket-uploads/<session>/` there. */
export type UploadsFolder = { folder: string; paths: PathKit };

/**
 * The folder on the computer for a session's attached files, from what it said of its system (`hello`, also kept
 * while it is offline): in its temporary folder, so they never pile up in a person's home. `session`: its permission
 * id there (`runnerScope`), the one folder of attached files its runner lets it reach. `clearUploads` empties it when
 * the session is archived; the system clears what is left.
 */
export function uploadsFolder(
    system: { os: string; tmpdir: string },
    session: string,
): UploadsFolder {
    const paths = pathsFor(system.os);

    return {
        folder: paths.join(system.tmpdir, "pi-pocket-uploads", session),
        paths,
    };
}

/** Where file `path` (in the conversation's uploads here) is on the computer, once `copyUploads` copied it. */
export function uploadedThere(folder: UploadsFolder, path: string): string {
    return folder.paths.join(folder.folder, basename(path));
}

/**
 * Copy files people attached (kept here, in the conversation's uploads) to the computer, into `folder` there with the
 * same names (`uploadedThere`). Images are copied too, so Pi's tools can use them there; the model also sees them in
 * the message. A computer that is offline is waited for. Never throws: the names of the files that could not be copied.
 */
export async function copyUploads(
    env: RemoteEnv,
    folder: UploadsFolder,
    files: readonly { path: string; name: string }[],
): Promise<string[]> {
    const failed: string[] = [];

    await Promise.all(
        files.map(async (file) => {
            const written = await readFile(file.path).then(
                (bytes) => env.writeFile(uploadedThere(folder, file.path), bytes, context),
                () => undefined,
            );

            if (written?.ok !== true) {
                failed.push(file.name);
            }
        }),
    );

    return failed;
}

/**
 * Remove a conversation's attached files from the computer (its session was archived): when it is offline, once it is
 * back. Errors are ignored.
 */
export async function clearUploads(env: RemoteEnv, session: string): Promise<void> {
    try {
        const { folder } = uploadsFolder(await env.connection.info(), session);

        await env.remove(folder, { recursive: true, force: true }, context);
    } catch {
        // Offline, or already gone: the system's temporary folder clears it in time.
    }
}

/** Trust decisions for folders on other computers: by computer, then by path there. */
type TrustData = Record<string, Record<string, boolean>>;

export const TRUST_FILE = "remote-trust.json";

/** The saved decisions, or undefined when the file cannot be read. */
function readTrust(dataDir: string): TrustData | undefined {
    const file = join(dataDir, TRUST_FILE);

    if (!existsSync(file)) {
        return {};
    }

    try {
        const data = JSON.parse(readFileSync(file, "utf8")) as unknown;

        return typeof data === "object" && data !== null && !Array.isArray(data)
            ? (data as TrustData)
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The decision for `folder` on computer `runner`, saved for it or the nearest folder above it, as Pi's trust store finds
 * one; null when there is none, undefined when the decisions cannot be read.
 */
export function savedTrust(
    dataDir: string,
    runner: string,
    folder: string,
    paths: PathKit,
): Saved | null | undefined {
    const data = readTrust(dataDir);

    if (data === undefined) {
        return undefined;
    }

    const mine = data[runner] ?? {};

    for (let current = folder; ; current = paths.dirname(current)) {
        const trusted = mine[current];

        if (typeof trusted === "boolean") {
            return { path: current, trusted };
        }

        if (paths.dirname(current) === current) {
            return null;
        }
    }
}

/** Save an answer to "trust this project?" for `folder` on computer `runner`, as `saveProjectTrust` does here. */
export function saveTrust(
    dataDir: string,
    runner: string,
    folder: string,
    paths: PathKit,
    choice: TrustChoice,
): void {
    const data = readTrust(dataDir);

    if (data === undefined) {
        throw new Error(`${join(dataDir, TRUST_FILE)} cannot be read.`);
    }

    const mine = { ...data[runner] };
    const parent = paths.dirname(folder);

    if (choice !== "trust-parent") {
        mine[folder] = choice === "trust";
    } else if (parent === folder) {
        throw new Error(`${folder} has no folder above it.`);
    } else {
        // The folder's own decision goes, so the one for the folder above applies to it.
        mine[parent] = true;
        delete mine[folder];
    }

    const file = join(dataDir, TRUST_FILE);
    const temporary = `${file}.${process.pid}.tmp`;

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ ...data, [runner]: mine }, null, 2)}\n`, {
        mode: 0o600,
    });
    renameSync(temporary, file);
}
