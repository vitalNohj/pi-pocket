// Project trust gates .agents/skills and model defaults from .pi/settings.json. The bar asks who is in charge of the
// session's computer when its project has either and nobody decided yet; /trust shows and changes the decision, which
// on this server is the one Pi's CLI goes by. Anyone else who prompts there sees that it waits, and for whom; who is in
// charge hears of it once (`src/server/trust-requests.ts`).
// Trusting model defaults affects only later new sessions, never the open session.
import { useEffect, useRef } from "preact/hooks";
import { actions, attempt, canSteer, closeSheet, notify, openSheet, store } from "./store.js";
import { html, Icon, Loader, Sheet, shortPath } from "./ui.js";

/**
 * Whether I decide which projects Pi trusts on the open session's computer: who is in charge of it (`access.ts`
 * `inCharge`), the owner on this server (the answer goes into Pi's own settings) and a runner's linker there. With no
 * session open, this server's.
 */
export function trustAvailable() {
    const { me, runners, view } = store.state;
    const runner = view.conversation?.runner;

    return runner
        ? runners.some((each) => each.id === runner && each.createdBy === me?.id)
        : me?.role === "owner";
}

/** The folders whose question the owner put off in this tab ("Not now"): the sheet and `/trust` still answer it. */
const LATER_KEY = "pocket.trustLater";

function later() {
    try {
        return new Set(JSON.parse(sessionStorage.getItem(LATER_KEY) ?? "[]"));
    } catch {
        return new Set();
    }
}

function putOff(folder) {
    sessionStorage.setItem(LATER_KEY, JSON.stringify([...later(), folder]));
    store.set({});
}

/** What the server said about the open conversation's project, when it was for its folder now. */
function answer() {
    const { trust, conversationId, view } = store.state;

    return trust?.conversationId === conversationId && trust.cwd === view.agent?.cwd
        ? trust.info
        : null;
}

/** The project's trust, for who decides it: null until the server said, and for anyone else. */
export function currentTrust() {
    const info = answer();

    return info && "folder" in info ? info : null;
}

/** For anyone else: whether the project waits for a decision, whose, and whether they heard (`{ waiting, by, asked }`). */
export function trustWait() {
    const info = answer();

    return info && "waiting" in info ? info : null;
}

/** Fetch whether Pi trusts the open conversation's project, unless that is known for its folder (or `force`). */
export function loadTrust({ force = false } = {}) {
    const { conversationId, view, trust } = store.state;
    const cwd = view.agent?.cwd;
    const known = trust?.conversationId === conversationId && trust.cwd === cwd;

    if (conversationId === null || !cwd || (known && !force)) {
        return;
    }

    // Asked for, which nothing shows until the answer: noted without a draw (each draw is the whole app's). The answer
    // draws only when it says something new.
    if (!known) {
        store.note({ trust: { conversationId, cwd, info: null } });
    }

    actions.trust().then(
        (info) => {
            const now = store.state.trust;

            if (
                now?.conversationId === conversationId &&
                now.cwd === cwd &&
                JSON.stringify(info) !== JSON.stringify(now.info)
            ) {
                store.set({ trust: { ...now, info } });
            }
        },
        () => {},
    );
}

/** The skills' names, a few of them: "deploy, review, and 3 more". */
function skillNames(skills, most = 3) {
    const names = skills.map((skill) => skill.name);

    if (names.length <= most) {
        return names.join(", ");
    }

    return `${names.slice(0, most).join(", ")}, and ${names.length - most} more`;
}

/** Save the owner's answer, and show it: the bar goes, and the skills join the slash commands. */
async function decide(choice) {
    const { conversationId, view, server } = store.state;
    const cwd = view.agent?.cwd;
    const info = await actions.setTrust(choice);

    // Saved for that session's folder; this tab shows another session now: its own trust stays as it is.
    if (store.state.conversationId !== conversationId || store.state.view.agent?.cwd !== cwd) {
        return;
    }

    store.set({ trust: { conversationId, cwd, info }, templates: null });

    if (!info.trusted) {
        notify(
            "info",
            "Not trusted: project model defaults and its own skills stay off. /trust changes that.",
        );

        return;
    }

    const where =
        choice === "trust-parent"
            ? `${shortPath(info.parent, server?.home)} and the folders in it`
            : "this project";
    const skills =
        info.skills.length > 0 ? ` Pi has its skills from now on: ${skillNames(info.skills)}.` : "";

    const defaults = info.settings
        ? " Project model defaults apply only to later new sessions; this session will not change."
        : "";

    notify("info", `Trusted ${where}.${skills}${defaults}`);
}

/** The sessions whose project this tab told who is in charge about: once each. The server keeps one request for all. */
const toldOf = new Set();

/**
 * Above the message box: this project's skills or settings wait for a trust decision. Who is in charge of the session's
 * computer is asked; anyone else who prompts here sees that it waits for them.
 */
export function TrustBar() {
    const { conversationId, trustRequests } = store.state;
    const cwd = store.state.view.agent?.cwd;
    const mine = trustAvailable();
    const reads = mine || canSteer();
    const first = useRef(true);

    useEffect(() => {
        if (reads) {
            loadTrust();
        }
    }, [conversationId, cwd, reads]);
    // A project was asked about, decided, or put away: what this session's project waits for may be different now.
    useEffect(() => {
        if (first.current) {
            first.current = false;
        } else if (reads) {
            loadTrust({ force: true });
        }
    }, [trustRequests]);
    const info = currentTrust();
    const wait = mine ? null : trustWait();
    const tell = !mine && canSteer() && wait?.waiting === true && !wait.asked;

    useEffect(() => {
        const key = `${conversationId}\n${cwd}`;

        if (tell && !toldOf.has(key)) {
            toldOf.add(key);
            // Its `trust-requests` event brings the answer to every tab, this one too.
            actions.askTrust().catch(() => {});
        }
    }, [tell, conversationId, cwd]);

    if (!mine) {
        if (!canSteer() || !wait?.waiting || later().has(cwd)) {
            return null;
        }

        return html`<div class="trust-bar" data-part="trust-wait">
            <span class="grow">
                <strong>Waiting for ${wait.by} to trust this project.</strong>${" "}Until then, its own
                skills and model defaults stay off.
            </span>
            <span class="trust-actions">
                <button
                    class="icon-button"
                    aria-label="Hide"
                    title="Hide: shown again in a new tab"
                    onClick=${() => putOff(cwd)}
                >
                    <${Icon} name="close" size=${13} />
                </button>
            </span>
        </div>`;
    }

    if (!info?.ask || later().has(info.folder)) {
        return null;
    }

    return html`<div class="trust-bar">
        <span class="grow">
            <strong>Trust this project?</strong>${" "}${
                info.settings
                    ? `Its .pi/settings.json can set the model and thinking level of later new sessions. This session will not change.${info.skills.length > 0 ? ` Its skills in .agents/skills (${skillNames(info.skills)}) also need trust.` : ""}`
                    : `Its skills in .agents/skills (${skillNames(info.skills)}) load only in a project Pi trusts.`
            }
        </span>
        <span class="trust-actions">
            <button class="link small" onClick=${() => attempt(() => decide("distrust"))}>
                Don't trust
            </button>
            <button class="button small primary" onClick=${() => openSheet({ type: "trust" })}>
                Review
            </button>
            <button
                class="icon-button"
                aria-label="Not now"
                title="Not now: ask again in a new tab"
                onClick=${() => putOff(info.folder)}
            >
                <${Icon} name="close" size=${13} />
            </button>
        </span>
    </div>`;
}

/** An answer in the sheet: what it does, the folder it is about when that is not this one, and whether it is saved. */
function Choice({ label, detail, current, onClick }) {
    return html`<button class=${`list-item trust-choice ${current ? "active" : ""}`} onClick=${onClick}>
        <span class="trust-radio" aria-hidden="true"></span>
        <span class="trust-choice-text">
            <span>${label}</span>
            ${detail && html`<span class="muted small mono">${detail}</span>`}
        </span>
        ${current && html`<span class="trust-current">✓ current</span>`}
    </button>`;
}

/**
 * Whether Pi was told not to trust the project: a saved "no", or its setting for undecided projects. A trust store that
 * cannot be read decides nothing (as on the server, `skills.ts`), so the project's .pi/skills load.
 */
const distrusted = (info) =>
    !info.trusted &&
    !info.unreadable &&
    (info.saved?.trusted === false ||
        (info.saved === null && info.defaultProjectTrust === "never"));

/** What the project's own skills do here, a sentence for each place they are in. */
function ownSkillsText(info) {
    const list = (skills) => skillNames(skills, 8);
    const texts = [];

    if (info.skills.length > 0) {
        texts.push(
            `In .agents/skills: ${list(info.skills)}. ${info.trusted ? "Pi has them." : "They load once you trust it."}`,
        );
    }

    if (info.ownSkills.length > 0) {
        texts.push(
            `In .pi/skills: ${list(info.ownSkills)}. ${distrusted(info) ? "They stay off while it is not trusted." : "They load unless you choose Don't trust."}`,
        );
    }

    return texts.length > 0
        ? texts
        : [
              info.settings
                  ? "It has no skills of its own."
                  : "It has no skills of its own, so this changes nothing in Pi Pocket here.",
          ];
}

/** Where the decision comes from, in a sentence. */
function status(info, short) {
    if (info.unreadable) {
        return "Pi's trust store (~/.pi/agent/trust.json) cannot be read, so no project is trusted, and no answer can be saved until it is mended or deleted.";
    }

    if (info.saved === null) {
        if (info.defaultProjectTrust === "always") {
            return "Trusted: no decision is saved for it, and Pi's defaultProjectTrust setting trusts every project.";
        }

        if (info.defaultProjectTrust === "never") {
            return "Not trusted: no decision is saved for it, and Pi's defaultProjectTrust setting trusts no project.";
        }

        return info.skills.length > 0
            ? "No decision yet. Until there is one, Pi Pocket leaves its skills in .agents/skills off."
            : "No decision yet.";
    }

    const what = info.saved.trusted ? "Trusted" : "Not trusted";

    return info.saved.path === info.folder
        ? `${what}.`
        : `${what}, as the folder it is in: ${short(info.saved.path)}.`;
}

/** The project's trust, and the three answers Pi's `/trust` offers. */
export function TrustSheet() {
    const { server } = store.state;
    const short = (path) => shortPath(path, server?.home);

    useEffect(() => loadTrust({ force: true }), []);
    const info = currentTrust();
    const wait = trustWait();

    if (wait) {
        return html`<${Sheet} title="Project trust" onClose=${closeSheet}>
            <p>
                ${wait.by} is in charge of this computer, and decides which projects Pi trusts on it.
                ${wait.waiting ? ` This project waits for that: until then, its own skills and model defaults stay off.` : ""}
            </p>
        <//>`;
    }

    if (!info) {
        return html`<${Sheet} title="Project trust" onClose=${closeSheet}>
            <${Loader} label="Loading" />
        <//>`;
    }

    const choose = (choice) =>
        attempt(async () => {
            await decide(choice);
            closeSheet();
        });
    const saved = (path, trusted) => info.saved?.path === path && info.saved.trusted === trusted;

    return html`<${Sheet} title="Project trust" onClose=${closeSheet}>
        <p class="mono small">${short(info.folder)}</p>
        <p>${status(info, short)}</p>
        ${ownSkillsText(info).map((text) => html`<p>${text}</p>`)}
        ${
            info.settings &&
            html`<p>
                In .pi/settings.json: model and thinking defaults apply only to later new sessions, after trust. This session will not change. The server's Default model still wins; clear it in Menu → Default model to use project defaults. No project setting can grant trust to itself. Extra skill and prompt paths and per-project run policy are not supported yet.
            </p>`
        }
        <p class="muted small">
            Pi's CLI goes by the same decision, saved in ~/.pi/agent/trust.json. There, trusting a project also loads its .pi settings, extensions, and packages, which run code on this machine. Trust only folders whose contents you trust.
        </p>
        ${
            !trustAvailable()
                ? html`<p class="muted small">
                      Only who is in charge of this computer can change this.
                  </p>`
                : !info.unreadable &&
                  html`<div class="group">
                      <${Choice}
                          label="Trust this folder"
                          current=${saved(info.folder, true)}
                          onClick=${() => choose("trust")}
                      />
                      ${
                          info.parent &&
                          html`<${Choice}
                              label="Trust the folder above it"
                              detail=${short(info.parent)}
                              current=${saved(info.parent, true)}
                              onClick=${() => choose("trust-parent")}
                          />`
                      }
                      <${Choice}
                          label="Don't trust"
                          current=${saved(info.folder, false)}
                          onClick=${() => choose("distrust")}
                      />
                  </div>`
        }
    <//>`;
}
