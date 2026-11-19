// A sheet of pages (`.pages-sheet`): what there is to choose on the left, the chosen one's page on the right, as the
// Runners sheet and the People sheet are laid out. On a phone the two stack: the list first, then the page.
import { html } from "../ui.js";

/** The list on the left and the chosen page beside it. */
export function Pages({ label, list, children }) {
    return html`<div class="pages-split">
        <nav class="pages-list" aria-label=${label}>${list}</nav>
        <div class="pages-detail">${children}</div>
    </div>`;
}

/** Where the list stands over the page, not beside it: as the stylesheet's `.pages-split` does on a phone. */
const STACKED = "(max-width: 719px)";

/**
 * A row in the list on the left: one thing to open, with what stands before its name and a count after it. A row that
 * shows a page here says whether it is the one shown (`selected`); one that opens something else leaves it out.
 */
export function PageItem({ selected, onSelect, lead, title, detail, badge }) {
    const select = (event) => {
        const split = event.currentTarget.closest(".pages-split");

        onSelect();

        // Stacked, the page is under the list and out of sight: a tap brings it up, once it is drawn.
        if (selected !== undefined && matchMedia(STACKED).matches) {
            requestAnimationFrame(() =>
                split?.querySelector(".pages-detail")?.scrollIntoView({ block: "start" }),
            );
        }
    };

    return html`<button
        class=${`pages-item ${selected ? "on" : ""}`}
        aria-current=${selected ? "page" : undefined}
        onClick=${select}
    >
        ${lead}
        <span class="pages-item-text">
            <span class="pages-item-title">${title}</span>
            ${detail && html`<span class="muted small">${detail}</span>`}
        </span>
        ${badge && html`<span class="pages-badge">${badge}</span>`}
    </button>`;
}

/** The parts of a page as tabs: each `[id, label, count]`. One part alone needs no tabs. */
export function PageTabs({ label, tabs, shown, onShow }) {
    if (tabs.length < 2) {
        return null;
    }

    return html`<div class="segmented sheet-tabs" role="tablist" aria-label=${label}>
        ${tabs.map(
            ([id, name, count]) => html`<button
                key=${id}
                role="tab"
                class=${shown === id ? "on" : ""}
                aria-selected=${shown === id}
                onClick=${() => onShow(id)}
            >
                ${name}${count > 0 ? html` <span class="muted">${count}</span>` : ""}
            </button>`,
        )}
    </div>`;
}
