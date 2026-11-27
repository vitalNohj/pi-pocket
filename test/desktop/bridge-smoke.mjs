import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export async function testBridge({
    remote,
    gui,
    until,
    prefs,
    waitForSettings,
    shot,
    out,
    stateFolder,
}) {
    const app = "Pi Pocket";
    const settings = "Desktop Settings — Pi Pocket";
    const seen = (event) =>
        remote.requests.filter(({ path }) => path === `/pocket/${event}`).length;
    const badge = "2 need you";
    const menu = "Pinned Sessions";
    const tray = (group, label, proof = "-", other = "-") =>
        gui("tray", badge, group, label, proof, other);

    const setPage = async (data) => {
        const step = remote.step(data);

        await until(`fixture step ${step} reached the primary page`, () => seen(`step-${step}`));
    };

    await until("the web view owns the bridge feed", () => seen("primary"));
    await gui("close", app);
    await until("the page reports a hidden window", () => seen("window-hidden"));
    await setPage({ badge: 2, hidden: true });
    const menuProof = join(out, "tray-pins-and-badge.png");

    await tray(menu, "Installer smoke", menuProof, "Release notes");
    assert((await stat(menuProof)).size > 4000, "the system menu screenshot is not empty");
    await until("the second pin opens session 17", () => seen("opened/s/17"));
    assert.equal(seen("opened/s/4"), 0);
    await tray(menu, "Release notes", "-", "Installer smoke");
    await until("the first pin opens session 4", () => seen("opened/s/4"));
    await tray("-", "New Session");
    await until("New Session from the native menu shows the sheet", () => seen("new-sheet") === 1);
    await gui("click", app, 180, 210); // Give the page keyboard focus, not the menu bar.
    await gui("new", app);
    await until(
        "the native New Session shortcut shows the same sheet",
        () => seen("new-sheet") === 2,
    );
    console.log(
        "The hidden app displayed the badge and both pins. Both clicks opened the right session. The native menu and shortcut opened New Session.",
    );

    await tray("-", "Desktop Settings");
    await waitForSettings(3);
    await gui("click", settings, 95, 361); // Notifications section
    await shot(settings, "notifications-settings");
    const click = (x, y) => gui("click", settings, x, y);
    const check = (key, value) =>
        until(
            `Notifications saved ${key} = ${value}`,
            async () => (await prefs()).notifications[key] === value,
        );

    const windows = process.platform === "win32";

    const chooseNext = async () => {
        await click(450, windows ? 302 : 297);
        await gui("chooseNext", settings);
    };

    const expectDecision = async (call, code) => {
        await setPage({ call });
        const log = join(stateFolder, "diagnostics.log");

        // The OS may block banners or sound on hosted runners. Assert the native adapter's
        // redacted presentation decision before OS delivery. Native unit tests cover the text.
        await until(`native notification decision ${code}`, async () =>
            (await readFile(log, "utf8")).includes(`notifications.approval: ${code}\n`),
        );
    };

    await click(252, 202); // Show notifications
    await check("enabled", false);
    await click(252, 235); // Play a sound
    await check("sound", false);
    await chooseNext(); // When the full command is shown -> Always
    await check("approve", "always");
    await click(282, windows ? 429 : 422); // Advanced
    await click(380, windows ? 496 : 490); // Command length limit
    await gui("selectAll", settings);
    await gui("type", settings, "20");
    await click(340, 100); // Commit the input by leaving it.
    await check("commandLimit", 20);
    await expectDecision("read: notes", "suppressed");
    await click(252, 202);
    await check("enabled", true);
    await shot(settings, "notifications-settings");
    await expectDecision("read:\n" + "fixture command ".repeat(8), "silent.allow-deny");
    await chooseNext(); // Always -> Never
    await check("approve", "never");
    await expectDecision("read: notes", "silent.deny");
    await click(252, 235);
    await check("sound", true);
    await expectDecision("read: notes", "sound.deny");
    console.log(
        "Notifications saved automatically and changed the native display, sound and approval policy without a restart.",
    );
}
