/**
 * The rights a person is given one at a time, beyond what their role gives them. Each is declared here once. The
 * settings file keeps them in one shape (`config.ts` `User.rights`, and a computer's `rights`); the access policy
 * answers for all of them with one check (`access.ts` `has`), and says who may give one (`offer`); one setter changes
 * them (`app.ts` `setRight`); and the app draws their switches from what is said here (`hello.server.rights`). A new
 * right is one entry here, and the code that asks for it.
 *
 * Data, and the rules read straight from it: this file imports nothing.
 */

/** What is said of one right. */
export type Right = {
    /**
     * `person`: held everywhere, and given by who manages that person. `computer`: held on one computer, and given by
     * who is in charge of it to someone chosen there.
     */
    scope: "person" | "computer";
    /** Only someone who is not limited to sessions holds it. A computer's right is always so. */
    whole?: true;
    /** Only the owner gives it. Absent: who manages the person does, and only what they hold themselves. */
    gives?: "owner";
    /** Who holds one of these rights has this one with it. */
    with?: readonly string[];
    /**
     * It is dropped from what is kept once its person can no longer hold it. Absent: it stays kept, and counts again
     * when they can. A pause (`config.ts` `User.paused`) keeps a right that lapses for when it ends.
     */
    lapses?: true;
    /** A person's page says it in the line under their name. */
    line?: true;
    /** Its switch: the name beside it. In small letters it ends "must be a user to …". */
    label: string;
    /** What the person does with it, after their name: a screen reader's name for its switch. */
    says: string;
    /** Under its switch while it is on. */
    on: string;
    /** Under its switch while it is off. Absent: `on`, which then reads the same in both. */
    off?: string;
    /** Under its switch while they have it with another right (`with`). */
    withHint?: string;
    /** Asked before it is turned on; `{name}` is the person. Absent: nothing is asked. */
    confirm?: string;
};

export const RIGHTS = {
    linksRunners: {
        scope: "person",
        whole: true,
        line: true,
        label: "Link runners",
        says: "links runners",
        on: "On: they link computers of their own as runners, which they are in charge of.",
    },
    invites: {
        scope: "person",
        whole: true,
        with: ["managesUsers"],
        label: "Invite people",
        says: "invites people",
        on: "On: they invite people, who join as viewers and see what the invite shares.",
        off: "Off: they do not invite people.",
        withHint:
            "On with Manage users: they invite people, who join as viewers and see what the invite shares.",
    },
    managesUsers: {
        scope: "person",
        whole: true,
        gives: "owner",
        lapses: true,
        line: true,
        label: "Manage users",
        says: "manages users",
        on: "On: they invite people, change what others may do, and remove them. They cannot change you, themselves, or others who manage users.",
        off: "Off: they do not manage users.",
        confirm:
            "Let {name} manage users? They can invite people, make viewers users, change what other people may do, remove them, and sign a device in as a viewer.",
    },
    managesRunners: {
        scope: "person",
        whole: true,
        gives: "owner",
        lapses: true,
        line: true,
        label: "Manage runners",
        says: "manages runners",
        on: "On: they are in charge of this server and the runners you linked, as you are. They can unlink any runner.",
        off: "Off: they are not in charge of this server or the runners you linked.",
        confirm:
            "Let {name} manage runners? They see and prompt every session on this server and on the runners you linked, in any folder, and choose who else may.",
    },
    managesServer: {
        scope: "person",
        whole: true,
        gives: "owner",
        lapses: true,
        line: true,
        label: "Manage server",
        says: "manages the server",
        on: "On: they change this server's settings: extensions, providers, models, themes, spend limits, and memory lessons, and restart it.",
        off: "Off: they do not change this server's settings.",
        confirm:
            "Let {name} manage the server? They can turn on extensions, which run code on it, add providers, which see every prompt, sign providers in and out, and restart it.",
    },
    keepsWarm: {
        scope: "person",
        label: "Keep sessions warm",
        says: "keeps sessions warm",
        on: "On: they turn keep warm on for a session and pick its time. Refreshes may be charged.",
        off: "Off: they can only turn keep warm off for a session.",
    },
    wheel: {
        scope: "computer",
        label: "Override take turns",
        says: "overrides take turns on",
        on: "On: they take the wheel from someone who is driving here, and turn take turns off.",
        off: "Off: they ask to drive, and wait for the wheel.",
    },
    allows: {
        scope: "computer",
        label: "Allow their own calls",
        says: "allows their own calls on",
        on: "On: they allow their own ! commands and calls that Lancet Guard asks about here.",
        off: "Off: whoever is in charge allows their ! commands. While Approvals need someone else is on, someone else allows their calls.",
    },
} as const satisfies Record<string, Right>;

export type RightKey = keyof typeof RIGHTS;

type Scoped<S extends Right["scope"]> = {
    [K in RightKey]: (typeof RIGHTS)[K]["scope"] extends S ? K : never;
}[RightKey];

/** A right held everywhere. */
export type PersonRight = Scoped<"person">;

/** A right held on one computer. */
export type ComputerRight = Scoped<"computer">;

const KEYS = Object.keys(RIGHTS) as RightKey[];

/** The rights of each scope, in the order their switches are shown. */
export const PERSON_RIGHTS: readonly PersonRight[] = KEYS.filter(
    (key): key is PersonRight => RIGHTS[key].scope === "person",
);

export const COMPUTER_RIGHTS: readonly ComputerRight[] = KEYS.filter(
    (key): key is ComputerRight => RIGHTS[key].scope === "computer",
);

/** What is said of right `key`. */
export function declared(key: RightKey): Right {
    return RIGHTS[key];
}

/** Is `value` the name of a right of scope `scope`. */
export function isRight<S extends Right["scope"]>(value: unknown, scope: S): value is Scoped<S> {
    return (
        typeof value === "string" &&
        Object.hasOwn(RIGHTS, value) &&
        RIGHTS[value as RightKey].scope === scope
    );
}

/** The rights that bring right `key` with them (`Right.with`). */
export function comesWith(key: PersonRight): readonly PersonRight[] {
    return (declared(key).with ?? []) as readonly PersonRight[];
}

/**
 * Can `person` hold person right `key` at all: a user, and for a right that takes the whole server, one who is not
 * limited to sessions. The owner needs none: they have them all (`access.ts` `has`).
 */
export function canHold(person: { role: string; sessions?: unknown }, key: PersonRight): boolean {
    return (
        person.role === "guest" && (declared(key).whole !== true || person.sessions === undefined)
    );
}

/**
 * Does `person` hold person right `key` now: the owner has them all; a user has one they were given, or one that
 * comes with another they hold (`Right.with`), while they can hold it at all (`canHold`).
 */
export function holds(
    person: { role: string; sessions?: unknown; rights?: readonly string[] },
    key: PersonRight,
): boolean {
    if (person.role === "owner") {
        return true;
    }

    return (
        canHold(person, key) &&
        (person.rights?.includes(key) === true ||
            comesWith(key).some((each) => holds(person, each)))
    );
}

/** What the app is told of a right, to draw its switch: its words, and none of its rules. */
export type ToldRight = Pick<
    Right,
    "scope" | "line" | "label" | "says" | "on" | "off" | "withHint" | "confirm"
> & { key: RightKey };

/** Every right as the app is told it, in the order their switches are shown. */
export function toldRights(): ToldRight[] {
    return KEYS.map((key) => {
        const { scope, line, label, says, on, off, withHint, confirm } = declared(key);

        return {
            key,
            scope,
            label,
            says,
            on,
            ...(line === undefined ? {} : { line }),
            ...(off === undefined ? {} : { off }),
            ...(withHint === undefined ? {} : { withHint }),
            ...(confirm === undefined ? {} : { confirm }),
        };
    });
}
