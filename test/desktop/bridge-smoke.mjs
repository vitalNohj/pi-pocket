import assert from "node:assert/strict";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function verifyMacMenus(out, stateFolder, until) {
    const file = "status-menu-model.json";
    let evidence;
    let model;

    try {
        await until("the installed Mac app built the menus with a badge while hidden", async () => {
            evidence = await readFile(join(stateFolder, file), "utf8").catch((error) => {
                if (error.code !== "ENOENT") {
                    throw error;
                }

                return null;
            });
            model = evidence && JSON.parse(evidence);

            return (
                model?.hidden &&
                model.badge === "π 2" &&
                model.tray.some(({ title }) => title === "Open Pi Pocket (2 need you)")
            );
        });
    } finally {
        if (evidence) {
            await writeFile(join(out, file), evidence);
        }
    }

    for (const entries of [model.tray, model.dock]) {
        assert(
            entries.some(
                ({ title, action, enabled }) =>
                    title === "New Session" && action === "window.newSession" && enabled,
            ),
        );
        const pins = entries.find(({ title }) => title === "Pinned Sessions");

        assert.deepEqual(pins?.items, [
            {
                title: "◆ Release notes & checks — Waiting for you",
                enabled: true,
                action: "window.pinned",
            },
            { title: "◐ Installer smoke — Working", enabled: true, action: "window.pinned" },
        ]);
    }

    console.log(
        "The installed app's π and Dock menus contain the expected native items; the hidden status item shows π 2.",
    );

    return model.anchor;
}

async function performMacMenuAction(stateFolder, action) {
    const next = join(stateFolder, "status-menu-action.next");

    await writeFile(next, action);
    await rename(next, join(stateFolder, "status-menu-action.txt"));
}

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
    const windows = process.platform === "win32";

    const setPage = async (data) => {
        const step = remote.step(data);

        await until(`fixture step ${step} reached the primary page`, () => seen(`step-${step}`));
    };

    await until("the web view owns the bridge feed", () => seen("primary"));
    await gui("close", app);
    await until("the page reports a hidden window", () => seen("window-hidden"));
    await setPage({ badge: 2, hidden: true });
    const menuProof = join(out, "tray-pins-and-badge.png");
    const anchor = windows ? null : await verifyMacMenus(out, stateFolder, until);
    const location = windows ? [] : [anchor?.x ?? "-", anchor?.y ?? "-"];
    let canClick = true;

    async function tray(action, group, label, proof = "-", other = "-") {
        if (canClick) {
            try {
                await gui("tray", badge, group, label, proof, other, ...location);

                return;
            } catch (error) {
                if (
                    windows ||
                    !/No π status item|The π menu did not show '2 need you'/.test(
                        error.stderr ?? "",
                    )
                ) {
                    throw error;
                }

                // The hosted desktop may not deliver the status-item click. Dispatch the actual
                // NSMenuItem through AppKit and still require the page to receive each action.
                canClick = false;

                if (proof !== "-") {
                    await rename(proof, join(out, "macos-status-item.png"));
                }

                console.log(
                    "The runner did not open the π menu. Testing the installed NSMenuItem actions without pointer input.",
                );
            }
        }

        await performMacMenuAction(stateFolder, action);
    }

    await tray("secondPin", menu, "Installer smoke", menuProof, "Release notes");

    if (canClick) {
        assert((await stat(menuProof)).size > 4000, "the system menu screenshot is not empty");
    }

    await until("the second pin opens session 17", () => seen("opened/s/17"));
    assert.equal(seen("opened/s/4"), 0);
    await tray("firstPin", menu, "Release notes", "-", "Installer smoke");
    await until("the first pin opens session 4", () => seen("opened/s/4"));
    await tray("newSession", "-", "New Session");
    await until("New Session from the native menu shows the sheet", () => seen("new-sheet") === 1);
    await gui("click", app, 180, 210); // Give the page keyboard focus, not the menu bar.
    await gui("new", app);
    await until(
        "the native New Session shortcut shows the same sheet",
        () => seen("new-sheet") === 2,
    );
    console.log(
        "The hidden app displayed the badge and both pins. Both selections opened the right session. The native menu and shortcut opened New Session.",
    );

    await tray("settings", "-", "Desktop Settings");
    await waitForSettings(3);
    await gui("click", settings, 95, 361); // Notifications section
    await shot(settings, "notifications-settings");
    const click = (x, y) => gui("click", settings, x, y);
    const check = (key, value) =>
        until(
            `Notifications saved ${key} = ${value}`,
            async () => (await prefs()).notifications[key] === value,
        );

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
