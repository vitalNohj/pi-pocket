/** The pages outside the app: signing in with a link, joining with an invite, and a share that arrived too early. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import { type Auth, type Invite, quickTunnelHost, setAuthCookie } from "../auth.ts";
import { HttpError } from "../errors.ts";
import { conversationId, escapeHtml, readBody, send } from "./io.ts";

/** A form posted from another site, as browsers report it. Such a post must not sign this browser in or out. */
function crossSite(request: IncomingMessage): boolean {
    const site = request.headers["sec-fetch-site"];

    return site !== undefined && site !== "same-origin" && site !== "none";
}

/** Where to go after signing in: a path on this server, never `//host` or `/\host`, which browsers read as another site. */
function localPath(next: string | null): string {
    return next !== null && /^\/(?![/\\])/.test(next) ? next : "/";
}

function page(title: string, body: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/style.css"></head><body class="plain-page"><main class="plain">${body}</main></body></html>`;
}

/** `/login`: sign this browser in with a token from a link, after asking when it would switch accounts. */
export async function login(
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
): Promise<void> {
    const posted = request.method === "POST";

    if (posted && crossSite(request)) {
        throw new HttpError(403, "Sign in from Pi Pocket's own page.");
    }

    const form = posted
        ? new URLSearchParams((await readBody(request, 10_000)).toString("utf8"))
        : url.searchParams;
    // A one-time link from the desktop app (`/login?once=…`) is spent here, whatever happens next.
    const once = form.get("once");
    const token = (once === null ? form.get("token") : auth.redeemSignInLink(once)) ?? "";
    const next = localPath(form.get("next"));
    const signingIn = auth.tokenUser(token);

    if (signingIn === undefined) {
        return send(
            response,
            401,
            page(
                "Pi Pocket",
                once === null
                    ? `<h1>Link expired</h1><p>That login link is not valid. Use the link Pi Pocket prints when it starts, or ask someone signed in for a new invite.</p>`
                    : `<h1>Link expired</h1><p>This one-time sign-in link was used already, or it is more than a minute old. Open Pi Pocket again from its icon in the menu bar or the notification area.</p>`,
            ),
            "text/html; charset=utf-8",
        );
    }

    const current = auth.user(request);

    // The question below would put the token in the page. A one-time link is the owner's own app window, which signs in
    // as the owner, so it switches without asking.
    if (!posted && once === null && current !== undefined && current.id !== signingIn.id) {
        // Signed in as someone else: switching takes a tap, so a link on another site cannot do it unnoticed.
        return send(
            response,
            200,
            page(
                "Switch account? · Pi Pocket",
                `<h1>Switch account?</h1><p>This browser is signed in as ${escapeHtml(current.name)}. The link you opened signs it in as ${escapeHtml(signingIn.name)} instead.</p><form method="post" action="/login"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">Sign in as ${escapeHtml(signingIn.name)}</button></form><p><a href="/">Stay signed in as ${escapeHtml(current.name)}</a></p>`,
            ),
            "text/html; charset=utf-8",
            { "referrer-policy": "no-referrer" },
        );
    }

    setAuthCookie(request, response, token);
    response.writeHead(303, { location: next });
    response.end();

    return;
}

/**
 * A device link's page: who this device signs in as, a field for a code from their authenticator when they have one,
 * and why the last try was refused.
 */
function devicePage(
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    grant: Extract<Invite, { device: unknown }>,
    refused?: HttpError,
): void {
    const person = grant.device;
    const name = escapeHtml(person.name);
    const current = auth.user(request);
    // Signed in as someone else: say so, as switching accounts does.
    const switching =
        current !== undefined && current.id !== person.id
            ? `<p>This browser is signed in as ${escapeHtml(current.name)}. It will change to ${name}.</p>`
            : "";
    const gets =
        person.role === "owner"
            ? "It gets full control of Pi Pocket and of this machine."
            : "It sees and does all that they can here.";
    const error =
        refused === undefined
            ? ""
            : `<p class="error-box" role="alert">${escapeHtml(refused.message)}</p>`;
    // The second code: the link's own is in the address already.
    const code =
        grant.code === true
            ? `<label>Code from ${name}'s authenticator app<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus placeholder="123456"></label>`
            : "";

    return send(
        response,
        refused?.status ?? 200,
        page(
            `Sign in as ${name} · Pi Pocket`,
            `<h1>Sign in as ${name}</h1><p>This device will sign in as ${name}${person.role === "owner" ? ", the owner" : ""}. ${gets} Go on only if you are ${name}.</p>${switching}${error}<form method="post">${code}<button type="submit">Sign in as ${name}</button></form>`,
        ),
        "text/html; charset=utf-8",
        { "referrer-policy": "no-referrer" },
    );
}

/**
 * `/join/:code`: what an invite grants, and redeeming it with a name; or, for a device link, who this device signs in
 * as, and signing it in (with a code from their authenticator, when they have one).
 */
export async function join(
    app: PocketApp,
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    code: string,
): Promise<void> {
    if (request.method === "POST") {
        if (crossSite(request)) {
            throw new HttpError(403, "Join from Pi Pocket's own page.");
        }

        const form = new URLSearchParams((await readBody(request, 10_000)).toString("utf8"));
        const tunnel = quickTunnelHost(request);
        let redeemed: ReturnType<Auth["redeem"]>;

        try {
            redeemed = auth.redeem(
                code,
                form.get("name") ?? "",
                tunnel,
                (form.get("code") ?? "").replace(/\s+/g, ""),
            );
        } catch (error) {
            const grant = auth.invite(code);

            // A device link whose second code was missing or wrong stays: its page says why, for another try.
            if (!(error instanceof HttpError) || grant === undefined || !("device" in grant)) {
                throw error;
            }

            return devicePage(auth, request, response, grant, error);
        }

        if (redeemed === undefined) {
            return send(
                response,
                410,
                page("Pi Pocket", "<h1>Invite expired</h1><p>Ask for a new one.</p>"),
                "text/html; charset=utf-8",
            );
        }

        if (redeemed.invitedBy !== undefined) {
            await app.welcome(redeemed.user.id, redeemed.invitedBy, {
                ...(redeemed.folder === undefined ? {} : { folder: redeemed.folder }),
                ...(redeemed.chosen === undefined ? {} : { chosen: redeemed.chosen }),
            });
        }

        // Someone new is tied to the tunnel they joined through. Another device of someone here is tied to it alone
        // (`redeem`), never the person.
        if (tunnel !== undefined && redeemed.device !== true && redeemed.user.role !== "owner") {
            app.config.updateUser(redeemed.user.id, { tunnel });
        }

        setAuthCookie(request, response, redeemed.token);
        response.writeHead(303, { location: "/" });
        response.end();

        return;
    }

    const grant = auth.invite(code);

    if (grant === undefined) {
        return send(
            response,
            410,
            page(
                "Pi Pocket",
                "<h1>Invite expired</h1><p>Each invite works once, and only until it expires. Ask for a new one.</p>",
            ),
            "text/html; charset=utf-8",
        );
    }

    if ("device" in grant) {
        return devicePage(auth, request, response, grant);
    }

    const where =
        grant.session !== undefined
            ? `the session “${escapeHtml(await app.conversationTitle(conversationId(grant.session)))}”`
            : grant.chosen !== undefined
              ? grant.chosen.length === 1
                  ? "the session chosen for you"
                  : `the ${String(grant.chosen.length)} sessions chosen for you`
              : grant.folder !== undefined
                ? `the sessions shared with you in the folder ${escapeHtml(grant.folder.path)}`
                : "the sessions shared with you on this server";
    const can =
        grant.role === "viewer"
            ? `read ${where} and chat with the people there, but not steer Pi`
            : `read and steer ${where}. Pi can run commands on this machine`;

    return send(
        response,
        200,
        page(
            "Join Pi Pocket",
            `<h1>Join Pi Pocket</h1><p>This device will be able to ${can}.</p><form method="post"><label>Your name<input name="name" maxlength="40" autofocus required placeholder="e.g. Alex"></label><button type="submit">Join</button></form>`,
        ),
        "text/html; charset=utf-8",
    );
}

/** `/share`: a share that reached the server, before the service worker that takes shares was installed here. */
export function sharePage(response: ServerResponse): void {
    return send(
        response,
        200,
        page(
            "Share to Pi",
            `<h1>Open Pi Pocket first</h1><p>Sharing works once Pi Pocket has been opened on this device over https. Open it, then share again.</p><p><a href="/">Open Pi Pocket</a></p>`,
        ),
        "text/html; charset=utf-8",
    );
}
