// Approvals kept on the server (`src/server/folder-approvals.ts`): a folder on a computer, a whole computer, or a session
// shared with someone, each for one person. Each person sees and revokes their own; the owner, everyone's. And the owner's
// choice of how long each person's approvals last once unused (`config.ts` `APPROVAL_DAYS`).
import { api, attempt, store } from "../store.js";
import { html, timeAgo } from "../ui.js";

/** The choices of an approval time, in days; 0 is "never ask". */
export const APPROVAL_DAYS = [1, 7, 14, 30, 0];

/** An approval time in words. */
export function daysText(days) {
    return days === 0 ? "never ask" : days === 1 ? "1 day" : `${days} days`;
}

/** What an approval is of, in words. */
function what(approval) {
    const computer =
        approval.computer === "this-server"
            ? "this server"
            : (store.state.runners.find((each) => each.id === approval.computer)?.name ??
              "a computer");

    // A recurring task's own: it lasts while the task does, and Revoke stops its runs.
    if (approval.task !== undefined) {
        return html`<strong>${approval.label ?? "A task"}</strong> on ${computer}`;
    }

    if (approval.session !== undefined) {
        const title =
            store.state.sessions.find((each) => String(each.id) === approval.session)?.title ??
            `session ${approval.session}`;

        return html`Steer <strong>${title}</strong>`;
    }

    if (approval.folder === "*") {
        return html`All of <strong>${computer}</strong>`;
    }

    return html`<code>${approval.folder}</code> on ${computer}`;
}

/** When an approval ends, unless used before. */
function ends(approval) {
    if (approval.task !== undefined) {
        return "lasts while the task does";
    }

    if (approval.expiresAt === null) {
        return "does not end";
    }

    const left = approval.expiresAt - Date.now();
    const days = Math.round(left / 86_400_000);

    return left <= 0
        ? "ending"
        : days >= 1
          ? `ends in ${days} day${days === 1 ? "" : "s"} unless used`
          : `ends in ${Math.max(1, Math.round(left / 3_600_000))} h unless used`;
}

/**
 * The approvals this person may see: their own, and for the owner everyone's (named). Revoke ends one at once: the next
 * session there, or message in that shared session, asks for a code again.
 */
export function ApprovalsList({ mine = false }) {
    const { folderApprovals, me } = store.state;
    const shown = (folderApprovals ?? []).filter((each) => !mine || each.person === me?.id);
    const others = !mine && me?.role === "owner";

    const revoke = (approval) =>
        attempt(() =>
            api(`approvals/${encodeURIComponent(approval.id)}`, undefined, { method: "DELETE" }),
        );

    return html`<div class="group approvals">
        <div class="group-title">${mine ? "Your approvals" : "Approvals"}</div>
        ${
            shown.length === 0 &&
            html`<div class="muted small">
                ${mine ? "None now. A code from your authenticator approves a folder when you start a session there." : "None now."}
            </div>`
        }
        <div class="sheet-list">
            ${shown.map(
                (
                    approval,
                ) => html`<div class="runner-permission-row approval-row" key=${approval.id}>
                    <div class="person-main">
                        <div class="small">${others ? html`<strong>${approval.name}</strong>: ` : ""}${what(approval)}</div>
                        <div class="muted small">
                            ${[
                                approval.method === "owner"
                                    ? "allowed by the owner"
                                    : "with a code",
                                `used ${timeAgo(approval.usedAt)}${timeAgo(approval.usedAt) === "now" ? "" : " ago"}`,
                                ends(approval),
                            ].join(" · ")}
                        </div>
                    </div>
                    <button class="button small ghost" onClick=${() => revoke(approval)}>Revoke</button>
                </div>`,
            )}
        </div>
    </div>`;
}

/** The owner picks how long `person`'s approvals last once unused, on every computer. */
export function ApprovalTime({ person }) {
    const set = (days) =>
        attempt(() =>
            api(`users/${encodeURIComponent(person.id)}/approval-days`, { days: Number(days) }),
        );

    return html`<label class="approval-time small">
        <span class="muted">Approvals last</span>
        <select
            value=${String(person.approvalDays ?? 7)}
            aria-label=${`How long ${person.name}'s approvals last once unused`}
            onChange=${(event) => set(event.currentTarget.value)}
        >
            ${APPROVAL_DAYS.map(
                (days) => html`<option value=${String(days)}>${daysText(days)}</option>`,
            )}
        </select>
    </label>`;
}
