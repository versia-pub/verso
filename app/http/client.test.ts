import { assert, assertEquals, assertRejects } from "@std/assert";
import { ApiError, Client, createPkce } from "@versia/client-api";
import { encode } from "fast-png";
import { createLocalAccount } from "../accounts/testing.ts";
import { oidcProvider } from "../auth/oidc.ts";
import { formTokenIn, tokenFor } from "../auth/testing.ts";
import { defaultSettings } from "../instances/testing.ts";
import { queues } from "../jobs/queues.ts";
import { indexUnindexedAccounts } from "../search/accounts.ts";
import { drain } from "../jobs/worker.ts";
import { fakeClock } from "../kernel/clock.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import type { IssuerConfig } from "../kernel/identity.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { createFakeIdentityProvider } from "../testing/fake_idp.ts";
import { routes } from "./routes.ts";

const issuer: IssuerConfig = {
    name: "Example ID",
    url: "https://idp.test",
    client_id: "verso",
    client_secret: "s3cret",
    username_claim: "preferred_username",
    scopes: [],
    registration: "open",
    roles: [],
};

/** Verso, with every route, and `@versia/client-api`'s client for it, as nobody. */
const open = async (settings = defaultSettings()) => {
    const clock = fakeClock();
    const idp = await createFakeIdentityProvider({
        client: { id: "verso", secret: "s3cret" },
        clock,
    });
    const transport = fakeTransport({ "idp.test": idp.app.fetch });
    const test = await createTestContext({
        clock,
        transport,
        identityProviders: { [issuer.url]: oidcProvider(issuer, { transport, clock }) },
    });
    const verso = createTestApp(test.ctx, routes(settings), { checkResponses: true });
    const client = new Client("https://social.example", {
        fetch: async (input, init) => await verso.request(new Request(input, init)),
    });

    /** A browser that sends Verso's requests to Verso and the rest to the network, with cookies. */
    let cookie = "";
    const browse = async (url: URL | string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (cookie) headers.set("cookie", cookie);

        const request = new Request(url, { ...init, headers });
        const response = new URL(url).host === "social.example"
            ? await verso.request(request)
            : await transport(request);

        const set = /(__Host-oauth_flow=[^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
        if (set !== undefined) cookie = set;

        return response;
    };

    /** The client, as `accountId`. */
    const as = async (accountId: string) =>
        client.withToken(await tokenFor(test.ctx, await createLocalAccount(test.ctx, accountId)));

    return { ...test, idp, client, browse, as };
};

const locationOf = (response: Response) => response.headers.get("location") ?? "";

/** A `width`×`height` PNG, entirely red. */
const png = (width: number, height: number) =>
    new Uint8Array(encode({
        width,
        height,
        data: new Uint8Array(width * height * 4).map((_, i) => [200, 30, 30, 255][i % 4]),
        channels: 4,
    }));

Deno.test("an app registers, logs a user in with PKCE, acts as them, and revokes", async () => {
    await using test = await open();
    test.idp.login = { sub: "u1", preferred_username: "alice" };

    const app = await test.client.oauth.registerApp({
        client_name: "Phanpy",
        redirect_uris: ["https://phanpy.example/back"],
        scopes: ["read", "write"],
    });
    const pkce = await createPkce();
    const authorize = test.client.oauth.authorizationUrl({
        client_id: app.client_id,
        redirect_uri: "https://phanpy.example/back",
        scopes: ["read", "write"],
        state: "xyz",
        code_challenge: pkce.challenge,
    });

    // The browser goes to the issuer, back to Verso, to the consent page, and allows the app.
    const toIssuer = await test.browse(authorize);
    const fromIssuer = await test.browse(locationOf(toIssuer));
    const toConsent = await test.browse(locationOf(fromIssuer));
    const consent = await (await test.browse(locationOf(toConsent))).text();
    const allowed = await test.browse("https://social.example/oauth/consent", {
        method: "POST",
        body: new URLSearchParams({ decision: "allow", form_token: formTokenIn(consent) }),
    });
    const back = new URL(locationOf(allowed));
    assertEquals(back.searchParams.get("state"), "xyz");

    const credentials = { client_id: app.client_id, client_secret: app.client_secret };
    const token = await test.client.oauth.exchangeCode(credentials, {
        code: back.searchParams.get("code") ?? "",
        redirect_uri: "https://phanpy.example/back",
        code_verifier: pkce.verifier,
    });
    const alice = test.client.withToken(token.access_token);

    assertEquals(token.scope, "read write");
    assertEquals((await alice.oauth.verifyApp()).name, "Phanpy");
    assertEquals((await alice.accounts.verifyCredentials()).username, "alice");

    await test.client.oauth.revoke(credentials, token.access_token);
    const error = await assertRejects(() => alice.accounts.verifyCredentials(), ApiError);
    assertEquals(error.status, 401);
});

Deno.test("an app gets a token for itself, which acts for no user", async () => {
    await using test = await open();

    const metadata = await test.client.oauth.metadata();
    const app = await test.client.oauth.registerApp({
        client_name: "Bot",
        redirect_uris: ["urn:ietf:wg:oauth:2.0:oob"],
    });
    const token = await test.client.oauth.appToken(app, ["read"]);
    const bot = test.client.withToken(token.access_token);

    assertEquals(metadata.token_endpoint, "https://social.example/oauth/token");
    assertEquals((await bot.oauth.verifyApp()).name, "Bot");
    assertEquals(
        (await assertRejects(() => bot.accounts.verifyCredentials(), ApiError)).status,
        422,
    );
});

Deno.test("the instance's own pages all match their schemas", async () => {
    const settings = defaultSettings();
    const document = { text: "Be kind.", updated: new Date("2026-01-01") };
    await using test = await open({
        ...settings,
        instance: {
            ...settings.instance,
            rules: [{ text: "Be kind", hint: "" }],
            extended_description: document,
            privacy_policy: document,
            terms_of_service: document,
        },
    });

    assertEquals((await test.client.instance.get()).domain, "social.example");
    assertEquals((await test.client.instance.getV1()).uri, "social.example");
    assertEquals((await test.client.instance.rules()).map((rule) => rule.text), ["Be kind"]);
    assertEquals((await test.client.instance.extendedDescription()).content, "<p>Be kind.</p>");
    assertEquals((await test.client.instance.privacyPolicy()).content, "<p>Be kind.</p>");
    assertEquals((await test.client.instance.termsOfService()).effective, true);
    assertEquals(
        (await test.client.instance.termsOfService("2026-01-01")).effective_date,
        "2026-01-01",
    );
});

Deno.test("a user posts, edits, reads back and deletes a status", async () => {
    await using test = await open();
    const alice = await test.as("alice");

    const posted = await alice.statuses.post({
        status: "Hello *world*",
        content_type: "text/markdown",
    });
    const edited = await alice.statuses.edit(posted.id, { status: "Hello again" });
    const source = await alice.statuses.source(posted.id);

    assertEquals((await test.client.statuses.get(posted.id)).content, edited.content);
    assertEquals([source.text, source.content_type], ["Hello again", "text/markdown"]);
    assertEquals((await alice.statuses.delete(posted.id)).text, "Hello again");
    assertEquals(
        (await assertRejects(() => test.client.statuses.get(posted.id), ApiError)).status,
        404,
    );
});

Deno.test("an account's statuses come a page at a time, and iterate across pages", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    for (const text of ["one", "two", "three"]) await alice.statuses.post({ status: text });
    const { id } = await test.client.accounts.lookup("alice");

    const first = await test.client.accounts.statuses(id, { limit: 2 });
    const all = [];
    for await (const status of first) all.push(status.content);

    assertEquals(first.items.length, 2);
    assertEquals(all, ["<p>three</p>", "<p>two</p>", "<p>one</p>"]);
    assertEquals((await test.client.accounts.get(id)).acct, "alice");
});

Deno.test("a user uploads a picture, describes it, and attaches it once processed", async () => {
    await using test = await open();
    const alice = await test.as("alice");

    const file = new File([png(8, 8)], "red.png", { type: "image/png" });
    const uploaded = await alice.media.upload({ file, description: "Red", focus: "0.5,0" });
    assertEquals(uploaded.url, null);

    await drain(test.ctx, queues);
    const processed = await alice.media.get(uploaded.id);
    const described = await alice.media.update(uploaded.id, { description: "A red square" });
    const posted = await alice.statuses.post({ media_ids: [uploaded.id] });

    assert(processed.url !== null);
    assertEquals(described.description, "A red square");
    assertEquals(posted.media_attachments.map((media) => media.id), [uploaded.id]);
});

Deno.test("a user changes their profile as JSON, or as a form with a picture", async () => {
    await using test = await open();
    const alice = await test.as("alice");

    const named = await alice.accounts.updateCredentials({
        display_name: "Alice",
        locked: true,
        fields_attributes: [{ name: "Website", value: "alice.example" }],
        source: { privacy: "unlisted", language: "en" },
    });
    const pictured = await alice.accounts.updateCredentials({
        avatar: new File([png(8, 8)], "me.png", { type: "image/png" }),
        avatar_description: "Me",
        fields_attributes: [{ name: "Pronouns", value: "she/her" }],
        source: { sensitive: true },
    });
    await drain(test.ctx, queues);
    const processed = await alice.accounts.verifyCredentials();
    const removed = await alice.accounts.deleteAvatar();

    assertEquals([named.display_name, named.locked], ["Alice", true]);
    assertEquals([named.source.privacy, named.source.language], ["unlisted", "en"]);
    assertEquals(pictured.fields.map((field) => field.name), ["Pronouns"]);
    assertEquals([pictured.avatar_description, pictured.source.sensitive], ["Me", true]);
    assert(processed.avatar !== named.avatar);
    assertEquals(removed.avatar, named.avatar);
    assertEquals((await alice.accounts.deleteHeader()).header, named.header);
});

Deno.test("a user follows, is followed back on request, and sees both sides", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const bob = await test.as("bob");
    const { id: aliceId } = await test.client.accounts.lookup("alice");
    const { id: bobId } = await test.client.accounts.lookup("bob");
    await alice.accounts.updateCredentials({ locked: true });

    const following = await alice.accounts.follow(bobId, { reblogs: false, notify: true });
    const asked = await bob.accounts.follow(aliceId);
    const requests = await alice.followRequests.list();
    const accepted = await alice.followRequests.authorize(bobId);

    assertEquals([following.following, following.showing_reblogs, following.notifying], [
        true,
        false,
        true,
    ]);
    assertEquals([asked.following, asked.requested], [false, true]);
    assertEquals(requests.items.map((account) => account.id), [bobId]);
    assertEquals(accepted.followed_by, true);
    assertEquals((await alice.accounts.followers(aliceId)).items.map((a) => a.id), [bobId]);
    assertEquals((await alice.accounts.following(aliceId)).items.map((a) => a.id), [bobId]);
    assertEquals(
        (await alice.accounts.relationships([bobId, aliceId])).map((r) => r.id),
        [bobId, aliceId],
    );

    assertEquals((await alice.accounts.removeFromFollowers(bobId)).followed_by, false);
    assertEquals((await alice.accounts.unfollow(bobId)).following, false);
    await bob.accounts.follow(aliceId);
    assertEquals((await alice.followRequests.reject(bobId)).followed_by, false);
});

Deno.test("a user blocks, mutes and notes accounts, and blocks a domain", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    await test.as("bob");
    const { id: bobId } = await test.client.accounts.lookup("bob");

    assertEquals((await alice.accounts.block(bobId)).blocking, true);
    assertEquals((await alice.blocks.list()).items.map((account) => account.id), [bobId]);
    assertEquals((await alice.accounts.unblock(bobId)).blocking, false);

    const muted = await alice.accounts.mute(bobId, { notifications: false, duration: 3600 });
    const [mute] = (await alice.mutes.list()).items;
    assertEquals([muted.muting, muted.muting_notifications], [true, false]);
    assert(mute.mute_expires_at !== null);
    assertEquals((await alice.accounts.unmute(bobId)).muting, false);

    assertEquals((await alice.accounts.note(bobId, "Met at a café")).note, "Met at a café");

    await alice.domainBlocks.block("spam.example");
    assertEquals((await alice.domainBlocks.list()).items, ["spam.example"]);
    await alice.domainBlocks.unblock("spam.example");
    assertEquals((await alice.domainBlocks.list()).items, []);
});

Deno.test("a user searches for accounts", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    await test.as("alicia");
    await test.as("bob");

    // The test accounts are made without being indexed.
    await indexUnindexedAccounts(test.ctx);
    const found = await alice.accounts.search({ q: "ali", limit: 5 });

    assertEquals(found.map((account) => account.username).sort(), ["alice", "alicia"]);
});
