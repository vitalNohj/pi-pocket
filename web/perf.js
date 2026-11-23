// Only the opt-in server serves this flag. No observers, marks, or buffer on the normal page.
export const webPerf =
    typeof document !== "undefined" &&
    document.querySelector?.('meta[name="pocket-perf"][content="1"]')
        ? start()
        : undefined;

function start() {
    const marks = [];
    let serial = 0;
    let session = null;
    let sheet = null;

    const mark = (name, sample, fields = {}) => {
        const key = `pocket.${name}`;

        performance.clearMarks(key);
        const { startTime: t } = performance.mark(key);

        marks.push({ name, id: sample.id, t, ms: t - (sample.t ?? t), ...fields });

        if (marks.length > 256) {
            marks.shift();
        }

        return t;
    };

    const sample = (name, fields) => {
        const item = { id: ++serial };

        item.t = mark(name, item, fields);

        return item;
    };

    // The second callback is an upper bound for presentation: the browser had a paint opportunity in between.
    const painted = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

    window.__pocketPerf = {
        marks,
        timeOrigin: performance.timeOrigin,
        reset() {
            marks.length = 0;
        },
    };

    return {
        navigate(conversation, from, via) {
            session =
                conversation == null
                    ? null
                    : {
                          ...sample("session.start", { conversation, from, via }),
                          conversation,
                          pending: new Set(),
                      };
        },
        received(conversation) {
            if (session?.conversation === conversation && !session.received) {
                session.received = true;
                mark("session.view", session, { conversation });
            }
        },
        transcript(view, rows, unloaded, synced) {
            const visit = session;
            const conversation = view.conversation?.id;

            if (visit === null || visit.conversation !== conversation) {
                return;
            }

            const record = (step) => {
                if (visit.pending.has(step)) {
                    return;
                }

                visit.pending.add(step);
                const dom = performance.now();

                painted(() => {
                    if (session === visit) {
                        mark(`session.${step}`, visit, {
                            conversation,
                            rows,
                            entries: view.entries.size,
                            unloaded,
                            synced,
                            dom,
                        });
                    }
                });
            };

            if (rows > 0) {
                record("rows");
            }

            if (
                (!visit.pending.has("tail") || !visit.pending.has("history")) &&
                !Array.from(view.entries.values()).some((entry) => entry.partial)
            ) {
                record("tail");

                if (unloaded === 0) {
                    record("history");
                }
            }
        },
        sheet(next) {
            const type = next?.type;

            sheet =
                type === "fork" || type === "cwd"
                    ? {
                          ...sample(`${type}.open`, { conversation: next.id, runner: next.runner }),
                          type,
                      }
                    : null;
        },
        forkRows({ loaded, folder, worktree }) {
            const opening = sheet;

            if (opening?.type !== "fork" || opening.rows || !loaded) {
                return;
            }

            const seen = (opening.seen ??= new Set());
            const ready = [
                "computer",
                "model",
                ...(folder ? ["folder"] : []),
                ...(worktree ? ["worktree"] : []),
            ];
            const newRows = ready.filter((each) => !seen.has(each));

            for (const row of newRows) {
                seen.add(row);
            }

            if (newRows.length > 0) {
                const dom = performance.now();
                const all = (opening.rows = seen.size === 4);

                painted(() => {
                    if (sheet !== opening) {
                        return;
                    }

                    for (const row of newRows) {
                        mark(`fork.${row}`, opening, { dom });
                    }

                    if (all) {
                        mark("fork.rows", opening, { dom });
                    }
                });
            }
        },
        folderRequest(runner) {
            if (sheet?.type !== "cwd") {
                return undefined;
            }

            const opening = sheet;
            const load = sample("cwd.request", { runner, opening: opening.id });
            const first = !opening.list;

            return (dirs, current) => {
                const dom = performance.now();

                painted(() => {
                    if (sheet === opening && current()) {
                        mark("cwd.list", load, { runner, dirs, dom, opening: opening.id });

                        if (first && !opening.list) {
                            opening.list = true;
                            mark("cwd.first-list", opening, { runner, dirs, dom });
                        }
                    }
                });
            };
        },
    };
}
