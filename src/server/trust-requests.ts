/**
 * Projects that wait for a trust decision (`skills.ts` `ProjectTrust.ask`) in a session of someone who cannot give it.
 * Who is in charge of the session's computer decides which projects Pi trusts there (`access.ts` `inCharge`: the owner
 * here, a runner's linker there). Anyone else who prompts in such a session asks once; who is in charge then sees a
 * card in their open tabs and gets a notice, and answers in the session itself, where the project's skills and settings
 * are shown. A card never trusts a project with one tap.
 *
 * One request for a folder on a computer, whoever asks and however often: it stands until the project is decided or who
 * is in charge dismisses it. A dismissed one is not asked again before a restart. Nobody waits on a request, so none
 * grows old.
 *
 * Requests live in memory: a restart ends them, and the next person who opens such a session asks again.
 */
import { randomUUID } from "node:crypto";
import { inFolder, type Person } from "./access.ts";
import { HttpError } from "./errors.ts";

/** The project that waits, and the session it was asked from. */
export type TrustQuestion = {
    /** `THIS_SERVER` or a runner's id. */
    computer: string;
    /** The computer's name, for people. */
    computerName: string;
    /** The project's folder, as the trust store names it. */
    folder: string;
    /** The session to answer it in. */
    session: string;
    /** Its title, for people. */
    title: string;
};

/** A request as who is in charge sees it. */
export type TrustRequestView = TrustQuestion & {
    id: string;
    /** Who asked. */
    person: string;
    name: string;
};

/**
 * What someone who is not in charge learns of a session's project trust: whether it waits for a decision, who gives it,
 * and whether they were asked already. No folder and no skill: those may be above the folder this person was given.
 */
export type TrustWait = { waiting: boolean; by: string; asked: boolean };

export type TrustRequestOptions = {
    /** The current record of a person (a person removed meanwhile is gone). */
    person: (id: string) => (Person & { name: string }) | undefined;
    /** Whether `person` is in charge of computer `computer` (`access.ts` `inCharge`): they see its requests. */
    inCharge: (person: Pick<Person, "id">, computer: string) => boolean;
    /** The requests changed: tell each person's tabs what they see. */
    changed: () => void;
    /** A new request: who is in charge of its computer hears of it (a notice, a push). */
    asked: (request: TrustRequestView) => void;
};

/** One project on one computer. */
const keyOf = (computer: string, folder: string) => `${computer}\n${folder}`;

export class TrustRequests {
    readonly #options: TrustRequestOptions;
    /** The requests that stand, by project. */
    readonly #open = new Map<string, TrustRequestView>();
    /** The projects asked about since the start and not decided since: open, or dismissed. */
    readonly #asked = new Set<string>();

    constructor(options: TrustRequestOptions) {
        this.#options = options;
    }

    /** The requests `person` sees: every one on a computer they are in charge of. */
    list(person: Pick<Person, "id">): TrustRequestView[] {
        const current = this.#options.person(person.id);

        return current === undefined
            ? []
            : [...this.#open.values()].filter((each) =>
                  this.#options.inCharge(current, each.computer),
              );
    }

    /** Whether the project was asked about already: its request stands, or was dismissed. */
    asked(computer: string, folder: string): boolean {
        return this.#asked.has(keyOf(computer, folder));
    }

    /**
     * `person` asks who is in charge to decide on a project. The first one to ask opens its request; everyone after them,
     * and anyone after a dismissal, changes nothing. Who is in charge asks no one: they answer.
     */
    ask(person: Pick<Person, "id">, question: TrustQuestion): void {
        const current = this.#options.person(person.id);
        const key = keyOf(question.computer, question.folder);

        if (
            current === undefined ||
            this.#asked.has(key) ||
            this.#options.inCharge(current, question.computer)
        ) {
            return;
        }

        const view: TrustRequestView = {
            ...question,
            id: randomUUID(),
            person: current.id,
            name: current.name,
        };

        this.#asked.add(key);
        this.#open.set(key, view);
        this.#options.changed();
        this.#options.asked(view);
    }

    /** Who is in charge puts request `id` away without deciding: it is not asked again before a restart. */
    dismiss(person: Pick<Person, "id">, id: string): void {
        const current = this.#options.person(person.id);
        const found = [...this.#open].find(([, each]) => each.id === id);

        if (
            current === undefined ||
            found === undefined ||
            !this.#options.inCharge(current, found[1].computer)
        ) {
            throw new HttpError(404, "That request is gone: it was answered or dismissed.");
        }

        this.#open.delete(found[0]);
        this.#options.changed();
    }

    /**
     * The project was decided: its request ends, and a later change of mind there may be asked about again. Everyone
     * hears when it was asked about, open or dismissed: a tab whose session waited reads its trust again.
     */
    decided(computer: string, folder: string): void {
        const key = keyOf(computer, folder);
        const asked = this.#asked.delete(key);

        this.#open.delete(key);

        if (asked) {
            this.#options.changed();
        }
    }

    /**
     * Decisions were saved for `folders` on `computer` (the Access sheet): each project in one of them, or in a folder
     * inside one, was decided, as `decided` says. A folder asked about has no decision that covers it, so the nearest one
     * saved now is what holds for it.
     */
    decidedUnder(computer: string, folders: readonly string[]): void {
        for (const request of [...this.#open.values()]) {
            if (
                request.computer === computer &&
                folders.some((folder) => inFolder(request.folder, folder))
            ) {
                this.decided(computer, request.folder);
            }
        }

        for (const key of [...this.#asked]) {
            const [there, folder = ""] = key.split("\n");

            if (there === computer && folders.some((each) => inFolder(folder, each))) {
                this.decided(computer, folder);
            }
        }
    }

    /**
     * End the requests `keep` refuses (its session is gone, its computer was unlinked, or its project no longer waits).
     * Such a project may be asked about again.
     */
    prune(keep: (request: TrustRequestView) => boolean): void {
        let changed = false;

        for (const [key, request] of [...this.#open]) {
            if (!keep(request)) {
                this.#open.delete(key);
                this.#asked.delete(key);
                changed = true;
            }
        }

        if (changed) {
            this.#options.changed();
        }
    }
}
