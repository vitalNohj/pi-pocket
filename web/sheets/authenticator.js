// Your own authenticator app (`src/server/approval-methods.ts`): link it to your account, and approve your new folders
// with its codes. Its secret is shown once, while linking; the server keeps it and never sends it again.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, store } from "../store.js";
import { copyText, html } from "../ui.js";

/** A 6-digit code field: digits only, filled from the phone's suggestion where it offers one. */
function CodeField({ code, setCode, label }) {
    return html`<input
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9]{6}"
        maxlength="6"
        aria-label=${label}
        placeholder="123456"
        value=${code}
        onInput=${(event) => setCode(event.currentTarget.value.replace(/\D/g, ""))}
    />`;
}

/** Link, check, or remove your authenticator, on your own page in People. */
export function MyAuthenticator() {
    const [status, setStatus] = useState(null);
    // While linking: the new secret, its link, and its QR code.
    const [linking, setLinking] = useState(null);
    const [removing, setRemoving] = useState(false);
    const [code, setCode] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        attempt(async () => setStatus(await api("me/authenticator")));
    }, []);

    const send = async (action, body) => {
        setBusy(true);
        setError("");

        try {
            return await api(`me/authenticator/${action}`, body ?? {});
        } catch (failure) {
            setError(failure.message);
            setCode("");

            return undefined;
        } finally {
            setBusy(false);
        }
    };

    const begin = async () => {
        const started = await send("begin");

        if (started) {
            setLinking(started);
            setCode("");
        }
    };

    const confirm = async (event) => {
        event.preventDefault();

        const next = await send("confirm", { code });

        if (next) {
            setStatus(next);
            setLinking(null);
            setCode("");
            // The account as the server has it now: for the owner, without the first-start prompt (`user.setup`).
            await attempt(async () => {
                const hello = await api("me");

                store.set({ me: hello.user, users: hello.users });
            });
        }
    };

    const remove = async (event) => {
        event.preventDefault();

        const next = await send("remove", { code });

        if (next) {
            setStatus(next);
            setRemoving(false);
            setCode("");
        }
    };

    const cancel = () => {
        // A link not confirmed is dropped, so nothing half-linked stays on the account.
        if (linking) {
            void api("me/authenticator/remove", {}).catch(() => {});
        }

        setLinking(null);
        setRemoving(false);
        setCode("");
        setError("");
    };

    // A temporary account links none (`config.ts` `User.temporary`), so it is offered nothing here.
    if (status === null || status.allowed === false) {
        return null;
    }

    // The owner is never made a user: an authenticator is only for their approvals.
    const owner = store.state.me?.role === "owner";

    const lockedUntil = status.lockedUntil;

    return html`<div class="group my-authenticator">
        <div class="group-title">Authenticator</div>
        ${
            linking
                ? html`<form class="authenticator-link" onSubmit=${confirm}>
                    <p class="muted small">
                        Scan this with an authenticator app on your phone, such as Google Authenticator, 1Password,
                        or Aegis. Then enter the code it shows.
                    </p>
                    <a class="qr" href=${linking.link} aria-label="Open in an authenticator app on this device">
                        <span dangerouslySetInnerHTML=${{ __html: linking.svg }}></span>
                    </a>
                    <div class="row wrap small">
                        <span class="muted">Or type this key:</span>
                        <code class="authenticator-secret">${linking.secret}</code>
                        <button type="button" class="button small ghost" onClick=${() => copyText(linking.secret)}>
                            Copy
                        </button>
                    </div>
                    <${CodeField} code=${code} setCode=${setCode} label="Code from your authenticator" />
                    ${error && html`<p class="runner-code-error" role="alert">${error}</p>`}
                    <div class="row">
                        <button type="button" class="button ghost" onClick=${cancel}>Cancel</button>
                        <button class="button primary" disabled=${busy || code.length !== 6}>Link</button>
                    </div>
                </form>`
                : removing
                  ? html`<form class="authenticator-link" onSubmit=${remove}>
                        <p class="muted small">
                            Enter a code from your authenticator to remove it. Lost your phone? Ask the owner to
                            remove it.
                        </p>
                        <${CodeField} code=${code} setCode=${setCode} label="Code from your authenticator" />
                        ${error && html`<p class="runner-code-error" role="alert">${error}</p>`}
                        <div class="row">
                            <button type="button" class="button ghost" onClick=${cancel}>Cancel</button>
                            <button class="button primary" disabled=${busy || code.length !== 6}>
                                Remove
                            </button>
                        </div>
                    </form>`
                  : html`<div class="setting wrap">
                        <div class="grow small">
                            ${status.linked ? "Linked to your account" : "Not linked"}
                            <div class="muted small">
                                ${
                                    status.linked
                                        ? "You approve your new folders with its codes."
                                        : owner
                                          ? "Link an authenticator app to approve your new folders with its codes."
                                          : "Link an authenticator app to be made a user, who can prompt."
                                }
                            </div>
                            ${
                                lockedUntil &&
                                html`<div class="runner-code-error small" role="alert">
                                    Too many wrong codes. Codes work again at
                                    ${" "}${new Date(lockedUntil).toLocaleTimeString()}.
                                </div>`
                            }
                        </div>
                        ${
                            status.linked
                                ? html`<button class="button small ghost" onClick=${() => setRemoving(true)}>
                                      Remove
                                  </button>`
                                : html`<button class="button small" disabled=${busy} onClick=${begin}>
                                      Link
                                  </button>`
                        }
                    </div>
                    ${error && html`<p class="runner-code-error" role="alert">${error}</p>`}`
        }
    </div>`;
}
