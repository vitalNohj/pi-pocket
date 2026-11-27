// Compiled into both hosts. The adapter supplies the origin, fixed menu items and the native transport.
((config, transport) => {
    const { basePath } = config;
    const path = location.pathname;
    const page =
        path === (basePath || "/") ||
        (path.startsWith(`${basePath}/`) &&
            /^(?:\/|\/s\/[1-9]\d*)$/.test(path.slice(basePath.length)));

    if (
        window.top !== window ||
        window.origin !== config.origin ||
        location.origin !== config.origin ||
        !["http:", "https:"].includes(location.protocol) ||
        !page
    ) {
        return;
    }

    const legacyEvents = ["visibility", "open", "approve"];
    let key = null;
    let listener = null;
    let events = [];
    let shown = false;
    let primary = false;
    let active = null;
    let auth = 0;
    let pins;
    let badge;

    const post = (type, body = {}) => {
        if (key !== null && listener !== null) {
            transport.send({ type, key, auth, ...body });
        }
    };

    const modern = () => events.includes("primary");
    const feed = () => primary && (!modern() || active === true);

    const snapshot = () => {
        if (feed()) {
            if (badge !== undefined) {
                post("badge", { count: badge });
            }

            if (pins !== undefined) {
                post("pinned", { pins });
            }
        }
    };

    const hello = () => {
        post("subscribe", { events });

        if (active !== null) {
            post("account", { active });
        }
    };

    const emit = (event) => {
        if (events.includes(event.type)) {
            listener?.(event);
        }
    };

    transport.listen((data) => {
        if (data?.type === "bind" && typeof data.key === "string") {
            // Only a committed top-level document gets a lease. A restored document may get a new one.
            key = data.key;
            shown = data.visible === true;
            primary = false;
            hello();
            emit({ type: "visibility" });
            emit({ type: "primary" });

            return;
        }

        if (!data || key === null || data.key !== key) {
            return;
        }

        if (data.type === "visibility") {
            shown = data.visible === true;
            emit({ type: "visibility" });
        } else if (data.type === "primary" && primary !== data.primary) {
            primary = data.primary === true;
            snapshot();
            emit({ type: "primary" });
        } else if (data.auth === auth && (!modern() || active === true)) {
            // Do not pass the lease or account epoch to page listeners.
            if (data.type === "newSession") {
                emit({ type: "newSession" });
            } else if (data.type === "open") {
                emit({ type: "open", url: data.url });
            } else if (data.type === "approve" && primary && modern()) {
                emit({ type: "approve", id: data.id, allow: data.allow });
            }
        }
    });

    const items = config.items.map((item) => Object.freeze(item));

    Object.defineProperty(window, "pocketHost", {
        value: Object.freeze({
            kind: config.kind,
            apiVersion: 1,
            capabilities: Object.freeze([
                "menu",
                "visibility",
                "badge",
                "notify",
                "pinned",
                "open",
                "newSession",
                "sessionFeed",
            ]),
            menuTitle: () => "Pi Pocket Desktop",
            menuItems: () => items.slice(),
            invoke(id) {
                if (!key || !listener || !items.some((item) => item.id === id)) {
                    return false;
                }

                post("action", { id });

                return true;
            },
            visible: () => shown,
            primary: () => primary,
            setAccount(value) {
                if (typeof value !== "boolean" || value === active) {
                    return;
                }

                active = value;
                auth++;
                pins = undefined;
                badge = undefined;
                post("account", { active });
            },
            setBadge(count) {
                if (Number.isSafeInteger(count) && count >= 0 && (!modern() || active)) {
                    badge = Math.min(count, 2147483647);

                    if (feed()) {
                        post("badge", { count: badge });
                    }
                }
            },
            setPinned(list) {
                if (Array.isArray(list) && (!modern() || active)) {
                    pins = list.slice(0, 20).map((pin) => ({
                        id: pin?.id,
                        title: String(pin?.title ?? "").slice(0, 240),
                        state: String(pin?.state ?? "").slice(0, 12),
                        label: String(pin?.label ?? "").slice(0, 120),
                    }));

                    if (feed()) {
                        post("pinned", { pins });
                    }
                }
            },
            notify(message) {
                if (!feed()) {
                    return;
                }

                const notice = {
                    title: String(message?.title ?? "Pi Pocket").slice(0, 200),
                    body: String(message?.body ?? "").slice(0, 400),
                    tag: String(message?.tag ?? "").slice(0, 200),
                    url: String(message?.url ?? "/").slice(0, 100),
                    stamp: String(message?.stamp ?? "").slice(0, 80),
                };
                const approval = message?.approval;

                if (approval) {
                    // Never make a shortened call look like one that fit the display budget.
                    notice.approval = {
                        id: String(approval.id ?? "").slice(0, 200),
                        call: String(approval.call ?? "").slice(0, 8192),
                        cut: String(approval.call ?? "").length > 8192,
                        may: approval.may === true,
                    };
                }

                post("notify", { notice });
            },
            subscribe(next, supported) {
                if (typeof next !== "function" || listener !== null) {
                    return;
                }

                listener = next;
                events = (Array.isArray(supported) ? supported : legacyEvents).filter((event) =>
                    [...legacyEvents, "newSession", "primary"].includes(event),
                );
                hello();
            },
        }),
    });
})(/* POCKET_BRIDGE_ARGUMENTS */);
