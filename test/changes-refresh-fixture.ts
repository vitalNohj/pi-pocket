import {
    cleanUp,
    lastText,
    newSession,
    openApp,
    root,
    scriptedModel,
    type App,
} from "./helpers.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";

/** A local Pi Pocket with no provider network and a model that writes exactly the requested fixture file. */
export async function changesLab() {
    const app = await openApp(
        scriptedModel((request) => {
            const { role, text } = lastText(request as never);
            const file = role === "user" && /(?:^|\n)write ([a-z0-9-]+\.txt)$/.exec(text)?.[1];

            return file
                ? fauxAssistantMessage(
                      [fauxToolCall("write", { path: file, content: "changed\n" })],
                      {
                          stopReason: "toolUse",
                      },
                  )
                : fauxAssistantMessage([fauxText("Done.")]);
        }),
    );
    const listen = { host: "127.0.0.1", port: 0 };
    const server = createServer(createHandler({ app, listen, restart: () => {} }));

    await new Promise<void>((resolve) => server.listen(0, listen.host, resolve));
    const base = `http://${listen.host}:${(server.address() as AddressInfo).port}`;

    return {
        app,
        base,
        login: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
        async close() {
            server.close();
            server.closeAllConnections();
            await app.close();
            cleanUp();
        },
    };
}

export function changesSession(app: App, files: string[] = []) {
    const cwd = mkdtempSync(join(root, "repo-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd });

    git("init", "-q");

    for (const file of files) {
        writeFileSync(join(cwd, file), "original\n");
    }

    git("add", ".");
    git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "init",
        "--allow-empty",
    );

    return newSession(app, cwd);
}

export const composer = ".composer textarea";
export const send = '.composer button[aria-label="Send"]:enabled';
export const menu = '.topbar [aria-label="Menu"]';
export const changesPlace = '.place[data-place="changes"]';
export const changesPanel = '.files-tile:not(.leaving) [aria-label="Changes"]:not([hidden])';
export const changeRow = (file: string) => `${changesPanel} .dr-file[data-path="${file}"]`;

export type ChangesTiming = { sendToRow: number; idleToRow: number; idleToRequest: number };

/** With the composer filled, time the Send click, the idle view, the list request, and the new row inside the page. */
export function measureChange(file: string): string {
    return `(async () => {
        const { store } = await import("/store.js");
        const { view, conversationId } = store.state;
        const before = view.order.at(-1);
        const selector = ${JSON.stringify(changeRow(file))};
        const click = document.querySelector(${JSON.stringify(send)});
        if (!click || document.querySelector(selector)) throw new Error("Expected Send and no target Changes row");

        let idle, requested, started;
        const off = store.subscribe(() => {
            const { view } = store.state;
            const last = view.order.at(-1);
            if (idle === undefined && !view.live.busy && last !== before &&
                view.entries.get(last)?.kind === "assistant" && view.entries.get(last).stopReason !== "toolUse") {
                idle = performance.now();
            }
        });
        const fetch = window.fetch;
        window.fetch = (url, ...args) => {
            if (idle !== undefined && requested === undefined &&
                new URL(url, location.href).pathname === "/api/c/" + conversationId + "/changes") {
                requested = performance.now();
            }
            return fetch(url, ...args);
        };
        let observer, timeout;
        try {
            return await new Promise((resolve, reject) => {
                observer = new MutationObserver(() => {
                    if (idle !== undefined && requested !== undefined && document.querySelector(selector)) {
                        const at = performance.now();
                        resolve({ sendToRow: at - started, idleToRow: at - idle, idleToRequest: requested - idle });
                    }
                });
                observer.observe(document.body, { subtree: true, childList: true, attributes: true });
                timeout = setTimeout(() => reject(new Error("No automatic Changes row for " + selector)), 5000);
                started = performance.now();
                click.click();
            });
        } finally {
            clearTimeout(timeout);
            observer?.disconnect();
            off();
            window.fetch = fetch;
        }
    })()`;
}
