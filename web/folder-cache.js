// The folder picker's listings, kept in this tab's memory: a folder opened again shows at once from what was read
// before, while a fresh read replaces it (stale-while-revalidate); and folders the person is likely to open next (the
// parent, the first folders in the list, one the pointer is on) are read ahead, one at a time. The same for this server
// and a linked computer: `runner` is null for this server.
//
// Listings are each person's own (folders given to them, their recent folders): every entry belongs to the person who
// read it, and all of them go when the signed-in person, or what the server says of them, changes. Nothing is saved to
// the device; a sign-out reloads the page, which empties memory.

/** How long a listing can show before the fresh read comes. Older ones are read again first, with "Opening…". */
export const KEPT_MS = 10 * 60_000;
/** A listing read this recently is not read ahead again. */
export const FRESH_MS = 20_000;
/** The most listings kept: the oldest go first. */
export const MAX_KEPT = 400;
/** The first folders of a listing read ahead, after its parent. */
export const AHEAD_CHILDREN = 8;

/** The most reads ahead waiting: a pointer that crosses many rows asks for the last ones it was on. */
export const MAX_WAITING = 16;

const keyOf = (runner, path, hidden) => `${runner ?? ""}\n${hidden ? 1 : 0}\n${path}`;

/**
 * A cache of folder listings. `read(runner, path, hidden)` asks the server for one (a promise of the listing, or a
 * failure); `person()` is the signed-in person as the app knows them (an object kept while it does not change), whose
 * change empties the cache; `now()` the time.
 */
export function createFolderCache({ read, person, now = Date.now }) {
    /** key → { listing, at } */
    const kept = new Map();
    /** key → the read on its way: a click and a read ahead of the same folder share it. */
    const reading = new Map();
    /** Folders to read ahead, in order, as [runner, path, hidden]; one read ahead runs at a time, so a computer far
     * away gets no burst of reads in front of the one a click asks for. */
    let queue = [];
    let ahead = false;
    let owner = person();

    /** Drops everything when the person changes. */
    const check = () => {
        const current = person();

        if (current !== owner) {
            owner = current;
            kept.clear();
            reading.clear();
            queue = [];
        }
    };

    /** Keeps a listing; returns the one kept before when nothing changed, so the picker need not draw it again. */
    const put = (key, listing) => {
        const before = kept.get(key)?.listing;
        const same = before !== undefined && JSON.stringify(before) === JSON.stringify(listing);

        kept.delete(key);
        kept.set(key, { listing: same ? before : listing, at: now() });

        while (kept.size > MAX_KEPT) {
            kept.delete(kept.keys().next().value);
        }

        return same ? before : listing;
    };

    /** Reads a folder, or joins the read of it already on its way; keeps the answer under the path asked and its real one. */
    const fetchListing = (runner, path, hidden) => {
        check();

        const key = keyOf(runner, path, hidden);
        const going = reading.get(key);

        if (going) {
            return going;
        }

        const by = owner;
        let asked;

        // Asked now, not in a later task: a listing kept that shows meanwhile must not hold the request back.
        try {
            asked = Promise.resolve(read(runner, path, hidden));
        } catch (error) {
            asked = Promise.reject(error);
        }

        const promise = asked.then(
            (listing) => {
                if (reading.get(key) === promise) {
                    reading.delete(key);
                }

                // Read for someone else: not kept for the person signed in now.
                if (person() !== by) {
                    return listing;
                }

                const shown = put(key, listing);

                // Also under its real path: `~`, or a path typed, is a folder that is read again by its own path.
                if (
                    typeof listing?.path === "string" &&
                    listing.path !== "" &&
                    listing.path !== path
                ) {
                    kept.delete(keyOf(runner, listing.path, hidden));
                    kept.set(keyOf(runner, listing.path, hidden), {
                        listing: shown,
                        at: now(),
                    });
                }

                return shown;
            },
            (error) => {
                if (reading.get(key) === promise) {
                    reading.delete(key);
                }

                kept.delete(key);

                throw error;
            },
        );

        reading.set(key, promise);

        return promise;
    };

    const fresh = (runner, path, hidden) => {
        const key = keyOf(runner, path, hidden);
        const entry = kept.get(key);

        return reading.has(key) || (entry !== undefined && now() - entry.at < FRESH_MS);
    };

    const pump = () => {
        if (ahead) {
            return;
        }

        check();

        const next = queue.shift();

        if (next === undefined) {
            return;
        }

        if (fresh(...next)) {
            pump();

            return;
        }

        ahead = true;
        fetchListing(...next)
            .catch(() => {})
            .finally(() => {
                ahead = false;
                pump();
            });
    };

    return {
        /** The listing kept for a folder, if one is young enough to show while a fresh one is read. */
        cached(runner, path, hidden) {
            check();

            const entry = kept.get(keyOf(runner, path, hidden));

            return entry !== undefined && now() - entry.at < KEPT_MS ? entry.listing : undefined;
        },

        /** A fresh listing of a folder: joins a read ahead of it already on its way. */
        read: fetchListing,

        /**
         * Read these folders ahead, in order, instead of what was waiting: the folder shown changed. Each is
         * [runner, path]. A read ahead already on its way finishes, as the server does its work anyway, and is kept.
         */
        ahead(folders, hidden) {
            check();
            queue = folders
                .filter(([, path]) => typeof path === "string" && path !== "")
                .map(([runner, path]) => [runner ?? null, path, hidden]);
            pump();
        },

        /** Read this folder ahead before the others waiting: the pointer is on it. */
        soon(runner, path, hidden) {
            check();

            if (typeof path !== "string" || fresh(runner, path, hidden)) {
                return;
            }

            queue = [[runner, path, hidden], ...queue].slice(0, MAX_WAITING);
            pump();
        },

        /** Forget every listing. */
        clear() {
            kept.clear();
            reading.clear();
            queue = [];
        },

        /** How many listings are kept, how many reads ahead wait, and how many reads are on their way: for tests. */
        get size() {
            return { kept: kept.size, waiting: queue.length, reading: reading.size };
        },
    };
}
