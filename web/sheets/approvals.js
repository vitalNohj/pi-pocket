// Session approvals (`src/server/folder-approvals.ts`): each session someone works in on a computer they are not in
// charge of has one. It lasts its last user's approval time after their last use; then the session is locked until its
// starter's code or Allow by who is in charge renews it in the session (`folder-requests.js`). Here: the owner's
// choice of each person's approval time
// (`config.ts` `APPROVAL_DAYS`), and of whether tasks stop with their session's approval. The approvals themselves
// are not listed anywhere.
import { api, attempt, store } from "../store.js";
import { html, Switch } from "../ui.js";
import { isOwner } from "../roles.js";

/** The choices of an approval time, in days; 0 is "never ends". */
export const APPROVAL_DAYS = [1, 7, 14, 30, 0];

/** An approval time in words. */
export function daysText(days) {
    return days === 0 ? "never ends" : days === 1 ? "1 day" : `${days} days`;
}

/**
 * Who manages `person` picks how long a session's approval lasts after they used it. `plain`: the choice without its
 * words. A user who manages users is offered no longer a time than their own (`app.ts` `setApprovalDays`), beside the
 * time the person has now.
 */
export function ApprovalTime({ person, plain = false }) {
    const { me, users } = store.state;
    const now = person.approvalDays ?? 7;
    // 0 is "never ends": the longest there is.
    const length = (days) => (days === 0 ? Infinity : days);
    const own = length(users.find((each) => each.id === me?.id)?.approvalDays ?? 7);
    const offered = isOwner(me)
        ? APPROVAL_DAYS
        : APPROVAL_DAYS.filter((days) => days === now || length(days) <= own);
    const set = (days) =>
        attempt(() =>
            api(`users/${encodeURIComponent(person.id)}/approval-days`, { days: Number(days) }),
        );

    return html`<label class="approval-time small">
        ${!plain && html`<span class="muted">Approvals last</span>`}
        <select
            value=${String(now)}
            aria-label=${`How long a session's approval lasts after ${person.name} used it`}
            onChange=${(event) => set(event.currentTarget.value)}
        >
            ${offered.map((days) => html`<option value=${String(days)}>${daysText(days)}</option>`)}
        </select>
    </label>`;
}

/**
 * The switch of who manages Pi Pocket: tasks that run on their own (webhooks, schedules, watches) stop with their session's approval, a
 * week after it ends, with reminders. Off: they run for good once set up.
 */
export function TasksExpire() {
    const on = store.state.tasksExpire === true;
    const toggle = () =>
        attempt(async () => {
            await api("tasks-expire", { on: !on });
            store.set({ tasksExpire: !on });
        });

    return html`<div class="setting wrap tasks-expire">
        <div class="grow">
            <div class="small">Tasks expire with the session</div>
            <div class="muted small">
                ${
                    on
                        ? "On: a session's webhooks, schedules, and watches pause a week after its approval ends."
                        : "Off: they keep running."
                }
            </div>
        </div>
        <${Switch} on=${on} label=${`Tasks expire with the session: ${on ? "on" : "off"}`} onChange=${toggle} />
    </div>`;
}
