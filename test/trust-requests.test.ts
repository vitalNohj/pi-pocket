// Projects that wait for a trust decision of who is in charge of their computer (`src/server/trust-requests.ts`): one
// request for a project, seen only by who is in charge, ended by a decision, and not asked again after a dismissal.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Person } from "../src/server/access.ts";
import { HttpError } from "../src/server/errors.ts";
import {
    type TrustQuestion,
    TrustRequests,
    type TrustRequestView,
} from "../src/server/trust-requests.ts";

/** The owner is in charge of this server, Lina of the laptop she linked; Gale and Alex are in charge of nothing. */
const people: Record<string, Person & { name: string }> = {
    owner: { id: "owner", role: "owner", name: "Owner" },
    lina: { id: "lina", role: "guest", name: "Lina" },
    gale: { id: "gale", role: "guest", name: "Gale" },
    alex: { id: "alex", role: "guest", name: "Alex" },
};

const here: TrustQuestion = {
    computer: "this-server",
    computerName: "this server",
    folder: "/srv/app",
    session: "7",
    title: "Fix the build",
};
const there: TrustQuestion = { ...here, computer: "laptop", computerName: "Laptop", session: "9" };

function setup() {
    const gone = new Set<string>();
    const told: TrustRequestView[] = [];
    let changes = 0;
    const requests = new TrustRequests({
        person: (id) => (gone.has(id) ? undefined : people[id]),
        inCharge: (person, computer) =>
            computer === "this-server" ? person.id === "owner" : person.id === "lina",
        changed: () => {
            changes += 1;
        },
        asked: (request) => told.push(request),
    });

    return { requests, gone, told, changes: () => changes };
}

/** A refusal with HTTP status `status`. */
const refused = (status: number) => (error: unknown) =>
    error instanceof HttpError && error.status === status;

describe("projects that wait for a trust decision", () => {
    it("opens one request for a project, whoever asks and however often, for who is in charge alone", () => {
        const { requests, told, changes } = setup();

        requests.ask(people.gale!, here);
        requests.ask(people.gale!, here);
        requests.ask(people.alex!, { ...here, session: "8", title: "Another session there" });

        const [request, ...more] = requests.list(people.owner!);

        assert.deepEqual(more, []);
        assert.deepEqual({ ...request, id: "" }, { ...here, id: "", person: "gale", name: "Gale" });
        assert.ok(request!.id.length > 0);
        assert.deepEqual(told, [request], "who is in charge hears once");
        assert.equal(changes(), 1);
        assert.equal(requests.asked("this-server", "/srv/app"), true);
        assert.equal(requests.asked("laptop", "/srv/app"), false, "another computer's folder");

        for (const other of [people.gale!, people.alex!, people.lina!]) {
            assert.deepEqual(requests.list(other), [], other.name);
        }
    });

    it("keeps a computer's requests for who is in charge of that computer: the owner is no one special on a runner", () => {
        const { requests } = setup();

        requests.ask(people.gale!, there);
        assert.equal(requests.list(people.lina!).length, 1);
        assert.deepEqual(requests.list(people.owner!), []);

        const [request] = requests.list(people.lina!);

        assert.throws(() => requests.dismiss(people.owner!, request!.id), refused(404));
        assert.throws(() => requests.dismiss(people.gale!, request!.id), refused(404));
        assert.equal(requests.list(people.lina!).length, 1, "nobody else puts it away");
    });

    it("asks no one when who is in charge opens the session: they answer", () => {
        const { requests, told, changes } = setup();

        requests.ask(people.owner!, here);
        requests.ask(people.lina!, there);
        assert.deepEqual(told, []);
        assert.equal(changes(), 0);
        assert.equal(requests.asked("this-server", "/srv/app"), false);
    });

    it("ends a request when its project is decided, tells everyone, and asks again after a change of mind", () => {
        const { requests, told, changes } = setup();

        requests.decided("this-server", "/srv/app");
        assert.equal(changes(), 0, "a project nobody asked about changes nothing");

        requests.ask(people.gale!, here);
        requests.decided("this-server", "/srv/app");
        assert.deepEqual(requests.list(people.owner!), []);
        assert.equal(requests.asked("this-server", "/srv/app"), false);
        assert.equal(changes(), 2, "the waiting session's tab hears, to read its trust again");

        // The decision was taken back later: the project waits again, and is asked about again.
        requests.ask(people.alex!, here);
        assert.equal(requests.list(people.owner!).length, 1);
        assert.equal(told.length, 2);
    });

    it("puts a dismissed request away without deciding, and does not ask again until the project is decided", () => {
        const { requests, told, changes } = setup();

        requests.ask(people.gale!, here);

        const [request] = requests.list(people.owner!);

        requests.dismiss(people.owner!, request!.id);
        assert.deepEqual(requests.list(people.owner!), []);
        assert.equal(requests.asked("this-server", "/srv/app"), true, "it was asked about");
        assert.throws(() => requests.dismiss(people.owner!, request!.id), refused(404));

        requests.ask(people.alex!, here);
        assert.deepEqual(requests.list(people.owner!), [], "not asked a second time");
        assert.equal(told.length, 1);

        // Decided after all (in the session, or in Pi's CLI): everyone hears, and it may be asked about again.
        const before = changes();

        requests.decided("this-server", "/srv/app");
        assert.equal(changes(), before + 1);
        assert.equal(requests.asked("this-server", "/srv/app"), false);
    });

    it("ends the requests it is told to, which may then be asked about again", () => {
        const { requests, told, changes } = setup();

        requests.ask(people.gale!, here);
        requests.ask(people.alex!, there);

        const before = changes();

        requests.prune(() => true);
        assert.equal(changes(), before, "nothing ended, nothing told");

        // Gale no longer prompts in that session.
        requests.prune((request) => request.person !== "gale");
        assert.deepEqual(requests.list(people.owner!), []);
        assert.equal(requests.list(people.lina!).length, 1, "the other one stands");
        assert.equal(changes(), before + 1);

        requests.ask(people.alex!, here);
        assert.equal(requests.list(people.owner!)[0]?.person, "alex");
        assert.equal(told.length, 3);
    });

    it("shows and takes nothing from a person who was removed", () => {
        const { requests, gone, told } = setup();

        gone.add("gale");
        requests.ask(people.gale!, here);
        assert.deepEqual(told, []);

        requests.ask(people.alex!, here);

        const [request] = requests.list(people.owner!);

        gone.add("owner");
        assert.deepEqual(requests.list(people.owner!), []);
        assert.throws(() => requests.dismiss(people.owner!, request!.id), refused(404));
    });
});
