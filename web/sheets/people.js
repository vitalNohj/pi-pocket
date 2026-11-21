// People with access to this server, and invites for more. The People sheet is laid out as the Runners sheet is
// (`pages.js`): everyone on the left, the chosen person's page beside it. The owner manages a person there: what they
// may do, where they may work (their folders and their sessions on each computer, as in Runners: `access.js`), and
// their sign-in. A user the owner lets manage users (`store.js` `managesPeople`) does the same for the people they may
// change. Anyone else reads who is here, and has their own things.
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar, avatarBlob } from "../avatar.js";
import { shortPath } from "../folder-paths.js";
import {
    actions,
    api,
    attempt,
    canInviteNew,
    closeSheet,
    collab,
    declaredRights,
    managesPeople,
    managesServer,
    notify,
    openId,
    openSheet,
    serverClockOffset,
    signOut,
    store,
} from "../store.js";
import { pinsSynced, syncPins } from "../theme.js";
import {
    copyText,
    countdown,
    html,
    Icon,
    Loader,
    Sheet,
    Switch,
    timeAgo,
    useMinute,
} from "../ui.js";
import { accessFolder } from "./access-tree.js";
import { AccessRow, choosable, computers, inCharge, loadComputers } from "./access.js";
import { ApprovalTime, TasksExpire } from "./approvals.js";
import { MyAuthenticator } from "./authenticator.js";
import { PageItem, Pages } from "./pages.js";
import { canShare } from "./session-share.js";

/** How long an invite may last: minutes, its button, and how the help text says it. */
const LASTS = [
    [15, "15 min", "in 15 minutes"],
    [60, "1 hour", "in an hour"],
    [24 * 60, "1 day", "in a day"],
    [7 * 24 * 60, "1 week", "in a week"],
    [30 * 24 * 60, "1 month", "in a month"],
];

/** How long a temporary account may last, in minutes, or without an end. */
const ACCOUNT_LASTS = [
    [24 * 60, "1 day"],
    [7 * 24 * 60, "1 week"],
    [30 * 24 * 60, "1 month"],
    [null, "Never"],
];

function DurationButtons({ label, choices, value, onChange }) {
    return html`<div class="segmented" role="group" aria-label=${label}>
        ${choices.map(
            ([each, text]) => html`<button
                class=${value === each ? "on" : ""}
                aria-pressed=${value === each}
                onClick=${() => onChange(each)}
            >
                ${text}
            </button>`,
        )}
    </div>`;
}

/** End an invite or a device link nobody will see: one no longer shown, or one that answered too late to show. */
const cancelInvite = (invite) => {
    // A server that says how long its invites last also ends them on request; an older one has no such route.
    if (invite?.minutes !== undefined) {
        // Sent even when the page goes (a reload, a web file edited), so it is never left live and unseen.
        fetch("/api/invite/cancel", {
            method: "POST",
            keepalive: true,
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ code: invite.code }),
        }).catch(() => {});
    }
};

export function InviteSheet({ session = null }) {
    const { view, sessions } = store.state;
    const here =
        session !== null
            ? (sessions.find((each) => each.id === session) ?? null)
            : view.conversation?.kind === "session"
              ? view.conversation
              : null;
    // The session as the list has it: its folder, its computer, and whether this person may share it.
    const row = here ? (sessions.find((each) => each.id === here.id) ?? here) : null;
    // "Only this session" is for who may share it (`access.ts` `mayShare`); the other two, for who may invite.
    const single = row !== null && canShare(row);
    // What the invite shares: the open session when there is one, else its folder, else all of this person's.
    const [what, setWhat] = useState(single ? "session" : here ? "folder" : "mine");
    const [minutes, setMinutes] = useState(15);
    const [account, setAccount] = useState(7 * 24 * 60);
    // Off until asked: whoever joins has a temporary account, which links no authenticator and so stays a viewer.
    const [allow, setAllow] = useState(false);
    // A server from before roles knows no temporary account: nothing is asked of it.
    const temporary = collab() && !allow;
    const [made, setMade] = useState(null);
    // The newest invite could not be made: the sheet offers to try again rather than wait for ever.
    const [failed, setFailed] = useState(false);
    // What the sheet says now: an invite shows only while it was made for exactly this.
    const asked = JSON.stringify([what, minutes, temporary, ...(temporary ? [account] : [])]);
    // Only the newest invite shows: one asked for before a change, answering late, must not stand for what the sheet says.
    const latest = useRef(0);
    // The invite the sheet last showed: a change to what it grants, or how long it lasts, ends it.
    const shown = useRef(null);
    // Closed (gone, or still sliding away): nothing more is made, and what was being made ends when it answers.
    const mounted = useRef(true);
    const open = () => mounted.current && store.state.sheet?.type === "invite";
    const create = ({ replacing = false } = {}) =>
        attempt(async () => {
            if (!open()) {
                return;
            }

            const ticket = ++latest.current;

            if (replacing) {
                cancelInvite(shown.current);
                shown.current = null;
            }

            setMade(null);
            setFailed(false);
            let answer;

            try {
                answer = await api("invite", {
                    minutes,
                    ...(collab() ? { temporary } : {}),
                    ...(temporary && account !== null ? { accountMinutes: account } : {}),
                    ...(collab() && here && what !== "mine"
                        ? { session: here.id, ...(what === "folder" ? { folder: true } : {}) }
                        : {}),
                });

                // A server from before folder invites made one to the session alone: never shown as the folder's.
                if (what === "folder" && here && answer.grant?.folder === undefined) {
                    cancelInvite(answer);

                    throw new Error("Restart Pi Pocket to invite someone to a folder.");
                }

                // A server from before temporary accounts made a full one: never shown as temporary.
                if (temporary && answer.grant?.temporary !== true) {
                    cancelInvite(answer);

                    throw new Error("Restart Pi Pocket to make a temporary account.");
                }

                if (temporary && account !== null && answer.grant?.accountMinutes !== account) {
                    cancelInvite(answer);

                    throw new Error("Restart Pi Pocket to make an account that expires.");
                }
            } catch (error) {
                if (ticket === latest.current) {
                    setFailed(true);
                }

                throw error;
            }

            if (ticket !== latest.current || !open()) {
                cancelInvite(answer);

                return;
            }

            shown.current = answer;
            setMade({ ...answer, asked });
        });

    useEffect(() => {
        create({ replacing: true });
    }, [asked]);
    useEffect(
        () => () => {
            mounted.current = false;
        },
        [],
    );
    // Shown only while it is what the sheet says, not for a frame after a change.
    const invite = made && made.asked === asked ? made : null;
    // An invite to more than one session shows its maker's sessions as they are now (`app.ts` `welcome`), no others.
    // The folder a folder invite is to: the open session's, as the server counts it (`access-tree.js` `accessFolder`).
    const folder =
        invite?.grant?.folder?.path ??
        (row
            ? accessFolder(
                  row,
                  sessions.filter((each) => (each.runner ?? null) === (row.runner ?? null)),
              )
            : null);
    const where =
        what === "session" && here
            ? `only “${here.title}”`
            : what === "folder" && here
              ? `the sessions you started in ${folder} so far, and later ones only when they are shared with them`
              : "the sessions you started so far, and later ones only when they are shared with them";
    // An invite to all of its maker's sessions is the widest there is: the sheet says so, and what follows for an
    // account that is not temporary.
    const all = what === "mine" || !here;
    // As long as the invite shown lasts (a server that does not say: 15 minutes), or, while one is made, as chosen.
    const lasting = LASTS.find(
        ([each]) => each === (invite ? (invite.minutes ?? 15) : minutes),
    )?.[2];
    const accountLength = ACCOUNT_LASTS.find(([each]) => each === account)?.[1];

    return html`<${Sheet} title="Invite someone" onClose=${closeSheet}>
        ${
            collab() &&
            html`<p class="muted small">
                ${
                    temporary
                        ? account === null
                            ? "They join as a viewer, with a temporary account."
                            : `They join as a viewer, with a temporary account that expires ${accountLength} after they join.`
                        : "They join as a viewer. To prompt, they link an authenticator and are made a user in People."
                }
            </p>
            ${
                here &&
                html`<div class="field">
                    <div class="label">Share</div>
                    <div class="invite-share">
                        <div class="segmented">
                            ${
                                single &&
                                html`<button
                                    class=${what === "session" ? "on" : ""}
                                    aria-pressed=${what === "session"}
                                    onClick=${() => setWhat("session")}
                                >
                                    Only this session
                                </button>`
                            }
                            <button
                                class=${what === "folder" ? "on" : ""}
                                aria-pressed=${what === "folder"}
                                onClick=${() => setWhat("folder")}
                            >
                                This folder
                            </button>
                            <button
                                class=${what === "mine" ? "on" : ""}
                                aria-pressed=${what === "mine"}
                                onClick=${() => setWhat("mine")}
                            >
                                My sessions
                            </button>
                        </div>
                        ${
                            what !== "mine" &&
                            html`<span
                                class=${`invite-what${what === "folder" ? " mono" : ""}`}
                                title=${what === "folder" ? folder : row.title || "New session"}
                            >
                                ${
                                    what === "folder"
                                        ? shortPath(
                                              folder,
                                              row.runner ? undefined : store.state.server?.home,
                                          )
                                        : row.title || "New session"
                                }
                            </span>`
                        }
                    </div>
                </div>`
            }`
        }
        <div class="field">
            <div class="label">Invite expires in</div>
            <${DurationButtons}
                label="Invite expires in"
                choices=${LASTS}
                value=${minutes}
                onChange=${setMinutes}
            />
        </div>
        ${
            collab() &&
            html`<${Setting}
                label="Allow viewer to become a user and prompt"
                hint=${
                    allow
                        ? "On: they can link an authenticator, and then be made a user in People."
                        : "Off: a temporary account. They view what is shared with them, and cannot link an authenticator or become a user."
                }
            >
                <${Switch}
                    on=${allow}
                    label=${`Allow viewer to become a user and prompt: ${allow ? "on" : "off"}`}
                    onChange=${() => setAllow(!allow)}
                />
            <//>`
        }
        ${
            temporary &&
            html`<div class="field">
                <div class="label">Account expires in</div>
                <${DurationButtons}
                    label="Account expires in"
                    choices=${ACCOUNT_LASTS}
                    value=${account}
                    onChange=${setAccount}
                />
                <div class="muted small">
                    ${
                        account === null
                            ? "Their account stays until someone removes it."
                            : "Starts when they join. After that their account is removed."
                    }
                </div>
            </div>`
        }
        ${
            collab() &&
            all &&
            html`<div class="warn-box" data-part="invite-warning" role="note">
                <strong>This invite shares every session you started so far.</strong>
                ${
                    !temporary &&
                    html` It allows them to become a user: they can link an authenticator, and once they are made a
                        user, they can prompt in all of those sessions.`
                }
            </div>`
        }
        <p class="muted small">
            ${`Scan this on the other device, or send it the link. It works once and expires ${lasting}. Whoever joins sees ${where}.`}
        </p>
        ${
            invite?.access?.url &&
            html`<p class="muted small">Other devices connect through ${invite.access.label}.</p>`
        }
        ${
            invite
                ? html`<${InviteShown} invite=${invite} />`
                : failed
                  ? html`<p class="muted small">No invite yet. Tap New invite to try again.</p>`
                  : html`<${Loader} label="Making an invite" />`
        }
        <button class="button wide" onClick=${create}>New invite</button>
        ${
            collab() &&
            html`<p class="muted small">
                Your own device? Use Sign in another device on your page in People.
            </p>`
        }
    <//>`;
}

/**
 * An invite, or a device link, as made: its QR code, its code to type on the other device's sign-in screen, and its
 * link. `code`: what the code is called; `again`: what to make once other devices can get in.
 */
function InviteShown({ invite, code = "Invite code", again = "invite" }) {
    return html`<div class="invite">
        ${
            invite.local &&
            html`<div class="error-box">
                This link only works on this device. To let other devices in, press <span class="mono">a</span> in the Pi Pocket terminal (or start it with <span class="mono">--access</span>) and pick Local network, Cloudflare Tunnel, or Tailscale. Then make a new ${again}.
            </div>`
        }
        <div class="invite-details">
            <div class="qr" dangerouslySetInnerHTML=${{ __html: invite.svg }}></div>
            <div class="invite-code">
                <div class="invite-code-head">
                    <span>${code}</span>
                    <button
                        class="link small"
                        onClick=${() =>
                            copyText(invite.code).then(
                                () => notify("info", "Code copied."),
                                () => notify("error", "Could not copy."),
                            )}
                    >
                        Copy
                    </button>
                </div>
                <div
                    class="invite-code-value"
                    aria-label=${`${code} ${invite.code.split("").join(" ")}`}
                >
                    <span>${invite.code.slice(0, 5)}</span>
                    <span>${invite.code.slice(5)}</span>
                </div>
                <div class="muted small">Or enter it on the other device's sign-in screen.</div>
            </div>
        </div>
        <div class="row">
            <input
                class="mono"
                readonly
                value=${invite.url}
                onFocus=${(event) => event.currentTarget.select()}
            />
            <button
                class="button"
                onClick=${() =>
                    copyText(invite.url).then(
                        () => notify("info", "Link copied."),
                        () => notify("error", "Could not copy."),
                    )}
            >
                Copy
            </button>
        </div>
        ${
            invite.alternatives?.length > 0 &&
            html`<p class="muted small">
                Also reachable at: ${invite.alternatives.map(
                    (url) => html`<span class="mono">${url} </span>`,
                )}
            </p>`
        }
    </div>`;
}

/**
 * Sign in another device: a device link, which signs that device in as `person` and makes no one new. On one's own
 * page it is for a device of one's own; on someone else's, the owner makes it for them (a lost device). It works once
 * and lasts 15 minutes; a new one ends the one before, and it leaves the page when its time is up. Someone with an
 * authenticator also gives one of its codes on the new device.
 */
function DeviceLink({ person }) {
    const theirs = person.id !== store.state.me?.id;
    const [made, setMade] = useState(null);
    const [busy, setBusy] = useState(false);
    // Only the newest link shows: one that answers late, or after the page went, ends unseen.
    const latest = useRef(0);
    const mounted = useRef(true);

    useEffect(
        () => () => {
            mounted.current = false;
        },
        [],
    );
    useEffect(() => {
        if (made === null) {
            return undefined;
        }

        const timer = setTimeout(() => setMade(null), Math.max(0, made.expiresAt - Date.now()));

        return () => clearTimeout(timer);
    }, [made]);

    const make = () =>
        attempt(async () => {
            const ticket = ++latest.current;
            const before = made;

            setBusy(true);

            try {
                const answer = await api(
                    theirs ? `users/${encodeURIComponent(person.id)}/device` : "me/device",
                    {},
                );

                if (!mounted.current || ticket !== latest.current) {
                    cancelInvite(answer);

                    return;
                }

                cancelInvite(before);
                setMade(answer);
            } finally {
                if (mounted.current && ticket === latest.current) {
                    setBusy(false);
                }
            }
        });

    const end = () => {
        latest.current += 1;
        cancelInvite(made);
        setMade(null);
        setBusy(false);
    };

    const until =
        made &&
        new Date(made.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    return html`<div class="device-link" data-part="device-link">
        <${Setting}
            label=${theirs ? "Sign in a device of theirs" : "Sign in another device"}
            hint=${
                theirs
                    ? made
                        ? `Give this only to ${person.name}: it signs a device in as them. It works once, until ${until}.${person.hasCode ? " It also asks for their authenticator code. A lost authenticator can be removed under Sign-in." : ""}`
                        : `Makes a link that signs a device in as ${person.name}. It works once, within 15 minutes.`
                    : made
                      ? `Open this on your other device. It signs in as you, so keep it to yourself. It works once, until ${until}.${person.hasCode ? " It also asks for your authenticator code." : ""}`
                      : "Makes a link that signs another phone or computer in as you. It works once, within 15 minutes."
            }
        >
            ${
                made
                    ? html`<div class="device-link-actions">
                          <button class="button small" disabled=${busy} onClick=${make}>New link</button>
                          <button class="button small ghost" onClick=${end}>Done</button>
                      </div>`
                    : html`<button class="button small" disabled=${busy} onClick=${make}>
                          Make a link
                      </button>`
            }
        <//>
        ${made && html`<${InviteShown} invite=${made} code="Sign-in code" again="link" />`}
    </div>`;
}

function lastSeen(person) {
    if (person.online) {
        return "here now";
    }

    if (!person.lastSeen) {
        return "not seen yet";
    }

    return `seen ${timeAgo(person.lastSeen)}${timeAgo(person.lastSeen) === "now" ? "" : " ago"}`;
}

/**
 * Your own picture, on your own page in People: choose one (cropped and shrunk here before it is sent), or take it
 * away. The page head beside it shows the face, so here are only its buttons.
 */
function MyPhoto() {
    const { me, users } = store.state;
    const person = users.find((each) => each.id === me?.id) ?? me;
    const input = useRef(null);

    const choose = (event) => {
        const file = event.currentTarget.files?.[0];

        event.currentTarget.value = "";

        if (file) {
            attempt(async () => api("me/avatar", await avatarBlob(file)));
        }
    };

    return html`<${Setting} label="Photo" hint="Shown in place of your initials, to everyone who can see you.">
        <div class="my-photo">
            <input ref=${input} type="file" accept="image/*" hidden onChange=${choose} />
            <button class="button small" onClick=${() => input.current.click()}>
                ${person.avatar ? "Change photo" : "Add photo"}
            </button>
            ${
                person.avatar &&
                html`<button
                    class="button small ghost"
                    onClick=${() => attempt(() => api("me/avatar", undefined, { method: "DELETE" }))}
                >
                    Remove photo
                </button>`
            }
        </div>
    <//>`;
}

/** Your own name, on your own page in People: as others see it on your messages. */
function MyName({ person }) {
    const [value, setValue] = useState(person.name);
    const [busy, setBusy] = useState(false);
    const name = value.trim();
    const unchanged = name === "" || name === person.name;

    const save = () =>
        !unchanged &&
        attempt(async () => {
            setBusy(true);

            try {
                await api("me", { name });
                const hello = await api("me");

                store.set({ me: hello.user, users: hello.users });
                // As the server keeps it: spaces folded, odd characters taken out.
                setValue(hello.user.name);
            } finally {
                setBusy(false);
            }
        });

    return html`<${Setting} label="Name" hint="Shown on your messages to others">
        <div class="my-name">
            <input
                aria-label="Name"
                maxlength="40"
                value=${value}
                onInput=${(event) => setValue(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && save()}
            />
            <button class="button small" disabled=${busy || unchanged} onClick=${save}>Save</button>
        </div>
    <//>`;
}

/** When something was asked, in words: "just now", "5m ago", or the day. */
function whenAsked(at) {
    const text = timeAgo(at);

    return text === "now" ? "just now" : /^\d+[mhd]$/.test(text) ? `${text} ago` : `on ${text}`;
}

/**
 * A viewer asks for access, on their own page: with a few words if they like, for who manages people here, who reads it
 * on the viewer's row in People. One at a time: once asked, the page says so, and they can take it back.
 */
function RequestAccess({ person }) {
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const asked = person.request;

    const send = (body) =>
        attempt(async () => {
            setBusy(true);

            try {
                await api("me/access-request", body);
                const hello = await api("me");

                store.set({ me: hello.user, users: hello.users });
                setNote("");
            } finally {
                setBusy(false);
            }
        });

    if (asked) {
        return html`<${Setting}
            label="Request access"
            hint=${`Asked ${whenAsked(asked.at)}${asked.note ? `: “${asked.note}”` : "."} Whoever manages people here sees it.`}
        >
            <button
                class="button small ghost"
                disabled=${busy}
                onClick=${() => send({ withdraw: true })}
            >
                Take back
            </button>
        <//>`;
    }

    const ask = () => send(note.trim() === "" ? {} : { note: note.trim() });

    return html`<${Setting}
        label="Request access"
        hint="Ask for a folder, a session, or to prompt. Whoever manages people here sees it."
    >
        <div class="my-name my-request">
            <input
                aria-label="What you need"
                placeholder="Optional note"
                maxlength="200"
                value=${note}
                onInput=${(event) => setNote(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && !busy && ask()}
            />
            <button class="button small" disabled=${busy} onClick=${ask}>Request access</button>
        </div>
    <//>`;
}

/**
 * What a viewer asked for access with, on their page, for who manages them: when, their words, and Clear once it is
 * answered. Access itself is given below it, where it always is.
 */
function Asked({ person }) {
    const clear = () =>
        attempt(async () => {
            store.set({
                users: await api(`users/${encodeURIComponent(person.id)}/access-request`, {
                    clear: true,
                }),
            });
        });

    return html`<div class="access-asked">
        <div class="grow">
            <div class="small"><b>Asked for access</b> ${whenAsked(person.request.at)}</div>
            ${person.request.note && html`<div class="small">“${person.request.note}”</div>`}
            <div class="muted small">Give them what they need below, then clear this.</div>
        </div>
        <button class="button small" aria-label=${`Clear ${person.name}'s request`} onClick=${clear}>
            Clear
        </button>
    </div>`;
}

/** Everyone with access, as the list on the left orders them: who is here first, then who was here last. */
function ordered(users) {
    return [...users].sort(
        (a, b) =>
            Number(Boolean(b.online)) - Number(Boolean(a.online)) ||
            (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
    );
}

/** What a person may do, in a word or two. */
function roleText(person) {
    if (person.role === "viewer") {
        return person.paused ? "paused" : "viewer";
    }

    return person.role === "owner" ? "owner" : "user";
}

/** A person's picture with the mark that says whether they are here now. */
function Face({ person, size = 28 }) {
    return html`<span class="people-here">
        <${Avatar} person=${person} size=${size} />
        <span class=${`online-mark ${person.online ? "" : "away"}`} aria-hidden="true"></span>
    </span>`;
}

/** One setting of a person: what it is, what it means now, and its control. */
function Setting({ label, hint, children }) {
    return html`<div class="setting wrap">
        <div class="grow">
            <div class="small">${label}</div>
            ${hint && html`<div class="muted small">${hint}</div>`}
        </div>
        ${children}
    </div>`;
}

/** The server's clock, so the end is shown and set correctly even when the browser's clock is off. */
const serverNow = () => Date.now() + serverClockOffset();

function AccountEnd({ expiresAt, own = false }) {
    useMinute();
    const when = countdown(expiresAt, serverNow(), { long: true });

    return own ? html`<p class="muted small">Your account expires ${when}.</p>` : when;
}

/** Keep pinned sessions synced on this browser (`theme.js`), on the owner's or a user's own page. */
function PinSync() {
    const on = pinsSynced();
    const label = "Keep pinned sessions synced on this browser";

    return html`<${Setting}
        label=${label}
        hint=${
            on
                ? "On: pins are the same in every browser where this is on."
                : Array.isArray(store.state.pinnedSynced)
                  ? "Off: pins stay in this browser. On: this browser shows your synced pins, in place of its own."
                  : "Off: pins stay in this browser. On: this browser's pins become your synced pins."
        }
    >
        <${Switch}
            on=${on}
            label=${`${label}: ${on ? "on" : "off"}`}
            onChange=${() => syncPins(!on)}
        />
    <//>`;
}

/** What a user who manages users reads under a switch they cannot turn on (`access.ts` `offer`: "lacking"). */
const NOT_YOURS = "Off: you can only give what you have yourself.";

/**
 * One right a person is given everywhere (to link runners, invite people, manage users, keep sessions warm), as the
 * server declares it (`each`: `rights.ts`, `store.js` `declaredRights`) and offers it to me for this person
 * (`person.offer`, `access.ts` `offer`): "open", mine to turn on and off; "lacking", only to take back, since I lack it
 * myself; "with", on with another right they hold. The rules are the server's: this draws what it says.
 */
function PersonRight({ person, each }) {
    const offer = person.offer[each.key];
    const on = person.rights?.includes(each.key) === true;
    const hint =
        offer === "with"
            ? (each.withHint ?? each.on)
            : on
              ? each.on
              : offer === "lacking"
                ? NOT_YOURS
                : (each.off ?? each.on);

    const flip = () =>
        (on || !each.confirm || confirm(each.confirm.replaceAll("{name}", person.name))) &&
        attempt(() =>
            api(`users/${encodeURIComponent(person.id)}/rights`, { right: each.key, on: !on }),
        );

    return html`<${Setting} label=${each.label} hint=${hint}>
        <${Switch}
            on=${on}
            disabled=${offer !== "open"}
            label=${`${person.name} ${each.says}: ${on ? "on" : "off"}`}
            onChange=${flip}
        />
    <//>`;
}

/**
 * What a person is let do everywhere: steer Pi (which takes their own authenticator), link computers of their own, how
 * long their sessions' approvals last, and get in past the one session they were invited to. The owner sets it, or a
 * user who manages users; whether they manage users themselves is the owner's alone.
 */
function Rights({ person, change }) {
    const sessionTitle = (id) =>
        store.state.sessions.find((each) => each.id === id)?.title ?? `session ${id}`;
    const steers = person.role === "guest";
    const only =
        person.sessions &&
        (person.sessions.length > 0
            ? person.sessions.map((id) => `“${sessionTitle(id)}”`).join(", ")
            : "a session not shared with you");

    return html`<div class="group">
        <div class="group-title">What they may do</div>
        ${
            !steers &&
            html`<${Setting}
                label="Allow viewer to become a user and prompt"
                hint=${
                    person.temporary
                        ? "Off: a temporary account. They cannot link an authenticator or become a user."
                        : "On: they can link an authenticator and be made a user. It stays on; you can still turn off Can prompt, revoke their access, or remove them."
                }
            >
                <${Switch}
                    on=${!person.temporary}
                    disabled=${!person.temporary}
                    label=${`${person.name} may become a user and prompt: ${person.temporary ? "off" : "on"}`}
                    onChange=${() =>
                        confirm(
                            `Allow ${person.name} to become a user and prompt? Their account cannot be made temporary again. You can still turn off Can prompt, revoke their sessions, or remove them.`,
                        ) && change({ temporary: false })}
                />
            <//>`
        }
        ${
            person.temporary &&
            html`<${Setting}
                label="Account expires"
                hint=${
                    person.expiresAt === undefined
                        ? "Never"
                        : html`<${AccountEnd} expiresAt=${person.expiresAt} />`
                }
            >
                <${DurationButtons}
                    label="Account expires"
                    choices=${ACCOUNT_LASTS}
                    value=${person.expiresAt === undefined ? null : undefined}
                    onChange=${(minutes) =>
                        change({
                            expiresAt: minutes === null ? null : serverNow() + minutes * 60_000,
                        })}
                />
            <//>`
        }
        <${Setting}
            label="Can prompt"
            hint=${
                steers
                    ? "On: a user. They prompt and start sessions in their folders."
                    : person.temporary
                      ? "Off: a viewer. Turn on Allow viewer to become a user and prompt first."
                      : person.hasCode
                        ? "Off: a viewer."
                        : `Off: a viewer. ${person.name} must link an authenticator first.`
            }
        >
            <${Switch}
                on=${steers}
                disabled=${!steers && (!person.hasCode || person.temporary === true)}
                label=${`${person.name} can prompt: ${steers ? "on" : "off"}`}
                onChange=${() => change({ role: steers ? "viewer" : "guest" })}
            />
        <//>
        ${declaredRights("person").map(
            (each) =>
                person.offer?.[each.key] !== undefined &&
                html`<${PersonRight} key=${each.key} person=${person} each=${each} />`,
        )}
        ${
            steers &&
            person.approvalDays !== undefined &&
            html`<${Setting}
                label="Approvals last"
                hint=${"A session of theirs locks this long after they last used it."}
            >
                <${ApprovalTime} person=${person} plain=${true} />
            <//>`
        }
        ${
            only &&
            html`<${Setting}
                label="One session only"
                hint=${`They were invited to ${only}, and get in nowhere else.`}
            >
                <button
                    class="button small ghost"
                    onClick=${() =>
                        confirm(
                            `Remove ${person.name}'s one-session limit? They lose that session until you share it with them.`,
                        ) && change({ sessions: null })}
                >
                    Remove the limit
                </button>
            <//>`
        }
    </div>`;
}

/** The computers I am in charge of that `person` can be chosen for. */
function placesFor(person) {
    return computers().filter((each) => inCharge(each) && choosable(each, person));
}

/**
 * Where a person may work, for the owner: each computer, whether they may use it, and under it the folders given to
 * them there and the sessions they have there, as two lists (`access.js` `AccessRow`). The same record as that
 * computer's People in Runners: a change in one is a change in the other. A runner's linker who manages nobody gets
 * the same of their own runners, from Invite to your runner (`Reach`).
 */
function Places({ person, title = "Where they may work" }) {
    return html`<div class="group">
        <div class="group-title">${title}</div>
        ${placesFor(person).map(
            (computer) => html`<${AccessRow}
                key=${computer.id}
                computer=${computer}
                person=${person}
                title=${computer.name}
                lead=${html`<span
                    class=${`runner-dot ${computer.id === "this-server" || computer.online ? "on" : computer.away ? "away" : ""}`}
                    aria-hidden="true"
                ></span>`}
            />`,
        )}
    </div>`;
}

/**
 * What whoever prompts does with another person, on that person's page: two buttons, and no list. Invite to your
 * session shares the session open behind People with them, at once (`commands.ts` `shareWith`); once they have it from
 * a share, the same button takes it back. Invite to your runner opens the runners I am in charge of, with that
 * person's switch for each (`Places`). A button with nothing behind it is greyed out, and a line says why: no session
 * is open, the open one is not mine to share, or they have it already another way. `placed`: the page shows Where
 * they may work already, so the second button would only repeat it.
 */
function Reach({ person, placed }) {
    const [open, setOpen] = useState(false);
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState("");
    // The session in the session's place, under this sheet; the server answers for its top session.
    const id = openId();
    const path =
        id === null ? null : `users/${encodeURIComponent(person.id)}/sharing?session=${id}`;
    const here = store.state.sessions.find((each) => each.id === id);
    // Asked again when what the answer stands on changes: whom it is shared with, who they are, where they are chosen.
    const stamp = JSON.stringify([
        here?.sharedWith,
        here?.createdBy,
        here?.mayShare,
        person.role,
        person.sessions,
        computers().map((each) => [each.id, (each.users ?? []).map((user) => user.id)]),
    ]);

    useEffect(() => {
        if (path === null) {
            return undefined;
        }

        let live = true;

        api(path).then(
            (answer) => live && setData({ path, row: answer.sessions[0] ?? null }),
            (failure) => live && setData({ path, row: null, error: failure.message }),
        );

        return () => {
            live = false;
        };
    }, [path, stamp]);

    // Undefined while the server has not answered for this session; null when it is not mine to share.
    const row = path === null ? null : data?.path === path ? data.row : undefined;
    const runners = placesFor(person).length > 0;
    // Theirs from a share: mine to take back.
    const remove = row?.state === "shared" && row.take;
    const give = row?.give === true;
    const mine = row && computers().some((each) => each.id === row.computer && inCharge(each));
    const about =
        path === null
            ? "Open a session to invite them to it."
            : row === undefined
              ? ""
              : row === null
                ? (data.error ?? "The open session is not yours to share.")
                : remove
                  ? `${person.name} has “${row.title}” from you.`
                  : give
                    ? `Shares “${row.title}” with ${person.name}.`
                    : row.state === "started"
                      ? `${person.name} started “${row.title}”.`
                      : row.state === "invited"
                        ? `${person.name} was invited to “${row.title}” alone.`
                        : row.state === "charge"
                          ? `${person.name} is in charge of ${row.computerName}: every session there is theirs.`
                          : /^cannot use /.test(row.reason ?? "")
                            ? `${person.name} cannot use ${row.computerName} yet. ${
                                  mine
                                      ? `Turn it on for them first, ${placed ? "under Where they may work" : "with Invite to your runner"}.`
                                      : "Whoever is in charge of it turns it on for them first."
                              }`
                            : `${person.name} is invited to one session only.`;
    const lines = [about, !placed && !runners && "You have no runner of your own."].filter(Boolean);

    const change = async () => {
        if (remove && !confirm(`Stop sharing “${row.title}” with ${person.name}?`)) {
            return;
        }

        setBusy(true);
        setSaid("");

        try {
            const answer = await api(path, remove ? { revoke: [row.id] } : { share: [row.id] });

            setData({ path, row: answer.sessions[0] ?? null });
            setSaid(answer.refused[0]?.reason ?? "");
        } catch (failure) {
            setSaid(failure.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="reach">
        <div class="row reach-buttons">
            <button class="button small" disabled=${busy || !(give || remove)} onClick=${change}>
                ${remove ? "Remove from your session" : "Invite to your session"}
            </button>
            ${
                !placed &&
                html`<button
                    class="button small"
                    aria-expanded=${open}
                    disabled=${!runners}
                    onClick=${() => setOpen(!open)}
                >
                    Invite to your runner
                </button>`
            }
        </div>
        ${lines.length > 0 && html`<div class="muted small">${lines.join(" ")}</div>`}
        ${said && html`<div class="runner-note warning" role="alert">${said}</div>`}
        ${open && runners && html`<${Places} person=${person} title="Your runners" />`}
    </div>`;
}

/** Their authenticator, for the owner: that one is linked, and its removal for a lost phone. */
function Authenticator({ person }) {
    return html`<div class="group">
        <div class="group-title">Sign-in</div>
        <${Setting}
            label="Authenticator"
            hint=${
                person.authenticator
                    ? "Linked. For a lost phone, remove it: they link a new one on their page in People."
                    : person.temporary
                      ? "None: a temporary account cannot link one."
                      : "None linked. They link one on their page in People."
            }
        >
            ${
                person.authenticator &&
                html`<button
                    class="button small ghost"
                    aria-label="Remove authenticator"
                    onClick=${() =>
                        confirm(
                            `Remove ${person.name}'s authenticator?${person.role === "guest" ? " They can only view until they link a new one. Then they are a user again." : ""}`,
                        ) &&
                        attempt(async () =>
                            store.set({
                                users: await api(
                                    `users/${encodeURIComponent(person.id)}/authenticator`,
                                    undefined,
                                    { method: "DELETE" },
                                ),
                            }),
                        )}
                >
                    Remove
                </button>`
            }
        <//>
    </div>`;
}

/**
 * One person: who they are, then, for the owner, everything about them: what they may do, where they may work (each
 * computer, with their folders and their sessions there as two lists, as in Runners), and their sign-in. Anyone else
 * reads who they are. One's own page is one's account: photo, name, another device of one's own, the authenticator,
 * and Sign out; for the owner, anyone's page signs in a device of theirs. A user who manages users gets the owner's
 * view of the people they may change (`mine`), without that sign-in link. Whoever prompts gets, on another person's
 * page, what they do with them (`Reach`): their own sessions and runners, for that person.
 */
function PersonPage({ person }) {
    const { me } = store.state;
    const owner = me?.role === "owner";
    const myself = person.id === me?.id;
    const viewer = person.role === "viewer";
    // Is this person mine to change (`access.ts` `mayManagePerson`): the owner changes everyone else; a user who manages
    // users changes neither themselves nor another who manages users.
    const mine =
        managesPeople() &&
        person.role !== "owner" &&
        (owner || (!myself && person.rights?.includes("managesUsers") !== true));
    // What is decided for a person; the owner themselves can do everything.
    const rules = mine && collab();
    // Where a person may work, on the computers I am in charge of. A runner's linker who manages nobody sets it under
    // their computer, in Runners.
    const places = (owner || mine) && placesFor(person).length > 0;
    // One's own approval time counts only on a computer someone else is in charge of.
    const asked = owner && myself && computers().some((each) => !inCharge(each));
    // What I do with them: for whoever prompts and starts sessions, on someone else's page.
    const reach = !myself && collab() && (owner || me?.role === "guest") && !me?.sessions;
    const change = (patch) =>
        attempt(async () => store.set({ users: await actions.setAccess(person.id, patch) }));

    const remove = () =>
        confirm(
            `Remove ${person.name}? Their devices are signed out, and their sessions move to who is in charge of each computer.`,
        ) &&
        attempt(async () => {
            await api(`users/${encodeURIComponent(person.id)}/remove`, {});
            store.set({ users: store.state.users.filter((each) => each.id !== person.id) });
        });

    return html`<div class="sheet-page">
        <div class="sheet-page-head">
            <${Face} person=${person} size=${36} />
            <h3 class="sheet-page-title">
                ${person.name}${myself ? html` <span class="muted small">(you)</span>` : ""}
            </h3>
            <div class="sheet-page-actions">
                ${
                    mine &&
                    html`<button class="button small ghost danger" onClick=${remove}>Remove</button>`
                }
            </div>
        </div>
        <div class="muted small">
            ${[
                person.role === "owner" ? "owner · in charge of this server" : roleText(person),
                person.sessions && "one session only",
                person.temporary && "temporary account",
                lastSeen(person),
                // The rights said in this line (`rights.ts` `line`): links runners, manages users.
                ...declaredRights("person")
                    .filter((each) => each.line && person.rights?.includes(each.key))
                    .map((each) => each.says),
            ]
                .filter(Boolean)
                .join(" · ")}
        </div>
        ${
            myself &&
            person.expiresAt !== undefined &&
            html`<${AccountEnd} expiresAt=${person.expiresAt} own=${true} />`
        }
        ${
            mine &&
            person.paused &&
            html`<${Setting}
                label="Paused: their authenticator was removed. They are a user again when they link one."
            >
                <button class="button small ghost" onClick=${() => change({ role: "viewer" })}>
                    Keep as viewer
                </button>
            <//>`
        }
        ${mine && person.request && html`<${Asked} person=${person} />`}
        ${reach && html`<${Reach} person=${person} placed=${places} />`}
        ${myself && !viewer && html`<${MyPhoto} />`}
        ${myself && html`<${MyName} key=${person.name} person=${person} />`}
        ${myself && viewer && html`<${RequestAccess} person=${person} />`}
        ${
            collab() &&
            // One's own, the owner's for anyone, and for a viewer whoever manages them (`access.ts` `maySignInAs`).
            (owner || (myself && !viewer) || (mine && viewer && !person.paused)) &&
            html`<${DeviceLink} key=${person.id} person=${person} />`
        }
        ${
            asked &&
            person.approvalDays !== undefined &&
            html`<${Setting}
                label="Approvals last"
                hint="How long your session stays open on a computer someone else is in charge of, after you last used it."
            >
                <${ApprovalTime} person=${person} plain=${true} />
            <//>`
        }
        ${myself && !viewer && html`<${PinSync} />`}
        ${
            myself &&
            person.paused &&
            html`<p class="muted small">
                Link an authenticator to prompt again. You get back what you had.
            </p>`
        }
        ${
            // A temporary account gets nothing here: it links none.
            myself && html`<${MyAuthenticator} paused=${person.paused} />`
        }
        ${
            (rules || places) &&
            html`<div class="sheet-pane">
                ${rules && html`<${Rights} person=${person} change=${change} />`}
                ${places && html`<${Places} person=${person} />`}
                ${rules && html`<${Authenticator} person=${person} />`}
            </div>`
        }
        ${
            !rules &&
            !places &&
            // The owner's own page says nothing of what they may do: they know.
            !(myself && person.role === "owner") &&
            html`<p class="muted small">
                ${
                    person.role === "owner"
                        ? "They see every session on this server and on the runners they linked."
                        : person.role === "viewer"
                          ? `${myself ? "You read" : "They read"} the sessions shared with ${myself ? "you" : "them"}, and cannot prompt.`
                          : `${myself ? "You prompt" : "They prompt"} and start sessions in ${myself ? "your" : "their"} folders.`
                }
            </p>`
        }
        ${
            // Last, away from the rest, in the color of what signs this device out.
            myself &&
            html`<div class="my-signout">
                <button class="button ghost sheet-footer signout" onClick=${signOut}>
                    <${Icon} name="logout" size=${16} /> Sign out
                </button>
            </div>`
        }
    </div>`;
}

/** What holds for everyone on this server: the owner sets it, and a user who manages the server. */
function SettingsPage() {
    return html`<div class="sheet-page">
        <h3 class="sheet-page-title">Settings</h3>
        <p class="muted small">For everyone on this server.</p>
        <${TasksExpire} />
    </div>`;
}

/**
 * People: everyone with access on the left, and the chosen person's page beside it, laid out as the Runners sheet is
 * (`pages.js`). The owner manages each person there. What holds for everyone (Settings) is set by who manages the
 * server (`store.js` `managesServer`).
 */
export function PeopleSheet() {
    const { me, users } = store.state;
    const settings = managesServer();
    const [view, setView] = useState(null);
    // A viewer has no list of the people here: their own page alone. The people they meet in the sessions shown to them
    // stay in `users`, for the names on messages there.
    const people = ordered(
        me?.role === "viewer" ? users.filter((each) => each.id === me.id) : users,
    );

    // The lists as they are now: also someone who joined with an invite a moment ago.
    useEffect(() => {
        attempt(async () => {
            const [list] = await Promise.all([api("users"), loadComputers()]);

            store.set({ users: list });
        });
    }, []);

    // One's own page first, for everyone: what is theirs to change is there. A removed person's page falls back the same
    // way.
    const fallback = (people.find((each) => each.id === me?.id) ?? people[0])?.id;
    const shown =
        view === "settings" && settings
            ? view
            : people.some((each) => `person:${each.id}` === view)
              ? view
              : fallback === undefined
                ? null
                : `person:${fallback}`;
    const current = people.find((each) => `person:${each.id}` === shown);

    const list = html`<div class="group-title">People</div>
        ${people.map(
            (person) => html`<${PageItem}
                key=${person.id}
                selected=${shown === `person:${person.id}`}
                onSelect=${() => setView(`person:${person.id}`)}
                lead=${html`<${Face} person=${person} />`}
                title=${person.id === me?.id ? `${person.name} (you)` : person.name}
                detail=${[roleText(person), lastSeen(person)].join(" · ")}
                badge=${managesPeople() && person.request ? "Request" : null}
                alert=${true}
            />`,
        )}
        ${
            canInviteNew() &&
            html`<${PageItem}
                onSelect=${() => openSheet({ type: "invite" })}
                lead=${html`<${Icon} name="plus" size=${16} />`}
                title="Invite someone"
            />`
        }
        <div class="group-title">More</div>
        ${
            settings &&
            html`<${PageItem}
                selected=${shown === "settings"}
                onSelect=${() => setView("settings")}
                lead=${html`<${Icon} name="shield" size=${16} />`}
                title="Settings"
                detail="For everyone"
            />`
        }
        <${PageItem}
            onSelect=${() => openSheet({ type: "notifications" })}
            lead=${html`<${Icon} name="phone" size=${16} />`}
            title="Notifications"
            detail="On this device"
        />`;

    return html`<${Sheet} title="People" onClose=${closeSheet} className="pages-sheet">
        <${Pages} label="People" list=${list}>
            ${current && html`<${PersonPage} key=${current.id} person=${current} />`}
            ${shown === "settings" && html`<${SettingsPage} />`}
        <//>
    <//>`;
}
