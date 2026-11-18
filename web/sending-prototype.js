// Throwaway, loopback-only UI preview: how should a send look before it reaches history?
// Compare a message bubble, outbox, and delivery marker in the real conversation layout.
import htm from "htm";
import { h } from "preact";
import { replaceAddress } from "./back.js";

const html = htm.bind(h);
const query = new URLSearchParams(location.search);

export const sendingPrototype =
    location.hostname === "127.0.0.9" && query.get("prototype") === "sending";
const variants = [
    ["bubble", "Message bubble"],
    ["outbox", "Compact outbox"],
    ["marker", "Delivery marker"],
];
let choice = Math.max(
    0,
    variants.findIndex(([key]) => key === query.get("variant")),
);
// The scratch server has a single sender. Keep the newest send in each conversation, not in the view or its cache.
const sends = new Map();

if (sendingPrototype) {
    const css = document.createElement("link");

    css.rel = "stylesheet";
    css.href = "/sending-prototype.css";
    document.head.append(css);
}

/** Hold the preview's real POST until Deliver or Refuse. Only the isolated app can take this path. */
export async function previewFetch(path, body, init, state, redraw) {
    const match = /^c\/(\d+)\/submit$/.exec(path);

    if (!match || typeof body?.text !== "string") {
        return fetch(`/api/${path}`, init);
    }

    const id = Number(match[1]);
    const view = state.view.conversation?.id === id ? state.view : state.pipView;
    const typed = body.text.trim();
    const request = {
        person: state.me?.id,
        after: view.conversation?.id === id ? (view.order.at(-1) ?? 0) : 0,
        // Preview the outgoing words without rendering Markdown or loading attachment images before acceptance.
        text: typed.slice(0, 1600),
        clipped: typed.length > 1600,
        files: (body.attachments ?? []).map((file) => file.name),
        phase: "sending",
    };
    const hold = new Promise((resolve) => {
        request.release = resolve;
    });

    sends.set(id, request);
    redraw();

    try {
        const deliver = await hold;

        request.release = undefined;
        redraw();

        if (!deliver) {
            return new Response(JSON.stringify({ error: "Preview: the message was not sent." }), {
                status: 409,
                headers: { "Content-Type": "application/json" },
            });
        }

        request.posted = true;
        const response = await fetch(`/api/${path}`, init);

        if (response.ok) {
            const receipt = await response.clone().json();

            if (receipt.submissionId !== undefined) {
                request.submission = receipt.submissionId;
                request.phase = "received";
                redraw();
            }
        }

        return response;
    } finally {
        if (request.phase !== "received" && sends.get(id) === request) {
            sends.delete(id);
            redraw();
        }
    }
}

/** Hand off to the ordinary transcript row, or the existing waiting strip for a queued message. */
export function sendingIn(view, person) {
    const id = view.conversation?.id;
    const request = sends.get(id);

    if (!request || request.person !== person) {
        return null;
    }

    if (!request.posted) {
        return request;
    }

    // This comparison is for the single-sender demo. A production version must match the exact submission to its entry.
    if (
        request.submission !== undefined &&
        view.inbox.some((item) => Number(item.id) === Number(request.submission))
    ) {
        sends.delete(id);

        return null;
    }

    for (let i = view.order.length - 1; i >= 0; i--) {
        const key = view.order[i];

        if (key <= request.after) {
            break;
        }

        if (view.entries.get(key)?.kind === "user" && view.authors?.[key] === person) {
            sends.delete(id);

            return null;
        }
    }

    return request;
}

const phaseLabel = (phase) => (phase === "received" ? "Updating history…" : "Sending…");
const indicator = () => html`<span class="sending-demo-spinner" aria-hidden="true"></span>`;
const words = ({ text, clipped, files }) =>
    html`<div class="sending-demo-copy">
        ${text}${clipped ? "…" : ""}
        ${files.length > 0 && html`<small>${files.join(" · ")}</small>`}
    </div>`;

/** Three presentations of the same client-only send, on both of Pocket's transcript surfaces. */
export function SendingRow({ request, floating = false }) {
    const label = phaseLabel(request.phase);
    const status = html`<span class="sending-demo-status" role="status">
        ${indicator()} ${label}
    </span>`;
    const state = request.phase;
    const variant = variants[choice][0];

    if (variant === "outbox") {
        const line = request.text.replace(/\s+/g, " ") || request.files.join(" · ");

        return html`<details class="sending-demo-row sending-demo-outbox" data-phase=${state}>
            <summary>
                ${status}
                <span class="sending-demo-excerpt">${line}</span>
                <span aria-hidden="true" class="sending-demo-chevron">⌄</span>
            </summary>
            ${words(request)}
        </details>`;
    }

    if (variant === "marker") {
        return html`<div class="sending-demo-row sending-demo-marker" data-phase=${state}>
            <div>${status}</div>
            <small>${state === "received" ? "Server accepted your message" : "Not in history yet"}</small>
        </div>`;
    }

    if (floating) {
        return html`<div class="pip-you sending-demo-row sending-demo-bubble" data-phase=${state}>
            ${status}
            ${words(request)}
        </div>`;
    }

    return html`<div class="user-row sending-demo-row sending-demo-bubble" data-phase=${state}>
        <div class="prompt">
            <span class="prompt-head">
                <span class="prompt-avatar sending-demo-avatar" aria-hidden="true">›</span>
                <b class="prompt-author">You</b>
                ${status}
            </span>
            <div class="prompt-body">${words(request)}</div>
        </div>
    </div>`;
}

/** Preview-only controls. Arrow keys work when the controls, not the message box, have focus. */
export function SendingControls({ redraw, person }) {
    const waiting = [...sends.values()].find(
        (request) => request.release && request.person === person,
    );

    const select = (dir) => {
        choice = (choice + dir + variants.length) % variants.length;
        const url = new URL(location.href);

        url.searchParams.set("prototype", "sending");
        url.searchParams.set("variant", variants[choice][0]);
        replaceAddress(url);
        redraw();
    };

    return html`<aside
        class="sending-demo-controls"
        aria-label="Send prototype controls"
        onKeyDown=${(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                event.stopPropagation();
                select(event.key === "ArrowRight" ? 1 : -1);
            }
        }}
    >
        <span class="sending-demo-tag">Preview</span>
        <div class="sending-demo-choices">
            <button type="button" aria-label="Previous design" onClick=${() => select(-1)}>‹</button>
            <span role="status">${variants[choice][1]}</span>
            <button type="button" aria-label="Next design" onClick=${() => select(1)}>›</button>
        </div>
        ${
            waiting
                ? html`<div class="sending-demo-actions">
                      <button type="button" onClick=${() => waiting.release(false)}>Refuse</button>
                      <button type="button" onClick=${() => waiting.release(true)}>Deliver</button>
                  </div>`
                : html`<span class="sending-demo-hint">Sends are held for the preview</span>`
        }
    </aside>`;
}
