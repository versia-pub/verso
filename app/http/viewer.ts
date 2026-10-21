/**
 * Who is calling, by their access token, and what they may do.
 * @module
 */
import type { Context as HonoContext } from "@hono/hono";
import type { Permissions } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import { type Cidr, parseIp } from "../kernel/ip.ts";
import type { Permission } from "../kernel/permissions.ts";
import { grants } from "../kernel/scopes.ts";
import { clientIp } from "./client_ip.ts";
import type { AppEnv, AppServices } from "./env.ts";
import { Forbidden, NotPermitted, Unauthorized, UserRequired } from "./errors.ts";
import type { Route, RouteViewer, Viewer } from "./route.ts";

/**
 * Who is calling, checked against the route's `auth` as Mastodon checks it. A token sent where none
 * is needed is ignored; on other routes, a token sent must be valid.
 */
export const viewerOf = async (
    ctx: Context,
    c: HonoContext<AppEnv>,
    route: Route,
    services: AppServices,
): Promise<Viewer | undefined> => {
    if (!route.auth) return undefined;

    if (c.req.header("authorization") === undefined && route.auth.require === "optional") {
        return undefined;
    }

    const viewer = await bearerOf(ctx, c, services);

    if (!viewer) throw new Unauthorized();
    if (route.auth.require === "user" && viewer.accountId === null) throw new UserRequired();
    if (route.auth.scope && !grants(viewer.scopes, route.auth.scope)) throw new Forbidden();

    return viewer;
};

/**
 * The viewer, able to say what it may do: a user, what every user may and their roles allow, and
 * anyone else, such as an app acting for itself, what anonymous visitors may. That is looked up
 * once, the first time something asks.
 */
export const withPermissions = (
    ctx: Context,
    viewer: Viewer,
    permissions: Permissions,
    services: AppServices,
): RouteViewer => {
    let granted: Promise<ReadonlySet<Permission>> | undefined;

    return {
        ...viewer,
        permissions: () =>
            granted ??= viewer.accountId === null
                ? Promise.resolve(new Set(permissions.anonymous))
                : services.permissionsOf(ctx, viewer.accountId, permissions.default),
    };
};

/**
 * Throws unless the viewer, or an anonymous visitor if there is none, may do what `route` needs.
 */
export const checkPermission = async (
    route: Route,
    viewer: RouteViewer | undefined,
    permissions: Permissions,
): Promise<void> => {
    const needed = route.auth?.permission;
    if (needed === undefined) return;

    const granted = viewer ? await viewer.permissions() : new Set(permissions.anonymous);
    if (!granted.has(needed)) throw new NotPermitted();
};

/**
 * The viewer the request's bearer token stands for, if it is valid. It is looked up once, though
 * both the rate limit and the route ask.
 */
const bearerOf = (ctx: Context, c: HonoContext<AppEnv>, services: AppServices) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (token === undefined) return Promise.resolve(undefined);

    const bearer = c.get("bearer") ?? services.authenticate(ctx, token);
    c.set("bearer", bearer);

    return bearer;
};

/**
 * Who a request counts against: the user its access token is for, or else the client's IP address.
 * Every token of a user counts as theirs, and an app's own tokens, which any app can make, as their
 * client, so making more tokens doesn't give more requests. A token that isn't valid doesn't count
 * either, or a client could send a new made-up one each time.
 */
export const rateLimitKey = async (
    ctx: Context,
    c: HonoContext<AppEnv>,
    trustedProxies: readonly Cidr[],
    services: AppServices,
): Promise<string> => {
    const viewer = await bearerOf(ctx, c, services);
    if (viewer?.accountId) return `account:${viewer.accountId}`;

    const peer = c.env?.remoteAddr?.hostname ?? "unknown";
    const ip = clientIp(peer, c.req.header("x-forwarded-for"), trustedProxies);
    const address = parseIp(ip);

    // A machine is usually given a whole /64 of IPv6 addresses, so it counts as one client.
    return address?.bits === 128 ? `ip:${(address.value >> 64n).toString(16)}/64` : `ip:${ip}`;
};
