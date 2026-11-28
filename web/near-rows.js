// A first-draw window at the end of the loaded transcript. The tail stays in the DOM, so the existing distance
// from the bottom still names the reader's place, and a row that was drawn never loses its local state.

const GAP = 16;

function estimate(item) {
    if (item.type === "activity") {
        return 36;
    }

    if (item.type === "mark") {
        return 0;
    }

    if (item.type === "reply") {
        // Long replies are common. Count only up to a screen's worth of lines; a fence can fold.
        let lines = 0;

        for (const { block } of item.blocks) {
            if (block.type === "text") {
                const text = block.text.slice(0, 2400);

                lines += Math.max(text.length / 80, text.split("\n").length);
            }
        }

        return 42 + Math.min(24, lines) * 14;
    }

    return 64;
}

/** Leave a screen above the bottom or saved reading place. Check the estimate against the first real layout. */
export function firstNear(items, keep, viewport) {
    let index = items.length;
    let left = Math.max(keep ?? viewport, viewport) + viewport;

    while (index > 0 && left > 0) {
        left -= estimate(items[--index]) + GAP;
    }

    return index;
}

/** One flex child stands in for the skipped rows and the gaps *between* them. */
export function nearSpacer(items, count) {
    let height = 0;

    for (let index = 0; index < count; index++) {
        height += estimate(items[index]);
    }

    return `calc(${height}px + ${GAP * (count - 1)}px * var(--space-y))`;
}
