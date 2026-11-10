import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { FileError, err } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
    saveScreenshot,
    screenshotFormat,
    SCREENSHOT_BYTES,
} from "../src/server/browser/screenshots.ts";

test("screenshot formats come only from the path's extension", () => {
    for (const [path, format] of [
        ["shots/page.png", "png"],
        ["shots/page.JPG", "jpeg"],
        ["shots/page.jpeg", "jpeg"],
        ["shots/page.WebP", "webp"],
    ]) {
        assert.equal(screenshotFormat(path!), format);
    }

    for (const path of ["shot", "shot.gif", "shot.png.exe", ".png"]) {
        assert.throws(() => screenshotFormat(path), /Use \.png, \.jpg\/\.jpeg, or \.webp/);
    }
});

test("saving creates parents through the environment and refuses folders and large files", async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pocket-screenshots-"));

    t.after(() => rm(cwd, { recursive: true, force: true }));
    const env = new NodeExecutionEnv({ cwd });
    const bytes = Buffer.from("image bytes");
    const write = t.mock.method(env, "writeFile");
    const mkdir = t.mock.method(env, "createDir");

    assert.equal(
        await saveScreenshot(env, "nested/shot.png", bytes, context),
        join(cwd, "nested/shot.png"),
    );
    assert.deepEqual(await readFile(join(cwd, "nested/shot.png")), bytes);
    assert.equal(write.mock.calls.length, 1);
    assert.equal(mkdir.mock.calls.length, 1);
    await assert.rejects(saveScreenshot(env, "nested", bytes, context), /is a folder/);
    await assert.rejects(
        saveScreenshot(env, "large.png", new Uint8Array(SCREENSHOT_BYTES + 1), context),
        /exceeds 50 MB/,
    );
    assert.equal(write.mock.calls.length, 1, "refused files never reach writeFile");

    // A final symlink to a directory is refused by writeFile too, without writing into that directory.
    await symlink(join(cwd, "nested"), join(cwd, "folder.png"), "dir");
    await assert.rejects(saveScreenshot(env, "folder.png", bytes, context));
});

test("saving propagates environment permission failures without a server filesystem fallback", async (t) => {
    const env = new NodeExecutionEnv({ cwd: "/unavailable" });
    const denied = new FileError("permission_denied", "The computer refused this folder.");

    t.mock.method(env, "fileInfo", async () => err(denied));
    const write = t.mock.method(env, "writeFile");

    await assert.rejects(
        saveScreenshot(env, "shot.png", Buffer.from("bytes"), context),
        /The computer refused this folder/,
    );
    assert.equal(write.mock.calls.length, 0);
});
