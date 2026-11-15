// People with access to this server, and invites for more. The People sheet is laid out as the Runners sheet is
// (`pages.js`): everyone on the left, the chosen person's page beside it, with what they may do and where. Where a
// person may work is the same list as each computer's People in Runners (`access.js`).
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar, avatarBlob } from "../avatar.js";
import {
    actions,
    api,
    attempt,
    canStart,
    closeSheet,
    collab,
    notify,
    openSheet,
    store,
} from "../store.js";
import { copyText, html, Icon, Loader, Sheet, Switch, timeAgo } from "../ui.js";
import {
    choosable,
    choosePerson,
    chosenFor,
    computers,
    FolderList,
    inCharge,
    loadComputers,
    THIS_SERVER,
} from "./access.js";
import { ApprovalsList, ApprovalTime, TasksExpire } from "./approvals.js";
import { PageItem, Pages, PageTabs } from "./pages.js";

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
    const [only, setOnly] = useState(session !== null);
    const [minutes, setMinutes] = useState(15);
    const [made, setMade] = useState(null);
    // The newest invite could not be made: the sheet offers to try again rather than wait for ever.
    const [failed, setFailed] = useState(false);
    // What the sheet says now: an invite shows only while it was made for exactly this.
    const asked = JSON.stringify([only, minutes]);
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
                    collab()
                        ? { ...(only && here ? { session: here.id } : {}), minutes }
                        : { minutes },
                );
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
    }, [only, minutes]);
    useEffect(
        () => () => {
            mounted.current = false;
        },
        [],
    );
    // Shown only while it is what the sheet says, not for a frame after a change.
    const invite = made && made.asked === asked ? made : null;
    // An invite to more than one session shows its maker's sessions as they are now (`app.ts` `welcome`), no others.
    const where =
        only && here
            ? `only “${here.title}”`
            : "the sessions you started so far, and later ones only when they are shared with them";
    // As long as the invite shown lasts (a server that does not say: 15 minutes), or, while one is made, as chosen.
    const lasting = LASTS.find(
        ([each]) => each === (invite ? (invite.minutes ?? 15) : minutes),
    )?.[2];

    return html`<${Sheet} title="Invite someone" onClose=${closeSheet}>
        ${
            collab() &&
            html`<p class="muted small">
                They join as a viewer: they read along, react, and chat. To steer Pi, they link an authenticator under
                their name; then the owner turns on Steer Pi for them in People.
            </p>
            ${
                here &&
                html`<div class="field">
                    <div class="label">In</div>
                    <div class="segmented">
                        <button
                            class=${!only ? "on" : ""}
                            aria-pressed=${!only}
                            onClick=${() => setOnly(false)}
                        >
                            My sessions
                        </button>
                        <button
                            class=${only ? "on" : ""}
                            aria-pressed=${only}
                            onClick=${() => setOnly(true)}
                        >
                            Only this session
                        </button>
                    </div>
                </div>`
            }`
        }
        <div class="field">
            <div class="label">Expires after</div>
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
                An invite is for someone new. For another device of your own, open your name in People and use Sign in
                another device.
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
    const owner = person.role === "owner";
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
                        ? `Send this to ${person.name}, or let them scan it. It signs their device in as ${person.name}, with all they have here, so give it only to them. It works once, until ${until}.${person.hasCode ? " Their device also asks for a code from their authenticator: if they lost that too, remove it under Sign-in first." : ""}`
                        : `For a lost device: makes a link that signs a phone or computer in as ${person.name}, not as someone new. It works once, within 15 minutes.`
                    : made
                      ? `Scan this on your other device, or open the link there. It signs that device in as you${owner ? ", the owner, with full control" : ""}, so keep it to yourself. It works once, until ${until}.${person.hasCode ? " That device also asks for a code from your authenticator." : ""}`
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

/** Your own picture: choose one (cropped and shrunk here before it is sent), or take it away. */
export function MyPhoto() {
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

    return html`<div class="my-photo">
        <${Avatar} person=${person} size=${48} />
        <input ref=${input} type="file" accept="image/*" hidden onChange=${choose} />
        <button class="button" onClick=${() => input.current.click()}>
            ${person.avatar ? "Change photo" : "Add photo"}
        </button>
        ${
            person.avatar &&
            html`<button
                class="button ghost"
                onClick=${() => attempt(() => api("me/avatar", undefined, { method: "DELETE" }))}
            >
                Remove photo
            </button>`
        }
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
    return person.role === "owner" ? "owner" : person.role === "viewer" ? "view only" : "can steer";
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

/**
 * What the owner lets a person do everywhere: steer Pi (which takes their own authenticator), link computers of their
 * own, and get in past the one session they were invited to.
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
        <${Setting}
            label="Steer Pi"
            hint=${
                steers
                    ? "On: they send to Pi, approve its requests, and start sessions in the folders given to them."
                    : person.hasCode
                      ? "Off: they read along, react, and chat."
                      : `Off: they read along, react, and chat. ${person.name} links an authenticator first: Menu → their name → Authenticator.`
            }
        >
            <${Switch}
                on=${steers}
                disabled=${!steers && !person.hasCode}
                label=${`${person.name} steers Pi: ${steers ? "on" : "off"}`}
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
            only &&
            html`<${Setting}
                label="One session only"
                hint=${`They were invited to ${only}, and get in nowhere else.`}
            >
                <button
                    class="button small ghost"
                    onClick=${() =>
                        confirm(
                            `Lift ${person.name}'s limit? They then get in as anyone does: on the computers chosen for them, and to the sessions shared with them. They keep that session only if it is shared with them.`,
                        ) && change({ sessions: null })}
                >
                    Lift the limit
                </button>
            <//>`
        }
    </div>`;
}

/**
 * One computer for one person: whether they may use it, and the folders given to them there. The same list the Runners
 * sheet shows under that computer's People (`access.js`): a change in one is a change in the other.
 */
function PersonComputer({ computer, person }) {
    const [busy, setBusy] = useState(false);
    const chosen = chosenFor(computer, person);
    const server = computer.id === THIS_SERVER;

    const toggle = async () => {
        if (
            chosen &&
            !confirm(
                `Take ${computer.name} from ${person.name}? They leave its sessions at once, and the sessions they started there move to you.`,
            )
        ) {
            return;
        }

        setBusy(true);

        try {
            await choosePerson(computer, person, !chosen);
        } finally {
            setBusy(false);
        }
    };

    return html`<div class="access-computer">
        <div class="setting wrap">
            <span
                class=${`runner-dot ${server || computer.online ? "on" : computer.away ? "away" : ""}`}
                aria-hidden="true"
            ></span>
            <div class="grow">
                <div class="small"><strong>${computer.name}</strong></div>
                <div class="muted small">
                    ${
                        person.sessions
                            ? "Not for someone invited to one session only."
                            : !chosen
                              ? "Off: they see nothing of it."
                              : person.role === "viewer"
                                ? "On: they see the sessions shared with them here."
                                : "On: they start sessions in the folders below, and see the ones shared with them."
                    }
                </div>
            </div>
            <${Switch}
                on=${chosen}
                disabled=${busy || Boolean(person.sessions)}
                label=${`${person.name} may use ${computer.name}: ${chosen ? "on" : "off"}`}
                onChange=${toggle}
            />
        </div>
        ${chosen && person.role === "guest" && html`<${FolderList} computer=${computer} person=${person} />`}
    </div>`;
}

/** The computers I am in charge of that `person` can be chosen for. */
function placesFor(person) {
    return computers().filter((each) => inCharge(each) && choosable(each, person));
}

/** Where a person may work: each computer I am in charge of, with their folders there. */
function Places({ person }) {
    const mine = placesFor(person);

    if (mine.length === 0) {
        return null;
    }

    return html`<div class="group">
        <div class="group-title">Where</div>
        <div class="muted small">
            A person gets in only on the computers chosen for them. Those who steer work only in the folders given
            to them there, and the folders inside them. The same choices are in Runners, under each computer's People.
        </div>
        ${mine.map(
            (computer) => html`<${PersonComputer}
                key=${computer.id}
                computer=${computer}
                person=${person}
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
                    ? "Linked. For a lost phone, remove it: they link a new one under their name."
                    : "None linked. They link one under their name: Menu → their name → Authenticator."
            }
        >
            ${
                person.authenticator &&
                html`<button
                    class="button small ghost"
                    onClick=${() =>
                        confirm(
                            `Remove ${person.name}'s authenticator? They view only until they link a new one and you let them steer again.`,
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
 * One person: who they are, then what they may do and where, and their sessions' approvals. One's own page also signs
 * in another device of one's own; for the owner, anyone's page signs in a device of theirs.
 */
function PersonPage({ person }) {
    const { me } = store.state;
    const owner = me?.role === "owner";
    const myself = person.id === me?.id;
    // What the owner decides for a person; the owner themselves can do everything.
    const rules = owner && person.role !== "owner" && collab();
    const count = (store.state.folderApprovals ?? []).filter(
        (each) => each.lastUser === person.id,
    ).length;
    const tabs = [
        (rules || placesFor(person).length > 0) && ["access", "Access"],
        // Viewers start nothing, so nothing of theirs needs an approval.
        owner &&
            person.role !== "viewer" &&
            person.approvalDays !== undefined && ["approvals", "Approvals", count],
    ].filter(Boolean);
    const [tab, setTab] = useState(null);
    const shown = tabs.some(([id]) => id === tab) ? tab : tabs[0]?.[0];

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
                    myself &&
                    html`<button class="button small" onClick=${() => openSheet({ type: "name" })}>
                        Name and photo
                    </button>`
                }
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
                lastSeen(person),
                person.linksRunners && "links runners",
            ]
                .filter(Boolean)
                .join(" · ")}
        </div>
        ${
            collab() &&
            (myself || owner) &&
            html`<${DeviceLink} key=${person.id} person=${person} />`
        }
        <${PageTabs}
            label=${`${person.name}: parts`}
            tabs=${tabs}
            shown=${shown}
            onShow=${setTab}
        />
        ${
            shown === "access" &&
            html`<div class="sheet-pane">
                ${rules && html`<${Rights} person=${person} />`}
                <${Places} person=${person} />
                ${rules && html`<${Authenticator} person=${person} />`}
            </div>`
        }
        ${
            shown === "approvals" &&
            html`<div class="sheet-pane">
                <${Setting}
                    label="Approvals last"
                    hint=${`How long a session's approval lasts after ${myself ? "you" : person.name} last used it.`}
                >
                    <${ApprovalTime} person=${person} plain=${true} />
                <//>
                <${ApprovalsList} person=${person.id} />
            </div>`
        }
        ${
            tabs.length === 0 &&
            html`<p class="muted small">
                ${
                    person.role === "owner"
                        ? "They can do everything here: every session on this server is theirs to see, and they choose who gets in."
                        : person.role === "viewer"
                          ? `${myself ? "You read" : "They read"} the sessions shared with ${myself ? "you" : "them"}, react, and chat. Steering Pi takes an authenticator, and the owner's leave.`
                          : `${myself ? "You send" : "They send"} to Pi in the sessions shared with ${myself ? "you" : "them"}, and start sessions in the folders the owner gave ${myself ? "you" : "them"}.`
                }
            </p>`
        }
    </div>`;
}

/** Every session approval the owner may list, and whether tasks stop with them. */
function ApprovalsPage() {
    return html`<div class="sheet-page">
        <h3 class="sheet-page-title">Session approvals</h3>
        <p class="muted small">
            A session someone works in on a computer they are not in charge of has an approval. It ends when it is not
            used for that person's approval time; then the session is locked until it is renewed.
        </p>
        <${ApprovalsList} heading=${false} />
        <${TasksExpire} />
    </div>`;
}

/**
 * People: everyone with access on the left, and the chosen person's page beside it, laid out as the Runners sheet is
 * (`pages.js`). The owner sets there what each person may do and, as anyone in charge of a computer, where: the same
 * choices as under each computer in Runners.
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

    // The first other person, whose settings are what this sheet is for; alone here, oneself. A removed person's page
    // falls back the same way.
    const fallback = (people.find((each) => each.id !== me?.id) ?? people[0])?.id;
    const shown =
        view === "approvals" && owner
            ? view
            : people.some((each) => `person:${each.id}` === view)
              ? view
              : fallback === undefined
                ? null
                : `person:${fallback}`;
    const current = people.find((each) => `person:${each.id}` === shown);
    const approvals = (store.state.folderApprovals ?? []).length;

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
                selected=${shown === "approvals"}
                onSelect=${() => setView("approvals")}
                lead=${html`<${Icon} name="shield" size=${16} />`}
                title="Session approvals"
                badge=${approvals > 0 ? String(approvals) : null}
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
            ${shown === "approvals" && html`<${ApprovalsPage} />`}
        <//>
    <//>`;
}
