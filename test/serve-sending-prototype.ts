/** A loopback-only send UI prototype. Uses disposable data and a model that never calls tools. */
import {
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createServer } from "node:http";
import { createHandler } from "../src/server/http.ts";

const host = "127.0.0.9";
const port = Number(process.argv[2] ?? 8897);
const app = await openApp(
    scriptedModel((request) => {
        const { text } = lastText(request as never);
        const answer = text.includes("launch checklist")
            ? "The launch checklist has three items left: confirm the handoff, review the release notes, and tidy the follow-up list."
            : "Review the handoff and release notes today. The follow-up list can wait until after launch.";

        return fauxAssistantMessage([fauxText(answer)]);
    }),
);
const session = await newSession(app);
const person = owner(app);
const pip = await app.pip.ensure(person);

await app.commands.configure(pip, person, {
    model: { provider: "faux", modelId: "faux-1" },
    thinkingLevel: "off",
});
await say(app, session, "What is left on the launch checklist?");
await say(app, pip, "What is left on the launch checklist?");
await app.commands.updateSession(session, person, { title: "Launch checklist" });

const server = createServer(createHandler({ app, listen: { host, port }, restart: () => {} }));
const base = `http://${host}:${port}`;

const stop = async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
    process.exit(0);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
await new Promise<void>((resolve) => server.listen(port, host, resolve));
console.log(`Send prototype (disposable data in ${root})`);
console.log(`1. Sign in: ${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
console.log(`2. Preview: ${base}/s/${session}?prototype=sending&variant=bubble`);
console.log("3. Send a message, compare with ‹ and ›, then choose Deliver or Refuse.");
console.log("   Open PiP with Alt+A to see the same preview in PiP.");
console.log("Ctrl+C stops the preview and deletes its data.");
