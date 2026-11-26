// People with access to this server, and invites for more. The People sheet is laid out as the Runners sheet is
// (`pages.js`): everyone on the left, the chosen person's page beside it. The owner manages a person there, in two
// parts: Folders and sessions (where they may work: their folders and their sessions on each computer, as in Runners:
// `access.js`), and Permissions (what they may do, and their sign-in). A user the owner lets manage users (`store.js`
// `managesPeople`) does the same for the people they may change. Whoever else prompts sees, on another person's page,
// what they have to give that person: their own runners, and their sessions and folders on other computers. One search
// and three filters stand over those lists (`Access`). Anyone else reads who is here, and has their own things.
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
    navigate,
    notify,
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
import { accessFolder, below, inFolder, keeps, matches, newest, wordsOf } from "./access-tree.js";
import {
    AccessRow,
    choosable,
    computers,
    ComputerRights,
    countOf,
    groupsOf,
    LevelMenu,
    levelsFor,
    inCharge,
    projectsOf,
    SessionLine,
    TreeGroup,
    treeOf,
    useGroups,
} from "./access.js";
import { ApprovalTime, TasksExpire } from "./approvals.js";
import { MyAuthenticator } from "./authenticator.js";
import { PageTabs } from "./pages.js";
import { AccessKey, GroupBy, Pick, SearchField, TIMES, ACCESS, useFind } from "./access-grid.js";
import { canShare } from "./session-share.js";
import {
    folderCheck,
    SelectBar,
    SelectButton,
    sessionCheck,
    useListed,
    useSelect,
} from "./session-select.js";
import { DirectChat } from "./direct.js";
import { isOwner, isViewer, isUser } from "../roles.js";

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

/** What a person may do, in a word or two. */
export function roleText(person) {
    if (isViewer(person)) {
        return person.paused ? "paused" : "viewer";
    }

    return isOwner(person) ? "owner" : "user";
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

/**
 * What a person is let do everywhere: steer Pi (which takes their own authenticator), link computers of their own, how
 * long their sessions' approvals last, and get in past the one session they were invited to. The owner sets it, or a
 * user who manages users; whether they manage users themselves is the owner's alone.
 */
function Rights({ person, change }) {
    const sessionTitle = (id) =>
        store.state.sessions.find((each) => each.id === id)?.title ?? `session ${id}`;
    const steers = isUser(person);
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
 * What the server says of one person and me (`GET /api/users/:id/sharing`): my sessions with how they have each, the
 * folders I can give them, the computers they are in charge of, and where I can share my new sessions with them. Asked
 * while `on`, and again when what the answer stands on changes: my sessions and whom each is shared with, who they are, and
 * where they are chosen. `reload` asks again after a change the server does not tell this tab of (a folder I gave on
 * someone else's computer). `ready`: the server has answered, or refused, or is not asked: until then nobody knows
 * what there is to give.
 */
function useSharing(person, on) {
    const [told, setTold] = useState(null);
    const [ready, setReady] = useState(false);
    const [turn, setTurn] = useState(0);
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
    }, [path, stamp, on, turn]);

    return {
        told,
        setTold,
        ready: !on || ready,
        path,
        reload: () => setTurn((now) => now + 1),
    };
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

/** Whether a person has a session of mine now, whichever way (`commands.ts` `SharingRow` `state`). */
const theirs = (row) => row.state !== "none" && row.state !== "blocked";

/**
 * What I can give `person` on the computers I am not in charge of, from the server's answer (`told`: `useSharing`):
 * one card for each such computer (`cards`), with the folders I can give them there or gave them, my sessions there
 * under the folder each counts as working in (`access-tree.js` `inFolder`, the deepest one), and the rest of them. A
 * session they cannot have (they cannot use its computer) is not listed: the card says why (`note`). A folder with no
 * session of mine to list, which they do not have and I can neither give them nor take back, is left out: it would
 * say nothing. `charge`: the computers they are in charge of, where every session is theirs already, by name.
 */
function reachOf(told, person) {
    const mine = (id) => computers().some((each) => each.id === id && inCharge(each));
    const cards = new Map();

    const card = (id, name) => {
        if (!cards.has(id)) {
            cards.set(id, { id, name, starts: true, folders: [], other: [], rows: [], blocked: 0 });
        }

        return cards.get(id);
    };

    for (const each of told?.computers ?? []) {
        if (!mine(each.id)) {
            const at = card(each.id, each.name);

            at.reason = each.reason;
            at.folders = each.folders.map((folder) => ({
                folder: folder.path,
                info: folder,
                rows: [],
            }));
        }
    }

    for (const each of told?.sessions ?? []) {
        if (mine(each.computer)) {
            continue;
        }

        const at = card(each.computer, each.computerName);

        if (each.state === "blocked") {
            at.blocked += 1;
            at.why = each.reason;

            continue;
        }

        let best;

        for (const node of at.folders) {
            if (
                inFolder(each.folder, node.folder) &&
                (best === undefined || node.folder.length > best.folder.length)
            ) {
                best = node;
            }
        }

        const row = {
            ...each,
            has: theirs(each),
            starter: each.starter.id,
            places: best === undefined ? [each.cwd] : [each.cwd, best.folder],
        };

        (best?.rows ?? at.other).push(row);
        at.rows.push(row);
    }

    for (const at of cards.values()) {
        at.folders = at.folders.filter(
            (each) => each.rows.length > 0 || each.info.has || each.info.give || each.info.take,
        );

        if (at.blocked > 0) {
            const yours = at.blocked === 1 ? "your session" : `your ${at.blocked} sessions`;

            at.note =
                at.why === "invited to one session only"
                    ? `${person.name} is invited to one session only, so ${yours} here cannot be shared with them.`
                    : `${person.name} cannot use ${at.name}, so ${yours} here cannot be shared with them. Whoever is in charge of it chooses who uses it.`;
        } else if (at.reason && at.folders.every((each) => !each.info.has)) {
            at.note = at.reason;
        }
    }

    return {
        cards: [...cards.values()],
        charge: (told?.charge ?? []).filter((each) => !mine(each.id)).map((each) => each.name),
    };
}

/**
 * One person on a computer someone else is in charge of, for me who share what I have there (`reachOf`): its folders I
 * can give them, or gave them, and my sessions there, as the tree of a computer of my own (`access.js` `TreeGroup`).
 * A folder they do not have ends in Add; one I gave them, in Remove, and its switch lets them access all sessions in
 * it while I see them all myself (`access.ts` `mayGiveFolder`, `mayTakeFolder`, `maySetSees`). A session ends in
 * Invite, or in Revoke where the share is mine to end (`mayUnshare`): one someone else shared says who, and has
 * neither. Whether they use the computer at all is its one in charge's choice, so there is no switch for it here.
 * While sessions are selected (`select`: `session-select.js`), each session and folder drawn has its checkbox in place
 * of Invite and Revoke.
 */
function OtherComputer({ card, person, sharing, find, select }) {
    const [busy, setBusy] = useState(false);
    const groups = useGroups(find);
    const { me } = store.state;
    const on = `${person.name} on ${card.name}`;
    const shown = groupsOf(card, find);

    // The sessions drawn, for the selection: in the rows that are open, each with what the server says can be done.
    useListed(
        select,
        `card:${card.id}`,
        shown
            .filter((each) => groups.isOpen(each.key))
            .flatMap((each) => each.listed)
            .map((row) => ({ id: row.id, share: row.give, revoke: row.take })),
    );

    if (find.active && shown.length === 0) {
        return null;
    }

    const act = async (run) => {
        setBusy(true);

        try {
            await attempt(run);
        } finally {
            setBusy(false);
        }
    };

    const share = (row, body) => {
        find.keep([row.id]);

        return act(async () => {
            const answer = await api(sharing.path, body);

            sharing.setTold(answer);

            if (answer.refused.length > 0) {
                notify("error", answer.refused[0].reason);
            }
        });
    };

    const revoke = (row) =>
        confirm(`Stop sharing “${row.title}” with ${person.name}?`) &&
        share(row, { revoke: [row.id] });

    const folderRoute = (part) => `runners/${encodeURIComponent(card.id)}/${part}`;

    // The server tells this tab of no change on a computer it is not in charge of: asked again after each. Taken
    // back, the sessions they started in it go to whoever is in charge: said first.
    const setLevel = (node, level) => {
        if (
            level === "none" &&
            !confirm(
                `Take ${node.folder} from ${person.name}? The sessions they started in it move to whoever is in charge of ${card.name}, with the tasks they set up there. Sessions shared with them stay.`,
            )
        ) {
            return undefined;
        }

        find.keep(node.rows.map((each) => each.id));

        return act(async () => {
            await api(folderRoute("level"), { person: person.id, folder: node.folder, level });
            sharing.reload();
        });
    };

    const how = (row) =>
        row.state === "started"
            ? "started it"
            : row.state === "invited"
              ? "invited to it alone"
              : row.state === "folder"
                ? "accesses all sessions in its folder"
                : row.state === "none"
                  ? "not shared with them"
                  : row.by === undefined
                    ? "shared with them"
                    : `shared by ${row.by.id === me?.id ? "you" : row.by.name}`;

    const go = (row) => {
        closeSheet();
        navigate(row.id);
    };

    const inside = (key, rows, folder) => html`
        ${rows.length === 0 && html`<div class="ft-row muted at-note" style="--depth:1">No session of yours ${folder === undefined ? "here" : "in it"}.</div>`}
        ${groups.inOrder(key, rows).map(
            (row) =>
                html`<${SessionLine}
                    key=${row.id}
                    name=${row.title}
                    how=${how(row)}
                    where=${folder === undefined ? row.cwd : below(row.cwd, folder)}
                    used=${row.usedAt}
                    words=${find.words}
                    off=${!row.has}
                    check=${sessionCheck(select, row)}
                >
                    <button
                        class="button small"
                        aria-label=${`Go to ${row.title}`}
                        onClick=${() => go(row)}
                    >
                        Go to session
                    </button>
                    ${
                        // A share that is mine to end: Revoke. One I can give them: Invite in its place. Neither (a
                        // share someone else made), or while sessions are selected: the place stays, so the buttons
                        // before it are one column.
                        select.on
                            ? html`<span class="at-end" aria-hidden="true"></span>`
                            : row.take
                              ? html`<button
                                  class="button small ghost at-end"
                                  disabled=${busy}
                                  aria-label=${`Revoke ${row.title} from ${person.name}`}
                                  onClick=${() => revoke(row)}
                              >
                                  Revoke
                              </button>`
                              : row.give
                                ? html`<button
                                    class="button small at-end"
                                    disabled=${busy}
                                    aria-label=${`Invite ${person.name} to ${row.title}`}
                                    title=${
                                        row.state === "folder"
                                            ? "They have it through the folder now. Invited, they keep it when that ends."
                                            : undefined
                                    }
                                    onClick=${() => share(row, { share: [row.id] })}
                                >
                                    Invite
                                </button>`
                                : html`<span class="at-end" aria-hidden="true"></span>`
                    }
                <//>`,
        )}
    `;

    const rest = card.folders.length > 0 ? "Your other sessions" : "Your sessions";

    return html`<div class="access-row" data-computer=${card.id}>
        <div class="setting wrap">
            <div class="grow">
                <div class="small"><strong>${card.name}</strong></div>
                <div class="muted small">
                    ${card.note ?? "Someone else is in charge here. You share what you have here."}
                </div>
            </div>
        </div>
        ${
            shown.length > 0 &&
            html`<div class="at-tree" role="group" aria-label=${`Folders and sessions of ${on}`}>
                ${shown.map((each) => {
                    if (each.folder === undefined) {
                        return html`<${TreeGroup}
                            key=${each.key}
                            name=${rest}
                            label=${`${rest} on ${card.name}: ${countOf(each.rows)}`}
                            count=${countOf(each.rows)}
                            title=${card.folders.length > 0 ? "In none of these folders." : undefined}
                            open=${groups.isOpen(each.key)}
                            onToggle=${() => groups.toggle(each.key)}
                            check=${folderCheck(
                                select,
                                `${rest} on ${card.name}`,
                                groups.isOpen(each.key) ? each.listed.map((row) => row.id) : [],
                            )}
                        >
                            <div class="at-group" role="group">
                                ${inside(each.key, each.listed, undefined)}
                            </div>
                        <//>`;
                    }

                    const { info } = each;

                    return html`<${TreeGroup}
                        key=${each.key}
                        folder=${true}
                        name=${each.folder}
                        label=${`Folder ${each.folder} of ${on}: ${countOf(each.rows)}`}
                        count=${countOf(each.rows)}
                        open=${groups.isOpen(each.key)}
                        onToggle=${() => groups.toggle(each.key)}
                        words=${find.words}
                        off=${!info.has}
                        check=${folderCheck(
                            select,
                            `${each.folder} on ${card.name}`,
                            groups.isOpen(each.key) ? each.listed.map((row) => row.id) : [],
                        )}
                        actions=${html`${
                            info.has &&
                            info.by &&
                            info.by.id !== me?.id &&
                            html`<span class="at-sees">given by ${info.by.name}</span>`
                        }
                            <${LevelMenu}
                                person=${person}
                                folder=${each.folder}
                                where=${card.name}
                                level=${info.level}
                                levels=${levelsFor(person).filter((one) => info.levels.includes(one))}
                                reason=${
                                    info.levels.length > 1
                                        ? undefined
                                        : card.reason
                                          ? "Cannot be given here"
                                          : "Not yours to change"
                                }
                                busy=${busy}
                                onPick=${(level) => setLevel(each, level)}
                            />`}
                    >
                        <div class="at-group" role="group">
                            ${inside(each.key, each.listed, each.folder)}
                        </div>
                    <//>`;
                })}
            </div>`
        }
    </div>`;
}

/**
 * A person's folders and sessions, for whoever can give them some: one card for each computer, under one search and
 * three filters over them all.
 *
 * A computer I am in charge of is the record Runners shows by computer (`access.js` `AccessRow`): whether they use it,
 * the folders given to them there, and every session there that is theirs or mine to share, each given and taken back
 * alone. The owner, and whoever manages this person, has those on the page (`direct`); a runner's linker who manages
 * nobody opens their own from Invite to your runner, greyed out with no runner. Any other computer shows what I have
 * there to share (`OtherComputer`).
 *
 * The search finds a session by its name or its folder, and a folder by its path. The filters keep the sessions they
 * have or do not have, the ones I last used within a time, and the ones one person started. Under either, a folder or
 * a computer with nothing to list is left out and the others are open. In an open row the session I used last is
 * first. A row changed since the search last changed stays listed, to be changed back where it stands. An archived
 * session is not listed.
 *
 * Select, beside the search, checks several sessions listed, on any of the computers, to share or take back all at
 * once (`session-select.js`). It ends when the computers shown change, and with the page, which is one person's.
 */
function Access({ person, direct, rights, sharing, reach }) {
    const { me } = store.state;
    const state = useFind();
    const { query, filters, kept } = state;
    const own = placesFor(person);
    // A linker who manages nobody: their runners open from the button, and are open where the person is there already.
    const [opened, setOpened] = useState(() =>
        own.some((each) => treeOf(each, person, false) !== null),
    );

    useMinute();

    const mine = direct || opened ? own : [];
    // Grouped by projects where the projects of a computer are known (I am in charge of it), else by folders.
    const known = mine.some((each) => projectsOf(each) !== undefined);
    const group = state.group ?? (known ? "projects" : "folders");

    const grouping = (computer) => {
        const projects = projectsOf(computer)?.projects;

        return group === "projects" && projects === undefined
            ? { group: "folders" }
            : { group, projects };
    };

    const trees = mine.map((computer) => ({
        computer,
        tree: treeOf(computer, person, true, grouping(computer)),
    }));
    const rows = [
        ...trees.flatMap((each) => each.tree?.rows ?? []),
        ...reach.cards.flatMap((each) => each.rows),
    ];
    // What there is to search: the sessions listed, and the folders. A search is offered over more than one session,
    // or more than one folder: there is nothing to find among less.
    const folders =
        trees.reduce((sum, each) => sum + (each.tree?.folders.length ?? 0), 0) +
        reach.cards.reduce((sum, each) => sum + each.folders.length, 0);
    const searched = rows.length > 1 || folders > 1;
    // Select stands beside the search: with the tool row gone, the selection ends too.
    const select = useSelect(
        JSON.stringify([
            person.id,
            searched,
            ...mine.map((each) => each.id),
            ...reach.cards.map((each) => each.id),
        ]),
    );
    const name = (id) =>
        id === me?.id
            ? "You"
            : (store.state.users.find((each) => each.id === id)?.name ?? "Someone");
    const starters = [...new Set(rows.map((each) => each.starter))]
        .filter(Boolean)
        .sort((one, other) =>
            one === me?.id ? -1 : other === me?.id ? 1 : name(one).localeCompare(name(other)),
        );
    const by = starters.includes(filters.by) ? filters.by : "";
    const words = wordsOf(query);
    const active = words.length > 0 || filters.access !== "" || filters.time !== "" || by !== "";
    const find = {
        words,
        access: filters.access,
        time: filters.time,
        by,
        active,
        kept,
        group,
        now: Date.now(),
        stamp: JSON.stringify([words, filters.access, filters.time, by, group]),
        keep: state.keep,
        clear: state.clear,
    };
    const found = rows.filter((each) => keeps(find, each)).length;
    // Whether anything is drawn under what is searched for: a folder found by its path counts, with no session in it.
    const none =
        active &&
        trees.every((each) => each.tree === null || groupsOf(each.tree, find).length === 0) &&
        reach.cards.every((each) => groupsOf(each, find).length === 0);

    const { filter, clear } = state;

    return html`<div class="group access">
        <div class="group-title">${direct ? "Where they may work" : "What they have from you"}</div>
        ${
            !direct &&
            html`<div class="reach">
                <div class="row reach-buttons">
                    <button
                        class="button small"
                        aria-expanded=${opened && own.length > 0}
                        disabled=${own.length === 0}
                        onClick=${() => setOpened(!opened)}
                    >
                        Invite to your runner
                    </button>
                </div>
                ${own.length === 0 && html`<div class="muted small">You have no runner of your own.</div>`}
            </div>`
        }
        ${
            searched &&
            html`<div class="access-find" role="search" aria-label=${`Find among the folders and sessions of ${person.name}`}>
                <div class="ak-tools">
                    <${SearchField}
                        state=${state}
                        active=${active}
                        found=${found}
                        total=${rows.length}
                        placeholder="Search sessions and folders"
                    />
                    <${SelectButton} select=${select} />
                    <div class="ak-tools-row">
                <div class="access-picks">
                    <${Pick}
                        name="Access"
                        value=${filters.access}
                        choices=${ACCESS}
                        onChange=${(value) => filter("access", value)}
                    />
                    <${Pick}
                        name="Last used by you"
                        value=${filters.time}
                        choices=${TIMES}
                        onChange=${(value) => filter("time", value)}
                    />
                    ${
                        starters.length > 1 &&
                        html`<${Pick}
                            name="Started by"
                            value=${by}
                            choices=${[
                                ["", "Anyone"],
                                ...starters.map((id) => [
                                    id,
                                    name(id),
                                    `Started by ${id === me?.id ? "you" : name(id)}`,
                                ]),
                            ]}
                            onChange=${(value) => filter("by", value)}
                        />`
                    }
                </div>
                        <${GroupBy}
                            value=${group}
                            projects=${known}
                            onChange=${state.setGroup}
                        />
                    </div>
                </div>
                <${AccessKey} />
                <${SelectBar}
                    select=${select}
                    person=${person}
                    find=${find}
                    onAnswer=${(answer) => sharing.told !== null && sharing.setTold(answer)}
                />
            </div>`
        }
        ${
            none &&
            html`<p class="muted small access-none">
                ${words.length > 0 ? `No session matches “${query.trim()}”${filters.access !== "" || filters.time !== "" || by !== "" ? " with these filters" : ""}.` : "No session matches these filters."}${" "}
                <button type="button" class="access-clear" onClick=${clear}>Clear</button>
            </p>`
        }
        ${trees.map(
            ({ computer }) =>
                html`<${AccessRow}
                    key=${computer.id}
                    computer=${computer}
                    person=${person}
                    rights=${rights}
                    title=${computer.name}
                    find=${find}
                    grouping=${grouping(computer)}
                    select=${select}
                    lead=${html`<span
                        class=${`runner-dot ${computer.id === "this-server" || computer.online ? "on" : computer.away ? "away" : ""}`}
                        aria-hidden="true"
                    ></span>`}
                />`,
        )}
        ${reach.cards.map(
            (card) =>
                html`<${OtherComputer}
                    key=${card.id}
                    card=${card}
                    person=${person}
                    sharing=${sharing}
                    find=${find}
                    select=${select}
                />`,
        )}
        ${
            !active &&
            reach.charge.length > 0 &&
            !isOwner(person) &&
            html`<p class="muted small">
                ${
                    rows.length === 0
                        ? `${person.name} is in charge of ${reach.charge.join(", ")}: every session there is theirs.`
                        : `Not listed: your sessions on ${reach.charge.join(", ")}. ${person.name} is in charge there, so every session there is theirs.`
                }
            </p>`
        }
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
    </div>`;
}

/**
 * One person: who they are, then what there is to do with them. For the owner, and for a user who manages users on the
 * people they may change (`mine`), another person's page has two parts (`pages.js` `PageTabs`): Folders and sessions
 * (each computer with their folders and the sessions there, each session given and taken back on its row, as in
 * Runners), and Permissions (what they may do, on this server and on each computer, and their sign-in). The part shown stays
 * the same from one person to the next (`part`, kept by the sheet). Whoever prompts and manages nobody gets the first
 * part alone, of what they have to give: their own runners, and their sessions and folders on other computers
 * (`Access`). With nothing to give, the page has no such part. Anyone else reads who they are, in the head and the role
 * line under it. One's own page is one's account: its head holds the photo buttons and Sign out; under the tabs, the
 * name, a viewer's request for access, the owner's approval time, pinned sessions synced, another device of one's own,
 * and the authenticator, last.
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
    // What is decided for a person; the owner themselves can do everything.
    const rules = mine && collab();
    // Where a person may work, on the computers I am in charge of. A runner's linker who manages nobody sets it under
    // their computer, in Runners.
    const places = (owner || mine) && placesFor(person).length > 0;
    // One's own approval time counts only on a computer someone else is in charge of.
    const asked = owner && myself && computers().some((each) => !inCharge(each));
    // What I give them: for whoever prompts and starts sessions, on someone else's page (`useSharing`).
    const gives = !myself && collab() && (owner || isUser(me)) && !me?.sessions;
    const sharing = useSharing(person, gives);
    const reach = reachOf(sharing.told, person);
    // Whether what I have to give them is known: on a computer of my own at once, on someone else's once the server has
    // said. Until then the page draws none of its parts, so that none shows first and then gives way to another.
    const known = placesFor(person).length > 0 || sharing.ready;
    // Their folders and sessions show to whoever has something to give them, including new sessions.
    const access =
        places ||
        (gives &&
            (placesFor(person).length > 0 ||
                (sharing.told?.shareNew.length ?? 0) > 0 ||
                reach.cards.length > 0 ||
                (reach.charge.length > 0 && !isOwner(person))));
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
              access && ["access", "Folders and sessions"],
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
                isOwner(person) ? "owner · in charge of this server" : roleText(person),
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
            // With Permissions beside it, the rights given on each computer are there (`rights`). No comment goes inside
            // the tag: a slash there ends it, and what follows is not passed.
            shown === "access" &&
            html`<div class="sheet-pane" data-part="person-access">
                <${NewSessions} person=${person} sharing=${sharing} />
                <${Access}
                    person=${person}
                    direct=${places}
                    rights=${!rules}
                    sharing=${sharing}
                    reach=${reach}
                />
            </div>`
        }
        ${
            // Someone else's, with their permissions: there (below).
            device && !myself && !rules && html`<${DeviceLink} key=${person.id} person=${person} />`
        }
        ${
            shown === "rules" &&
            html`<div class="sheet-pane" data-part="person-rules">
                <${Rights} person=${person} change=${change} />
                ${
                    places &&
                    placesFor(person).map(
                        (computer) =>
                            html`<${ComputerRights}
                                key=${computer.id}
                                computer=${computer}
                                person=${person}
                            />`,
                    )
                }
                <${Authenticator} person=${person} />
                ${device && !myself && html`<${DeviceLink} key=${person.id} person=${person} />`}
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

/** What holds for everyone on this server: the owner sets it, and a user who manages the server. */
export function SettingsPage() {
    return html`<div class="sheet-page">
        <h3 class="sheet-page-title">Settings</h3>
        <p class="muted small">For everyone on this server.</p>
        <${TasksExpire} />
        <${ProjectChatSetting} />
    </div>`;
}
