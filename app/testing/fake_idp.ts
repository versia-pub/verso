import { Hono } from "@hono/hono";
import { exportJWK, generateKeyPair, SignJWT } from "@panva/jose";
import { type Clock, systemClock } from "../kernel/clock.ts";

/** Who the fake identity provider says logged in: `sub` and any other ID token claims. */
export type Login = { readonly sub: string } & Readonly<Record<string, unknown>>;

export type FakeIdentityProvider = {
    /** Serve it at the issuer's host on a fake transport. */
    readonly app: Hono;
    readonly issuer: string;
    /** The next login is approved as this user. Set it before starting a login. */
    login: Login;
    /** Claims only the userinfo endpoint gives, about whoever logged in last. */
    userinfo: Readonly<Record<string, unknown>>;
};

export type FakeIdentityProviderOptions = {
    readonly issuer?: string;
    /** The one client allowed to log in. */
    readonly client: { readonly id: string; readonly secret: string };
    /** Sets the ID tokens' times. Defaults to the system clock. */
    readonly clock?: Clock;
    /** `false` leaves out the userinfo endpoint, as some issuers do. */
    readonly userinfo?: boolean;
};

type Grant = {
    readonly redirectUri: string;
    readonly codeChallenge: string;
    readonly nonce?: string;
    readonly login: Login;
};

const sha256 = async (text: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
        .toBase64({ alphabet: "base64url", omitPadding: true });

/**
 * An OpenID provider for tests: discovery, JWKS, an authorise endpoint that approves at once as
 * `login`, a token endpoint that checks the code, PKCE and client secret before signing an ID
 * token, and a userinfo endpoint. It only does what Verso's login needs: the code flow with S256
 * PKCE.
 */
export const createFakeIdentityProvider = async (
    options: FakeIdentityProviderOptions,
): Promise<FakeIdentityProvider> => {
    const issuer = options.issuer ?? "https://idp.test";
    const clock = options.clock ?? systemClock;
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "1", alg: "RS256", use: "sig" };
    const grants = new Map<string, Grant>();
    const accessTokens = new Map<string, Login>();
    const userinfo = options.userinfo ?? true;

    const app = new Hono();
    const idp: FakeIdentityProvider = { app, issuer, login: { sub: "alice" }, userinfo: {} };

    app.get("/.well-known/openid-configuration", (c) =>
        c.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            userinfo_endpoint: userinfo ? `${issuer}/userinfo` : undefined,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        }));

    app.get("/jwks", (c) => c.json({ keys: [jwk] }));

    app.get("/authorize", (c) => {
        const query = c.req.query();
        if (
            query.client_id !== options.client.id || query.response_type !== "code" ||
            !query.redirect_uri || query.code_challenge_method !== "S256" || !query.code_challenge
        ) {
            return c.text("Bad authorisation request", 400);
        }

        const code = crypto.randomUUID();
        grants.set(code, {
            redirectUri: query.redirect_uri,
            codeChallenge: query.code_challenge,
            nonce: query.nonce,
            login: idp.login,
        });

        const redirect = new URL(query.redirect_uri);
        redirect.searchParams.set("code", code);
        if (query.state) redirect.searchParams.set("state", query.state);
        return c.redirect(redirect.href);
    });

    app.post("/token", async (c) => {
        const form = await c.req.parseBody<Record<string, string>>();

        const basic = c.req.header("authorization")?.match(/^Basic (.+)$/)?.[1];
        const [id, secret] = basic
            ? atob(basic).split(":").map(decodeURIComponent)
            : [form.client_id, form.client_secret];
        if (id !== options.client.id || secret !== options.client.secret) {
            return c.json({ error: "invalid_client" }, 401);
        }

        // A code works once, for the redirect URI and PKCE verifier it was issued with.
        const grant = grants.get(form.code);
        grants.delete(form.code);
        if (
            form.grant_type !== "authorization_code" || !grant ||
            grant.redirectUri !== form.redirect_uri ||
            grant.codeChallenge !== await sha256(form.code_verifier ?? "")
        ) {
            return c.json({ error: "invalid_grant" }, 400);
        }

        const now = Math.floor(clock.now().getTime() / 1000);
        const idToken = await new SignJWT({ ...grant.login, nonce: grant.nonce })
            .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
            .setIssuer(issuer)
            .setAudience(options.client.id)
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .sign(privateKey);

        const accessToken = crypto.randomUUID();
        accessTokens.set(accessToken, grant.login);

        return c.json({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 300,
            id_token: idToken,
        });
    });

    if (userinfo) {
        app.get("/userinfo", (c) => {
            const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
            const login = accessTokens.get(token ?? "");
            if (!login) return c.json({ error: "invalid_token" }, 401);

            return c.json({ sub: login.sub, ...idp.userinfo });
        });
    }

    return idp;
};
