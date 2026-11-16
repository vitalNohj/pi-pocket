// Sessions waiting for an approval, on this server or a runner (`src/server/folder-requests.ts`), from
// `folder-requests` events: a new session, or a locked one to renew. The person who asked approves with a code from
// their own authenticator (a session's starter only), or cancels; who is in charge of the computer (the owner here, a
// runner's linker there) allows or denies it from the app. Each tab gets only what its person may see: their own
// requests, and every one on a computer they are in charge of.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, store } from "./store.js";
import { html, Spinner } from "./ui.js";

/** What a request asks for, for the one who allows it. */
function asks(request) {
    return request.kind === "renew"
        ? html`to go on in <strong>${request.title ?? "a session"}</strong>, whose approval ended`
        : html`to start a session in <code>${request.folder}</code>`;
}

/** Seconds left on a request, at least 0. */
function secondsLeft(request) {
    return Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000));
}

/** The countdown moves each second while requests stand. */
function useTick(active) {
    const [, tick] = useState(0);

    useEffect(() => {
        if (!active) {
            return undefined;
        }

        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, [active]);
}

/** Why it waits and what to do, for the one who asked. */
function myText(request) {
    const who = `whoever is in charge of ${request.computerName}`;

    if (request.kind === "renew") {
        return request.code
            ? `This session's approval ended. Enter a code from your authenticator to go on, or wait for ${who} to allow it.`
            : `This session's approval ended. Wait for ${who} to allow it.`;
    }

    return request.code
        ? `Enter a code from your authenticator to start here, or wait for ${who} to allow it.`
        : `Wait for ${who} to allow it. To approve yourself, link an authenticator in Menu → Your name.`;
}

/** My own request: the code field (when a code can answer it), and Cancel. */
function MyRequest({ request }) {
    const [code, setCode] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    const send = async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");

        try {
            await api(`folder-requests/${encodeURIComponent(request.id)}`, { code });
        } catch (failure) {
            setError(failure.message);
            setCode("");
        } finally {
            setBusy(false);
        }
    };

    const cancel = () =>
        api(`folder-requests/${encodeURIComponent(request.id)}`, { deny: true }).catch(() => {});

    return html`<section
        class="runner-wait"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-request-title"
    >
        <h2 id="folder-request-title">
            ${request.kind === "renew" ? "Renew this session" : `New session on ${request.computerName}`}
        </h2>
        <p>${myText(request)}</p>
        <p class="runner-wait-folder">
            ${request.kind === "renew" ? request.title : "Folder"}:
            <bdi dir="ltr">${request.folder}</bdi>
        </p>
        ${
            request.code &&
            html`<form class="runner-code" onSubmit=${send}>
                <label class="field">
                    <span class="label">Code from your authenticator</span>
                    <input
                        type="text"
                        inputmode="numeric"
                        autocomplete="one-time-code"
                        pattern="[0-9]{6}"
                        maxlength="6"
                        autofocus
                        value=${code}
                        onInput=${(event) => setCode(event.currentTarget.value.replace(/\D/g, ""))}
                    />
                </label>
                ${error && html`<p class="runner-code-error" role="alert">${error}</p>`}
                <button class="button primary" disabled=${busy || code.length !== 6}>Approve</button>
            </form>`
        }
        <p class="runner-wait-countdown">
            <${Spinner} label="Waiting for an approval" />
            It stops in ${secondsLeft(request)} s.
        </p>
        <button type="button" class="button wide" onClick=${cancel}>Cancel</button>
    </section>`;
}

/** Someone else's request, for who is in charge: Allow or Deny. */
function OwnerCard({ request }) {
    const answer = (body) =>
        attempt(() => api(`folder-requests/${encodeURIComponent(request.id)}`, body));

    return html`<div class="folder-request" role="alert">
        <div class="small">
            <strong>${request.name}</strong> asks ${asks(request)} on ${request.computerName}.
        </div>
        <div class="muted small">
            Allowing approves this session for their approval time. ${secondsLeft(request)} s left.
        </div>
        <div class="row">
            <button class="button small ghost" onClick=${() => answer({ deny: true })}>Deny</button>
            <button class="button small primary" onClick=${() => answer({ approve: true })}>Allow</button>
        </div>
    </div>`;
}

/**
 * Every request this tab may see, on this server and on runners: mine as a dialog, others' (on a computer I am in
 * charge of) as cards.
 */
export function FolderRequests() {
    const { folderRequests, me } = store.state;
    const requests = folderRequests ?? [];

    useTick(requests.length > 0);

    if (!me || requests.length === 0) {
        return null;
    }

    const mine = requests.filter((each) => each.person === me.id);
    const others = requests.filter((each) => each.person !== me.id);

    return html`${
        others.length > 0 &&
        html`<div class="folder-requests">
            ${others.map((request) => html`<${OwnerCard} key=${request.id} request=${request} />`)}
        </div>`
    }
    ${
        mine.length > 0 &&
        html`<div class="overlay runner-wait-overlay">
            <${MyRequest} key=${mine.at(-1).id} request=${mine.at(-1)} />
        </div>`
    }`;
}
