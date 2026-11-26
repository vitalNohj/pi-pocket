// People in the Access sheet: everyone on the left, the chosen person's page beside it. Computers says where
// they work and opens the grid of one computer with that person shown. Permissions holds their account, what they
// may do, and their sign-in. What can be changed follows what the server lets the reader do.
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar, avatarBlob } from "../avatar.js";
import { shortPath } from "../folder-paths.js";
import {
    actions,
    api,
    attempt,
    closeSheet,
    collab,
    declaredRights,
    managesPeople,
    notify,
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
import { accessFolder, matches, newest, wordsOf } from "./access-tree.js";
import {
    choosable,
    choosePerson,
    chosenFor,
    ComputerDot,
    computers,
    inCharge,
    RightSwitch,
    sessionsOf,
    standing,
} from "./access.js";
import { ApprovalTime, TasksExpire } from "./approvals.js";
import { MyAuthenticator } from "./authenticator.js";
import { PageTabs } from "./pages.js";
import { canShare } from "./session-share.js";
import { DirectChat } from "./direct.js";
import { isOwner, isViewer, isUser, prompts } from "../roles.js";

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

/** A computer's name, for the heads of the custom invite's chooser: This server, or a linked one's. */
const computerName = (runner) =>
    runner === null
        ? "This server"
        : (store.state.runners.find((each) => each.id === runner)?.name ??
          store.state.sessions.find((each) => each.runner === runner && each.runnerName)
              ?.runnerName ??
          "Another computer");

/**
 * The sessions a custom invite may give, as its chooser lists them: the ones not archived that this person may share
 * (`session-share.js` `canShare`), by computer (this server first), then by folder (`access-tree.js` `accessFolder`),
 * newest first in a folder. Each computer `{ runner, name, folders }`, each folder `{ key, folder, home, sessions }`.
 */
function choosableOf(sessions) {
    const listed = sessions.filter((each) => !each.archived && canShare(each));
    const runners = [...new Set(listed.map((each) => each.runner ?? null))].sort((one, other) =>
        one === null
            ? -1
            : other === null
              ? 1
              : computerName(one).localeCompare(computerName(other)),
    );

    return runners.map((runner) => {
        const there = sessions.filter((each) => (each.runner ?? null) === runner);
        const folders = new Map();

        for (const each of listed.filter((one) => (one.runner ?? null) === runner)) {
            const folder = accessFolder(each, there);

            folders.set(folder, [...(folders.get(folder) ?? []), each]);
        }

        return {
            runner,
            name: computerName(runner),
            folders: [...folders.entries()]
                .sort(([one], [other]) => one.localeCompare(other))
                .map(([folder, list]) => ({
                    key: `${runner ?? ""}\0${folder}`,
                    folder,
                    home:
                        runner === null
                            ? store.state.server?.home
                            : store.state.runners.find((each) => each.id === runner)?.home,
                    sessions: newest(list),
                })),
        };
    });
}

/** A checkbox for many sessions at once: checked when all of them are picked, mixed when some are. */
function CheckMany({ label, ids, picked, onChange, children }) {
    const count = ids.filter((id) => picked.includes(id)).length;

    return html`<label class="check invite-many">
        <input
            type="checkbox"
            aria-label=${label}
            checked=${ids.length > 0 && count === ids.length}
            indeterminate=${count > 0 && count < ids.length}
            disabled=${ids.length === 0}
            onChange=${(event) =>
                onChange(
                    event.currentTarget.checked
                        ? [...new Set([...picked, ...ids])]
                        : picked.filter((id) => !ids.includes(id)),
                )}
        />
        ${children}
    </label>`;
}

/**
 * The chooser of a custom invite: the sessions this person may share, to check one by one, a folder's at once, or all
 * that show; a search keeps the ones whose name or folder has each word typed. `picked`: the ids checked.
 */
function InviteChooser({ groups, picked, onChange }) {
    const [query, setQuery] = useState("");
    const words = wordsOf(query);
    const total = groups.flatMap((each) => each.folders.flatMap((folder) => folder.sessions));
    const shown = groups
        .map((computer) => ({
            ...computer,
            folders: computer.folders
                .map((folder) => ({
                    ...folder,
                    sessions: folder.sessions.filter((each) =>
                        matches(words, each.title || "New session", folder.folder, each.cwd),
                    ),
                }))
                .filter((folder) => folder.sessions.length > 0),
        }))
        .filter((computer) => computer.folders.length > 0);
    const ids = (list) => list.map((each) => each.id);
    const count = total.filter((each) => picked.includes(each.id)).length;

    if (total.length === 0) {
        return html`<p class="muted small" data-part="invite-chooser">
            No session of yours to share yet.
        </p>`;
    }

    return html`<div class="invite-chooser" data-part="invite-chooser">
        <label class="search">
            <${Icon} name="search" size=${14} />
            <input
                placeholder="Find a session or folder"
                aria-label="Find a session or folder"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
                onKeyDown=${(event) => {
                    // Escape clears what is typed, not the sheet around it.
                    if (event.key === "Escape" && query !== "") {
                        event.preventDefault();
                        event.stopPropagation();
                        setQuery("");
                    }
                }}
            />
        </label>
        <${CheckMany}
            label="Select all"
            ids=${ids(shown.flatMap((each) => each.folders.flatMap((folder) => folder.sessions)))}
            picked=${picked}
            onChange=${onChange}
        >
            <span>Select all</span>
            <span class="invite-count">${`${count} of ${total.length}`}</span>
        <//>
        <div class="invite-list">
            ${shown.map(
                (computer) => html`<div class="invite-computer" key=${computer.runner ?? ""}>
                    <div class="invite-computer-name">${computer.name}</div>
                    ${computer.folders.map(
                        (folder) => html`<div class="invite-folder" key=${folder.key}>
                            <${CheckMany}
                                label=${`Give every session in ${folder.folder}`}
                                ids=${ids(folder.sessions)}
                                picked=${picked}
                                onChange=${onChange}
                            >
                                <span class="mono invite-folder-name" title=${folder.folder}>
                                    ${shortPath(folder.folder, folder.home)}
                                </span>
                            <//>
                            ${folder.sessions.map(
                                (each) => html`<label class="check invite-session" key=${each.id}>
                                    <input
                                        type="checkbox"
                                        aria-label=${`Give ${each.title || "New session"}`}
                                        checked=${picked.includes(each.id)}
                                        onChange=${(event) =>
                                            onChange(
                                                event.currentTarget.checked
                                                    ? [...picked, each.id]
                                                    : picked.filter((id) => id !== each.id),
                                            )}
                                    />
                                    <span>${each.title || "New session"}</span>
                                </label>`,
                            )}
                        </div>`,
                    )}
                </div>`,
            )}
            ${shown.length === 0 && html`<p class="muted small">No session matches the search.</p>`}
        </div>
    </div>`;
}

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
    // "Only this session" is for who may share it (`access.ts` `mayShare`); the other three, for who may invite.
    const single = row !== null && canShare(row);
    // What the invite shares: the open session when there is one, else its folder, else all of this person's; or, with
    // Custom, the sessions checked in its chooser.
    const [what, setWhat] = useState(single ? "session" : here ? "folder" : "mine");
    const custom = collab() && what === "custom";
    // The sessions Custom may give, and the ids of the ones checked; one no longer listed (archived, say) is not sent.
    const groups = custom ? choosableOf(sessions) : [];
    const offered = groups.flatMap((each) =>
        each.folders.flatMap((folder) => folder.sessions.map((one) => one.id)),
    );
    const [picked, setPicked] = useState([]);
    const giving = picked.filter((id) => offered.includes(id));
    // What the sheet said when the newest invite was asked for: Custom shows that it is being made. The ref is the same
    // for the effect below, which can run after Make invite was pressed for what the sheet says now.
    const [requested, setRequested] = useState(null);
    const requesting = useRef(null);
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
    const asked = JSON.stringify([
        what,
        minutes,
        temporary,
        ...(temporary ? [account] : []),
        ...(custom ? [[...giving].sort((one, other) => one - other)] : []),
    ]);
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
            setRequested(asked);
            requesting.current = asked;
            let answer;

            try {
                answer = await api("invite", {
                    minutes,
                    ...(collab() ? { temporary } : {}),
                    ...(temporary && account !== null ? { accountMinutes: account } : {}),
                    ...(custom
                        ? { sessions: giving }
                        : collab() && here && what !== "mine"
                          ? { session: here.id, ...(what === "folder" ? { folder: true } : {}) }
                          : {}),
                });

                // A server from before folder invites made one to the session alone: never shown as the folder's.
                if (what === "folder" && here && answer.grant?.folder === undefined) {
                    cancelInvite(answer);

                    throw new Error("Restart Pi Pocket to invite someone to a folder.");
                }

                // A server from before custom invites made one to all of its maker's sessions: never shown as custom.
                if (custom && answer.grant?.chosen === undefined) {
                    cancelInvite(answer);

                    throw new Error("Restart Pi Pocket to make a custom invite.");
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
        // Custom makes no invite until Make invite is pressed, and a change to it ends the one shown: each check would
        // else make a live code and cancel the one before. One asked for already for exactly this stays.
        if (custom) {
            if (requesting.current === asked) {
                return;
            }

            requesting.current = null;
            latest.current++;
            cancelInvite(shown.current);
            shown.current = null;
            setMade(null);
            setFailed(false);
            setRequested(null);

            return;
        }

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
    // How many sessions Custom gives: as the server kept them once it answered, else as checked.
    const chosen = invite?.grant?.chosen?.length ?? giving.length;
    const where = custom
        ? chosen === 1
            ? "the session you chose"
            : `the ${chosen} sessions you chose`
        : what === "session" && here
          ? `only “${here.title}”`
          : what === "folder" && here
            ? `the sessions you started in ${folder} so far, and later ones only when they are shared with them`
            : "the sessions you started so far, and later ones only when they are shared with them";
    // An invite to all of its maker's sessions is the widest there is: the sheet says so, and what follows for an
    // account that is not temporary.
    const all = what === "mine" || (!here && !custom);
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
            <div class="field">
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
                            ${
                                here &&
                                html`<button
                                    class=${what === "folder" ? "on" : ""}
                                    aria-pressed=${what === "folder"}
                                    onClick=${() => setWhat("folder")}
                                >
                                    This folder
                                </button>`
                            }
                            <button
                                class=${what === "mine" ? "on" : ""}
                                aria-pressed=${what === "mine"}
                                onClick=${() => setWhat("mine")}
                            >
                                My sessions
                            </button>
                            <button
                                class=${custom ? "on" : ""}
                                aria-pressed=${custom}
                                onClick=${() => setWhat("custom")}
                            >
                                Custom
                            </button>
                        </div>
                        ${
                            (what === "session" || what === "folder") &&
                            row &&
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
                    ${
                        custom &&
                        html`<${InviteChooser}
                                groups=${groups}
                                picked=${giving}
                                onChange=${setPicked}
                            />
                            <button
                                class="button primary wide"
                                disabled=${giving.length === 0}
                                onClick=${create}
                            >
                                Make invite
                            </button>`
                    }
                </div>`
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
        ${
            // Custom says what an invite gives once one is shown or being made: before that there is nothing to scan.
            (!custom || invite || failed || requested === asked) &&
            html`<p class="muted small">
                ${`Scan this on the other device, or send it the link. It works once and expires ${lasting}. Whoever joins sees ${where}.`}
            </p>`
        }
        ${
            invite?.access?.url &&
            html`<p class="muted small">Other devices connect through ${invite.access.label}.</p>`
        }
        ${
            invite
                ? html`<${InviteShown} invite=${invite} />`
                : failed
                  ? html`<p class="muted small">
                        ${`No invite yet. Tap ${custom ? "Make invite" : "New invite"} to try again.`}
                    </p>`
                  : !custom || requested === asked
                    ? html`<${Loader} label="Making an invite" />`
                    : null
        }
        ${!custom && html`<button class="button wide" onClick=${create}>New invite</button>`}
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

/**
 * When a person was last here, in words. Nothing of someone the server does not say it of (`online` absent: a viewer
 * is told only the name of the people they meet or chat with, `app.ts` `people`).
 */
export function lastSeen(person) {
    if (person.online === undefined) {
        return undefined;
    }

    if (person.online) {
        return "here now";
    }

    if (!person.lastSeen) {
        return "not seen yet";
    }

    return `seen ${timeAgo(person.lastSeen)}${timeAgo(person.lastSeen) === "now" ? "" : " ago"}`;
}

/**
 * Your own picture, in the head of your own page in People, after your name: choose one (cropped and shrunk here before
 * it is sent), or take it away. The head shows the face, so here are only its buttons.
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

    return html`<div class="my-photo">
        <input ref=${input} type="file" accept="image/*" hidden onChange=${choose} />
        <button
            class="button small"
            title="Shown in place of your initials, to everyone who can see you."
            onClick=${() => input.current.click()}
        >
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
    </div>`;
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
export function ordered(users) {
    return [...users].sort(
        (a, b) =>
            Number(Boolean(b.online)) - Number(Boolean(a.online)) ||
            (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
    );
}

/** What a person is, in one word: the server's (`rights.ts` `roleWord`), or paused. */
export function roleText(person) {
    return person.paused ? "paused" : person.word;
}

/** "This server", "This server and Macbook", "This server, Macbook, and Monolith". */
function listed(names) {
    return names.length < 3
        ? names.join(" and ")
        : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * A person's picture with the mark that says whether they are here now. No mark for someone the server does not say
 * it of (`lastSeen`).
 */
export function Face({ person, size = 28 }) {
    return html`<span class="people-here">
        <${Avatar} person=${person} size=${size} />
        ${
            person.online !== undefined &&
            html`<span class=${`online-mark ${person.online ? "" : "away"}`} aria-hidden="true"></span>`
        }
    </span>`;
}

/** One setting of a person: what it is, what it means now, and its control. */
function Setting({ label, hint, children, ...attrs }) {
    return html`<div class="setting wrap" ...${attrs}>
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
 * One right a person is given everywhere (to link runners, invite people, manage users, keep sessions warm, chat with
 * one person), as the server declares it (`each`: `rights.ts`, `store.js` `declaredRights`) and offers it to me for
 * this person (`person.offer`, `access.ts` `offer`): "open", mine to turn on and off; "lacking", only to take back,
 * since I lack it myself; "with", on with another right they hold. The rules are the server's: this draws what it
 * says.
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

/** The account settings for a person I manage. */
function Account({ person, change }) {
    const sessionTitle = (id) =>
        store.state.sessions.find((each) => each.id === id)?.title ?? `session ${id}`;
    const steers = isUser(person);
    const only =
        person.sessions &&
        (person.sessions.length > 0
            ? person.sessions.map((id) => `“${sessionTitle(id)}”`).join(", ")
            : "a session not shared with you");

    return html`<div class="group" data-part="account">
        <div class="group-title">Account</div>
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
            !steers &&
            html`<${Setting}
                label="Allow viewer to become a user and prompt"
                hint=${
                    person.temporary
                        ? "Off: a temporary account. They cannot link an authenticator or become a user."
                        : "On: they can link an authenticator and be made a user. This cannot be turned off again."
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
    </div>`;
}

/** The computers I am in charge of that `person` can be chosen for. */
function placesFor(person) {
    return computers().filter((each) => inCharge(each) && choosable(each, person));
}

/** The person rights I may give, in their declared order. */
function PocketRights({ person }) {
    const rights = declaredRights("person").filter(
        (each) => person.offer?.[each.key] !== undefined,
    );

    if (rights.length === 0) {
        return null;
    }

    return html`<div class="group" data-part="pi-pocket">
        <div class="group-title">Pi Pocket</div>
        ${rights.map((each) => html`<${PersonRight} key=${each.key} person=${person} each=${each} />`)}
    </div>`;
}

/** The choice and rights for one computer. */
function ComputerPermissions({ computer, person }) {
    const [busy, setBusy] = useState(false);
    const chosen = chosenFor(computer, person);

    const choose = async () => {
        setBusy(true);

        try {
            await choosePerson(computer, person, true);
        } finally {
            setBusy(false);
        }
    };

    const rights = declaredRights("computer").filter(
        (each) => each.key !== "manages" || computer.gives?.includes(each.key),
    );

    return html`<div class="access-row" data-part="computer" data-computer=${computer.id}>
        <div class="group-title">${computer.name}</div>
        ${
            chosen
                ? rights.map(
                      (each) => html`<${RightSwitch}
                      key=${each.key}
                      computer=${computer}
                      person=${person}
                      each=${each}
                  />`,
                  )
                : html`<div class="setting wrap">
                  <div class="grow muted small">Not chosen for ${computer.name}.</div>
                  <button class="button small" disabled=${busy} onClick=${choose}>Choose</button>
              </div>`
        }
    </div>`;
}

/**
 * What the server says of one person and me (`GET /api/users/:id/sharing`): my sessions with how they have each, the
 * folders I can give them, the computers they are in charge of, and where I can share my new sessions with them. Asked
 * while `on`, and again when what the answer stands on changes: my sessions and whom each is shared with, who they are, and
 * where they are chosen. `ready`: the server has answered, refused, or is not asked.
 */
function useSharing(person, on) {
    const [told, setTold] = useState(null);
    const [ready, setReady] = useState(false);
    const path = `users/${encodeURIComponent(person.id)}/sharing`;
    const stamp = JSON.stringify([
        store.state.sessions.map((each) => [
            each.id,
            each.title,
            each.sharedWith,
            each.archived,
            each.mayShare,
            each.usedAt,
        ]),
        person.role,
        person.sessions,
        computers().map((each) => [
            each.id,
            each.mayUse,
            each.inCharge,
            (each.users ?? []).map((user) => user.id),
            each.given?.[person.id],
            each.sees?.[person.id],
        ]),
    ]);

    useEffect(() => {
        if (!on) {
            setTold(null);

            return undefined;
        }

        let live = true;

        const answered = (answer) => {
            if (live) {
                setTold(answer);
                setReady(true);
            }
        };

        // One that cannot be asked about shows nothing of it.
        api(path).then(answered, () => answered(null));

        return () => {
            live = false;
        };
    }, [path, stamp, on]);

    return { told, setTold, ready: !on || ready };
}

/** Share the sessions I start from now on with this person, on each computer where I can. */
function NewSessions({ person, sharing }) {
    const [saving, setSaving] = useState(false);
    const rows = sharing.told?.shareNew ?? [];

    if (rows.length === 0) {
        return null;
    }

    const change = async (computer, on) => {
        setSaving(true);
        await attempt(async () => {
            const answer = await api(`users/${encodeURIComponent(person.id)}/share-new`, {
                computer,
                on,
            });

            sharing.setTold(answer);
        });
        setSaving(false);
    };

    return html`<div class="group">
        <div class="group-title">New sessions</div>
        ${rows.map(({ id, name, on }) => {
            const label = `Share my new sessions on ${name}`;
            const hint = on
                ? `Each session you start there from now on is shared with ${person.name}.`
                : "Your new sessions there start private.";

            return html`<${Setting}
                key=${id}
                label=${label}
                hint=${hint}
                data-part="share-new"
                data-computer=${id}
            >
                <${Switch}
                    on=${on}
                    disabled=${saving}
                    label=${`${label} with ${person.name}: ${on ? "on" : "off"}`}
                    onChange=${() => change(id, !on)}
                />
            <//>`;
        })}
    </div>`;
}

/** A count with its word: "1 session", "2 sessions". */
const countOf = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What one person's row says here, and whether it can lead to a column or a switch. */
function computerRow(computer, person, told) {
    if (computer.mayUse === false) {
        return undefined;
    }

    if (inCharge(computer)) {
        if (!choosable(computer, person)) {
            return { line: "In charge here: every session there is theirs." };
        }

        const sessions = sessionsOf(computer, person).length;
        const { chosen, manager } = standing(computer, person);

        if (person.sessions) {
            return sessions === 0
                ? { line: "Invited to one session only: nothing here." }
                : {
                      jump: true,
                      line: `Invited to one session only · ${countOf(sessions, "session")}`,
                  };
        }

        const folders = (computer.given?.[person.id] ?? []).length;
        const line = manager
            ? "In charge here"
            : chosen
              ? `${countOf(folders, "folder")} · ${countOf(sessions, "session")}`
              : sessions > 0
                ? `Not chosen · ${countOf(sessions, "session")} shared`
                : "Not chosen";

        return { jump: true, line };
    }

    const { id, name } = computer;

    if (told?.charge.some((each) => each.id === id)) {
        return { line: "In charge there: every session there is theirs." };
    }

    const sessions = told?.sessions.filter((each) => each.computer === id) ?? [];
    const place = told?.computers.find((each) => each.id === id);

    if (person.sessions) {
        const titles = sessions
            .filter((each) => each.state === "invited")
            .map((each) => `“${each.title}”`);

        return titles.length > 0
            ? { line: `${person.name} is invited to one session only: ${titles.join(", ")}.` }
            : sessions.length > 0
              ? { line: `${person.name} is invited to one session only.` }
              : undefined;
    }

    const folders = place?.folders ?? [];
    const offered = folders.filter((each) => each.has || each.levels.length > 1);
    const jump =
        sessions.some((each) => each.give || each.take) ||
        offered.some((each) => each.levels.length > 1);
    const possible = sessions.filter((each) => each.state !== "blocked");

    if (jump || possible.length > 0 || offered.length > 0) {
        const has = possible.filter((each) => each.state !== "none").length;
        const given = offered.filter((each) => each.has).length;
        const line =
            `${has} of ${sessions.length} of your sessions` +
            (offered.length > 0 ? ` · ${given} of ${offered.length} of your folders` : "");

        return { jump, line };
    }

    if (sessions.length > 0) {
        return {
            line: `${person.name} cannot use ${name}. Whoever is in charge of it chooses who uses it.`,
        };
    }

    return undefined;
}

/** A row opens Computer for this person when there is something to show or a switch to turn on. */
function PersonComputer({ person, computer, line, jump }) {
    const body = html`<${ComputerDot} computer=${computer} />
        <span class="grow">
            <strong>${computer.name}</strong>
            <span class="muted small person-computer-line">${line}</span>
        </span>`;

    return jump
        ? html`<button
            class="setting person-computer"
            type="button"
            data-part="person-computer"
            data-computer=${computer.id}
            aria-label=${`${person.name} on ${computer.name}: open in Computer`}
            onClick=${() =>
                openSheet({
                    type: "access",
                    view: "computer",
                    computer: computer.id,
                    only: person.id,
                    person: person.id,
                })}
        >
            ${body}
            <${Icon} name="chevron" size=${13} />
        </button>`
        : html`<div class="setting person-computer" data-computer=${computer.id}>${body}</div>`;
}

/** Their authenticator, for the owner: that one is linked, and its removal for a lost phone. */
function Authenticator({ person, children }) {
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
                            `Remove ${person.name}'s authenticator?${isUser(person) ? " They can only view until they link a new one. Then they are a user again." : ""}`,
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
        ${children}
    </div>`;
}

/**
 * A person's page: Computers and Permissions, with Chat when the server offers it. The part shown stays from one
 * person to the next. The reader sees what they can give that person or change for them. One's own page is one's
 * account: photo, sign out, name, access request, approval time, pins, another device, and authenticator.
 */

export function PersonPage({ person, part, onPart }) {
    const { me } = store.state;
    const owner = isOwner(me);
    const myself = person.id === me?.id;
    const viewer = isViewer(person);
    // Is this person mine to change (`access.ts` `mayManagePerson`): the owner changes everyone else; a user who manages
    // users changes neither themselves nor another who manages users.
    const mine =
        managesPeople() &&
        !isOwner(person) &&
        (owner || (!myself && person.rights?.includes("managesUsers") !== true));
    // Account settings are separate from the rights given on a computer in my charge.
    const account = mine && collab();
    const cards =
        !myself && collab() && prompts(person) && !person.sessions ? placesFor(person) : [];
    const rules = account || cards.length > 0;
    // One's own approval time counts only on a computer someone else is in charge of.
    const asked = owner && myself && computers().some((each) => !inCharge(each));
    const gives = !myself && collab() && (owner || isUser(me)) && !me?.sessions;
    const sharing = useSharing(person, gives);
    const rows = gives
        ? computers().flatMap((computer) => {
              const row = computerRow(computer, person, sharing.told);

              return row === undefined ? [] : [{ computer, ...row }];
          })
        : [];
    const known = rows.some((row) => inCharge(row.computer)) || sharing.ready;
    const access = rows.length > 0 || (sharing.told?.shareNew.length ?? 0) > 0;
    // A sign-in link: one's own (`access.ts` `mayAddDevice`: no viewer's, but a paused user's, who links an
    // authenticator again on that device), the owner's for anyone, and for a viewer whoever manages them
    // (`maySignInAs`).
    const device =
        collab() &&
        (owner || (myself && (!viewer || person.paused)) || (mine && viewer && !person.paused));
    // A chat with them (`direct.js`): the server says who may (`access.ts` `mayMessage`). Its count is what I have not
    // read of it.
    const chat = !myself && person.mayMessage && collab();
    // The parts of another person's page; one part alone shows without tabs.
    const tabs = known
        ? [
              access && ["access", "Computers"],
              rules && ["rules", "Permissions"],
              chat && ["chat", "Chat", store.state.directUnread[person.id] ?? 0],
          ].filter(Boolean)
        : [];
    const shown = tabs.some(([id]) => id === part) ? part : tabs[0]?.[0];
    const change = (patch) =>
        attempt(async () => store.set({ users: await actions.setAccess(person.id, patch) }));

    const remove = () =>
        confirm(
            `Remove ${person.name}? Their devices are signed out, and their sessions move to whoever is in charge of each computer.`,
        ) &&
        attempt(async () => {
            await api(`users/${encodeURIComponent(person.id)}/remove`, {});
            store.set({ users: store.state.users.filter((each) => each.id !== person.id) });
        });

    return html`<div class="sheet-page">
        <div class=${myself ? "sheet-page-head my-head" : "sheet-page-head"}>
            <${Face} person=${person} size=${36} />
            <h3 class="sheet-page-title">
                ${person.name}${myself ? html` <span class="muted small">(you)</span>` : ""}
            </h3>
            ${myself && !viewer && html`<${MyPhoto} />`}
            ${
                myself
                    ? html`<div class="sheet-page-actions my-signout">
                          <button class="button small ghost danger signout" onClick=${signOut}>
                              <${Icon} name="logout" size=${14} /> Sign out
                          </button>
                      </div>`
                    : html`<div class="sheet-page-actions">
                          ${
                              mine &&
                              html`<button class="button small ghost danger" onClick=${remove}>Remove</button>`
                          }
                      </div>`
            }
        </div>
        <div class="muted small">
            ${[
                roleText(person),
                person.sessions && "one session only",
                person.temporary && "temporary account",
                lastSeen(person),
                // The computers they are in charge of, as the server named them (`app.ts` `people`).
                person.inCharge?.length > 0 && `in charge of ${listed(person.inCharge)}`,
            ]
                .filter(Boolean)
                .join(" · ")}
        </div>
        ${
            // Their authenticator was removed: they read why they only view, and what brings it back, first.
            myself &&
            person.paused &&
            html`<p class="err small" role="status" data-part="relink-notice">
                Your authenticator was removed. Link one again below to get back what you had.
            </p>`
        }
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
        <${PageTabs} label=${`${person.name}: parts`} tabs=${tabs} shown=${shown} onShow=${onPart} />
        ${!known && html`<${Loader} />`}
        ${
            shown === "access" &&
            html`<div class="sheet-pane" data-part="person-access">
                ${
                    rows.length > 0 &&
                    html`<div class="group">
                    <div class="group-title">Computers</div>
                    ${rows.map(
                        ({ computer, line, jump }) => html`<${PersonComputer}
                        key=${computer.id}
                        person=${person}
                        computer=${computer}
                        line=${line}
                        jump=${jump}
                    />`,
                    )}
                </div>`
                }
                <${NewSessions} person=${person} sharing=${sharing} />
            </div>`
        }
        ${
            // Someone else's, with their permissions: there (below).
            device && !myself && !rules && html`<${DeviceLink} key=${person.id} person=${person} />`
        }
        ${
            shown === "rules" &&
            html`<div class="sheet-pane" data-part="person-rules">
                ${account && html`<${Account} person=${person} change=${change} />`}
                <${PocketRights} person=${person} />
                ${cards.map(
                    (computer) => html`<${ComputerPermissions}
                        key=${computer.id}
                        computer=${computer}
                        person=${person}
                    />`,
                )}
                ${
                    account &&
                    html`<${Authenticator} person=${person}>
                        ${device && !myself && html`<${DeviceLink} key=${person.id} person=${person} />`}
                    <//>`
                }
            </div>`
        }
        ${
            shown === "chat" &&
            html`<div class="sheet-pane direct-chat" data-part="person-chat">
                <${DirectChat} key=${person.id} person=${person} />
            </div>`
        }
        ${
            // One's own account; the authenticator last.
            myself &&
            html`<${MyName} key=${person.name} person=${person} />
                ${
                    // A paused person asks for nothing: linking an authenticator gives back what they had.
                    viewer && !person.paused && html`<${RequestAccess} person=${person} />`
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
                ${!viewer && html`<${PinSync} />`}
                ${device && html`<${DeviceLink} key=${person.id} person=${person} />`}
                ${
                    // A temporary account gets nothing here: it links none.
                    html`<${MyAuthenticator} paused=${person.paused} />`
                }`
        }
    </div>`;
}

function deletedText(deleted) {
    if (deleted === 0) {
        return "No project chat was stored.";
    }

    return `Deleted the chat of ${deleted} ${deleted === 1 ? "folder" : "folders"}.`;
}

/** Off closes project chat and keeps its history. Delete history removes the chat of every folder, on or off. */
function ProjectChatSetting() {
    const on = store.state.server?.projectChat === true;
    const [saving, setSaving] = useState(false);
    const [result, setResult] = useState(null);

    const toggle = async () => {
        setSaving(true);
        await attempt(() => api("project-chat", { on: !on }));
        setSaving(false);
    };

    const remove = async () => {
        if (!confirm("Delete the project chat of every folder? This cannot be undone.")) {
            return;
        }

        setSaving(true);
        const answer = await attempt(() => api("project-chat", undefined, { method: "DELETE" }));

        setSaving(false);

        if (answer !== undefined) {
            setResult(deletedText(answer.deleted));
        }
    };

    return html`<div class="setting wrap" data-part="project-chat-setting">
        <div class="grow">
            <div class="small">Project chat</div>
            <div class="muted small">
                ${
                    on
                        ? "Each folder has a chat for the people who have it, beside each session's chat."
                        : "Off. Its history is kept."
                }
            </div>
            ${result !== null && html`<div class="muted small" role="status">${result}</div>`}
        </div>
        <${Switch} on=${on} disabled=${saving} label="Project chat" onChange=${toggle} />
        <button
            class="button ghost"
            type="button"
            data-part="project-chat-delete"
            disabled=${saving}
            onClick=${remove}
        >
            Delete history
        </button>
    </div>`;
}

/** What holds for everyone on this server: the owner sets it, and a user who manages Pi Pocket. */
export function SettingsPage() {
    return html`<div class="sheet-page">
        <h3 class="sheet-page-title">Settings</h3>
        <p class="muted small">For everyone on this server.</p>
        <${TasksExpire} />
        <${ProjectChatSetting} />
    </div>`;
}
