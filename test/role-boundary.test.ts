// The line around a person's role (`src/server/roles.ts`): the server compares a role with "owner", "guest", or "viewer"
// in four files only. Everything else asks the access policy a question named for what it is for (`access.ts`
// `AccessPolicy`: `isOwner`, `prompts`, `reachesMachine`, ...), or, with no policy at hand, a function of `roles.ts`. So
// a new role is decided in one place, and no check is left behind that reads a stale record.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { isGivenRole, isOwner, ownerOf, prompts, rolePrompts } from "../src/server/roles.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVER = join(ROOT, "src", "server");

/** The files that may compare a role: its rules, what a role can hold, the policy, and the record that keeps it. */
const COMPARE = ["roles.ts", "rights.ts", "access.ts", "config.ts"];

/**
 * The files that may call the functions of `roles.ts`, each for a reason: they have no policy at hand, or read a
 * value that is not a person's record. Add a file here only with its reason; a file that has the app asks its policy.
 */
const ASK: Record<string, string> = {
    "config.ts": "the record keeper: the policy reads from it",
    "app.ts": "the code that changes a role reads the role a page asked for",
    "auth.ts": "the default when no policy is given (tests of sign-in alone)",
    "runners.ts": "the default when no policy is given (tests of runners alone)",
    "approval-methods.ts": "the default when no policy is given (tests of the methods alone)",
    "extension-web.ts": "the default when no policy is given (a module's parts tested alone)",
    "extensions/design.ts":
        "an extension: it has the public request, with the current role, and no policy",
    "http/api.ts": "reads the role a page sent for an invite",
    "http/sign-in.ts":
        "the sign-in pages: the words for the person a link signs in, and an invite's role",
};

/** The `.ts` files in `folder` and below. */
function sources(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const path = join(folder, entry.name);

        return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
    });
}

const name = (file: string) => relative(SERVER, file).split(sep).join("/");

/** A file's code without its comments, so words about a role are no compare. */
function code(file: string): string {
    return readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
        .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The lines of `text` that compare a role with one of its values. Found by the value, not by the name of what holds
 * it, so a role read into a variable of any name is found too:
 * - any compare with "guest" or "viewer", either way round: those words are roles and nothing else here;
 * - a compare with "owner", unless it is of a web part's access (`access`: "owner", "steer", "view") or of who gives
 *   a right (`gives`), which are not a person's role;
 * - a `case` of a switch, and a list asked with `includes`, that names a role.
 */
function compares(text: string): string[] {
    const other = `["'](?:guest|viewer)["']`;
    const owner = `["']owner["']`;
    const any = `["'](?:owner|guest|viewer)["']`;
    const found = [
        new RegExp(`[!=]==?\\s*${other}`),
        new RegExp(`${other}\\s*[!=]==?`),
        new RegExp(`\\bcase\\s+${any}\\s*:`),
        new RegExp(`\\[[^\\]]*${any}[^\\]]*\\]\\s*\\.includes\\(`),
    ];
    const ownerCompare = new RegExp(`[!=]==?\\s*${owner}|${owner}\\s*[!=]==?`, "g");
    const notARole = new RegExp(`(?:\\baccess|\\bgives)\\s*[!=]==?\\s*${owner}`, "g");

    return text
        .split("\n")
        .map((line, at) => ({ line, at }))
        .filter(
            ({ line }) =>
                found.some((pattern) => pattern.test(line)) ||
                (line.match(ownerCompare)?.length ?? 0) > (line.match(notARole)?.length ?? 0),
        )
        .map(({ line, at }) => `${String(at + 1)}: ${line.trim()}`);
}

describe("the line around a person's role", () => {
    it("finds a compare written each way, and not a web part's access or words in a comment", () => {
        assert.equal(compares(`if (user.role === "viewer") {`).length, 1);
        assert.equal(compares(`if (person?.role !== 'owner') {`).length, 1);
        assert.equal(compares(`if ("guest" === patch.role) {`).length, 1);
        assert.equal(compares(`if (config.userById(id)!.role == "owner") {`).length, 1);
        assert.equal(compares(`if (["owner", "guest"].includes(user.role)) {`).length, 1);
        assert.equal(
            compares(`switch (user.role) {\n    case "viewer":\n        return 1;`).length,
            1,
        );
        // A color's role (`design/scan-roles.ts`), not a person's.
        assert.equal(compares(`switch (role) {\n    case "accent":\n        return 1;`).length, 0);
        // A role read into a variable of another name is found by its value.
        assert.equal(compares(`const kind = user.role;\nif (kind === "viewer") {`).length, 1);
        assert.equal(compares(`const is = person.role;\nreturn is !== "owner";`).length, 1);
        // One line with both: the access is no role, the other compare is.
        assert.equal(
            compares(`if (this.#access !== "owner" || current.role !== "owner") {`).length,
            1,
        );

        // A web part's access ("owner", "steer", "view") and a right's giver are not a person's role.
        assert.equal(compares(`if (part.client.access === "owner") {`).length, 0);
        assert.equal(
            compares(`if (this.#access !== "owner" || !policy.isOwner(user)) {`).length,
            0,
        );
        assert.equal(compares(`if (declared(right).gives === "owner") {`).length, 0);
        assert.equal(compares(`const grant = { role: "viewer" };`).length, 0);
    });

    it("compares a role in four files only", () => {
        const found = sources(SERVER)
            .filter((file) => !COMPARE.includes(name(file)))
            .flatMap((file) => compares(code(file)).map((line) => `${name(file)}:${line}`));

        assert.deepEqual(
            found,
            [],
            "Ask the access policy (access.ts AccessPolicy) a question named for what the check is for, not the role.",
        );
    });

    it("lets only the listed files ask roles.ts, each for its reason", () => {
        const asks = sources(SERVER)
            .filter((file) =>
                /\bimport\s+\{[^}]*\}\s+from\s+["'](?:\.\.?\/)+roles\.ts["']/.test(
                    readFileSync(file, "utf8").replace(/\bimport\s+type\b[^;]*;/g, ""),
                ),
            )
            .map(name)
            .filter((file) => !COMPARE.includes(file) || file === "config.ts")
            .sort();

        assert.deepEqual(asks, Object.keys(ASK).sort());
    });

    it("keeps roles.ts free of imports: data, and the rules read straight from it", () => {
        assert.doesNotMatch(readFileSync(join(SERVER, "roles.ts"), "utf8"), /^\s*import\b/m);
    });
});

describe("the questions asked of a role by itself", () => {
    it("the owner's record is the owner's; a user's, a viewer's, and anything a page sent are not", () => {
        assert.equal(isOwner({ role: "owner" }), true);
        assert.equal(isOwner({ role: "guest" }), false);
        assert.equal(isOwner({ role: "viewer" }), false);
        assert.equal(isOwner({ role: ["owner"] }), false);
        assert.equal(isOwner({}), false);
    });

    it("the owner and a user prompt; a viewer does not", () => {
        assert.equal(prompts({ role: "owner" }), true);
        assert.equal(prompts({ role: "guest" }), true);
        assert.equal(prompts({ role: "viewer" }), false);
        assert.equal(rolePrompts("guest"), true);
        assert.equal(rolePrompts("viewer"), false);
    });

    it("a person is given guest or viewer, never owner or anything else", () => {
        assert.equal(isGivenRole("guest"), true);
        assert.equal(isGivenRole("viewer"), true);
        assert.equal(isGivenRole("owner"), false);
        assert.equal(isGivenRole("admin"), false);
        assert.equal(isGivenRole(undefined), false);
    });

    it("finds the owner among people, and nobody where there is none", () => {
        const people = [
            { id: "a", role: "guest" as const },
            { id: "b", role: "owner" as const },
        ];

        assert.equal(ownerOf(people)?.id, "b");
        assert.equal(ownerOf(people.slice(0, 1)), undefined);
    });
});

// ─── A role is written in one place, and the page compares none ──────────────

const WEB = join(ROOT, "web");

/** The `.js` files in `folder` and below. */
function scripts(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const path = join(folder, entry.name);

        return entry.isDirectory() ? scripts(path) : entry.name.endsWith(".js") ? [path] : [];
    });
}

/**
 * The lines of `text` that write a role, or name one to write it: any "guest" or "viewer" in code (those words are
 * roles and nothing else on the server), and an assignment to a `role`.
 */
function writes(text: string): string[] {
    return text
        .split("\n")
        .map((line, at) => ({ line, at }))
        .filter(({ line }) => /["'](?:guest|viewer)["']/.test(line) || /\.role\s*=(?!=)/.test(line))
        .map(({ line, at }) => `${String(at + 1)}: ${line.trim()}`);
}

/** The files of the server that call method `name` of the record keeper. */
function callers(name: string): string[] {
    return sources(SERVER)
        .filter((file) => new RegExp(`\\.${name}\\(`).test(code(file)))
        .map((file) => relative(SERVER, file).split(sep).join("/"))
        .sort();
}

describe("the one place a role is written", () => {
    it("finds a role written each way", () => {
        assert.equal(writes(`config.updateUser(id, { role: "viewer" });`).length, 1);
        assert.equal(writes(`const grant = { role: 'guest' };`).length, 1);
        assert.equal(writes(`user.role = next;`).length, 1);
        assert.equal(writes(`change.role  = patch.role;`).length, 1);
        assert.equal(writes(`if (user.role === next) {`).length, 0);
        assert.equal(writes(`this.config.giveRole(id, role, change);`).length, 0);
    });

    it("names guest and viewer in four files only, and assigns a role in none other", () => {
        const found = sources(SERVER)
            .filter((file) => !COMPARE.includes(name(file)))
            .flatMap((file) => writes(code(file)).map((line) => `${name(file)}:${line}`));

        assert.deepEqual(
            found,
            [],
            "A role is written by config.ts giveRole, pauseUser, and resumeUser; a new person starts as roles.ts STARTS_AS.",
        );
    });

    it("gives, pauses, and resumes a role from the app alone, and adds a person from sign-in alone", () => {
        assert.deepEqual(callers("giveRole"), ["app.ts"]);
        assert.deepEqual(callers("pauseUser"), ["app.ts"]);
        assert.deepEqual(callers("resumeUser"), ["app.ts"]);
        assert.deepEqual(callers("addUser"), ["auth.ts"]);
    });

    it("takes no role through updateUser: its patch has none", () => {
        const text = readFileSync(join(SERVER, "config.ts"), "utf8");
        const patch = /export type UserPatch = Partial<\s*Pick<\s*User,([\s\S]*?)>\s*>/.exec(
            text,
        )?.[1];

        assert.ok(patch !== undefined, "UserPatch is declared");
        assert.doesNotMatch(patch, /"role"|"paused"/);
        assert.match(text, /updateUser\(id: string, patch: UserPatch\): void/);
    });
});

describe("the page compares no role", () => {
    /**
     * A module that reads the role through the public extension API alone (`types/pocket.d.ts` `Person.role`), as a
     * module someone else wrote would: the API says the role and none of the page's answers.
     */
    const PUBLIC_API = ["extensions/session-tags/index.js"];
    /**
     * Lines the finder takes for a role that name something else. Each is the whole line, so a new compare beside it
     * is still found. "viewer" here is the sheet that shows an artifact (`web/sheets/viewers.js`), not the role.
     */
    const NOT_A_ROLE = new Set([
        'web/sheets.js:case "viewer":',
        'web/sheets/viewers.js:if (message.type === "pocket-selection" && store.state.sheet?.type === "viewer") {',
    ]);

    it("asks web/roles.js, which reads what the server said: no file of the page compares a role", () => {
        const pages = [
            ...scripts(WEB).map((file) => ({ file, as: `web/${relative(WEB, file)}` })),
            ...scripts(join(SERVER, "extensions"))
                .filter((file) => !PUBLIC_API.includes(name(file)))
                .map((file) => ({ file, as: `src/server/${name(file)}` })),
        ];
        const found = pages.flatMap(({ file, as }) => {
            const at = as.split(sep).join("/");

            return compares(code(file))
                .filter((line) => !NOT_A_ROLE.has(`${at}:${line.replace(/^\d+: /, "")}`))
                .map((line) => `${at}:${line}`);
        });

        assert.ok(pages.length > 100, "the page's files are found");
        assert.deepEqual(
            found,
            [],
            "Ask web/roles.js (isOwner, isViewer, isUser, prompts) or a flag of the hello (web/store.js), not the role.",
        );
    });

    it("reads in web/roles.js only what the server said, never the role", () => {
        const text = code(join(WEB, "roles.js"));

        assert.doesNotMatch(text, /\.role\b/);
        assert.match(text, /\.owner === true/);
        assert.match(text, /\.prompts === (?:true|false)/);
    });
});
