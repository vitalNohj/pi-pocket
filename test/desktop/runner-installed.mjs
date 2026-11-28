// Installer smoke. Run with the installed Node, after blocking npm. It does not use the checkout's node_modules.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RunnerController } from "../../packaging/desktop/controller/runner/index.mjs";
import { installedRunner } from "../../packaging/desktop/controller/runner/process.mjs";
import { runnerPolicy } from "../../packaging/desktop/controller/runner/policy.mjs";
import { installedModules } from "./fixture.mjs";

const windows = process.platform === "win32";
const modules = installedModules();
const pocket = join(modules, "pi-pocket");
const installed = (path) => import(pathToFileURL(join(pocket, path)).href);
const runnerFiles = ["package.json", "main.js", "src/main.ts", "src/activity.ts"];

async function stagedServerUpdate(root) {
    const { npmCommand } = await installed("src/server/npm-install.ts");
    const { stageNpmUpdate } = await installed("src/server/npm-update.ts");
    const { finishNpmPending, readPending, stagedPackagePath, swapInPackage, writePending } =
        await installed("src/server/update-state.ts");
    const prefix = join(root, "disposable npm prefix");
    const packages = join(prefix, ...(windows ? [] : ["lib"]), "node_modules");
    const server = join(packages, "pi-pocket");
    const runner = join(packages, "pi-pocket-runner");
    const payload = join(root, "stage this package");
    const offline = {
        ...process.env,
        npm_config_cache: join(root, "npm-cache"),
        npm_config_userconfig: join(root, "empty-npmrc"),
        npm_config_offline: "true",
    };
    const fromVersion = "1.0.0";
    const toVersion = "2.0.0";
    const version = (path) => JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version;

    for (const [folder, version] of [
        [server, fromVersion],
        [payload, toVersion],
    ]) {
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "pi-pocket", version }));
    }

    cpSync(join(modules, "pi-pocket-runner"), runner, { recursive: true });
    const expectedRunner = realpathSync(join(runner, "main.js"));
    const resolvesRunner = () =>
        realpathSync(createRequire(join(server, "package.json")).resolve("pi-pocket-runner/main"));

    assert.equal(resolvesRunner(), expectedRunner);
    const command = npmCommand();
    const args = ["pack", "--ignore-scripts", "--pack-destination", root];
    const pack = spawnSync(
        command.shell ? `"${command.file}"` : command.file,
        command.shell ? args.map((arg) => `"${arg}"`) : args,
        {
            cwd: payload,
            env: offline,
            encoding: "utf8",
            shell: command.shell,
            timeout: 30_000,
            windowsHide: true,
        },
    );

    assert.equal(pack.status, 0, "npm packed only the disposable fixture");
    writePending(server, {
        v: 1,
        kind: "npm-global",
        tag: `v${toVersion}`,
        fromVersion,
        toVersion,
        from: "",
        to: "",
        branch: null,
        modules: false,
        oneWay: false,
        phase: "packages",
        at: Date.now(),
    });

    // Use the server updater's real staging, swap, and startup completion. No public registry or installed server target.
    await stageNpmUpdate(server, toVersion, {
        spec: join(root, `pi-pocket-${toVersion}.tgz`),
        env: offline,
    });
    assert.equal(version(server), fromVersion);
    assert.equal(version(stagedPackagePath(server)), toVersion);
    swapInPackage(server);
    assert.equal(version(server), toVersion);
    assert.equal(finishNpmPending(server, readPending(server)).ok, true);
    assert.equal(
        resolvesRunner(),
        expectedRunner,
        "the updated server still resolves the sibling fork runner",
    );

    for (const file of runnerFiles) {
        assert(
            readFileSync(join(runner, file)).equals(
                readFileSync(join(modules, "pi-pocket-runner", file)),
            ),
            `the update changed the runner's ${file}`,
        );
    }
}

function openRunner(dir, publish = () => {}) {
    return new RunnerController({
        start: installedRunner({ stateDir: dir }),
        publish,
        ...runnerPolicy(dir),
    });
}

async function until(check, name) {
    for (let i = 0; i < 300; i++) {
        if (check()) {
            return;
        }

        await sleep(100);
    }

    throw new Error(`Did not see ${name} within 30 seconds.`);
}

async function smoke() {
    assert.ok(
        process.env.NPM_CONFIG_REGISTRY?.startsWith("http://127.0.0.1:9/"),
        "run after the npm block step",
    );

    for (const name of runnerFiles) {
        const source = readFileSync(new URL(`../../packages/runner/${name}`, import.meta.url));
        const bundled = readFileSync(join(modules, "pi-pocket-runner", name));

        assert.ok(bundled.equals(source), `the installed runner's ${name} differs from this build`);
    }

    await installed("bin/strip-types.js");
    const { PocketApp } = await installed("src/server/app.ts");
    const { createHandler } = await installed("src/server/http.ts");
    const { BACKGROUND_CONTEXT } = await installed(
        "node_modules/@earendil-works/chord/dist/context/index.js",
    );
    const root = mkdtempSync(join(tmpdir(), "pocket-installed-runner-"));
    const dir = join(root, "runner config with spaces");
    const borrowedDir = join(root, "separate runner");
    const work = join(root, "work");

    mkdirSync(work);
    const initialStatus = spawnSync(
        process.execPath,
        [
            join(pocket, "bin", "pi-pocket.js"),
            "runner",
            "status",
            "--config",
            join(root, "no-link.json"),
        ],
        {
            encoding: "utf8",
            windowsHide: true,
            timeout: 30_000,
        },
    );

    assert.ok(
        initialStatus.status === 0 &&
            initialStatus.stdout.startsWith("This computer is not linked."),
        "the installed CLI resolves the runner offline",
    );

    let app;
    let http;
    let external;
    let externalExit;
    let main = openRunner(dir);
    const borrower = openRunner(borrowedDir);

    try {
        app = await PocketApp.open({
            dataDir: join(root, "server data"),
            defaultCwd: work,
            home: root,
            supervised: false,
            log: () => {},
        });
        http = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        http.on("upgrade", (request, socket, head) => {
            if (!app.runners.upgrade(request, socket, head)) {
                socket.destroy();
            }
        });
        await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
        const server = `http://127.0.0.1:${http.address().port}`;
        const owner = app.config.users.find((user) => user.role === "owner");
        const runnerId = (name) => app.config.runners.find((runner) => runner.name === name)?.id;
        const online = (id) => app.runners.link(id).online;

        await main.boot();
        assert.equal(main.state.status, "unlinked");
        await main.link({
            server,
            code: app.runners.makeCode("Desktop smoke", owner.id).code,
            trusted: true,
        });
        assert.equal(main.state.status, "disabled");
        const id = runnerId("Desktop smoke");

        assert.ok(id, "the disposable server has the linked computer");
        await main.setEnabled(true);
        await until(() => main.state.status === "connected", "the installed runner connect");
        assert.ok(online(id));
        assert.equal(main.state.working, false);

        await borrower.boot();
        await borrower.link({
            server,
            code: app.runners.makeCode("Separate smoke", owner.id).code,
            trusted: true,
        });
        await borrower.setEnabled(true);
        await until(() => borrower.state.status === "connected", "the separate runner connect");
        const otherId = runnerId("Separate smoke");

        assert.ok(online(otherId));

        const env = app.runners.env(id, work, {
            id: "7053c1d4-4f9f-48b4-81ea-5b3fccc10fb6",
            folder: work,
        });
        const command = env.exec('node -e "setTimeout(() => {}, 5000)"', {}, BACKGROUND_CONTEXT);

        // Attach a rejection handler now so a failure while we wait can still reach finally.
        void command.catch(() => {});
        await until(() => main.state.working, "real PI-POCKET-ACTIVITY from the installed runner");
        assert.equal(main.state.label, "Working now");
        assert.equal(main.state.workingFolders, 1);
        await assert.rejects(main.reconnect(false), { code: "runner.confirm" });
        assert.equal((await command).ok, true);
        await until(() => !main.state.working, "the runner return to idle");
        console.log(
            "Installed runner: linked, enabled, connected, and reported Working now and idle.",
        );

        const link = join(dir, "link.json");
        const beforeUpdate = readFileSync(link);

        await stagedServerUpdate(root);
        assert(
            readFileSync(link).equals(beforeUpdate),
            "updating the server must not change the private runner link",
        );
        assert.ok(
            online(id),
            "staging and applying the server update left the installed runner online",
        );
        await main.reconnect(true);
        await until(
            () => main.state.status === "connected" && online(id),
            "the installed runner reconnect with its original link",
        );
        assert(
            readFileSync(link).equals(beforeUpdate),
            "reconnect reused the runner link after the server update",
        );
        console.log(
            "Server-only npm staging and swap preserved the fork runner prefix, source and link.",
        );
        await main.setEnabled(false, true);
        await until(() => !online(id), "the disabled runner go offline");
        assert.ok(online(otherId), "disabling the owned runner did not stop the separate one");
        assert.equal(main.state.linked, true);

        // Start a separate controller with this private link, then kill that controller. The native helper must use EOF
        // to stop only its own runner, even without a normal shutdown request. No test endpoint ships with the installer.
        await main.setEnabled(true);
        await until(() => main.state.status === "connected", "the re-enabled runner connect");
        await main.close();
        await until(() => !online(id), "the closed runner go offline");
        external = spawn(process.execPath, [fileURLToPath(import.meta.url), "--crash-probe", dir], {
            stdio: "ignore",
            windowsHide: true,
        });
        externalExit = new Promise((resolve) => {
            external.once("error", resolve);
            external.once("close", resolve);
        });
        await until(() => online(id), "the second controller start the installed runner");
        external.kill("SIGKILL");
        await externalExit;
        await until(() => !online(id), "the native adapter clean up after its controller exits");
        assert.ok(online(otherId));
        console.log(
            "Installed runner: reconnect, disable, normal close and controller crash affected only the owned runner.",
        );

        main = openRunner(dir);
        await main.boot();
        await until(() => main.state.status === "connected", "the boot-enabled runner reconnect");
        await app.unlinkRunner(id);
        await until(() => main.state.status === "ended", "the revoked runner report Link ended");
        assert.equal(main.state.running, false);
        await main.close();
        main = openRunner(dir);
        await main.boot();
        assert.equal(main.state.status, "ended");
        assert.equal(main.state.running, false);
        await main.unlink(true);
        assert.equal(main.state.status, "unlinked");
        assert.ok(online(otherId));
        console.log(
            "Installed runner: revoked link did not restart, and unlink cleared the saved link.",
        );
    } finally {
        external?.kill();
        await externalExit;
        await Promise.all([main.close(), borrower.close()]);
        await app?.close();
        http?.closeAllConnections();

        if (http) {
            await new Promise((resolve) => http.close(resolve));
        }

        rmSync(root, { recursive: true, force: true });
    }
}

if (process.argv[2] === "--crash-probe") {
    await openRunner(process.argv[3]).boot();
} else {
    await smoke();
}
