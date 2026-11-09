// Authenticator lockouts in the app: each person's authenticator is kept with their account, and when too many wrong
// codes lock someone's codes out, the owner is told in their open tabs. Nobody else is.
import { type App, cleanUp, fakeTab, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { User } from "../src/server/config.ts";
import { STEP_MS, totp } from "../src/server/totp.ts";

let app: App;
let alex: User;
let clock = 1_800_000_000_000;

before(async () => {
    app = await openApp(scriptedModel(), undefined, () => clock);
    alex = app.config.addUser("Alex", "guest").user;
});

after(async () => {
    await app?.close();
    cleanUp();
});

const lockNotices = (tab: ReturnType<typeof fakeTab>) =>
    tab.events.filter(
        (each) =>
            each.event === "notice" &&
            String(each.data.message).includes("wrong authenticator codes"),
    );

test("keeps a person's authenticator with their account, and never in what browsers get", async () => {
    const { secret } = app.authenticators.begin(alex.id, alex.name);

    app.authenticators.confirm(alex.id, totp(secret, Math.floor(clock / STEP_MS)));
    assert.equal(app.authenticators.linked(alex.id), true);
    assert.equal(app.config.userById(alex.id)?.authenticator?.secret, secret);

    const shown = JSON.stringify([await app.hello(alex), await app.hello(owner(app))]);

    assert.equal(shown.includes(secret), false);
    // The owner learns that one is linked (to remove it for a lost phone); others learn nothing of it.
    assert.equal(JSON.stringify(await app.hello(alex)).includes("authenticator"), false);
    assert.equal(
        (await app.hello(owner(app))).users.find((each) => each.id === alex.id)?.authenticator,
        true,
    );
});

test("tells the owner when a guest's codes lock out, and not the guest", async () => {
    const ownerTab = fakeTab(undefined, owner(app));
    const alexTab = fakeTab(undefined, alex);

    await app.attach(ownerTab.client);
    await app.attach(alexTab.client);

    try {
        clock += STEP_MS;

        for (let i = 0; i < 4; i++) {
            assert.equal(app.authenticators.check(alex.id, "000000"), false);
        }

        assert.deepEqual(lockNotices(ownerTab), [], "no notice before the lockout");
        assert.equal(app.authenticators.check(alex.id, "000000"), false);

        const [notice] = lockNotices(ownerTab);

        assert.equal(notice?.data.level, "warning");
        assert.match(
            String(notice?.data.message),
            /^Alex entered 5 wrong authenticator codes\. Codes for their account are refused for 10 min\.$/,
        );
        assert.deepEqual(lockNotices(alexTab), [], "the guest is not told");

        // The next lockout the same day lasts 30 minutes, and says it is a repeat.
        clock = app.authenticators.lockedUntil(alex.id)! + STEP_MS;

        for (let i = 0; i < 5; i++) {
            app.authenticators.check(alex.id, "000000");
        }

        assert.match(
            String(lockNotices(ownerTab)[1]?.data.message),
            /refused for 30 min\. This is lockout 2 today: each one lasts longer\.$/,
        );
    } finally {
        app.detach(ownerTab.client);
        app.detach(alexTab.client);
    }
});
