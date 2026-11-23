// The folder picker's list of folders (`sheets/folder.js`), drawn so that it stays quick with a thousand folders:
// - each row draws again only when its folder or its selection changes, so a click that selects a row draws two rows;
// - the whole list draws nothing while its folders and selection stay the same, so a change elsewhere in the app (a
//   message in a session, someone's presence) does not draw a thousand rows again;
// - a long list draws its first rows at once and the rest a few at a time after each frame is painted, so the folder
//   shows at once and no frame waits for all of it.
import { Component } from "preact";
import { html, Icon } from "./ui.js";

/** The rows drawn at once: more than a tall screen shows. */
export const FIRST_ROWS = 80;
/** The rows added after each frame, until all are drawn. */
export const STEP_ROWS = 150;

class Row extends Component {
    shouldComponentUpdate(next) {
        return next.dir !== this.props.dir || next.on !== this.props.on;
    }

    render({ dir, on, touch, actions }) {
        return html`<button
            type="button"
            tabindex="-1"
            class=${`fp-row ${on ? "on" : ""}`}
            role="option"
            aria-selected=${on ? "true" : "false"}
            data-path=${dir.path}
            title=${touch ? undefined : "Double-click to open"}
            onClick=${() => actions.current.click(dir.path)}
            onDblClick=${() => actions.current.open(dir.path)}
        >
            <${Icon} name="folder" size=${16} />
            <span class="fp-name">${dir.name}</span>
            ${touch && html`<${Icon} name="chevron" size=${14} class="fp-chev" />`}
        </button>`;
    }
}

/**
 * The rows of `dirs`, `selected` marked. `actions` is a ref to `{ click, open }`, each given a folder's path:
 * kept current by the picker, so the rows need not draw again when its handlers are made anew.
 */
export class FolderRows extends Component {
    constructor(props) {
        super(props);
        // How many of the folders `of` are drawn so far.
        this.state = { of: props.dirs, count: FIRST_ROWS };
    }

    /** Other folders start again from their first rows, also ones drawn whole before (a folder kept, opened again). */
    static getDerivedStateFromProps(props, state) {
        return props.dirs === state.of ? null : { of: props.dirs, count: FIRST_ROWS };
    }

    shouldComponentUpdate(next, state) {
        return (
            next.dirs !== this.props.dirs ||
            next.selected !== this.props.selected ||
            state.count !== this.state.count
        );
    }

    componentDidMount() {
        this.more();
    }

    componentDidUpdate() {
        this.more();
    }

    componentWillUnmount() {
        cancelAnimationFrame(this.frame);
        clearTimeout(this.timer);
    }

    /** More rows to draw: some after this frame is painted (a frame, then a task after it). */
    more() {
        cancelAnimationFrame(this.frame);
        clearTimeout(this.timer);

        const { dirs } = this.props;

        if (this.drawn() >= dirs.length) {
            return;
        }

        this.frame = requestAnimationFrame(() => {
            this.timer = setTimeout(() => {
                if (this.props.dirs === dirs) {
                    this.setState({ count: this.drawn() + STEP_ROWS });
                }
            });
        });
    }

    /** How many rows to draw now: those drawn so far, and down to the selected one so it can come into view. */
    drawn() {
        const { dirs, selected } = this.props;
        const count = this.state.of === dirs ? this.state.count : FIRST_ROWS;
        const at = selected === null ? -1 : dirs.findIndex((dir) => dir.path === selected);

        return Math.min(dirs.length, Math.max(count, at + 20));
    }

    render({ dirs, selected, touch, actions }) {
        return dirs.slice(0, this.drawn()).map(
            (dir) =>
                html`<${Row}
                    key=${dir.path}
                    dir=${dir}
                    on=${dir.path === selected}
                    touch=${touch}
                    actions=${actions}
                />`,
        );
    }
}
