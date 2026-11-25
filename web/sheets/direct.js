// Chat with one person, on their page in People (`people.js`): only the two of them read it, and Pi never sees it. The
// server keeps the thread and what each has not read (`src/server/direct.ts`); this tab keeps the loaded thread in
// `store.state.directs`, and its log follows the newest message as the session chat does (`chat.js` `useFollowLog`).
import { useEffect, useRef, useState } from "preact/hooks";
import { personColor } from "../avatar.js";
import { useFollowLog } from "../chat.js";
import { actions, attempt, directShown, dismissDirectNotices, drafts, store } from "../store.js";
import { clockTime, html, Icon, Loader, Spinner } from "../ui.js";

const coarse = matchMedia("(pointer: coarse)").matches;

const clock = (at) => clockTime(new Date(at));

/**
 * The chat between this person and `person`: loaded from the server each time it shows, and again on each new
 * connection, which can follow a gap in which messages came and no event told of them. A load that fails says so, and
 * can be tried again.
 */
export function DirectChat({ person }) {
    const messages = store.state.directs[person.id];
    const [turn, setTurn] = useState(0);
    // Whether a load brought the thread since this chat showed, and how the load that ended last went.
    const [ready, setReady] = useState(false);
    const [ended, setEnded] = useState(null);
    // The newest connection that opened. One that is closed or still opening has no id (`store.js` `connect`): it is
    // no new connection, so it asks for nothing.
    const stream = useRef(store.state.streamId ?? "");

    if (store.state.streamId != null) {
        stream.current = store.state.streamId;
    }

    // One load for each connection, and one more for each Try again.
    const asked = `${stream.current}:${turn}`;

    useEffect(() => {
        let live = true;

        actions.loadDirect(person.id).then(
            (kept) => {
                if (live && kept) {
                    setReady(true);
                    setEnded({ asked, ok: true });
                }
            },
            () => {
                if (live) {
                    setEnded({ asked, ok: false });
                }
            },
        );

        return () => {
            live = false;
        };
    }, [asked]);

    // Whether the thread kept is what the server has on this connection, and not what this tab had before it.
    const current = ended?.asked === asked && ended.ok;
    const failed =
        ended?.asked === asked &&
        !ended.ok &&
        html`<div class="direct-failed muted small" data-part="direct-failed">
            <span>${ready ? "New messages did not load." : "This chat did not load."}</span>
            <button class="button small" onClick=${() => setTurn(turn + 1)}>Try again</button>
        </div>`;

    // What this tab kept of it shows only once the server has said what it has now.
    if (!ready || messages === undefined) {
        return failed || html`<${Loader} />`;
    }

    return html`${failed}<${DirectThread}
            person=${person}
            messages=${messages}
            current=${current}
        />`;
}

/**
 * The loaded thread: its log, which follows the newest message, and the box to write in. `current`: it is what the
 * server has on this connection.
 */
function DirectThread({ person, messages, current }) {
    const { me, directUnread } = store.state;
    const draftKey = `direct-${person.id}`;
    const [text, setText] = useState(() => drafts.get(draftKey));
    const [sending, setSending] = useState(false);
    const box = useRef(null);
    const count = directUnread[person.id] ?? 0;
    const log = useFollowLog(messages.at(-1)?.id);

    useEffect(() => directShown(person.id), []);
    // Shown on a page in view, it is read: its count goes on every device, and the notices of it here. Not while the
    // thread loads again on a new connection: a message from the gap is counted before it shows.
    useEffect(() => {
        const read = () => {
            if (!current || document.visibilityState !== "visible") {
                return;
            }

            dismissDirectNotices(person.id);

            if ((store.state.directUnread[person.id] ?? 0) > 0) {
                actions.readDirect(person.id).catch(() => {});
            }
        };

        read();
        document.addEventListener("visibilitychange", read);

        return () => document.removeEventListener("visibilitychange", read);
    }, [count, current]);
    useEffect(() => {
        const element = box.current;

        if (!element) {
            return;
        }

        element.style.height = "auto";
        element.style.height = `${Math.min(element.scrollHeight, innerHeight * 0.3)}px`;
    }, [text]);

    const update = (value) => {
        setText(value);
        drafts.set(draftKey, value);
    };

    const send = async () => {
        if (text.trim() === "" || sending) {
            return;
        }

        setSending(true);
        const ok = await attempt(() => actions.direct(person.id, text));

        setSending(false);

        if (ok) {
            update("");

            if (!coarse) {
                box.current?.focus();
            }
        }
    };

    return html`<div class="chat-label">
            <${Icon} name="eye" size=${12} />Only you and ${person.name} see this chat. Pi does not.
        </div>
        <div class="chat-log" ref=${log}>
            ${messages.length === 0 && html`<div class="muted">No messages yet.</div>`}
            ${messages.map((message, index) => {
                const previous = messages[index - 1];
                const grouped =
                    previous?.userId === message.userId && message.at - previous.at < 5 * 60_000;
                const mine = message.userId === me?.id;

                return html`<div
                    key=${message.id}
                    data-chat=${message.id}
                    class=${`chat-msg ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}`}
                    style=${`--who:${personColor(message.userId)}`}
                >
                    ${
                        !grouped &&
                        html`<div class="chat-meta">
                            <span class="chat-name">${mine ? "You" : person.name}</span>
                            <span class="muted">${clock(message.at)}</span>
                        </div>`
                    }
                    <div class="chat-text">${message.text}</div>
                </div>`;
            })}
        </div>
        <div class="chat-compose">
            <textarea
                ref=${box}
                rows="1"
                maxlength="4000"
                value=${text}
                placeholder=${`Message ${person.name}…`}
                onInput=${(event) => update(event.currentTarget.value)}
                onKeyDown=${(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !coarse && !event.isComposing) {
                        event.preventDefault();
                        send();
                    }
                }}
                enterkeyhint=${coarse ? "enter" : "send"}
            ></textarea>
            <button
                class="round send"
                aria-label="Send"
                disabled=${text.trim() === "" || sending}
                onClick=${send}
            >
                ${sending ? html`<${Spinner} />` : html`<${Icon} name="send" size=${18} />`}
            </button>
        </div>`;
}
