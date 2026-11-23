/**
 * `/api`: the routes the web app calls. Each needs a signed-in person, and each but a GET needs the `X-Pocket` header,
 * which a form on another site cannot send. A conversation's routes are in `conversation-routes.ts`.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { MAX_PEEKS } from "../app.ts";
import {
    ACCOUNT_MINUTES,
    type Auth,
    COOKIE,
    clearAuthCookie,
    INVITE_MINUTES,
    type InviteGrant,
    type InviteMinutes,
    origin,
    parseCookies,
    quickTunnelHost,
    SIGN_IN_LINK_MS,
} from "../auth.ts";
import { inFolder, THIS_SERVER } from "../access.ts";
import type { ComputerSettings, User } from "../config.ts";
import { MAX_AVATAR, readAvatar } from "../avatars.ts";
import { HttpError, optionalText } from "../errors.ts";
import { isLocalRequest, withReveal } from "../local-browser.ts";
import { machineRoots, parentFolder } from "../paths.ts";
import { desktopTheme, wallpaperFile } from "../omarchy.ts";
import { runningBoard, runningNow } from "../running.ts";
import { serveImage } from "./assets.ts";
import { browserRoutes } from "./browser-routes.ts";
import { conversationRoutes } from "./conversation-routes.ts";
import { createEventStreams, keptPart } from "./events.ts";
import { extensionRoute } from "./extension-routes.ts";
import { isIconColors, storeIconColors } from "../icon-store.ts";
import {
    type ApiRequest,
    conversationId,
    type HttpOptions,
    json,
    readBody,
    readJson,
} from "./io.ts";
import { pushRoutes } from "./push-routes.ts";

/** This machine's non-internal IPv4 addresses, for invite links other devices on its networks can open. */
function lanAddresses(): string[] {
    return Object.values(networkInterfaces())
        .flat()
        .filter((net) => net !== undefined && net.family === "IPv4" && !net.internal)
        .map((net) => net!.address);
}

/** A 6-digit code from a request body, or a 400 that says what to enter. */
/** A folder's real path here, or the path as given when it cannot be read. */
function realpathOrSelf(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** A folder listing as the picker reads it (`GET /api/fs`, `/api/runners/:id/fs`). */
type Listing = {
    path: string;
    parent: string | null;
    home: string;
    roots?: string[];
    dirs: { name: string; path: string }[];
};

/**
 * The picker's listing for someone given folders who asked for a place outside them: the folders given, and no way up.
 */
function givenListing(given: readonly string[]): Listing & { given: string[] } {
    return {
        path: "",
        parent: null,
        home: given[0] ?? "",
        roots: [],
        dirs: given.map((path) => ({ name: path, path })),
        given: [...given],
    };
}

/**
 * Keep someone given folders inside them: no way up out of a given folder, no other top folders, and the given ones
 * named so the picker can offer them. `given` undefined: the owner, who goes anywhere.
 */
function scopeListing<T extends Listing>(
    listing: T,
    given: readonly string[] | undefined,
): T & { given?: string[] } {
    if (given === undefined) {
        return listing;
    }

    const top = given.some(
        (each) => listing.path === each.replace(/[\\/]+$/, "") || listing.path === each,
    );

    // `home` stays the computer's own, so paths read as they are (`~/projects/app`, not `~/app`).
    return {
        ...listing,
        parent: top ? null : listing.parent,
        roots: [],
        given: [...given],
    };
}

function sixDigits(value: unknown): string {
    if (typeof value !== "string" || !/^\d{6}$/.test(value)) {
        throw new HttpError(400, "Enter the 6-digit code from your authenticator.");
    }

    return value;
}

/**
 * `/api/me/authenticator[/action]`: a person's own authenticator app. Anyone signed in links one to their own account,
 * viewers too; its secret is shown once, while linking, and never again.
 *
 * - GET: whether one is linked, and until when wrong codes locked it out.
 * - POST `begin`: a new secret, its `otpauth:` link, and that link as a QR code; replaces one not yet confirmed.
 * - POST `confirm` `{ code }`: the first code links it.
 * - POST `remove` `{ code }`: one of its codes removes it; one not yet confirmed needs none.
 */
async function authenticatorRoute(
    { app, request, user }: ApiRequest,
    action: string | undefined,
    method: string,
): Promise<unknown> {
    const status = () => {
        const until = app.authenticators.lockedUntil(user.id);

        return {
            linked: app.authenticators.linked(user.id),
            ...(until === undefined ? {} : { lockedUntil: until }),
            // A temporary account links none (`config.ts` `User.temporary`): its page offers no way to.
            ...(user.temporary === true ? { allowed: false } : {}),
        };
    };

    if (action === undefined && method === "GET") {
        return status();
    }

    if (method !== "POST") {
        throw new HttpError(404, "Not found");
    }

    if ((action === "begin" || action === "confirm") && user.temporary === true) {
        throw new HttpError(
            403,
            "A temporary account cannot link an authenticator. Ask whoever manages people here to allow you to become a user.",
        );
    }

    if (action === "begin") {
        const { secret, link } = app.authenticators.begin(user.id, user.name);
        const svg = await QRCode.toString(link, {
            type: "svg",
            margin: 1,
            color: { dark: "#000000", light: "#ffffff" },
        });

        return { secret, link, svg };
    }

    const body = await readJson<{ code?: unknown } | null>(request);

    if (action === "confirm") {
        app.confirmAuthenticator(user, sixDigits(body?.code));

        return status();
    }

    if (action === "remove") {
        app.removeAuthenticator(
            user.id,
            user,
            body?.code === undefined ? undefined : sixDigits(body.code),
        );
        // A viewer now: what they were in charge of as one who manages runners is handed over before the answer.
        await app.settle();

        return status();
    }

    throw new HttpError(404, "Not found");
}

/** The `/api` routes. Each HTTP handler makes its own, and its event streams live as long as it does. */
export function createApi(options: HttpOptions, auth: Auth) {
    const { app } = options;
    const { events, poll } = createEventStreams(app);

    const requireUser = (request: IncomingMessage): User => {
        const user = auth.user(request);

        if (user === undefined) {
            throw new HttpError(401, "Sign in first");
        }

        return user;
    };

    const requireOwner = (user: User): void => {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }
    };

    /**
     * What an invite may grant (`access.ts` `mayInvite`): its maker's own sessions, or a folder's, for who may start
     * sessions on some computer; one session, for who may share it. An invite is always for someone new: one's own other device takes a device link (`me/device`).
     */
    const inviteGrant = (
        user: User,
        body: {
            role?: unknown;
            session?: unknown;
            folder?: unknown;
            temporary?: unknown;
            accountMinutes?: unknown;
        },
    ): InviteGrant => {
        // A page loaded before device links still asks for an owner invite, which handed out the owner's token.
        if (body.role === "owner") {
            throw new HttpError(
                400,
                "Reload Pi Pocket, then use Sign in another device on your own page in People.",
            );
        }

        // Off for everyone but the owner, until the owner turns Invite people on for a user (`access.ts` `invites`).
        if (!app.policy.invites(user)) {
            throw new HttpError(403, "You do not have the Invite people permission.");
        }

        // Every invite starts as a viewer: steering comes later, once they link an authenticator, from who is in charge.
        const grant: InviteGrant = { role: "viewer" };

        // Unless the invite allows more, the account links no authenticator and stays a viewer.
        if (body.temporary !== false) {
            grant.temporary = true;

            if (body.accountMinutes !== undefined && body.accountMinutes !== null) {
                const accountMinutes = ACCOUNT_MINUTES.find((each) => each === body.accountMinutes);

                if (accountMinutes === undefined) {
                    throw new HttpError(400, "accountMinutes must be 1440, 10080, or 43200");
                }

                grant.accountMinutes = accountMinutes;
            }
        }

        if (body.session === undefined || body.session === null) {
            if (!app.policy.mayInvite(user)) {
                throw new HttpError(
                    403,
                    "Only people who may start sessions here can invite others.",
                );
            }

            return grant;
        }

        const session = conversationId(String(body.session));

        if (!app.canSee(user, session) || app.sessionMeta(session) === undefined) {
            throw new HttpError(400, "No such session");
        }

        // To the folder of that session: the server names the folder, never the page. As an invite to every session,
        // it shares only what its maker started, so the same people may make it.
        if (body.folder === true) {
            const folder = app.folderOf(session);

            if (folder === undefined) {
                throw new HttpError(400, "No such session");
            }

            if (!app.policy.mayInvite(user)) {
                throw new HttpError(
                    403,
                    "Only people who may start sessions here can invite others.",
                );
            }

            return { ...grant, folder };
        }

        if (!app.policy.mayInvite(user, String(app.rootOf(session)))) {
            throw new HttpError(
                403,
                "Only people who may share this session can invite others to it.",
            );
        }

        return { ...grant, session: String(app.rootOf(session)) };
    };

    /** How long an invite lasts, in minutes: one of `INVITE_MINUTES`, 15 when not said. */
    const inviteMinutes = (body: { minutes?: unknown }): InviteMinutes => {
        if (body.minutes === undefined) {
            return 15;
        }

        const minutes = INVITE_MINUTES.find((each) => each === body.minutes);

        if (minutes === undefined) {
            throw new HttpError(
                400,
                "An invite lasts 15 minutes, an hour, a day, a week, or a month.",
            );
        }

        return minutes;
    };

    /**
     * An invite or a device link as its maker's page shows it: the link another device can open, its QR code, and the
     * other addresses this server answers at.
     */
    const shownInvite = async (
        request: IncomingMessage,
        user: User,
        invite: { code: string; expiresAt: number; minutes: InviteMinutes },
    ) => {
        const here = origin(request);
        const loopback = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(here);
        const { listen } = options;
        // A Unix socket has no address of its own: the reverse proxy's address (here) is the way in.
        const lan =
            "port" in listen && loopback && (listen.host === "0.0.0.0" || listen.host === "::")
                ? lanAddresses().map((address) => `http://${address}:${listen.port}`)
                : [];
        // A tunnel the launcher started is the way in for other devices.
        const tunnel = loopback ? app.access?.url : undefined;
        const base = tunnel ?? lan[0] ?? here;
        const link = `${base}/join/${invite.code}`;
        // One whose QR code could not be made is never shown: it ends rather than stay live, unseen.
        const svg = await QRCode.toString(link, {
            type: "svg",
            margin: 1,
            color: { dark: "#000000", light: "#ffffff" },
        }).catch((error: unknown) => {
            auth.cancelInvite(invite.code, user);

            throw error;
        });

        return {
            ...invite,
            url: link,
            svg,
            alternatives: (tunnel === undefined ? lan.slice(1) : lan).map(
                (address) => `${address}/join/${invite.code}`,
            ),
            // Only this device can open a loopback link.
            local: loopback && lan.length === 0 && tunnel === undefined,
            ...(app.access === undefined ? {} : { access: app.access }),
        };
    };

    /** A guest signed in by a cookie set on a Cloudflare quick tunnel can only come back through it: remember which one. */
    const noteTunnel = (request: IncomingMessage, user: User): void => {
        const cookie = parseCookies(request.headers.cookie)[COOKIE];

        // Another device of theirs was tagged alone when it signed in (`auth.ts` `redeem`): never the person for it.
        if (
            user.role === "owner" ||
            user.tunnel !== undefined ||
            !cookie ||
            app.config.isDevice(cookie)
        ) {
            return;
        }

        const tunnel = quickTunnelHost(request);

        if (tunnel !== undefined) {
            app.config.updateUser(user.id, { tunnel });
        }
    };

    return async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        parts: string[],
    ): Promise<void> => {
        const method = request.method ?? "GET";
        const user = requireUser(request);

        noteTunnel(request, user);

        if (method !== "GET" && request.headers["x-pocket"] !== "1") {
            throw new HttpError(403, "Missing X-Pocket header");
        }

        const [first, second, third, fourth] = parts;
        const route: ApiRequest = { app, request, response, url, user };

        if (first === "events" && method === "GET") {
            return events(request, response, url, user);
        }

        if (first === "poll" && method === "GET") {
            return poll(request, response, url, user);
        }

        if (first === "me" && second === undefined && method === "GET") {
            return json(
                response,
                200,
                withReveal(await app.hello(user), user, isLocalRequest(request)),
            );
        }

        if (first === "me" && second === undefined && method === "POST") {
            const body = await readJson<{ name?: string }>(request);
            // No control characters: names show in other people's views and in a runner's terminal question.
            const name = String(body.name ?? "")
                .replace(/\s+/g, " ")

                .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
                .trim()
                .slice(0, 40);

            if (name === "") {
                throw new HttpError(400, "Name is empty");
            }

            app.rename(user, name);

            return json(response, 200, { ok: true });
        }

        if (first === "me" && second === "avatar" && (method === "POST" || method === "DELETE")) {
            if (user.role === "viewer") {
                throw new HttpError(403, "Viewers do not set a photo.");
            }

            app.setAvatar(
                user,
                method === "POST" ? await readBody(request, MAX_AVATAR) : undefined,
            );

            return json(response, 200, { ok: true });
        }

        // Session approvals (`folder-approvals.ts`): of the sessions a person started, and on computers they are in charge
        // of. DELETE revokes one (the session locks); POST renews it: Allow by who is in charge, or the starter's code.
        if (first === "session-approvals" && second !== undefined && method === "DELETE") {
            app.revokeApproval(user, conversationId(second));

            return json(response, 200, { ok: true });
        }

        if (first === "session-approvals" && second !== undefined && method === "POST") {
            const body = await readJson<{ code?: unknown } | null>(request);

            await app.renewApproval(
                user,
                conversationId(second),
                body?.code === undefined ? undefined : sixDigits(body.code),
            );

            return json(response, 200, { ok: true });
        }

        // Who manages a person gives them one right, or takes it back: to link computers of their own, invite people,
        // manage people, keep sessions warm, or chat with one person (`rights.ts`; `app.ts` `setRight` says who gives
        // which).
        if (first === "users" && second !== undefined && third === "rights" && method === "POST") {
            const body = await readJson<{ right?: unknown; on?: unknown } | null>(request);

            app.setRight(user, { person: second, right: body?.right, on: body?.on });
            // Managing runners taken back: what they had by it alone is handed over before the answer.
            await app.settle();

            return json(response, 200, { ok: true });
        }

        // Who manages people has answered a viewer's request for access: it leaves their row.
        if (
            first === "users" &&
            second !== undefined &&
            third === "access-request" &&
            method === "POST"
        ) {
            const body = await readJson<{ clear?: unknown } | null>(request);

            if (body?.clear !== true) {
                throw new HttpError(400, "clear must be true.");
            }

            app.clearAccessRequest(user, second);

            // The people as they are now, as the other changes to a person answer.
            return json(response, 200, app.people(user));
        }

        // "Tasks expire with the session": a server setting.
        if (first === "tasks-expire" && second === undefined && method === "POST") {
            const body = await readJson<{ on?: unknown } | null>(request);

            if (typeof body?.on !== "boolean") {
                throw new HttpError(400, "on must be true or false.");
            }

            app.setTasksExpire(user, body.on);

            return json(response, 200, { ok: true });
        }

        // How long a person's approvals last once unused, on every computer (`config.ts` `approvalDays`): for who
        // manages them to set (`app.ts` `setApprovalDays`).
        if (
            first === "users" &&
            second !== undefined &&
            third === "approval-days" &&
            method === "POST"
        ) {
            const body = await readJson<{ days?: unknown } | null>(request);

            app.setApprovalDays(user, second, body?.days);

            return json(response, 200, { ok: true });
        }

        // A viewer asks for access, with a few words if they like, or takes that back (`app.ts` `requestAccess`).
        if (
            first === "me" &&
            second === "access-request" &&
            third === undefined &&
            method === "POST"
        ) {
            const body = await readJson<{ note?: unknown; withdraw?: unknown } | null>(request);

            if (body?.withdraw === true) {
                app.clearAccessRequest(user);

                return json(response, 200, { ok: true });
            }

            if (body?.note !== undefined && typeof body.note !== "string") {
                throw new HttpError(400, "note must be text.");
            }

            app.requestAccess(user, body?.note);

            return json(response, 200, { ok: true });
        }

        // Each person's own authenticator app (`approval-methods.ts`): they approve their new folders with its codes.
        // A device link: it signs another device in as this person once, within 15 minutes.
        if (first === "me" && second === "device" && third === undefined && method === "POST") {
            if (user.role === "viewer") {
                throw new HttpError(403, "Ask whoever manages people here for a sign-in link.");
            }

            return json(
                response,
                200,
                await shownInvite(request, user, auth.createDeviceLink(user)),
            );
        }

        // The owner makes one for someone else, who lost their device: it signs a device in as them, not as someone new.
        // Who manages users makes one for a viewer, who makes none themselves (`access.ts` `maySignInAs`).
        if (first === "users" && second !== undefined && third === "device" && method === "POST") {
            if (!app.policy.managesPeople(user)) {
                throw new HttpError(403, "Only someone who manages users can do that.");
            }

            const person = app.config.userById(second);

            if (person === undefined) {
                throw new HttpError(404, "No such person.");
            }

            if (!app.policy.maySignInAs(user, person)) {
                throw new HttpError(
                    403,
                    "Who manages users makes a sign-in link only for a viewer.",
                );
            }

            return json(
                response,
                200,
                await shownInvite(request, user, auth.createDeviceLink(user, person)),
            );
        }

        if (first === "me" && second === "authenticator") {
            return json(response, 200, await authenticatorRoute(route, third, method));
        }

        // The owner's "Not now" to the first-start prompt (`hello`'s `user.setup`): it does not come again.
        if (first === "me" && second === "setup" && third === undefined && method === "POST") {
            requireOwner(user);

            const body = await readJson<{ dismissed?: unknown } | null>(request);

            if (body?.dismissed !== true) {
                throw new HttpError(400, "dismissed must be true.");
            }

            app.config.updateUser(user.id, { setupDismissed: true });

            return json(response, 200, { ok: true });
        }

        // A picture of anyone this person may see in the people list.
        if (first === "avatar" && second !== undefined && method === "GET") {
            const picture = app.people(user).some((each) => each.id === second)
                ? readAvatar(app.dataDir, second)
                : undefined;

            if (picture === undefined) {
                throw new HttpError(404, "No picture");
            }

            // The address carries the picture's version, so a copy never goes stale.
            response.writeHead(200, {
                "content-type": picture.type,
                "content-length": picture.bytes.length,
                "cache-control": "private, max-age=31536000, immutable",
                "x-content-type-options": "nosniff",
            });
            response.end(picture.bytes);

            return;
        }

        if (first === "folder-favorites" && second === undefined && method === "GET") {
            return json(response, 200, await app.folderFavorites.list(user));
        }

        if (first === "folder-favorites" && second === undefined && method === "POST") {
            await app.folderFavorites.set(user, await readJson(request));

            return json(response, 200, { ok: true });
        }

        // The owner and users can sync pins. Viewers keep theirs in the browser.
        if (first === "pinned-sessions" && second === undefined && method === "GET") {
            const pinned = user.role === "viewer" ? undefined : await app.pinnedSessions.list(user);

            return json(response, 200, { pinned: pinned ?? null });
        }

        if (first === "pinned-sessions" && second === undefined && method === "POST") {
            if (user.role === "viewer") {
                throw new HttpError(403, "Viewers keep their pins in this browser.");
            }

            await app.pinnedSessions.set(user, await readJson(request));

            return json(response, 200, { ok: true });
        }

        if (first === "logout" && method === "POST") {
            // Another device of theirs has a token of its own, which ends with it. Their first one stays: it is all
            // that the link they signed in with carries.
            app.config.removeDevice(parseCookies(request.headers.cookie)[COOKIE] ?? "");
            clearAuthCookie(response);

            return json(response, 200, { ok: true });
        }

        if (first === "users" && second === undefined && method === "GET") {
            return json(response, 200, app.people(user));
        }

        if (first === "users" && second !== undefined && third === "remove" && method === "POST") {
            await app.removeUser(user, second);

            return json(response, 200, { ok: true });
        }

        // Who manages them can remove an authenticator for a lost phone. A user is paused until they link again.
        if (
            first === "users" &&
            second !== undefined &&
            third === "authenticator" &&
            method === "DELETE"
        ) {
            app.requireManages(user, second);

            if (app.config.userById(second) === undefined) {
                throw new HttpError(404, "No such person.");
            }

            app.removeAuthenticator(second, user);
            await app.settle();

            return json(response, 200, app.people(user));
        }

        // The sessions I may share, each with how one person has it now: to share several with them at once, or take
        // several back (`commands.ts` `sharingWith`, `shareWith`). For whoever prompts; a viewer shares nothing.
        if (first === "users" && second !== undefined && third === "sharing") {
            if (method === "GET") {
                return json(response, 200, app.commands.sharingWith(user, second));
            }

            if (method === "POST") {
                return json(
                    response,
                    200,
                    await app.commands.shareWith(
                        user,
                        second,
                        await readJson<{ share?: unknown; revoke?: unknown } | null>(request),
                    ),
                );
            }
        }

        // Chat with one person (`direct.ts`): only the two read it, and each asks as themselves, never for another.
        if (first === "users" && second !== undefined && third === "chat") {
            if (fourth === undefined && method === "GET") {
                return json(response, 200, await app.direct.thread(user, second));
            }

            if (fourth === undefined && method === "POST") {
                const body = await readJson<{ text?: unknown; requestId?: unknown } | null>(
                    request,
                );

                if (typeof body?.text !== "string" || typeof body.requestId !== "string") {
                    throw new HttpError(400, "text and requestId are required");
                }

                return json(
                    response,
                    200,
                    await app.direct.post(user, second, {
                        text: body.text,
                        requestId: body.requestId,
                    }),
                );
            }

            if (fourth === "read" && method === "POST") {
                await app.direct.read(user, second);

                return json(response, 200, { ok: true });
            }
        }

        if (first === "users" && second !== undefined && third === undefined && method === "POST") {
            app.setAccess(user, second, await readJson(request));
            // Made a viewer, or limited to sessions: they manage runners no longer, and what they had by it moves on.
            await app.settle();

            return json(response, 200, app.people(user));
        }

        if (first === "visibility" && method === "POST") {
            const body = await readJson<{ tab?: unknown; visible?: unknown }>(request);

            app.setVisible(user, String(body.tab ?? ""), body.visible !== false);

            return json(response, 200, { ok: true });
        }

        // The sessions a connection shows as peek tiles on screen now: they get `peek` events until it sends another list.
        if (first === "peeks" && method === "POST") {
            const body = await readJson<{ connection?: unknown; ids?: unknown; seq?: unknown }>(
                request,
            );

            if (!Array.isArray(body.ids)) {
                throw new HttpError(400, "ids must be a list of session ids");
            }

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            app.setPeeks(
                user,
                String(body.connection ?? ""),
                body.ids.slice(0, MAX_PEEKS).map((id) => conversationId(String(id))),
                body.seq as number | undefined,
            );

            return json(response, 200, { ok: true });
        }

        // A tab shows another session, or the list (`c` null), on the connection it has; `have` is what it kept of it.
        if (first === "switch" && method === "POST") {
            const body = await readJson<{
                connection?: unknown;
                c?: unknown;
                have?: unknown;
                seq?: unknown;
            }>(request);

            if (!Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            const switched = app.switchTo(
                user,
                String(body.connection ?? ""),
                body.c === null || body.c === undefined
                    ? undefined
                    : conversationId(String(body.c)),
                keptPart(typeof body.have === "string" ? body.have : null),
                body.seq as number,
            );

            if (!switched) {
                throw new HttpError(409, "This connection is not open");
            }

            return json(response, 200, { ok: true });
        }

        // Every subagent in the sessions this person can see, as the subagents board shows them.
        if (first === "subagents" && method === "GET") {
            return json(response, 200, app.subagents(user));
        }

        // The PiP panel opened or closed in a tab: while open, it gets PiP's conversation (`pipview` events). Opening it
        // the first time makes this person's PiP; the answer says which conversation it is.
        if (first === "pip" && second === undefined && method === "POST") {
            const body = await readJson<{ connection?: unknown; on?: unknown; seq?: unknown }>(
                request,
            );

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            await app.setPip(
                user,
                String(body.connection ?? ""),
                body.on === true,
                body.seq as number | undefined,
            );

            return json(response, 200, { pip: app.pip.state(user) });
        }

        // Webhooks: the ones this person may manage, with the address to give other services; making and removing one.
        if (first === "hooks" && second === undefined && method === "GET") {
            return json(response, 200, await app.commands.hooks(user));
        }

        if (first === "hooks" && second === undefined && method === "POST") {
            return json(response, 200, await app.commands.addHook(user, await readJson(request)));
        }

        // A repository watch removed, by its person or the owner.
        if (
            first === "repo-watches" &&
            second !== undefined &&
            third === "remove" &&
            method === "POST"
        ) {
            await app.repoWatches.remove(user, second);

            return json(response, 200, { ok: true });
        }

        // A repository watch let hear from anyone, or only from the repository's people: by its person or the owner,
        // never by PiP.
        if (
            first === "repo-watches" &&
            second !== undefined &&
            third === "anyone" &&
            method === "POST"
        ) {
            const body = await readJson<{ anyone?: unknown }>(request);

            if (typeof body.anyone !== "boolean") {
                throw new HttpError(400, "anyone must be true or false");
            }

            await app.repoWatches.setAnyone(user, second, body.anyone);

            return json(response, 200, { ok: true });
        }

        if (first === "hooks" && second !== undefined && third === undefined && method === "POST") {
            const body = await readJson<{ instructions?: unknown }>(request);

            return json(response, 200, await app.hooks.update(user, second, body.instructions));
        }

        // A new secret, for a hook whose address or secret got out.
        if (first === "hooks" && second !== undefined && third === "rotate" && method === "POST") {
            return json(response, 200, await app.hooks.rotate(user, second));
        }

        if (
            first === "hooks" &&
            second !== undefined &&
            parts[2] === "remove" &&
            method === "POST"
        ) {
            await app.commands.removeHook(user, second);

            return json(response, 200, { ok: true });
        }

        // The subagents board opened or closed in a tab: while open, it gets every subagent (`subagents` events).
        if (first === "subagents" && method === "POST") {
            const body = await readJson<{ connection?: unknown; on?: unknown; seq?: unknown }>(
                request,
            );

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            app.setBoard(
                user,
                String(body.connection ?? ""),
                body.on === true,
                body.seq as number | undefined,
            );

            return json(response, 200, { ok: true });
        }

        if (first === "push") {
            return pushRoutes(route, second);
        }

        // The Omarchy desktop's theme, for the app's "Follow desktop" look: colors say nothing about the sessions here, so
        // everyone signed in gets them. The wallpaper may be a personal photo: only the owner gets that.
        if (first === "theme" && second === undefined && method === "GET") {
            const theme = await desktopTheme();

            return json(response, 200, {
                theme:
                    theme === null
                        ? null
                        : { ...theme, wallpaper: theme.wallpaper && user.role === "owner" },
            });
        }

        // Theme folders (`themes.ts`): everyone signed in lists them and chooses their own look; only people who
        // manage the server add, edit, or remove them, and report the app icon colors for requests without a cookie.
        if (first === "app-icon" && second === undefined && method === "PUT") {
            app.policy.requireManagesServer(user);

            const { colors } = await readJson<{ colors?: unknown }>(request);

            if (!isIconColors(colors)) {
                throw new HttpError(400, "Colors are five hex colors joined by dots");
            }

            storeIconColors(app.dataDir, colors);

            return json(response, 200, { ok: true });
        }

        if (first === "themes" && second === undefined && method === "GET") {
            return json(response, 200, { themes: app.themes.list(app.policy.managesServer(user)) });
        }

        if (first === "themes" && second === "default" && method === "PUT") {
            await app.setThemeDefault(
                user,
                (await readJson<{ default?: unknown }>(request)).default,
            );

            return json(response, 200, { ok: true });
        }

        if (first === "themes" && second === "duplicate" && method === "POST") {
            app.policy.requireManagesServer(user);
            const body = await readJson<{ from?: unknown; name?: unknown; colors?: unknown }>(
                request,
            );

            if (typeof body.from !== "string") {
                throw new HttpError(400, "Say which theme or colors to copy");
            }

            return json(response, 200, {
                id: await app.themes.duplicate(body.from, body.name, body.colors === true),
            });
        }

        if (first === "themes" && second !== undefined && third === "fonts" && method === "PUT") {
            app.policy.requireManagesServer(user);
            app.themes.setFonts(
                second,
                await readJson<{ sans?: unknown; mono?: unknown; ligatures?: unknown }>(request),
            );

            return json(response, 200, { ok: true });
        }

        if (first === "themes" && second !== undefined && third === "edit" && method === "GET") {
            app.policy.requireManagesServer(user);

            return json(response, 200, app.themes.edit(second));
        }

        if (
            first === "themes" &&
            second !== undefined &&
            third === undefined &&
            method === "DELETE"
        ) {
            app.policy.requireManagesServer(user);
            app.themes.remove(second);

            return json(response, 200, { ok: true });
        }

        if (first === "theme" && second === "wallpaper" && method === "GET") {
            if (user.role !== "owner") {
                throw new HttpError(403, "Only the owner sees the desktop's wallpaper");
            }

            const file = await wallpaperFile();

            if (file === undefined) {
                throw new HttpError(404, "No wallpaper");
            }

            return serveImage(request, response, file);
        }

        if (first === "running" && second === "board" && method === "GET") {
            return json(response, 200, await runningBoard(app, user));
        }

        if (first === "running" && method === "GET") {
            return json(response, 200, await runningNow(app, user));
        }

        if (first === "spend" && method === "GET") {
            return json(response, 200, app.spend.summary(user));
        }

        if (first === "spend" && method === "POST") {
            const body = await readJson<{ session?: unknown; person?: unknown; budget?: unknown }>(
                request,
            );

            if (body.session !== undefined) {
                await app.spend.setSessionBudget(
                    user,
                    conversationId(String(body.session)),
                    body.budget,
                );
            } else if (typeof body.person === "string") {
                app.spend.setPersonBudget(user, body.person, body.budget);
            } else {
                throw new HttpError(400, "Say which session or person");
            }

            return json(response, 200, app.spend.summary(user));
        }

        if (first === "sessions" && second === undefined && method === "GET") {
            return json(response, 200, app.sessions(user));
        }

        if (first === "artifacts" && second === undefined && method === "GET") {
            return json(response, 200, await app.artifactOverview(user));
        }

        // Pi's sessions from the terminal, which the owner can continue here.
        if (first === "pi-sessions" && second === undefined && method === "GET") {
            return json(
                response,
                200,
                await app.piSessions.list(
                    user,
                    url.searchParams.get("q") ?? "",
                    url.searchParams.get("runner") ?? undefined,
                ),
            );
        }

        if (first === "pi-sessions" && second === "preview" && method === "GET") {
            const controller = new AbortController();

            response.on("close", () => {
                if (!response.writableEnded) {
                    controller.abort();
                }
            });

            return json(
                response,
                200,
                await app.piSessions.preview(
                    user,
                    url.searchParams.get("path") ?? "",
                    url.searchParams.get("runner") ?? undefined,
                    controller.signal,
                ),
            );
        }

        if (first === "pi-sessions" && second === "continue" && method === "POST") {
            const controller = new AbortController();

            response.on("close", () => {
                if (!response.writableEnded) {
                    controller.abort();
                }
            });

            const body = await readJson<{ path?: unknown; runner?: unknown }>(request);

            if (typeof body.path !== "string") {
                throw new HttpError(400, "path is required");
            }

            return json(
                response,
                200,
                await app.commands.continuePiSession(user, body.path, {
                    runner: optionalText(body.runner, "runner"),
                    signal: controller.signal,
                }),
            );
        }

        // The computers a person may use; the owner also sees every runner, to unlink one.
        if (first === "runners" && second === undefined && method === "GET") {
            return json(response, 200, app.runners.list(user));
        }

        /**
         * Answer a request for a new folder on this server (`folder-requests.ts`): its requester with their own code, or
         * withdraws it; the owner approves or denies it from the app. Anyone else learns nothing of it (404).
         */
        if (first === "folder-requests" && second !== undefined && method === "POST") {
            const body = await readJson<{
                code?: unknown;
                approve?: unknown;
                deny?: unknown;
            } | null>(request);

            if (body?.deny === true) {
                app.folderRequests.deny(user, second);
            } else if (body?.approve === true) {
                await app.folderRequests.approve(user, second, { method: "owner" });
            } else {
                await app.folderRequests.approve(user, second, {
                    method: "totp",
                    code: sixDigits(body?.code),
                });
            }

            return json(response, 200, { ok: true });
        }

        /**
         * Put away a project that waits for a trust decision (`trust-requests.ts`), without deciding: who is in charge of
         * its computer alone. It is answered in its session (`POST /api/c/:id/trust`). Anyone else learns nothing (404).
         */
        if (first === "trust-requests" && second !== undefined && method === "POST") {
            const body = await readJson<{ dismiss?: unknown } | null>(request);

            if (body?.dismiss !== true) {
                throw new HttpError(400, "Only dismissing a request is asked for here");
            }

            app.trustRequests.dismiss(user, second);

            return json(response, 200, { ok: true });
        }

        // This server's record (`ServerView`): its people, saved folders, and rules, for those who manage it.
        if (
            first === "runners" &&
            second === THIS_SERVER &&
            third === undefined &&
            method === "GET"
        ) {
            app.policy.requireManage(user, THIS_SERVER);

            return json(response, 200, app.thisServer(user));
        }

        // What guards linking (`link-limits.ts`): the owner's, and of who manages runners.
        if (first === "runners" && second === "locks" && third === undefined && method === "GET") {
            app.policy.requireManagesRunners(user);

            return json(response, 200, app.runners.linkLocks());
        }

        // Lift a ban on an address that guessed link codes (`link-limits.ts`).
        if (
            first === "runners" &&
            second === "bans" &&
            third === undefined &&
            method === "DELETE"
        ) {
            app.policy.requireManagesRunners(user);

            const address = url.searchParams.get("address") ?? "";

            app.runners.liftLinkBan(address);

            return json(response, 200, { ok: true });
        }

        // Who may link computers: the owner, and the guests the owner lets (`access.ts` `mayLink`). Linking one again is
        // its linker's.
        if (first === "runners" && second === "code" && method === "POST") {
            if (!app.policy.mayLink(user)) {
                throw new HttpError(403, "You do not have the Link runners permission.");
            }

            const body = await readJson<{ name?: unknown; runner?: unknown }>(request);

            if (typeof body.runner === "string") {
                app.runners.require(body.runner);
                app.policy.requireManage(user, body.runner);
            }

            return json(
                response,
                200,
                app.runners.makeCode(
                    typeof body.name === "string" ? body.name : "",
                    user.id,
                    typeof body.runner === "string" ? body.runner : undefined,
                ),
            );
        }

        if (
            first === "runners" &&
            second !== undefined &&
            third === undefined &&
            method === "DELETE"
        ) {
            if (second === THIS_SERVER) {
                throw new HttpError(400, "This server cannot be removed.");
            }

            app.runners.require(second);
            app.policy.requireUnlink(user, second);
            await app.unlinkRunner(second);

            return json(response, 200, { ok: true });
        }

        // Who may use a computer: for who is in charge of it to choose (`access.ts` `mayManage`). Either the whole list
        // (`users`), or one person chosen or no longer (`person` and `on`), which leaves the others as they are now.
        if (first === "runners" && second !== undefined && third === "users" && method === "POST") {
            if (second !== THIS_SERVER) {
                app.runners.require(second);
            }

            app.policy.requireManage(user, second);

            const body = await readJson<{
                users?: unknown;
                person?: unknown;
                on?: unknown;
            } | null>(request);

            if (typeof body?.person === "string" && typeof body.on === "boolean") {
                await app.choosePerson(second, body.person, body.on);
            } else if (
                Array.isArray(body?.users) &&
                body.users.every((id) => typeof id === "string")
            ) {
                await app.choosePeople(second, body.users as string[]);
            } else {
                throw new HttpError(
                    400,
                    "users must be a list of person ids; or send person, with on true or false.",
                );
            }

            return json(
                response,
                200,
                second === THIS_SERVER
                    ? app.thisServer(user)
                    : app.runners.list(user).find((runner) => runner.id === second),
            );
        }

        /**
         * A computer's settings kept here: "Default sharing" (`shareNew`) for any computer; for a runner, whether its
         * sessions' browsers use its network, and where their downloads go there. Its linker's and the owner's. A runner
         * gets its settings at once (`runner-settings`).
         */
        if (
            first === "runners" &&
            second !== undefined &&
            third === "settings" &&
            method === "POST"
        ) {
            if (second !== THIS_SERVER) {
                app.runners.require(second);
            }

            app.policy.requireManage(user, second);

            const body = await readJson<{
                shareNew?: unknown;
                network?: unknown;
                downloads?: unknown;
            } | null>(request);
            const change: ComputerSettings = {};

            if (body?.shareNew !== undefined) {
                if (typeof body.shareNew !== "boolean") {
                    throw new HttpError(400, "shareNew must be true or false.");
                }

                change.shareNew = body.shareNew;
            }

            if (second !== THIS_SERVER && body?.network !== undefined) {
                if (typeof body.network !== "boolean") {
                    throw new HttpError(400, "network must be true or false.");
                }

                change.network = body.network;
            }

            if (second !== THIS_SERVER && body?.downloads !== undefined) {
                // An absolute folder on that computer (POSIX or Windows), or null for its temporary folder.
                if (
                    body.downloads !== null &&
                    (typeof body.downloads !== "string" ||
                        body.downloads.length > 1024 ||
                        !/^(\/|[A-Za-z]:[\\/])/.test(body.downloads))
                ) {
                    throw new HttpError(400, "downloads must be an absolute folder, or null.");
                }

                change.downloads = body.downloads;
            }

            app.config.setComputerSettings(second === THIS_SERVER ? undefined : second, change);

            if (second !== THIS_SERVER) {
                app.runners.link(second).sendSettings();
                app.runners.changed();
            }

            app.accessChanged();

            return json(
                response,
                200,
                second === THIS_SERVER
                    ? app.thisServer(user)
                    : app.runners.list(user).find((runner) => runner.id === second),
            );
        }

        // The folders the owner gives one chosen person on a computer (`access.ts`): the whole list, replaced.
        if (first === "runners" && second !== undefined && third === "given" && method === "POST") {
            const body = await readJson<{ person?: unknown; folders?: unknown } | null>(request);

            if (
                typeof body?.person !== "string" ||
                !Array.isArray(body.folders) ||
                !body.folders.every((each) => typeof each === "string")
            ) {
                throw new HttpError(400, "Send person and folders, a list of paths.");
            }

            await app.giveFolders(user, second, body.person, body.folders as string[]);

            return json(
                response,
                200,
                second === THIS_SERVER
                    ? app.thisServer(user)
                    : app.runners.list(user).find((runner) => runner.id === second),
            );
        }

        // One folder on a computer is given to one person, or taken back (`app.ts` `giveFolder`): by who is in charge
        // there, or by someone who gives a folder that was given to them (`access.ts` `mayGiveFolder`).
        if (first === "runners" && second !== undefined && third === "give" && method === "POST") {
            const body = await readJson<{
                person?: unknown;
                folder?: unknown;
                on?: unknown;
            } | null>(request);

            await app.giveFolder(user, second, body?.person, body?.folder, body?.on);

            return json(response, 200, { ok: true });
        }

        // One chosen person sees every session in one of their folders on a computer, or no longer (`app.ts` `seeFolder`).
        if (first === "runners" && second !== undefined && third === "sees" && method === "POST") {
            const body = await readJson<{
                person?: unknown;
                folder?: unknown;
                on?: unknown;
            } | null>(request);

            await app.seeFolder(user, second, body?.person, body?.folder, body?.on);

            // Who set it on a folder they gave, and is not in charge there, has no view of the computer.
            return json(
                response,
                200,
                (second === THIS_SERVER
                    ? app.thisServer(user)
                    : app.runners.list(user).find((runner) => runner.id === second)) ?? {
                    ok: true,
                },
            );
        }

        // One chosen person may take the wheel from a driver on a computer, allow their own calls there, or share what
        // they were given there, or no longer (`app.ts` `setRight`).
        if (
            first === "runners" &&
            second !== undefined &&
            third === "rights" &&
            method === "POST"
        ) {
            const body = await readJson<{
                person?: unknown;
                right?: unknown;
                on?: unknown;
            } | null>(request);

            app.setRight(user, {
                computer: second,
                person: body?.person,
                right: body?.right,
                on: body?.on,
            });

            return json(
                response,
                200,
                second === THIS_SERVER
                    ? app.thisServer(user)
                    : app.runners.list(user).find((runner) => runner.id === second),
            );
        }

        // The folders on another computer, for the folder picker of a new session there.
        if (first === "runners" && second !== undefined && third === "fs" && method === "GET") {
            if (!app.policy.mayBrowse(user, second)) {
                throw new HttpError(403, "You cannot use this computer.");
            }

            const given = app.policy.givenFolders(user, second);
            const requested = url.searchParams.get("path") ?? "~";
            // Someone given folders browses inside them only, judged by the real folder there: a link in a given folder
            // that leads out of it lists nothing. Anywhere else, the picker lists the folders given.
            const real =
                given === undefined ? requested : await app.runners.realPath(second, requested);
            const listing =
                given === undefined ||
                (real !== undefined && given.some((each) => inFolder(real, each)))
                    ? await app.runners.folders(
                          second,
                          real ?? requested,
                          url.searchParams.get("hidden") === "1",
                      )
                    : undefined;

            return json(response, 200, {
                ...(listing === undefined
                    ? givenListing(given ?? [])
                    : scopeListing(listing, given)),
                // The folders of this person's newest sessions on that computer.
                recent: app
                    .recentFolders(user, second)
                    .filter((each) => app.policy.mayUseFolder(user, second, each)),
            });
        }

        if (first === "sessions" && second === undefined && method === "POST") {
            const controller = new AbortController();

            response.on("close", () => {
                if (!response.writableEnded) {
                    controller.abort();
                }
            });

            const body = await readJson<{
                cwd?: string;
                title?: string;
                worktree?: unknown;
                runner?: unknown;
            }>(request);

            return json(
                response,
                200,
                await app.commands.createSession(user, body, {
                    signal: controller.signal,
                }),
            );
        }

        // Whom a session is shared with, and whom it can be: its starter's and the owner's to see (`access.ts` `mayShare`).
        if (first === "sessions" && second !== undefined && third === "share" && method === "GET") {
            return json(response, 200, app.commands.sharing(conversationId(second), user));
        }

        // Whom a session is shared with: its starter's and the owner's to change (`access.ts` `mayShare`).
        if (
            first === "sessions" &&
            second !== undefined &&
            third === "share" &&
            method === "POST"
        ) {
            const body = await readJson<{ people?: unknown }>(request);

            return json(response, 200, {
                sharedWith: await app.commands.shareSession(
                    conversationId(second),
                    user,
                    body.people,
                ),
            });
        }

        // Who is in charge of a session's computer takes that one session from one person (`app.ts` `revokeSession`).
        if (
            first === "sessions" &&
            second !== undefined &&
            third === "revoke" &&
            method === "POST"
        ) {
            const body = await readJson<{ person?: unknown } | null>(request);

            await app.revokeSession(user, conversationId(second), body?.person);

            return json(response, 200, { ok: true });
        }

        if (
            first === "sessions" &&
            second !== undefined &&
            method === "POST" &&
            (third === undefined || (third === "undo" && fourth === undefined))
        ) {
            const id = conversationId(second);

            if (third === "undo" && fourth === undefined) {
                app.requireSee(user, id);

                return conversationRoutes(route, id, parts);
            }

            const body = await readJson<{ title?: string; archived?: boolean; keepWarm?: unknown }>(
                request,
            );

            const { repeating } = await app.commands.updateSession(id, user, body);

            return json(response, 200, { ok: true, repeating });
        }

        if (first === "c" && second !== undefined) {
            const id = conversationId(second);

            app.requireSee(user, id);

            if (third === "browser") {
                return browserRoutes(
                    route,
                    id,
                    fourth,
                    "port" in options.listen ? options.listen.port : undefined,
                );
            }

            return conversationRoutes(route, id, parts);
        }

        if (first === "approvals" && second !== undefined && method === "POST") {
            const body = await readJson<{ allow?: boolean; values?: unknown }>(request);

            // An id may hold a slash, which the path decoded into a part of its own: a codemode script's calls are
            // named `<call>/<n>`. `values` answer an ask's fields (`host.ask`), and go to the asker alone.
            if (
                !(await app.answerApproval(
                    parts.slice(1).join("/"),
                    body.allow === true,
                    user,
                    body.values,
                ))
            ) {
                throw new HttpError(404, "That approval is no longer pending");
            }

            return json(response, 200, { ok: true });
        }

        // This server's folders, for the folder picker: whoever may start sessions here (`access.ts` `mayBrowse`).
        if (first === "fs" && method === "GET") {
            app.requireBrowse(user);

            const given = app.policy.givenFolders(user, THIS_SERVER);
            const asked = url.searchParams.get("path") || "~";
            // With no folder asked for, the picker opens in the home folder when that is theirs (someone given `/`),
            // else in the first folder given to them.
            const homeIsTheirs =
                given?.some((each) => inFolder(realpathOrSelf(homedir()), each)) === true;
            const requested =
                given !== undefined && asked === "~" && !homeIsTheirs ? (given[0] ?? asked) : asked;
            // Its real path, links followed: what the folders given are compared with, and what a session is saved by.
            const path = app.workspace.checkDirectory(requested);

            // Someone given folders browses inside them only: anywhere else, the picker lists the folders given.
            if (given !== undefined && !given.some((each) => inFolder(path, each))) {
                return json(response, 200, {
                    ...givenListing(given),
                    recent: app
                        .recentFolders(user, undefined)
                        .filter((each) => app.policy.mayUseFolder(user, THIS_SERVER, each)),
                });
            }

            const showHidden = url.searchParams.get("hidden") === "1";
            const dirs: { name: string; path: string }[] = [];
            let entries;

            try {
                entries = readdirSync(path, { withFileTypes: true });
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;

                if (code === "EACCES" || code === "EPERM") {
                    throw new HttpError(403, `Pi Pocket cannot read ${path}.`);
                }

                throw error;
            }

            for (const entry of entries) {
                if (!showHidden && entry.name.startsWith(".")) {
                    continue;
                }

                let isDir = entry.isDirectory();

                if (entry.isSymbolicLink()) {
                    try {
                        isDir = statSync(join(path, entry.name)).isDirectory();
                    } catch {
                        isDir = false;
                    }
                }

                if (isDir) {
                    dirs.push({ name: entry.name, path: join(path, entry.name) });
                }
            }

            dirs.sort((a, b) => a.name.localeCompare(b.name));
            // The folders of this person's newest sessions here: another computer's folders are not on this one.
            const recent = app
                .recentFolders(user, undefined)
                .filter((each) => app.policy.mayUseFolder(user, THIS_SERVER, each));

            return json(response, 200, {
                ...scopeListing(
                    {
                        path,
                        parent: parentFolder(path),
                        home: homedir(),
                        // This machine's top folders: `/`, or each Windows drive, as places to start from.
                        roots: await machineRoots(),
                        dirs: dirs.slice(0, 1000),
                    },
                    given === undefined ? undefined : given.map(realpathOrSelf),
                ),
                recent,
            });
        }

        // A new folder, from the folder picker: it opens in the picker, ready to use.
        if (first === "fs" && second === undefined && method === "POST") {
            const body = await readJson<{ path?: unknown }>(request);

            if (typeof body.path !== "string") {
                throw new HttpError(400, "Name the folder to make.");
            }

            return json(response, 200, { path: app.workspace.makeFolder(user, body.path) });
        }

        if (first === "settings" && method === "POST") {
            const body = await readJson<{
                approvalRule?: unknown;
                defaultModel?: unknown;
                pipCompactAt?: unknown;
                subagentModels?: unknown;
                limitWaitHours?: unknown;
            }>(request);

            // One at a time: a second that fails must not leave the first changed.
            if (
                [
                    body.approvalRule,
                    body.defaultModel,
                    body.pipCompactAt,
                    body.subagentModels,
                    body.limitWaitHours,
                ].filter((value) => value !== undefined).length > 1
            ) {
                throw new HttpError(400, "Change one setting at a time.");
            }

            // The models subagents may run on (access checked in `app.ts`).
            if (body.subagentModels !== undefined) {
                await app.setSubagentModels(user, body.subagentModels);
            }

            if (body.pipCompactAt !== undefined) {
                await app.setPipCompactAt(user, body.pipCompactAt);
            }

            // How long a run waits for a provider's limit to clear (access checked in `app.ts`).
            if (body.limitWaitHours !== undefined) {
                await app.setLimitWaitHours(user, body.limitWaitHours);
            }

            if (body.approvalRule !== undefined) {
                await app.setApprovalRule(user, body.approvalRule);
            }

            // Null clears it: new sessions start with the last model picked again.
            if (body.defaultModel !== undefined) {
                await app.setDefaultModel(user, body.defaultModel);
            }

            return json(response, 200, { ok: true });
        }

        // Keep warm's settings window: every setting, model lifetimes, and what is warm now.
        if (first === "keep-warm" && second === undefined && method === "GET") {
            return json(response, 200, app.keepWarm.overview(user));
        }

        if (first === "keep-warm" && second === undefined && method === "POST") {
            await app.keepWarm.setSettings(user, await readJson<unknown>(request));

            return json(response, 200, app.keepWarm.overview(user));
        }

        // One model allowed for subagents, or no longer: the rest stay as they are (access checked in `app.ts`).
        if (first === "subagent-models" && second === undefined && method === "POST") {
            const body = await readJson<{ model?: unknown; allowed?: unknown }>(request);

            return json(response, 200, {
                subagentModels: await app.allowSubagentModel(user, body.model, body.allowed),
            });
        }

        // Routes extension modules add, each checking who may use it (`extension-routes.ts`).
        if (first === "x" && second !== undefined) {
            return extensionRoute(route, parts.slice(1));
        }

        // Fetch the LANCET model Lancet Guard needs. Answers at once; the download goes on and shows in the guard's status.
        if (first === "guard" && second === "model" && third === undefined && method === "POST") {
            await app.setupGuardModel(user);

            return json(response, 200, await app.extensions(user));
        }

        // Server managers set a module's settings (`web.settings`); its browser module's users can also read them.
        if (first === "extension-settings" && second !== undefined && third === undefined) {
            if (method === "GET") {
                return json(response, 200, app.extensionSettings(user, second));
            }

            if (method === "PUT") {
                app.policy.requireManagesServer(user);

                return json(
                    response,
                    200,
                    app.setExtensionSettings(user, second, await readJson(request)),
                );
            }
        }

        if (first === "extensions" && second === undefined && method === "GET") {
            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "extensions" &&
            second !== undefined &&
            third === undefined &&
            method === "POST"
        ) {
            app.policy.requireManagesServer(user);
            const body = await readJson<{ enabled?: unknown }>(request);

            if (typeof body.enabled !== "boolean") {
                throw new HttpError(400, "enabled must be true or false");
            }

            await app.setExtensionEnabled(user, second, body.enabled);

            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "extensions" &&
            second !== undefined &&
            third === "reload" &&
            method === "POST"
        ) {
            app.policy.requireManagesServer(user);
            await app.reloadExtension(second);

            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "models" &&
            second === "refresh" &&
            third === undefined &&
            method === "POST"
        ) {
            app.policy.requireManagesServer(user);

            return json(response, 200, await app.providers.modelRefresh.refresh());
        }

        // OpenAI-compatible endpoints in Pi's models.json hold keys and decide models.
        if (first === "custom-providers") {
            app.policy.requireManagesServer(user);
            const providers = app.customProviders;

            if (second === undefined && method === "GET") {
                return json(response, 200, providers.list());
            }

            if (second === undefined && method === "POST") {
                return json(response, 200, await providers.create(await readJson(request)));
            }

            if (second === "discover" && third === undefined && method === "POST") {
                return json(response, 200, {
                    models: await providers.discover(await readJson(request)),
                });
            }

            if (second !== undefined && third === undefined && method === "PUT") {
                return json(response, 200, await providers.update(second, await readJson(request)));
            }

            if (second !== undefined && third === undefined && method === "DELETE") {
                await providers.remove(second);

                return json(response, 200, { ok: true });
            }
        }

        // Ask each subscription afresh for people who manage the server (three seconds at most; a mark found later
        // comes with the models). Others see what was last found, so they do not make the server ask providers.
        if (first === "providers" && second === undefined && method === "GET") {
            const managesServer = app.policy.managesServer(user);

            if (managesServer) {
                await app.providers.checkAll(3_000);
            }

            return json(response, 200, app.providers.list(managesServer));
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "login" &&
            method === "POST"
        ) {
            app.policy.requireManagesServer(user);
            const body = await readJson<{ type?: string }>(request);

            return json(response, 200, {
                flowId: app.providers.startLogin(
                    user,
                    second,
                    body.type === "oauth" ? "oauth" : "api_key",
                ),
            });
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "logout" &&
            method === "POST"
        ) {
            app.policy.requireManagesServer(user);
            await app.providers.logout(second);

            return json(response, 200, { ok: true });
        }

        if (first === "auth" && second !== undefined && third === "cancel" && method === "POST") {
            app.providers.cancelLogin(user, second);

            return json(response, 200, { ok: true });
        }

        if (first === "auth" && second !== undefined && third !== undefined && method === "POST") {
            const body = await readJson<{ value?: string; cancel?: boolean }>(request);

            app.providers.answerLogin(
                user,
                second,
                third,
                body.cancel === true ? undefined : String(body.value ?? ""),
            );

            return json(response, 200, { ok: true });
        }

        if (first === "invite" && second === "cancel" && method === "POST") {
            const body = (await readJson(request)) as { code?: unknown };

            if (typeof body.code !== "string") {
                throw new HttpError(400, "Say which invite.");
            }

            // Only whoever made it ends it; for anyone else it stays as it was, and nothing says whether it exists.
            auth.cancelInvite(body.code, user);

            return json(response, 200, { ok: true });
        }

        if (first === "invite" && second === undefined && method === "POST") {
            const body = (await readJson(request)) as {
                role?: unknown;
                session?: unknown;
                folder?: unknown;
                minutes?: unknown;
                temporary?: unknown;
                accountMinutes?: unknown;
            };
            const grant = inviteGrant(user, body);
            const invite = auth.createInvite(user, grant, inviteMinutes(body));

            return json(response, 200, { ...(await shownInvite(request, user, invite)), grant });
        }

        // A one-time sign-in link for a window of the desktop app, which asks with the owner's token (docs/desktop-app.md).
        if (first === "sign-in-link" && second === undefined && method === "POST") {
            requireOwner(user);

            return json(response, 200, {
                path: `/login?once=${auth.createSignInLink()}`,
                expiresInMs: SIGN_IN_LINK_MS,
            });
        }

        if (first === "restart" && method === "POST") {
            app.policy.requireManagesServer(user);

            if (!app.supervised) {
                throw new HttpError(
                    409,
                    "Start Pi Pocket with bin/pi-pocket.js to restart from the app.",
                );
            }

            json(response, 200, { ok: true });
            setTimeout(() => options.restart(), 100);

            return;
        }

        throw new HttpError(404, "Unknown API route");
    };
}
