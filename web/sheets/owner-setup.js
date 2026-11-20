// The owner's first start (`app.ts` `hello`'s `user.setup`): a prompt to link an authenticator, which is on their own
// page in People. It comes once a page load until one is linked or they say "Not now" (`POST /api/me/setup`).
import { useState } from "preact/hooks";
import { api, attempt, closeSheet, openSheet, store } from "../store.js";
import { html, Sheet } from "../ui.js";

export function OwnerSetupSheet() {
    const [busy, setBusy] = useState(false);

    // Not a "Not now": the prompt comes again at the next page load until an authenticator is linked. Closed first, so
    // back from People does not show it again.
    const open = () => {
        closeSheet();
        openSheet({ type: "people" });
    };

    const later = () =>
        attempt(async () => {
            setBusy(true);

            try {
                await api("me/setup", { dismissed: true });
                closeSheet();

                // The account as the server has it now, without `setup`: a later hello then matches it.
                const hello = await api("me");

                store.set({ me: hello.user, users: hello.users });
            } finally {
                setBusy(false);
            }
        });

    return html`<${Sheet} title="Finish setting up your owner account" onClose=${closeSheet}>
        <p class="muted small">
            Link an authenticator app to your account. You approve sessions with its codes on a computer that someone
            else is in charge of, and a sign-in link for another device asks for a code too.
        </p>
        <div class="sheet-actions">
            <button class="button" disabled=${busy} onClick=${later}>Not now</button>
            <button class="button primary" onClick=${open}>Open People</button>
        </div>
    <//>`;
}
