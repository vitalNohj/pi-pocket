// New folders on this server waiting for an approval (`src/server/folder-requests.ts`), from `folder-requests` events.
// The person who asked approves with a code from their own authenticator, or cancels; the owner allows or denies
// anyone's from the app. Each tab gets only what its person may see: their own requests, and the owner every one.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, store } from "./store.js";
import { html, Spinner } from "./ui.js";

const KIND_TEXT = {
    new: "a new session",
    fork: "a copy of a session",
    move: "moving a session",
    linked: "a session an agent starts",
};

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

/** My own request: the code field (with an authenticator linked), and Cancel. */
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
        <h2 id="folder-request-title">New folder</h2>
        <p>
            ${
                request.code
                    ? "Enter a code from your authenticator to start here, or wait for the owner to allow it."
                    : "Wait for the owner to allow it. To approve folders yourself, link an authenticator in Menu → Your name."
            }
        </p>
        <p class="runner-wait-folder">Folder: <bdi dir="ltr">${request.folder}</bdi></p>
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

/** Someone else's request, for the owner: Allow or Deny. */
function OwnerCard({ request }) {
    const answer = (body) =>
        attempt(() => api(`folder-requests/${encodeURIComponent(request.id)}`, body));

    return html`<div class="folder-request" role="alert">
        <div class="small">
            <strong>${request.name}</strong> asks for ${KIND_TEXT[request.kind] ?? "a session"} in
            ${" "}<code>${request.folder}</code>
        </div>
        <div class="muted small">
            ${
                request.saved
                    ? "A saved folder covers it."
                    : request.broad
                      ? "Too broad to save: they will be asked again next time."
                      : "Allowing saves the folder for this server."
            }
            ${" "}${secondsLeft(request)} s left.
        </div>
        <div class="row">
            <button class="button small ghost" onClick=${() => answer({ deny: true })}>Deny</button>
            <button class="button small primary" onClick=${() => answer({ approve: true })}>Allow</button>
        </div>
    </div>`;
}

/** Someone else's question on a runner, for the owner: Allow or Deny, which the server tells the runner. */
function RunnerCard({ runner, question }) {
    const answer = (body) =>
        attempt(() =>
            api(`runners/${encodeURIComponent(runner.id)}/approval`, { id: question.id, ...body }),
        );
    const what = question.expired
        ? "to continue a session"
        : question.permission === "session"
          ? "a session"
          : "a session in a new folder";

    return html`<div class="folder-request" role="alert">
        <div class="small">
            <strong>${question.name ?? "Someone"}</strong> asks for ${what} on ${runner.name} in
            ${" "}<code>${question.folder}</code>
        </div>
        <div class="muted small">
            ${question.broad ? "Too broad to save: allowing lets this session in only." : `${runner.name} can approve it too.`}
        </div>
        <div class="row">
            <button class="button small ghost" onClick=${() => answer({ deny: true })}>Deny</button>
            <button class="button small primary" onClick=${() => answer({ approve: true })}>Allow</button>
        </div>
    </div>`;
}

/**
 * Every folder request this tab may see: mine as a dialog, others' (the owner's to answer) as cards, with others'
 * questions on runners that take the owner's answer. A person's own runner question shows where they wait for it
 * (`runner-wait.js`).
 */
export function FolderRequests() {
    const { folderRequests, me, runners } = store.state;
    const requests = folderRequests ?? [];
    const runnerQuestions = (runners ?? []).flatMap((runner) =>
        (runner.questions ?? [])
            .filter((question) => question.approve && question.asker !== me?.id)
            .map((question) => ({ runner, question })),
    );

    useTick(requests.length > 0);

    if (!me || (requests.length === 0 && runnerQuestions.length === 0)) {
        return null;
    }

    const mine = requests.filter((each) => each.person === me.id);
    const others = requests.filter((each) => each.person !== me.id);

    return html`${
        (others.length > 0 || runnerQuestions.length > 0) &&
        html`<div class="folder-requests">
            ${others.map((request) => html`<${OwnerCard} key=${request.id} request=${request} />`)}
            ${runnerQuestions.map(
                ({ runner, question }) =>
                    html`<${RunnerCard} key=${question.id} runner=${runner} question=${question} />`,
            )}
        </div>`
    }
    ${
        mine.length > 0 &&
        html`<div class="overlay runner-wait-overlay">
            <${MyRequest} key=${mine.at(-1).id} request=${mine.at(-1)} />
        </div>`
    }`;
}
