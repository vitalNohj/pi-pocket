// People with access to this server, and invites for more. The People sheet is laid out as the Runners sheet is
// (`pages.js`): everyone on the left, the chosen person's page beside it. The owner manages a person there: what they
// may do, where they may work (their folders and their sessions on each computer, as in Runners: `access.js`), and
// their sign-in. Anyone else reads who is here, and has their own things.
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar, avatarBlob } from "../avatar.js";
import { shortPath } from "../folder-paths.js";
import {
    actions,
    api,
    attempt,
    canInvite,
    canStart,
    closeSheet,
    collab,
    notify,
    openSheet,
    signOut,
    store,
} from "../store.js";
import { pinsSynced, syncPins } from "../theme.js";
import { copyText, html, Icon, Loader, Sheet, Switch, timeAgo } from "../ui.js";
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
];

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
    // Off until asked: whoever joins has a temporary account, which links no authenticator and so stays a viewer.
    const [allow, setAllow] = useState(false);
    // A server from before roles knows no temporary account: nothing is asked of it.
    const temporary = collab() && !allow;
    const [made, setMade] = useState(null);
    // The newest invite could not be made: the sheet offers to try again rather than wait for ever.
    const [failed, setFailed] = useState(false);
    // What the sheet says now: an invite shows only while it was made for exactly this.
    const asked = JSON.stringify([what, minutes, temporary]);
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
                answer = await api(
                    "invite",
                    collab() && here && what !== "mine"
                        ? {
                              session: here.id,
                              ...(what === "folder" ? { folder: true } : {}),
                              minutes,
                              temporary,
                          }
                        : { minutes, ...(collab() ? { temporary } : {}) },
                );

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
    }, [what, minutes, temporary]);
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
    // account that is not temporary. Only the owner makes someone a user (`app.ts` `setAccess`), never they themselves.
    const all = what === "mine" || !here;
    const makes = store.state.me?.role === "owner" ? "you make" : "the owner makes";
    // As long as the invite shown lasts (a server that does not say: 15 minutes), or, while one is made, as chosen.
    const lasting = LASTS.find(
        ([each]) => each === (invite ? (invite.minutes ?? 15) : minutes),
    )?.[2];

    return html`<${Sheet} title="Invite someone" onClose=${closeSheet}>
        ${
            collab() &&
            html`<p class="muted small">
                ${
                    temporary
                        ? "They join as a viewer, with a temporary account."
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
            <div class="segmented">
                ${LASTS.map(
                    ([each, label]) => html`<button
                        class=${minutes === each ? "on" : ""}
                        aria-pressed=${minutes === each}
                        onClick=${() => setMinutes(each)}
                    >
                        ${label}
                    </button>`,
                )}
            </div>
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
            collab() &&
            all &&
            html`<div class="warn-box" data-part="invite-warning" role="note">
                <strong>This invite shares every session you started so far.</strong>
                ${
                    !temporary &&
                    html` It allows them to become a user: they can link an authenticator, and once ${makes} them
                        a user, they can prompt in all of those sessions.`
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
    return person.role === "owner" ? "owner" : person.role === "viewer" ? "viewer" : "user";
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

/** Keep pinned sessions synced on this browser (`theme.js`): one's own, on one's own page, for every role. */
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

/**
 * What the owner lets a person do everywhere: steer Pi (which takes their own authenticator), link computers of their
 * own, how long their sessions' approvals last, and get in past the one session they were invited to.
 */
function Rights({ person }) {
    const sessionTitle = (id) =>
        store.state.sessions.find((each) => each.id === id)?.title ?? `session ${id}`;
    const change = (patch) =>
        attempt(async () => store.set({ users: await actions.setAccess(person.id, patch) }));
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
        ${
            steers &&
            !person.sessions &&
            html`<${Setting}
                label="Link runners"
                hint="On: they link computers of their own as runners, which they are in charge of."
            >
                <${Switch}
                    on=${person.linksRunners === true}
                    label=${`${person.name} links runners: ${person.linksRunners ? "on" : "off"}`}
                    onChange=${() =>
                        attempt(() =>
                            api(`users/${encodeURIComponent(person.id)}/links-runners`, {
                                on: person.linksRunners !== true,
                            }),
                        )}
                />
            <//>`
        }
        ${
            steers &&
            !person.sessions &&
            html`<${Setting}
                label="Invite people"
                hint=${
                    person.invites
                        ? "On: they invite people, who join as viewers and see what the invite shares."
                        : "Off: only you invite people."
                }
            >
                <${Switch}
                    on=${person.invites === true}
                    label=${`${person.name} invites people: ${person.invites ? "on" : "off"}`}
                    onChange=${() =>
                        attempt(() =>
                            api(`users/${encodeURIComponent(person.id)}/invites`, {
                                on: person.invites !== true,
                            }),
                        )}
                />
            <//>`
        }
        ${
            steers &&
            html`<${Setting}
                label="Keep sessions warm"
                hint=${
                    person.keepsWarm
                        ? "On: they turn keep warm on for a session and pick its time. Refreshes may be charged."
                        : "Off: they can only turn keep warm off for a session."
                }
            >
                <${Switch}
                    on=${person.keepsWarm === true}
                    label=${`${person.name} keeps sessions warm: ${person.keepsWarm ? "on" : "off"}`}
                    onChange=${() =>
                        attempt(() =>
                            api(`users/${encodeURIComponent(person.id)}/keeps-warm`, {
                                on: person.keepsWarm !== true,
                            }),
                        )}
                />
            <//>`
        }
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
 * computer's People in Runners: a change in one is a change in the other.
 */
function Places({ person }) {
    return html`<div class="group">
        <div class="group-title">Where they may work</div>
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
                    onClick=${() =>
                        confirm(
                            `Remove ${person.name}'s authenticator? They are a viewer until they link a new one and are made a user again.`,
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
 * and Sign out; for the owner, anyone's page signs in a device of theirs.
 */
function PersonPage({ person }) {
    const { me } = store.state;
    const owner = me?.role === "owner";
    const myself = person.id === me?.id;
    // What the owner decides for a person; the owner themselves can do everything.
    const rules = owner && person.role !== "owner" && collab();
    // Where a person may work is the owner's to set here. A runner's linker sets it under their computer, in Runners.
    const places = owner && placesFor(person).length > 0;
    // One's own approval time counts only on a computer someone else is in charge of.
    const asked = owner && myself && computers().some((each) => !inCharge(each));

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
                    owner &&
                    person.role !== "owner" &&
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
                person.linksRunners && "links runners",
            ]
                .filter(Boolean)
                .join(" · ")}
        </div>
        ${myself && html`<${MyPhoto} />`}
        ${myself && html`<${MyName} key=${person.name} person=${person} />`}
        ${
            collab() &&
            (myself || owner) &&
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
        ${myself && html`<${PinSync} />`}
        ${
            // A temporary account gets nothing here: it links none.
            myself && html`<${MyAuthenticator} />`
        }
        ${
            (rules || places) &&
            html`<div class="sheet-pane">
                ${rules && html`<${Rights} person=${person} />`}
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
                        ? "They see every session and choose who gets in."
                        : person.role === "viewer"
                          ? `${myself ? "You read" : "They read"} the sessions shared with ${myself ? "you" : "them"}, and cannot send to Pi Pocket.`
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

/** What the owner sets for everyone on this server. */
function SettingsPage() {
    return html`<div class="sheet-page">
        <h3 class="sheet-page-title">Settings</h3>
        <p class="muted small">For everyone on this server.</p>
        <${TasksExpire} />
    </div>`;
}

/**
 * People: everyone with access on the left, and the chosen person's page beside it, laid out as the Runners sheet is
 * (`pages.js`). The owner manages each person there, and sets what holds for everyone (Settings).
 */
export function PeopleSheet() {
    const { me, users } = store.state;
    const owner = me?.role === "owner";
    const [view, setView] = useState(null);
    const people = ordered(users);

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
        view === "settings" && owner
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
            />`,
        )}
        ${
            canStart() &&
            canInvite() &&
            html`<${PageItem}
                onSelect=${() => openSheet({ type: "invite" })}
                lead=${html`<${Icon} name="plus" size=${16} />`}
                title="Invite someone"
            />`
        }
        <div class="group-title">More</div>
        ${
            owner &&
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
