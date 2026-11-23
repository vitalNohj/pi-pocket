// The folder picker's listings kept in memory (`web/folder-cache.js`): a folder opened again shows at once while a
// fresh read replaces it, folders likely opened next are read ahead one at a time, and nothing read for one person
// shows for another.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a browser module, without types.
import * as folderCache from "../web/folder-cache.js";

type Listing = { path: string; dirs: { name: string; path: string }[] };
type Cache = {
    cached(runner: string | null, path: string, hidden: boolean): Listing | undefined;
    read(runner: string | null, path: string, hidden: boolean): Promise<Listing>;
    ahead(folders: [string | null, string][], hidden: boolean): void;
    soon(runner: string | null, path: string, hidden: boolean): void;
    clear(): void;
    readonly size: { kept: number; waiting: number };
};
type Options = {
    read: (runner: string | null, path: string, hidden: boolean) => Promise<Listing>;
    person: () => unknown;
    now?: () => number;
};

const createFolderCache = folderCache.createFolderCache as (options: Options) => Cache;
const { KEPT_MS, FRESH_MS, MAX_KEPT } = folderCache as {
    KEPT_MS: number;
    FRESH_MS: number;
    MAX_KEPT: number;
};

/** A server whose reads wait until a test answers them; each read is logged. */
function fakeServer() {
    const asked: {
        runner: string | null;
        path: string;
        hidden: boolean;
        answer: (dirs?: string[]) => void;
        fail: (error: Error) => void;
    }[] = [];
    const read = (runner: string | null, path: string, hidden: boolean) =>
        new Promise<Listing>((resolve, reject) => {
            asked.push({
                runner,
                path,
                hidden,
                answer: (dirs = ["a", "b"]) =>
                    resolve({
                        path: path === "~" ? "/home/me" : path,
                        dirs: dirs.map((name) => ({ name, path: `${path}/${name}` })),
                    }),
                fail: reject,
            });
        });

    return { asked, read };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a folder read once shows at once the next time, and the fresh read replaces it", async () => {
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => "me" });

    assert.equal(cache.cached(null, "/w", false), undefined);

    const first = cache.read(null, "/w", false);

    server.asked[0]!.answer(["a"]);
    assert.deepEqual(
        (await first).dirs.map((dir) => dir.name),
        ["a"],
    );
    assert.deepEqual(
        cache.cached(null, "/w", false)?.dirs.map((dir) => dir.name),
        ["a"],
    );

    // Opened again: the old listing shows, and a fresh read goes out at once.
    const again = cache.read(null, "/w", false);

    assert.equal(server.asked.length, 2, "the fresh read is asked at once");
    server.asked[1]!.answer(["a", "new"]);
    assert.deepEqual(
        (await again).dirs.map((dir) => dir.name),
        ["a", "new"],
    );
    assert.deepEqual(
        cache.cached(null, "/w", false)?.dirs.map((dir) => dir.name),
        ["a", "new"],
    );
});

test("an unchanged fresh read gives back the listing kept, so the picker draws nothing again", async () => {
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => "me" });
    const first = cache.read(null, "/w", false);

    server.asked[0]!.answer();

    const kept = await first;
    const again = cache.read(null, "/w", false);

    server.asked[1]!.answer();
    assert.equal(await again, kept);
});

test("listings are kept per computer, per path, and per hidden choice", async () => {
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => "me" });
    const reads = [
        cache.read(null, "/w", false),
        cache.read("laptop", "/w", false),
        cache.read(null, "/w", true),
    ];

    server.asked[0]!.answer(["server"]);
    server.asked[1]!.answer(["laptop"]);
    server.asked[2]!.answer(["hidden"]);
    await Promise.all(reads);

    assert.equal(cache.cached(null, "/w", false)?.dirs[0]?.name, "server");
    assert.equal(cache.cached("laptop", "/w", false)?.dirs[0]?.name, "laptop");
    assert.equal(cache.cached(null, "/w", true)?.dirs[0]?.name, "hidden");
    assert.equal(cache.cached("other", "/w", false), undefined);
});

test("a listing asked by another name is also kept under its real path", async () => {
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => "me" });
    const home = cache.read(null, "~", false);

    server.asked[0]!.answer(["code"]);
    await home;

    assert.equal(cache.cached(null, "/home/me", false)?.path, "/home/me");
    assert.equal(cache.cached(null, "~", false)?.path, "/home/me");
});

test("a failed read keeps no listing, and the failure reaches the picker", async () => {
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => "me" });
    const first = cache.read(null, "/w", false);

    server.asked[0]!.answer();
    await first;

    const gone = cache.read(null, "/w", false);

    server.asked[1]!.fail(new Error("isn't there"));
    await assert.rejects(gone, /isn't there/);
    assert.equal(cache.cached(null, "/w", false), undefined);
});

test("a listing too old to show is not shown, and the oldest go past the limit", async () => {
    let now = 0;
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => "me", now: () => now });
    const first = cache.read(null, "/w", false);

    server.asked[0]!.answer();
    await first;
    now += KEPT_MS + 1;
    assert.equal(cache.cached(null, "/w", false), undefined);

    for (let i = 0; i <= MAX_KEPT; i++) {
        const read = cache.read(null, `/f${i}`, false);

        server.asked.at(-1)!.answer([]);
        await read;
    }

    assert.equal(cache.size.kept, MAX_KEPT);
    assert.equal(cache.cached(null, "/f0", false), undefined, "the oldest went");
    assert.ok(cache.cached(null, `/f${MAX_KEPT}`, false));
});

test("nothing read for one person shows for the next, also a read still on its way when they change", async () => {
    let person: object | null = { id: "owner" };
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => person });
    const first = cache.read(null, "/w", false);

    server.asked[0]!.answer(["secret"]);
    await first;
    assert.ok(cache.cached(null, "/w", false));

    // On its way while the person changes: answered, but kept for nobody.
    const late = cache.read(null, "/x", false);

    person = { id: "guest" };
    assert.equal(cache.cached(null, "/w", false), undefined, "the listing went with its person");
    server.asked[1]!.answer(["secret"]);
    await late;
    assert.equal(cache.cached(null, "/x", false), undefined, "the late answer is not kept");

    // Signed out: nothing.
    person = null;
    assert.equal(cache.size.kept, 0);
    assert.equal(cache.cached(null, "/x", false), undefined);
});

test("a read ahead and a click on the same folder share one request", async () => {
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => "me" });

    cache.ahead([[null, "/w/a"]], false);
    await settle();
    assert.equal(server.asked.length, 1);

    const click = cache.read(null, "/w/a", false);

    assert.equal(server.asked.length, 1, "the click joins the read ahead");
    server.asked[0]!.answer(["x"]);
    assert.deepEqual(
        (await click).dirs.map((dir) => dir.name),
        ["x"],
    );
});

test("folders are read ahead one at a time, in order, and a new folder shown replaces the queue", async () => {
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => "me" });

    cache.ahead(
        [
            [null, "/w"],
            [null, "/w/a/one"],
            ["laptop", "~"],
        ],
        false,
    );
    await settle();
    assert.deepEqual(
        server.asked.map((each) => each.path),
        ["/w"],
        "one at a time",
    );
    server.asked[0]!.answer();
    await settle();
    assert.deepEqual(
        server.asked.map((each) => each.path),
        ["/w", "/w/a/one"],
    );

    // Another folder shows: what waited is dropped for its own; the read on its way finishes.
    cache.ahead([[null, "/v"]], false);
    server.asked[1]!.answer();
    await settle();
    assert.deepEqual(
        server.asked.map((each) => [each.runner, each.path]),
        [
            [null, "/w"],
            [null, "/w/a/one"],
            [null, "/v"],
        ],
    );
    server.asked[2]!.answer();
    await settle();
    assert.equal(cache.size.waiting, 0);
    assert.equal(server.asked.length, 3);
});

test("a folder read moments ago is not read ahead again; the pointer's folder goes first", async () => {
    let now = 0;
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => "me", now: () => now });
    const first = cache.read(null, "/w", false);

    server.asked[0]!.answer();
    await first;

    cache.ahead(
        [
            [null, "/w"],
            [null, "/x"],
            [null, "/y"],
        ],
        false,
    );
    await settle();
    assert.deepEqual(
        server.asked.map((each) => each.path),
        ["/w", "/x"],
        "/w is fresh",
    );

    cache.soon(null, "/hover", false);
    server.asked[1]!.answer();
    await settle();
    assert.equal(server.asked[2]!.path, "/hover", "the pointer's folder before /y");

    // Later, the same folder is worth reading again.
    now += FRESH_MS + 1;
    server.asked[2]!.answer();
    await settle();
    server.asked[3]!.answer();
    await settle();
    cache.ahead([[null, "/w"]], false);
    await settle();
    assert.equal(server.asked.at(-1)!.path, "/w");
});

test("a failed read ahead does not stop the ones after it", async () => {
    const server = fakeServer();
    const cache = createFolderCache({ read: server.read, person: () => "me" });

    cache.ahead(
        [
            [null, "/locked"],
            [null, "/open"],
        ],
        false,
    );
    await settle();
    server.asked[0]!.fail(new Error("Pi Pocket cannot read /locked."));
    await settle();
    assert.equal(server.asked[1]?.path, "/open");
});
