import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageDesktopUpdate } from "../../packaging/desktop/controller/updates/desktop-updates.mjs";
import {
    checkDesktopUpdate,
    isNewerDesktopVersion,
} from "../../packaging/desktop/feed/desktop-builds.mjs";
import { updateFixture } from "./update-fixture.mjs";

const current = "0.30.1-desktop.9";
const next = "0.30.1-desktop.10";
const bytes = Buffer.from("fixture installer");

test("desktop version order uses both the release core and the workflow run number", () => {
    assert.equal(isNewerDesktopVersion(next, current), true);
    assert.equal(isNewerDesktopVersion(current, next), false);
    assert.equal(isNewerDesktopVersion("0.29.1-desktop.10", current), false);
    assert.equal(isNewerDesktopVersion("0.31.0-desktop.8", current), false);
    assert.equal(isNewerDesktopVersion(next, "0.30.1"), false);
});

test("only a matching artifact from a successful fork push is offered", async (t) => {
    const fixture = await updateFixture("win32", next, bytes);

    t.after(fixture.close);

    const candidate = await checkDesktopUpdate(current, "win32", fixture.request);

    assert.equal(candidate.phase, "available");
    assert.equal(candidate.version, next);
    assert.equal(candidate.size, bytes.length);
    assert.equal(
        candidate.downloadUrl,
        "https://github.com/vitalNohj/pi-pocket/actions/runs/456/artifacts/789",
    );
    assert.equal((await checkDesktopUpdate(next, "win32", fixture.request)).phase, "current");
    assert.equal(
        (await checkDesktopUpdate(current, "darwin", fixture.request)).phase,
        "unavailable",
    );

    fixture.artifact.expired = true;
    assert.equal(
        (await checkDesktopUpdate(current, "win32", fixture.request)).phase,
        "unavailable",
    );
    fixture.artifact.expired = false;
    fixture.artifact.digest = "sha256:missing";
    await assert.rejects(checkDesktopUpdate(current, "win32", fixture.request), /digest and size/);
    fixture.run.run_number += 1;
    assert.equal(
        (await checkDesktopUpdate(current, "win32", fixture.request)).phase,
        "unavailable",
    );
    fixture.run.event = "pull_request";
    await assert.rejects(
        checkDesktopUpdate(current, "win32", fixture.request),
        /desktop-native push/,
    );
    fixture.run.event = "push";
    fixture.run.head_repository.full_name = "another/fork";
    await assert.rejects(
        checkDesktopUpdate(current, "win32", fixture.request),
        /desktop-native push/,
    );
});

test("other builds do not try to use this feed", async () => {
    const noNetwork = () => assert.fail("The feed should not be accessed");

    assert.equal((await checkDesktopUpdate("0.30.1", "win32", noNetwork)).phase, "disabled");
    assert.equal((await checkDesktopUpdate(current, "linux", noNetwork)).phase, "disabled");
});

test("staging checks the bytes, not the user-selected filename", async (t) => {
    const fixture = await updateFixture("darwin", next, bytes);

    t.after(fixture.close);
    const dir = await mkdtemp(join(tmpdir(), "pp-update-fixture-"));

    t.after(() => rm(dir, { force: true, recursive: true }));
    const selected = join(dir, "Downloaded file (1).pkg");
    const cache = join(dir, "stage");

    await writeFile(selected, Buffer.alloc(bytes.length, 0));
    await assert.rejects(
        stageDesktopUpdate(current, "darwin", selected, cache, fixture.request),
        /SHA-256/,
    );
    await assert.rejects(readFile(join(cache, "pending.json")), { code: "ENOENT" });
    await writeFile(selected, bytes);
    assert.deepEqual(
        await stageDesktopUpdate(current, "darwin", selected, cache, fixture.request),
        {
            phase: "staged",
            current,
            version: next,
        },
    );
    const { version, sha256 } = JSON.parse(await readFile(join(cache, "pending.json"), "utf8"));

    assert.equal(version, next);
    assert.deepEqual(await readFile(join(cache, `${sha256}-${fixture.artifact.name}`)), bytes);
});
