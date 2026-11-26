/** Offline dictation: download a speech model once, then use the microphone to write drafts on this device. */
import type { ExtensionWeb, PocketHost } from "../host.ts";

export default function (_host: PocketHost, web: ExtensionWeb): void {
    // Like Diagrams, this first-party client needs no session or extension-route access.
    web.client("dictation", { access: "view" });
}
