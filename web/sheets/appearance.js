// Appearance: themes, and how the app looks and moves.
import { closeSheet, openSheet, store } from "../store.js";
import {
    chooseTheme,
    fontOf,
    FONTS,
    paletteOf,
    prefs,
    setPrefs,
    themeIds,
    THEMES,
    themeVars,
    varsStyle,
} from "../theme.js";
import { html, Icon, Sheet, Switch } from "../ui.js";

/** A theme as a card: a tiny Hyprland desktop drawn in its own colors. */
function ThemeCard({ id, index, desktop = false }) {
    const palette = paletteOf(id);
    const vars = varsStyle(themeVars(palette));
    // "Desktop" on a server without an Omarchy desktop shows Tokyo Night.
    const on =
        prefs().theme === id ||
        (id === "tokyo-night" && prefs().theme === "desktop" && !store.state.desktopTheme);
    const dots = ["--o-red", "--o-yellow", "--o-green", "--o-cyan", "--o-blue", "--o-magenta"];
    const desk = html`<div class="tc-desk">
        <div class="tc-win"><i></i><i></i><i class="lit"></i></div>
        <div class="tc-win"><i></i><i></i><i class="lit"></i></div>
    </div>`;
    const name = html`<div class="tc-name">
        ${desktop ? `Desktop · ${palette.name}` : THEMES[id].name}
        ${palette.colors.mode === "light" && html`<small>light</small>`}
    </div>`;

    return html`<button
        class=${`theme-card ${on ? "on" : ""} ${desktop ? "theme-desktop" : ""}`}
        style=${`${vars};--i:${index}`}
        title=${desktop ? "Follow the Omarchy theme of the machine Pi Pocket runs on" : THEMES[id].name}
        onClick=${(event) => chooseTheme(id, event)}
    >
        ${desk}
        ${
            desktop
                ? html`<div class="tc-text">
                    ${name}
                    <div class="tc-note">
                        Follows your desktop: change the Omarchy theme and Pi Pocket changes with it.
                    </div>
                    <div class="tc-dots">
                        ${dots.map((dot) => html`<i style=${`background:var(${dot})`}></i>`)}
                    </div>
                </div>`
                : html`${name}
                <div class="tc-dots">
                    ${dots.map((dot) => html`<i style=${`background:var(${dot})`}></i>`)}
                </div>`
        }
    </button>`;
}

function SettingRow({ title, detail, children }) {
    return html`<div class="setting-row">
        <div class="setting-text">
            <span>${title}</span>
            ${detail && html`<span>${detail}</span>`}
        </div>
        ${children}
    </div>`;
}

export function AppearanceSheet() {
    const p = prefs();
    const font = fontOf(p.font);
    const desktop = store.state.desktopTheme;

    return html`<${Sheet} title="Appearance" onClose=${closeSheet} wide=${true}>
        <div class="label">Theme</div>
        <div class="theme-grid">
            ${desktop && html`<${ThemeCard} id="desktop" index=${0} desktop=${true} />`}
            ${themeIds().map(
                (id, index) => html`<${ThemeCard} key=${id} id=${id} index=${index + 1} />`,
            )}
        </div>
        ${
            !desktop &&
            html`<p class="muted small">
                Running Pi Pocket on an Omarchy desktop adds “Desktop”: the app follows the theme the desktop uses.
            </p>`
        }
        <div class="label">Typography</div>
        <div>
            <div class="font-picker">
                <label for="appearance-font">Font</label>
                <select
                    id="appearance-font"
                    value=${font.id}
                    aria-describedby="appearance-font-detail"
                    onChange=${(event) => setPrefs({ font: event.currentTarget.value })}
                >
                    ${FONTS.map(
                        (choice) => html`<option key=${choice.id} value=${choice.id}>
                            ${choice.name}${choice.id === "jetbrains-mono" ? " (default)" : ""}
                        </option>`,
                    )}
                </select>
                <p id="appearance-font-detail" class="muted small">
                    Saved in this browser. Code and diffs stay monospace.
                </p>
                <div class="font-preview" aria-label="Font preview">
                    <div>The quick brown fox jumps over the lazy dog.</div>
                    <code>const answer = (x) => x !== 42; // 0O 1lI</code>
                    ${
                        // Icons as a prompt prints them: a folder, Git's branch, Node.js, and Python.
                        font.id === "jetbrains-mono-nerd" &&
                        html`<code>\u{F07C} ~/pi-pocket \u{E0A0} main \u{E718} \u{E73C}</code>`
                    }
                </div>
            </div>
            <${SettingRow}
                title="Use ligatures"
                detail="Draw => and !== as one symbol, in the fonts that have them"
            >
                <${Switch}
                    on=${p.ligatures}
                    label="Use ligatures"
                    onChange=${() => setPrefs({ ligatures: !p.ligatures })}
                />
            <//>
            <${SettingRow} title="Text size">
                <div class="segmented">
                    ${[12, 13, 14, 15, 16].map(
                        (size) => html`<button
                            class=${p.text === size ? "on" : ""}
                            onClick=${() => setPrefs({ text: size })}
                        >
                            ${size}
                        </button>`,
                    )}
                </div>
            <//>
        </div>
        <div class="label">Layout and motion</div>
        <div>
            <${SettingRow}
                title="Tiled windows"
                detail="Wide screens: the sidebar and the session as Hyprland windows, with gaps and the active border"
            >
                <${Switch}
                    on=${p.tiling}
                    label="Tiled windows"
                    onChange=${() => setPrefs({ tiling: !p.tiling })}
                />
            <//>
            <${SettingRow}
                title="Peek tiles"
                detail="Other sessions beside this one, live while on screen: working, waiting for you, done since you looked, and pinned. Also the tiles button in the top bar, or Alt+P"
            >
                <${Switch}
                    on=${p.peeks}
                    label="Peek tiles"
                    onChange=${() => setPrefs({ peeks: !p.peeks })}
                />
            <//>
            ${
                desktop?.wallpaper &&
                html`<${SettingRow}
                    title="Desktop wallpaper"
                    detail="Your wallpaper in the gaps between windows, while following the desktop"
                >
                    <${Switch}
                        on=${p.wallpaper}
                        disabled=${!p.tiling || p.theme !== "desktop"}
                        label="Desktop wallpaper"
                        onChange=${() => setPrefs({ wallpaper: !p.wallpaper })}
                    />
                <//>`
            }
            <${SettingRow}
                title="Sidebar"
                detail="Folded, it shows numbered sessions like workspaces"
            >
                <div class="segmented">
                    ${[
                        ["open", "Open"],
                        ["rail", "Folded"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.sidebar === value ? "on" : ""}
                                onClick=${() => setPrefs({ sidebar: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow}
                title="Motion"
                detail="Auto follows your system's reduced-motion setting"
            >
                <div class="segmented">
                    ${[
                        ["auto", "Auto"],
                        ["full", "Full"],
                        ["reduced", "Reduced"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.motion === value ? "on" : ""}
                                onClick=${() => setPrefs({ motion: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
        </div>
        <div class="label">Status line</div>
        <div>
            <${SettingRow}
                title="Reply speed"
                detail="Under the message box: how fast the last answer came, in tokens a second, and how long its first token took"
            >
                <${Switch}
                    on=${p.speed}
                    label="Reply speed"
                    onChange=${() => setPrefs({ speed: !p.speed })}
                />
            <//>
        </div>
        <button class="button wide" onClick=${() => openSheet({ type: "shortcuts" })}>
            <${Icon} name="keyboard" size=${16} /> Keyboard shortcuts
        </button>
    <//>`;
}
