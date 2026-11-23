// The work maps' shared model and parts (`web/branch-board.js` shows them). The map's data comes from the board in a
// message, already narrowed to what the person picked; a map opened on its own asks the server for all of it.
(function () {
    "use strict";

    let D, T0, H, HOME;
    const MON = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
    ];
    const SVGNS = "http://www.w3.org/2000/svg";

    const esc = (s) =>
        String(s == null ? "" : s).replace(
            /[&<>"']/g,
            (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
        );

    const home = (p) => {
        const x = String(p);

        return HOME && (x === HOME || x.startsWith(HOME + "/")) ? "~" + x.slice(HOME.length) : x;
    };

    const date = (h) => new Date(T0 + h * 36e5);

    const fmt = (h) => {
        const d = date(h);

        return (
            MON[d.getMonth()] +
            " " +
            d.getDate() +
            ", " +
            String(d.getHours()).padStart(2, "0") +
            ":00"
        );
    };

    const fmtDay = (h) => {
        const d = date(h);

        return MON[d.getMonth()] + " " + d.getDate();
    };

    const ago = (h) => {
        if (h == null) {
            return "never";
        }

        const x = H - h;

        return x < 1 ? "just now" : x < 48 ? Math.round(x) + "h ago" : Math.round(x / 24) + "d ago";
    };

    const svg = (tag, attrs = {}, parent) => {
        const n = document.createElementNS(SVGNS, tag);

        for (const k in attrs) {
            if (attrs[k] != null) {
                n.setAttribute(k, attrs[k]);
            }
        }

        if (parent) {
            parent.appendChild(n);
        }

        return n;
    };

    const h = (html) => {
        const t = document.createElement("template");

        t.innerHTML = html.trim();

        return t.content.firstElementChild;
    };

    const REPO_HUE = [
        205, 145, 35, 280, 330, 175, 15, 250, 95, 55, 310, 190, 0, 120, 230, 160, 265,
    ];
    const KIND = {
        firstmate: {
            label: "Firstmate (this main session)",
            short: "Firstmate",
            hue: 43,
            order: 0,
        },
        supervision: { label: "Firstmate supervision", short: "Supervision", hue: 22, order: 1 },
        worker: {
            label: "Fleet worker (started by Firstmate)",
            short: "Worker",
            hue: 205,
            order: 2,
        },
        chat: { label: "Your own chat", short: "Your chat", hue: 300, order: 3 },
        fork: { label: "Fork of one of your chats", short: "Fork", hue: 160, order: 4 },
        linked: { label: "Started by another session", short: "Linked", hue: 120, order: 5 },
    };
    let repos, wts, wtById, sessions, sById, links, sharedWts, idleWts, emptyIdle, picked;

    function build(data) {
        D = data;
        T0 = Date.parse(D.windowStart);
        H = D.hours;
        HOME = D.home || "";
        picked = new Set(D.picked || []);
        const hre = HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Two repositories of one name are told apart by where they are.
        const names = {};

        for (const r of D.repos) {
            names[r.name] = (names[r.name] || 0) + 1;
        }

        repos = D.repos.map((r, i) => ({
            ...r,
            label:
                r.main === D.appRoot
                    ? r.name + " · this server"
                    : names[r.name] > 1
                      ? r.name + " · " + home(r.main).split("/").slice(-2, -1)[0]
                      : r.name,
            color: `hsl(${REPO_HUE[(r.hue ?? i) % REPO_HUE.length]} 70% 62%)`,
            idx: i,
        }));

        // ---------- worktrees ----------
        const LOC = [
            [
                new RegExp("^" + hre + "/\\.treehouse/"),
                "treehouse",
                "Fleet worker slot (~/.treehouse)",
            ],
            [
                new RegExp("^" + hre + "/\\.pi-pocket/worktrees/"),
                "pocket",
                "Made by Pi Pocket (~/.pi-pocket/worktrees)",
            ],
            [/^\/tmp\//, "tmp", "Temporary (/tmp)"],
            [new RegExp("^" + hre + "/\\.cache/"), "cache", "Cache (~/.cache)"],
            [
                new RegExp("^" + hre + "/firstmate/data/"),
                "data",
                "Firstmate scratch (firstmate/data)",
            ],
            [new RegExp("^" + hre + "/[^/]+$"), "sibling", "Next to the main copy (~/…)"],
        ];

        wts = [];
        wtById = {};

        for (const r of repos) {
            r.wts = [];

            for (const w0 of r.worktrees) {
                const w = {
                    ...w0,
                    repo: r,
                    sessions: [],
                    r: 0,
                    w: 0,
                    last: null,
                    first: null,
                    writers: 0,
                };

                if (w.isMain) {
                    ((w.loc = "main"), (w.locLabel = "Main copy"));
                } else {
                    const m = LOC.find(([re]) => re.test(w.id));

                    w.loc = m ? m[1] : "other";
                    w.locLabel = m ? m[2] : "Elsewhere";
                }

                const seg = w.id.split("/");

                w.folder =
                    w.loc === "treehouse"
                        ? "treehouse slot " + seg[seg.length - 2]
                        : w.isMain
                          ? home(w.id)
                          : seg[seg.length - 1];
                w.locShort =
                    w.loc === "treehouse"
                        ? "slot " + seg[seg.length - 2]
                        : w.loc === "main"
                          ? "main copy"
                          : w.loc === "sibling"
                            ? "~/" + seg[seg.length - 1]
                            : w.loc === "tmp"
                              ? "/tmp/" + seg[seg.length - 1]
                              : w.loc === "pocket"
                                ? "pocket-made"
                                : w.loc === "cache"
                                  ? "~/.cache"
                                  : w.loc === "data"
                                    ? "fm scratch"
                                    : "elsewhere";
                w.name = w.isMain ? w.branch || "main" : w.branch || "detached " + w.head;
                w.short = w.isMain
                    ? w.name
                    : w.branch
                      ? w.branch.replace(/^(feat|fix|fm|perf|merge|upstream|drill|prototype)\//, "")
                      : w.folder;
                wts.push(w);
                wtById[w.id] = w;
                r.wts.push(w);
            }
        }

        // ---------- sessions ----------
        sessions = D.sessions.map((s) => ({
            ...s,
            label: s.title.replace(/^fm-(fm-)?/, ""),
            wts: [],
            r: 0,
            w: 0,
        }));
        const initials = (s) =>
            s.kind === "firstmate"
                ? "FM"
                : s.kind === "supervision"
                  ? "SV"
                  : (
                        s.label
                            .split(/[-\s·_]+/)
                            .filter(
                                (x) =>
                                    /^[A-Za-z0-9]/.test(x) &&
                                    !/^(for|the|and|of|a|to|in|on|pi|pp|fm|clb)$/i.test(x),
                            )
                            .slice(0, 2)
                            .map((x) => x[0])
                            .join("") || s.label.slice(0, 2)
                    ).toUpperCase();

        for (const s of sessions) {
            s.ini = initials(s);
        }

        sById = {};
        sessions.sort(
            (a, b) =>
                (KIND[a.kind] || KIND.chat).order - (KIND[b.kind] || KIND.chat).order ||
                a.created - b.created,
        );
        const perKind = {};

        for (const s of sessions) {
            const k = KIND[s.kind] || KIND.chat,
                i = (perKind[s.kind] = (perKind[s.kind] || 0) + 1);
            const spread =
                s.kind === "worker"
                    ? [185, 245]
                    : s.kind === "chat"
                      ? [268, 340]
                      : s.kind === "fork"
                        ? [140, 175]
                        : s.kind === "linked"
                          ? [95, 135]
                          : [k.hue, k.hue];
            const n = sessions.filter((x) => x.kind === s.kind).length;
            const hue =
                spread[0] + ((spread[1] - spread[0]) * ((i * 7) % Math.max(n, 1))) / Math.max(n, 1);

            s.color = `hsl(${hue.toFixed(0)} ${s.kind === "firstmate" || s.kind === "supervision" ? 85 : 72}% ${58 + (i % 3) * 6}%)`;
            s.kindLabel = k.label;
            s.kindShort = k.short;
            sById[s.id] = s;
        }

        links = [];

        for (const s of sessions) {
            for (const t of s.touches) {
                const w = wtById[t.wt];

                if (!w) {
                    continue;
                }

                const L = {
                    s,
                    w,
                    r: t.r,
                    w_: t.w,
                    n: t.r + t.w,
                    h: t.h,
                    first: t.h.length ? t.h[0][0] : null,
                    last: t.h.length ? t.h[t.h.length - 1][0] : null,
                };

                links.push(L);
                s.wts.push(L);
                w.sessions.push(L);
                s.r += t.r;
                s.w += t.w;
                w.r += t.r;
                w.w += t.w;

                if (t.w > 0) {
                    w.writers++;
                }

                if (L.last != null && (w.last == null || L.last > w.last)) {
                    w.last = L.last;
                }

                if (L.first != null && (w.first == null || L.first < w.first)) {
                    w.first = L.first;
                }
            }

            s.wts.sort((a, b) => b.n - a.n);
        }

        for (const w of wts) {
            w.sessions.sort((a, b) => b.w_ - a.w_ || b.n - a.n);
        }

        for (const r of repos) {
            r.touched = r.wts.filter((w) => w.sessions.length).length;
            r.main = r.wts.find((w) => w.isMain) || r.wts[0];
        }

        sharedWts = wts.filter((w) => w.writers > 1);
        idleWts = wts.filter((w) => !w.isMain && !w.sessions.length);
        emptyIdle = idleWts.filter((w) => w.ahead === 0 && !w.dirty);
    }

    // ---------- health flags ----------
    function flags(w) {
        const f = [];

        if (w.isMain) {
            f.push(["main copy", "good"]);
        }

        if (w.repo.main === D.appRoot && w.isMain) {
            f.push(["running server", "info"]);
        }

        if (w.writers > 1) {
            f.push([w.writers + " sessions wrote here", "bad"]);
        }

        if (w.dirty) {
            f.push([w.dirty + " uncommitted file" + (w.dirty > 1 ? "s" : ""), "warn"]);
        }

        if (!w.exists) {
            f.push(["folder is gone", "bad"]);
        }

        if (w.prunable) {
            f.push(["git says prunable", "warn"]);
        }

        if (!w.isMain && w.ahead === 0 && w.behind > 0 && !w.dirty) {
            f.push(["nothing of its own", "warn"]);
        }

        if (!w.isMain && w.behind >= 200) {
            f.push([w.behind + " behind main", "warn"]);
        }

        if (w.task) {
            f.push(["fleet task " + w.task, "info"]);
        }

        if (!w.sessions.length && !w.isMain) {
            f.push(["no session in 14 days", ""]);
        }

        return f;
    }

    // ---------- spark ----------
    function spark(hours, { color = "#58a6ff", commits = [], height = 34 } = {}) {
        const W = 340,
            bins = Math.ceil(H / 6),
            bw = W / bins,
            R = new Array(bins).fill(0),
            Wr = new Array(bins).fill(0);

        for (const [hr, r, w] of hours) {
            const b = Math.min(bins - 1, Math.max(0, Math.floor(hr / 6)));

            R[b] += r;
            Wr[b] += w;
        }

        const mx = Math.max(1, ...R.map((x, i) => x + Wr[i]));
        let s = `<svg class="spark" viewBox="0 0 ${W} ${height}" preserveAspectRatio="none">`;

        for (let d = 0; d <= H; d += 24) {
            s += `<line x1="${(d / H) * W}" x2="${(d / H) * W}" y1="0" y2="${height}" stroke="#ffffff10"/>`;
        }

        for (const c of commits) {
            if (c >= 0) {
                s += `<line x1="${(c / H) * W}" x2="${(c / H) * W}" y1="${height - 5}" y2="${height}" stroke="#3fb950"/>`;
            }
        }

        for (let i = 0; i < bins; i++) {
            const tot = R[i] + Wr[i];

            if (!tot) {
                continue;
            }

            const ht = Math.max(2, Math.sqrt(tot / mx) * (height - 7)),
                hw = Wr[i] ? Math.max(1.5, (ht * Wr[i]) / tot) : 0;

            s += `<rect x="${i * bw}" y="${height - 6 - ht}" width="${Math.max(1, bw - 0.6)}" height="${ht - hw}" fill="${color}" opacity=".45"/>`;

            if (hw) {
                s += `<rect x="${i * bw}" y="${height - 6 - hw}" width="${Math.max(1, bw - 0.6)}" height="${hw}" fill="${color}"/>`;
            }
        }

        return (
            s +
            `</svg><div class="kv" style="display:flex;justify-content:space-between;font-size:10.5px"><span>${fmtDay(0)}</span><span>faded = read · solid = wrote${commits.length ? " · green = main commit" : ""}</span><span>now</span></div>`
        );
    }

    // ---------- sheet ----------
    let sheet,
        sheetBody,
        onSelect = () => {};

    function ensureSheet() {
        if (sheet) {
            return;
        }

        sheet = h(
            `<div class="sheet" role="dialog" aria-modal="false"><button class="x" aria-label="Close">×</button><div class="body"></div></div>`,
        );
        sheetBody = sheet.querySelector(".body");
        document.body.appendChild(sheet);

        sheet.querySelector(".x").onclick = () => {
            closeSheet();
            onSelect(null);
        };

        sheet.addEventListener("click", (e) => {
            const act = e.target.closest("[data-act]");

            if (act) {
                e.preventDefault();
                e.stopPropagation();
                tell({
                    type: "work-map-" + act.dataset.act,
                    kind: act.dataset.kind,
                    id: act.dataset.id,
                });

                return;
            }

            const a = e.target.closest("[data-wt],[data-s]");

            if (!a) {
                return;
            }

            if (a.dataset.wt) {
                showWt(wtById[a.dataset.wt]);
                onSelect({ wt: wtById[a.dataset.wt] });
            } else {
                showSession(sById[a.dataset.s]);
                onSelect({ s: sById[a.dataset.s] });
            }
        });
    }

    /** What the map tells the board: a session to open, or a session or folder to add to or take off the map. */
    function tell(message) {
        if (window.parent !== window) {
            window.parent.postMessage(message, "*");
        }
    }

    const embedded = () => window.parent !== window;

    function actions(kind, id) {
        if (!embedded()) {
            return "";
        }

        const on = picked.has(kind + ":" + id);

        return `<div class="acts"><button class="act" data-act="${on ? "remove" : "add"}" data-kind="${kind}" data-id="${esc(id)}">${on ? "Take off the map" : "Add to the map"}</button>${kind === "s" ? `<button class="act" data-act="open" data-kind="s" data-id="${esc(id)}">Open session</button>` : ""}</div>`;
    }

    function openSheet(html) {
        ensureSheet();
        sheetBody.innerHTML = html;
        sheet.classList.add("open");
        sheet.scrollTop = 0;
    }

    function closeSheet() {
        if (sheet) {
            sheet.classList.remove("open");
        }
    }

    function flagHtml(w) {
        return `<div class="flags">${flags(w)
            .map(([t, c]) => `<span class="flag ${c}">${esc(t)}</span>`)
            .join("")}</div>`;
    }

    function showWt(w) {
        const hours = {};

        for (const L of w.sessions) {
            for (const [hr, r, x] of L.h) {
                const b = hours[hr] || (hours[hr] = [hr, 0, 0]);

                b[1] += r;
                b[2] += x;
            }
        }

        openSheet(`
    <div class="kicker"><span class="dot" style="background:${w.repo.color}"></span>${esc(w.repo.label)} · ${esc(w.locLabel)}</div>
    <h2>${esc(w.name)}</h2>
    ${actions("w", w.id)}
    <div class="kv">Folder <code>${esc(home(w.id))}</code></div>
    <div class="kv">Last commit <b>${esc(w.head)}</b> ${esc(w.subject)}${w.headTime != null ? ` · ${ago(w.headTime)}` : ""}</div>
    ${
        w.isMain
            ? `<div class="kv"><b>${w.repo.commits.filter((c) => c >= 0).length}</b> commits landed on <b>${esc(w.repo.base)}</b> in 14 days</div>`
            : `<div class="kv"><b>${w.ahead}</b> commits of its own · <b>${w.behind}</b> behind ${esc(w.repo.base)}${w.fork != null ? ` · split off ${w.fork < 0 ? Math.round(-w.fork / 24) + "d before this window" : fmt(w.fork)}` : ""}</div>`
    }
    ${w.pr ? `<div class="kv">Pull request <a href="${esc(w.pr)}" target="_blank" rel="noopener">${esc(w.pr.replace("https://github.com/", ""))}</a></div>` : ""}
    ${flagHtml(w)}
    ${w.writers > 1 ? `<div class="collide">${w.writers} different sessions changed files here. If they ran at the same time, they could overwrite each other's work.</div>` : ""}
    <h3>Activity, last 14 days</h3>${spark(Object.values(hours), { color: w.repo.color, commits: w.isMain ? w.repo.commits : w.commits })}
    <h3>${w.sessions.length} session${w.sessions.length === 1 ? "" : "s"} touched it</h3>
    <ul class="list">${w.sessions.map((L) => `<li data-s="${L.s.id}"><span class="dot" style="background:${L.s.color}"></span><div class="m"><div class="t">${esc(L.s.title)}</div><small>${esc(L.s.kindShort)} · ${L.w_ ? `<b style="color:#e3b341">wrote ${L.w_}×</b>, ` : ""}read ${L.r}× · last ${ago(L.last)}</small></div></li>`).join("") || `<li style="cursor:default"><div class="m"><small>No session touched this folder in the last 14 days.</small></div></li>`}</ul>`);
    }

    function showSession(s) {
        const hours = {};

        for (const L of s.wts) {
            for (const [hr, r, x] of L.h) {
                const b = hours[hr] || (hours[hr] = [hr, 0, 0]);

                b[1] += r;
                b[2] += x;
            }
        }

        const parent = s.parent && sById[s.parent];

        openSheet(`
    <div class="kicker"><span class="dot" style="background:${s.color}"></span>${esc(s.kindLabel)}${s.archived ? " · archived" : ""}</div>
    <h2>${esc(s.title)}</h2>
    ${actions("s", s.id)}
    <div class="kv">Started in <code>${esc(home(s.cwd))}</code></div>
    <div class="kv">${s.created >= 0 ? "Created " + fmt(s.created) + " · " : ""}last active ${ago(s.updated)} · <b>${s.calls}</b> tool calls</div>
    ${parent ? `<div class="kv">Started from <a href="#" data-s="${parent.id}">${esc(parent.title)}</a></div>` : s.parent ? `<div class="kv">Started from session ${s.parent}</div>` : ""}
    <h3>Activity, last 14 days</h3>${spark(Object.values(hours), { color: s.color })}
    <h3>Touched ${s.wts.length} folder${s.wts.length === 1 ? "" : "s"}</h3>
    <ul class="list">${s.wts.map((L) => `<li data-wt="${esc(L.w.id)}"><span class="dot" style="background:${L.w.repo.color}"></span><div class="m"><div class="t">${esc(L.w.name)} <span class="repo-badge">${esc(L.w.repo.label)}</span></div><small>${esc(home(L.w.id))}</small><small>${L.w_ ? `<b style="color:#e3b341">wrote ${L.w_}×</b>, ` : ""}read ${L.r}× · ${ago(L.last)}${L.w.writers > 1 && L.w_ ? ` · <span style="color:#ff9b93">shared with ${L.w.writers - 1} other writer${L.w.writers > 2 ? "s" : ""}</span>` : ""}</small></div></li>`).join("")}</ul>`);
    }

    // ---------- page chrome ----------
    /**
     * One slim row of controls, with the how-to-read text and the key folded behind an info button.
     * Returns the row, the box to put the controls in, and a line in the fold that a page can fill.
     */
    function toolbar({ about, legend }) {
        const touched = wts.filter((w) => w.sessions.length).length;
        const el = h(`<div class="head"><div class="tools"><div class="ctl"></div>
  <button class="info" aria-expanded="false" aria-label="How to read this map" title="How to read this map">?</button></div>
  <div class="about" hidden><p>${about}</p><div class="legend">${legend}</div><p class="live"></p>
  <p class="stats">${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${touched} of ${wts.length} folders touched · ${repos.length} repo${repos.length === 1 ? "" : "s"} · ${fmtDay(0)} – ${fmtDay(H)}</p></div></div>`);
        const info = el.querySelector(".info"),
            fold = el.querySelector(".about");

        info.onclick = () => {
            fold.hidden = !fold.hidden;
            info.setAttribute("aria-expanded", String(!fold.hidden));
            info.classList.toggle("on", !fold.hidden);
            resize && resize();
        };

        return { el, ctl: el.querySelector(".ctl"), live: el.querySelector(".live") };
    }

    /** A small drop-down of the repos on the map; just the name when there is one. */
    function repoPicker(list, current, onPick, count = () => "") {
        if (list.length < 2) {
            const only = list[0];

            return h(
                `<span class="pick-one">${only ? `<span class="dot" style="background:${only.color}"></span>${esc(only.label)}` : ""}</span>`,
            );
        }

        const el = h(
            `<label class="pick"><span class="dot" style="background:${current.color}"></span><select aria-label="Repository">${list
                .map(
                    (r, i) =>
                        `<option value="${i}"${r === current ? " selected" : ""}>${esc(r.label)}${count(r) === "" ? "" : ` (${count(r)})`}</option>`,
                )
                .join("")}</select></label>`,
        );
        const select = el.querySelector("select");

        select.onchange = () => {
            const r = list[Number(select.value)];

            el.querySelector(".dot").style.background = r.color;
            onPick(r);
        };

        return el;
    }

    /** A row of choices where one is on. */
    function segmented(choices, current, onPick) {
        const el = h(`<div class="seg" role="group"></div>`);

        for (const [value, label] of choices) {
            const b = h(`<button aria-pressed="${value === current}">${esc(label)}</button>`);

            b.onclick = () => {
                el.querySelectorAll("button").forEach((x) =>
                    x.setAttribute("aria-pressed", String(x === b)),
                );
                onPick(value);
            };

            el.appendChild(b);
        }

        return el;
    }

    function legendSessions() {
        return `${Object.entries(KIND)
            .map(
                ([k, v]) =>
                    `<span><span class="dot" style="background:hsl(${k === "worker" ? 215 : k === "chat" ? 300 : k === "fork" ? 160 : k === "linked" ? 115 : v.hue} 75% 62%)"></span>${esc(v.short)}</span>`,
            )
            .join("")}`;
    }

    let page = null,
        resize = null,
        latest = null;

    function run() {
        if (!page || !latest) {
            return;
        }

        sheet = null;
        resize = null;

        onSelect = () => {};

        document.body.innerHTML = `<div class="loading" id="loading"></div>`;

        try {
            build(latest);
            Object.assign(window.WT, exported());
            page();
        } catch (e) {
            showError((e && e.stack) || String(e));
        }
    }

    function guard(fn) {
        page = fn;
        window.addEventListener("error", (e) => showError(e.message || String(e)));
        window.addEventListener("unhandledrejection", (e) => showError(String(e.reason)));
        run();
    }

    let rt;

    window.addEventListener("resize", () => {
        clearTimeout(rt);
        rt = setTimeout(() => resize && resize(), 150);
    });
    window.addEventListener("message", (e) => {
        if (e.source !== window.parent || !e.data || e.data.type !== "work-map") {
            return;
        }

        latest = e.data.map;
        run();
    });

    // Opened on its own: the whole map, from the server.
    if (!embedded()) {
        fetch("/api/work-map", { credentials: "same-origin" })
            .then((r) =>
                r.ok
                    ? r.json()
                    : r.text().then((t) => {
                          throw new Error(t || r.statusText);
                      }),
            )
            .then(
                (m) => {
                    latest = m;
                    run();
                },
                (e) => {
                    document.body.innerHTML = "";
                    showError(e.message);
                },
            );
    } else {
        tell({ type: "work-map-ready" });
    }

    function showError(m) {
        const box =
            document.getElementById("err") ||
            document.body.appendChild(h(`<div id="err" class="err"></div>`));

        box.textContent = "Something went wrong: " + m;
    }

    const exported = () => ({
        D,
        H,
        T0,
        repos,
        wts,
        wtById,
        sessions,
        sById,
        links,
        sharedWts,
        idleWts,
        emptyIdle,
    });

    window.WT = {
        esc,
        home,
        fmt,
        fmtDay,
        ago,
        svg,
        h,
        KIND,
        flags,
        showWt,
        showSession,
        closeSheet,
        setOnSelect: (f) => {
            onSelect = f;
        },
        onResize: (f) => {
            resize = f;
        },
        toolbar,
        repoPicker,
        segmented,
        legendSessions,
        guard,
        spark,
    };
})();
