// The private folder of this server's own browser downloads (`privateFolder` in `src/server/browser/downloads.ts`), and
// where a download of a session on this server goes (`placeHere`).
import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { placeHere, privateFolder } from "../src/server/browser/downloads.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-download-folder-test-"));

after(() => rmSync(root, { recursive: true, force: true }));

describe("this server's private downloads folder", { skip: process.getuid === undefined }, () => {
    const uid = process.getuid!();

    it("is made with mode 0700, and closed again when it is open to others", async () => {
        const base = join(root, "made");

        mkdirSync(base);
        const folder = await privateFolder(base, uid);

        assert.equal(folder, join(base, `pi-pocket-downloads-${uid}`));
        assert.equal(statSync(folder).mode & 0o777, 0o700);

        chmodSync(folder, 0o755);
        assert.equal(await privateFolder(base, uid), folder);
        assert.equal(statSync(folder).mode & 0o777, 0o700);
    });

    it("is refused when another user owns it, or when it is a link", async () => {
        const base = join(root, "taken");

        mkdirSync(base);
        // Owned by "another user": this folder's owner is not the uid asked for.
        mkdirSync(join(base, `pi-pocket-downloads-${uid + 1}`));
        await assert.rejects(privateFolder(base, uid + 1), /belongs to another user: refused/);

        mkdirSync(join(base, "elsewhere"));
        symlinkSync(join(base, "elsewhere"), join(base, `pi-pocket-downloads-${uid}`));
        await assert.rejects(privateFolder(base, uid), /is not a folder: refused/);
    });
});

describe("a download of a session on this server", { skip: process.getuid === undefined }, () => {
    const uid = process.getuid!();

    /** A finished download, as Chromium leaves it in its incoming folder. */
    function arrived(base: string): string {
        const file = join(base, "incoming", "guid");

        mkdirSync(join(base, "incoming"), { recursive: true });
        writeFileSync(file, "report");

        return file;
    }

    it("goes to <folder>/<conversation>/ when this server's settings name a folder", async () => {
        const base = join(root, "named");
        const folder = join(base, "chosen");
        const file = arrived(base);
        const placed = await placeHere(folder, 7, file, "report.pdf", base);

        assert.equal(placed, join(folder, "7", "report.pdf"));
        assert.equal(readFileSync(placed, "utf8"), "report");
        assert.equal(existsSync(file), false, "moved, not copied");
        assert.equal(existsSync(join(base, `pi-pocket-downloads-${uid}`)), false);
    });

    it("goes to the private temporary folder when none is named", async () => {
        const base = join(root, "unnamed");
        const file = arrived(base);
        const placed = await placeHere(undefined, 7, file, "report.pdf", base);

        assert.equal(placed, join(base, `pi-pocket-downloads-${uid}`, "7", "report.pdf"));
        assert.equal(readFileSync(placed, "utf8"), "report");
    });
});
