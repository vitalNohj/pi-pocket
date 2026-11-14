import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigStore, Role, User } from "./config.ts";

export const COOKIE = "pocket_auth";

/** How long an invite may last, in minutes: 15 minutes (the default, and always for an owner invite), an hour, a day, or a week. */
export const INVITE_MINUTES = [15, 60, 24 * 60, 7 * 24 * 60] as const;
export type InviteMinutes = (typeof INVITE_MINUTES)[number];

export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};

    for (const part of (header ?? "").split(";")) {
        const index = part.indexOf("=");

        if (index <= 0) {
            continue;
        }

        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();

        try {
            out[key] = decodeURIComponent(value);
        } catch {
            out[key] = value;
        }
    }

    return out;
}

/** https when the request came through TLS or a TLS-terminating tunnel such as ngrok or Tailscale Funnel. */
function isHttps(request: IncomingMessage): boolean {
    const forwarded = String(request.headers["x-forwarded-proto"] ?? "")
        .split(",")[0]
        ?.trim();

    return forwarded === "https" || (request.socket as { encrypted?: boolean }).encrypted === true;
}

export function origin(request: IncomingMessage): string {
    const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost");

    return `${isHttps(request) ? "https" : "http"}://${host}`;
}

/** The Cloudflare quick tunnel host a request came through, such as `abc-def.trycloudflare.com`, if it did. */
export function quickTunnelHost(request: IncomingMessage): string | undefined {
    const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "")
        .toLowerCase()
        .replace(/:\d+$/, "");

    return /^[a-z0-9-]+\.trycloudflare\.com$/.test(host) ? host : undefined;
}

export function setAuthCookie(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
): void {
    const parts = [
        `${COOKIE}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${60 * 60 * 24 * 365}`,
        ...(isHttps(request) ? ["Secure"] : []),
    ];

    response.setHeader("set-cookie", parts.join("; "));
}

export function clearAuthCookie(response: ServerResponse): void {
    response.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * What an invite grants: a role, and optionally a single session instead of all of them. An owner invite signs a device
 * in as the owner, with the owner's token: it is never for one session.
 */
export type InviteGrant =
    { role: Exclude<Role, "owner">; session?: string } | { role: "owner"; session?: never };

/** Invites live in `config.json` (by their codes' hashes), so one that lasts a day or a week outlives a restart. */
/**
 * May `creator` invite someone new, to session `session` alone or to this server: the app's access policy
 * (`access.ts` `mayInvite`). Without it, by role alone: no viewer, no one invited to one session.
 */
export type MayInvite = (creator: User, session?: string) => boolean;

const byRole: MayInvite = (creator) => creator.role !== "viewer" && creator.sessions === undefined;

export class Auth {
    readonly #config: ConfigStore;
    readonly #mayInvite: MayInvite;

    constructor(config: ConfigStore, mayInvite: MayInvite = byRole) {
        this.#config = config;
        this.#mayInvite = mayInvite;
    }

    user(request: IncomingMessage): User | undefined {
        const token = parseCookies(request.headers.cookie)[COOKIE];

        if (token === undefined || token === "") {
            const bearer = String(request.headers.authorization ?? "");

            if (bearer.startsWith("Bearer ")) {
                return this.#config.userByToken(bearer.slice(7).trim());
            }

            return undefined;
        }

        return this.#config.userByToken(token);
    }

    tokenUser(token: string): User | undefined {
        return this.#config.userByToken(token);
    }

    /** A new invite that lasts `minutes`; an owner invite always lasts 15, the least. */
    createInvite(
        by: User,
        grant: InviteGrant = { role: "guest" },
        minutes: InviteMinutes = 15,
    ): { code: string; expiresAt: number; minutes: InviteMinutes } {
        // Unambiguous characters, easy to type on a phone.
        const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
        const bytes = randomBytes(10);
        let code = "";

        for (const byte of bytes) {
            code += alphabet[byte % alphabet.length];
        }

        const lasts = grant.role === "owner" ? INVITE_MINUTES[0] : minutes;
        const expiresAt = Date.now() + lasts * 60_000;

        // Every invite but an owner's starts its person as a viewer: steering comes once they link an authenticator.
        if (grant.role !== "owner") {
            grant = { ...grant, role: "viewer" };
        }

        this.#config.addInvite(code, { ...grant, expiresAt, createdBy: by.id });

        return { code, expiresAt, minutes: lasts };
    }

    /** End an invite before its time, if `by` made it: when the sheet that showed it moves on to another. */
    cancelInvite(code: string, by: User): void {
        if (this.#config.invite(code)?.createdBy === by.id) {
            this.#config.removeInvite(code);
        }
    }

    /** The grant of a live invite, or undefined when it expired or was used. */
    invite(code: string): InviteGrant | undefined {
        const invite = this.#config.invite(code);

        if (invite === undefined) {
            return undefined;
        }

        return invite.role === "owner" || invite.session === undefined
            ? { role: invite.role }
            : { role: invite.role, session: invite.session };
    }

    inviteValid(code: string): boolean {
        return this.invite(code) !== undefined;
    }

    /**
     * Spend an invite on a new device: a user with the invite's role and scope, and its own token. An owner invite makes
     * no one new: the device gets the owner and the owner's token. Either way the invite is gone, used or not.
     */
    redeem(
        code: string,
        name: string,
    ): { user: User; token: string; invitedBy?: string } | undefined {
        const invite = this.#config.invite(code);

        if (invite === undefined || !this.#config.removeInvite(code)) {
            return undefined;
        }

        // The person who made it must still be allowed to: not removed, and still free to invite to what it grants.
        const creator = this.#config.userById(invite.createdBy);

        if (creator === undefined) {
            return undefined;
        }

        if (invite.role === "owner") {
            return creator.role === "owner"
                ? { user: creator, token: this.#config.ownerToken }
                : undefined;
        }

        if (!this.#mayInvite(creator, invite.session)) {
            return undefined;
        }

        const clean = name.replace(/\s+/g, " ").trim().slice(0, 40) || "Guest";
        // Every invite starts its person as a viewer, also one saved before this rule with another role: steering
        // takes their own authenticator and the owner's Let steer (`app.ts` `setAccess`).
        const added = this.#config.addUser(
            clean,
            "viewer",
            invite.session === undefined ? undefined : [invite.session],
        );

        // An invite to every session: the app shares the inviter's sessions with them (`app.ts` `welcome`).
        return invite.session === undefined ? { ...added, invitedBy: creator.id } : added;
    }
}
