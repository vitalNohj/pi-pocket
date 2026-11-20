import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigStore, Role, StoredInvite, User } from "./config.ts";
import { HttpError } from "./errors.ts";

export const COOKIE = "pocket_auth";

/**
 * How long an invite may last, in minutes: 15 minutes (the default, and always for a device link), an hour, a day, a
 * week, or a month (30 days).
 */
export const INVITE_MINUTES = [15, 60, 24 * 60, 7 * 24 * 60, 30 * 24 * 60] as const;
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
 * What an invite grants someone new: a role, and optionally a single session instead of the ones shared with them, or
 * only its maker's sessions in one folder of one computer instead of all of theirs.
 */
export type InviteGrant = {
    role: Exclude<Role, "owner">;
    session?: string;
    folder?: { computer: string; path: string };
    /** The account it makes is temporary (`config.ts` `User.temporary`). */
    temporary?: true;
};

/**
 * What a live code is for: someone new, or another device of someone here (a device link). `code`: that person has an
 * authenticator, so the device must give one of its codes too.
 */
export type Invite = InviteGrant | { device: User; code?: true };

/** Each person's authenticator, as a device link asks (`approval-methods.ts` `Authenticators`). */
export interface Codes {
    linked(person: string): boolean;
    check(person: string, code: string): boolean;
    refusal(person: string): HttpError;
}

/** A code that is easy to type on a phone: ten unambiguous characters. */
function newCode(): string {
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    let code = "";

    for (const byte of randomBytes(10)) {
        code += alphabet[byte % alphabet.length];
    }

    return code;
}

/** Invites live in `config.json` (by their codes' hashes), so one that lasts a day, a week, or a month outlives a restart. */
/**
 * May `creator` invite someone new, to session `session` alone or to this server: the app's access policy
 * (`access.ts` `mayInvite`). Without it, by role alone: the owner, and a guest the owner lets who is not invited to one
 * session.
 */
export type MayInvite = (creator: User, session?: string) => boolean;

const byRole: MayInvite = (creator) =>
    creator.role === "owner" ||
    (creator.role === "guest" && creator.invites === true && creator.sessions === undefined);

export class Auth {
    readonly #config: ConfigStore;
    readonly #mayInvite: MayInvite;
    readonly #codes: Codes | undefined;

    constructor(config: ConfigStore, mayInvite: MayInvite = byRole, codes?: Codes) {
        this.#config = config;
        this.#mayInvite = mayInvite;
        this.#codes = codes;
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

    /** A new invite for someone new, which lasts `minutes`. */
    createInvite(
        by: User,
        grant: InviteGrant = { role: "guest" },
        minutes: InviteMinutes = 15,
    ): { code: string; expiresAt: number; minutes: InviteMinutes } {
        const code = newCode();
        const expiresAt = Date.now() + minutes * 60_000;

        // Every invite starts its person as a viewer: steering comes once they link an authenticator.
        this.#config.addInvite(code, { ...grant, role: "viewer", expiresAt, createdBy: by.id });

        return { code, expiresAt, minutes };
    }

    /**
     * A device link: it signs another device in as `target` and makes no one new. The owner and users make one for
     * themselves; the owner makes one for someone else, who lost their device (`api.ts` checks who asks). It works
     * once and lasts 15 minutes: whoever opens it gets all that `target` has, after a code from their authenticator
     * when they have one (`redeem`).
     */
    createDeviceLink(
        by: User,
        target: User = by,
    ): { code: string; expiresAt: number; minutes: InviteMinutes } {
        const code = newCode();
        const minutes = INVITE_MINUTES[0];
        const expiresAt = Date.now() + minutes * 60_000;

        this.#config.addInvite(code, {
            device: true,
            ...(target.id === by.id ? {} : { person: target.id }),
            expiresAt,
            createdBy: by.id,
        });

        return { code, expiresAt, minutes };
    }

    /**
     * Who a device link signs in: whoever made it, or the person the owner made it for. Undefined when either is gone,
     * or when its maker is no longer the owner.
     */
    #devicePerson(invite: StoredInvite): User | undefined {
        const maker = this.#config.userById(invite.createdBy);

        if (maker === undefined) {
            return undefined;
        }

        if (invite.person === undefined || invite.person === maker.id) {
            return maker;
        }

        return maker.role === "owner" ? this.#config.userById(invite.person) : undefined;
    }

    /** End an invite before its time, if `by` made it: when the sheet that showed it moves on to another. */
    cancelInvite(code: string, by: User): void {
        if (this.#config.invite(code)?.createdBy === by.id) {
            this.#config.removeInvite(code);
        }
    }

    /** What a live code is for, or undefined when it expired, was used, or is a device link for someone removed. */
    invite(code: string): Invite | undefined {
        const invite = this.#config.invite(code);

        if (invite === undefined) {
            return undefined;
        }

        if (invite.device === true) {
            const device = this.#devicePerson(invite);

            if (device === undefined) {
                return undefined;
            }

            return this.#codes?.linked(device.id) === true ? { device, code: true } : { device };
        }

        // A temporary account, whatever else the invite is to (`config.ts` `User.temporary`).
        const temporary = invite.temporary === true ? { temporary: true as const } : {};

        if (invite.session !== undefined) {
            return { role: invite.role, session: invite.session, ...temporary };
        }

        return invite.folder === undefined
            ? { role: invite.role, ...temporary }
            : { role: invite.role, folder: invite.folder, ...temporary };
    }

    inviteValid(code: string): boolean {
        return this.invite(code) !== undefined;
    }

    /**
     * Spend an invite on a new device: a user with the invite's role and scope, and its own token. A device link makes
     * no one new: the device gets the person it is for, with a token of its own (`tunnel`: the Cloudflare quick
     * tunnel it came through, which that token is tied to). Either way the invite is gone, used or not.
     *
     * A device link for someone with an authenticator takes two codes: its own, and one from that authenticator
     * (`proof`). Without that one, or with a wrong one, this throws and the link stays for another try: a wrong code
     * counts toward their lockout (`approval-methods.ts`).
     */
    redeem(
        code: string,
        name: string,
        tunnel?: string,
        proof?: string,
    ):
        | {
              user: User;
              token: string;
              invitedBy?: string;
              folder?: { computer: string; path: string };
              device?: true;
          }
        | undefined {
        const invite = this.#config.invite(code);

        if (invite === undefined) {
            return undefined;
        }

        if (invite.device === true) {
            const person = this.#devicePerson(invite);

            if (person !== undefined && this.#codes?.linked(person.id) === true) {
                if (proof === undefined || proof === "") {
                    throw new HttpError(400, "Enter the code from your authenticator.");
                }

                if (!this.#codes.check(person.id, proof)) {
                    throw this.#codes.refusal(person.id);
                }
            }

            if (!this.#config.removeInvite(code) || person === undefined) {
                return undefined;
            }

            const token = this.#config.addDevice(person.id, tunnel);

            return token === undefined ? undefined : { user: person, token, device: true };
        }

        if (!this.#config.removeInvite(code)) {
            return undefined;
        }

        // The person who made it must still be allowed to: not removed, and still free to invite to what it grants.
        const creator = this.#config.userById(invite.createdBy);

        if (creator === undefined) {
            return undefined;
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
            invite.temporary === true,
        );

        if (invite.session !== undefined) {
            return added;
        }

        // An invite to every session, or to a folder's: the app shares the inviter's sessions with them (`app.ts`
        // `welcome`).
        return {
            ...added,
            invitedBy: creator.id,
            ...(invite.folder === undefined ? {} : { folder: invite.folder }),
        };
    }
}
