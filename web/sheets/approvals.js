// Session approvals (`src/server/folder-approvals.ts`): each session someone works in on a computer they are not in
// charge of has one. It lasts its last user's approval time after their last use; then the session is locked until its
// starter's code or the Allow of who is in charge renews it. A person lists the sessions they started; who is in charge
// of a computer, every one there. And the owner's choice of each person's approval time (`config.ts` `APPROVAL_DAYS`),
// and of whether tasks stop with their session's approval.
import { api, attempt, notify, store } from "../store.js";
import { html, timeAgo } from "../ui.js";

/** The choices of an approval time, in days; 0 is "never ends". */
export const APPROVAL_DAYS = [1, 7, 14, 30, 0];

/** An approval time in words. */
export function daysText(days) {
    return days === 0 ? "never ends" : days === 1 ? "1 day" : `${days} days`;
}

/** Where a session is: its folder, on which computer. */
function where(approval) {
    const computer =
        approval.computer === "this-server"
            ? "this server"
            : (store.state.runners.find((each) => each.id === approval.computer)?.name ??
              "a computer");

    return html`<code>${approval.folder}</code> on ${computer}`;
}

/** When an approval ends, unless used before. */
function ends(approval) {
    if (approval.expiresAt === null) {
        return "does not end";
    }

    if (approval.ended) {
        return approval.revokedAt === undefined
            ? "ended: locked until renewed"
            : "revoked: locked until renewed";
    }

    const left = approval.expiresAt - Date.now();
    const days = Math.round(left / 86_400_000);

    return days >= 1
        ? `ends in ${days} day${days === 1 ? "" : "s"} unless used`
        : `ends in ${Math.max(1, Math.round(left / 3_600_000))} h unless used`;
}

/** Whether `me` is in charge of `approval`'s computer: the owner here, a runner's linker there. */
function inCharge(approval, me) {
    return approval.computer === "this-server"
        ? me?.role === "owner"
        : store.state.runners.find((each) => each.id === approval.computer)?.createdBy === me?.id;
}

/** Renew a session's approval: Allow for who is in charge, else a code from the starter's own authenticator. */
async function renew(approval, me) {
    if (inCharge(approval, me)) {
        await attempt(() => api(`session-approvals/${encodeURIComponent(approval.session)}`, {}));

        return;
    }

    const code = prompt(`Code from your authenticator to renew “${approval.title}”`)?.trim();

    if (!code) {
        return;
    }

    await attempt(async () => {
        await api(`session-approvals/${encodeURIComponent(approval.session)}`, { code });
        notify("Renewed.");
    });
}

/**
 * The session approvals this person may list: the sessions they started, and on computers they are in charge of every
 * one (named by who used it last). Revoke locks a session at once; Renew opens it again. `computer` keeps one
 * computer's, `person` the ones that person used last. `heading` false: under a page's own title.
 */
export function ApprovalsList({ mine = false, computer, person, heading = true }) {
    const { folderApprovals, me } = store.state;
    const shown = (folderApprovals ?? []).filter(
        (each) =>
            (computer === undefined || each.computer === computer) &&
            (person === undefined || each.lastUser === person) &&
            (!mine ||
                store.state.sessions.find((session) => String(session.id) === each.session)
                    ?.createdBy === me?.id),
    );

    const revoke = (approval) =>
        attempt(() =>
            api(`session-approvals/${encodeURIComponent(approval.session)}`, undefined, {
                method: "DELETE",
            }),
        );

    return html`<div class="group approvals">
        ${heading && html`<div class="group-title">${mine ? "Your sessions' approvals" : "Session approvals"}</div>`}
        ${
            shown.length === 0 &&
            html`<div class="muted small">
                None now. A session someone starts on a computer they are not in charge of gets one.
            </div>`
        }
        <div class="sheet-list">
            ${shown.map(
                (
                    approval,
                ) => html`<div class="runner-permission-row approval-row" key=${approval.session}>
                    <div class="person-main">
                        <div class="small"><strong>${approval.title}</strong> · ${where(approval)}</div>
                        <div class="muted small">
                            ${[
                                approval.method === "owner" ? "allowed in the app" : "with a code",
                                `used by ${approval.name} ${timeAgo(approval.usedAt)}${timeAgo(approval.usedAt) === "now" ? "" : " ago"}`,
                                ends(approval),
                            ].join(" · ")}
                        </div>
                    </div>
                    <div class="row">
                        ${
                            approval.ended &&
                            html`<button class="button small" onClick=${() => renew(approval, me)}>
                                Renew
                            </button>`
                        }
                        ${
                            !approval.ended &&
                            html`<button class="button small ghost" onClick=${() => revoke(approval)}>
                                Revoke
                            </button>`
                        }
                    </div>
                </div>`,
            )}
        </div>
    </div>`;
}

/** The owner picks how long a session's approval lasts after `person` used it. `plain`: the choice without its words. */
export function ApprovalTime({ person, plain = false }) {
    const set = (days) =>
        attempt(() =>
            api(`users/${encodeURIComponent(person.id)}/approval-days`, { days: Number(days) }),
        );

    return html`<label class="approval-time small">
        ${!plain && html`<span class="muted">Approvals last</span>`}
        <select
            value=${String(person.approvalDays ?? 7)}
            aria-label=${`How long a session's approval lasts after ${person.name} used it`}
            onChange=${(event) => set(event.currentTarget.value)}
        >
            ${APPROVAL_DAYS.map(
                (days) => html`<option value=${String(days)}>${daysText(days)}</option>`,
            )}
        </select>
    </label>`;
}

/**
 * The owner's switch: tasks that run on their own (webhooks, schedules, watches) stop with their session's approval, a
 * week after it ends, with reminders. Off: they run for good once set up.
 */
export function TasksExpire() {
    const on = store.state.tasksExpire === true;
    const toggle = () =>
        attempt(async () => {
            await api("tasks-expire", { on: !on });
            store.set({ tasksExpire: !on });
        });

    return html`<label class="row small tasks-expire">
        <input type="checkbox" checked=${on} onChange=${toggle} />
        <span>
            Tasks expire with the session
            <span class="muted">
                ${" "}· webhooks, schedules, and watches pause a week after their session's approval ends, with reminders.
            </span>
        </span>
    </label>`;
}
