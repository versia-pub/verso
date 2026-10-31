import { assert, assertEquals, assertRejects } from "@std/assert";
import { ApiError, Client, createPkce, type Stream, type StreamEvent } from "@versia/client-api";
import { encode } from "fast-png";
import { createLocalAccount, createRole, giveRole } from "../accounts/testing.ts";
import { oidcProvider } from "../auth/oidc.ts";
import { formTokenIn, tokenFor } from "../auth/testing.ts";
import { defaultSettings } from "../instances/testing.ts";
import { queues } from "../jobs/queues.ts";
import { indexUnindexedAccounts } from "../search/accounts.ts";
import { indexUnindexed } from "../search/notes.ts";
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

    /** Verso, served on a port of its own, for WebSockets, until disposed. */
    const listen = () => {
        const server = Deno.serve(
            { hostname: "127.0.0.1", port: 0, onListen: () => {} },
            (request) => verso.request(request),
        );
        return Object.assign(server, {
            url: `http://127.0.0.1:${server.addr.port}`,
            [Symbol.asyncDispose]: () => server.shutdown(),
        });
    };

    return { ...test, idp, client, browse, as, listen };
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
            show_blocks: "all",
        },
        federation: { blocked_domains: ["spam.example"] },
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
    assertEquals(await test.client.instance.peers(), []);
    assertEquals((await test.client.instance.activity()).length, 12);
    assertEquals(
        (await test.client.instance.languages()).find((language) => language.code === "de")?.name,
        "German",
    );
    assertEquals(
        (await test.client.instance.domainBlocks()).map((block) => block.domain),
        ["spam.example"],
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
    assertEquals((await test.client.statuses.getMany([posted.id, "missing"])).map((s) => s.id), [
        posted.id,
    ]);
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
    const preferences = await alice.accounts.preferences();
    assertEquals(
        [preferences["posting:default:visibility"], preferences["posting:default:language"]],
        ["unlisted", "en"],
    );
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
    assertEquals((await test.client.accounts.getMany([bobId, aliceId])).map((a) => a.id), [
        bobId,
        aliceId,
    ]);
    // alice follows bob, who follows her.
    const [familiar] = await alice.accounts.familiarFollowers([aliceId]);
    assertEquals([familiar.id, familiar.accounts.map((a) => a.id)], [aliceId, [bobId]]);

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

Deno.test("a user likes, shares and reacts to a status, and undoes each", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const bob = await test.as("bob");
    const { id: bobId } = await test.client.accounts.lookup("bob");
    const { id } = await alice.statuses.post({ status: "Hello" });

    assertEquals((await bob.statuses.favourite(id)).favourited, true);
    const share = await bob.statuses.reblog(id, { visibility: "public" });
    assertEquals((await bob.statuses.react(id, "👍")).reactions?.map((r) => r.name), ["👍"]);

    assertEquals(share.reblog?.id, id);
    assertEquals((await alice.statuses.favouritedBy(id)).items.map((a) => a.id), [bobId]);
    assertEquals((await alice.statuses.rebloggedBy(id)).items.map((a) => a.id), [bobId]);
    assertEquals((await alice.statuses.reactions(id)).map((r) => [r.name, r.count]), [["👍", 1]]);
    assertEquals((await alice.statuses.reactedBy(id, "👍")).items.map((a) => a.id), [bobId]);
    assertEquals((await bob.favourites.list()).items.map((status) => status.id), [id]);

    assertEquals((await bob.statuses.unfavourite(id)).favourited, false);
    assertEquals((await bob.statuses.unreblog(id)).reblogged, false);
    assertEquals((await bob.statuses.unreact(id, "👍")).reactions ?? [], []);
});

Deno.test("a user bookmarks a status, lists it, and removes the bookmark", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const bob = await test.as("bob");
    const { id } = await alice.statuses.post({ status: "Hello" });

    assertEquals((await bob.statuses.bookmark(id)).bookmarked, true);
    assertEquals((await bob.bookmarks.list()).items.map((status) => status.id), [id]);
    assertEquals((await alice.bookmarks.list()).items, []);

    assertEquals((await bob.statuses.unbookmark(id)).bookmarked, false);
    assertEquals((await bob.bookmarks.list()).items, []);
});

Deno.test("a user features an account they follow, lists it, and stops featuring it", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    await test.as("bob");
    const { id } = await test.client.accounts.lookup("bob");
    await alice.accounts.follow(id);

    assertEquals((await alice.accounts.pin(id)).endorsed, true);
    assertEquals((await alice.endorsements.list()).items.map((account) => account.id), [id]);
    assertEquals((await alice.accounts.unpin(id)).endorsed, false);
});

Deno.test("a user features a hashtag, lists it, and stops featuring it", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    await alice.statuses.post({ status: "Hello #cats" });
    const { id } = await test.client.accounts.lookup("alice");

    assertEquals((await alice.featuredTags.suggestions()).map((tag) => tag.name), ["cats"]);
    const featured = await alice.featuredTags.feature("cats");
    assertEquals(featured.statuses_count, "1");
    assertEquals((await alice.featuredTags.list()).map((tag) => tag.id), [featured.id]);
    assertEquals((await test.client.accounts.featuredTags(id)).map((tag) => tag.name), ["cats"]);

    await alice.featuredTags.unfeature(featured.id);
    assertEquals(await alice.featuredTags.list(), []);
});

Deno.test("a user follows a hashtag, sees its statuses at home, lists it, and unfollows it", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const bob = await test.as("bob");

    assertEquals((await alice.tags.follow("Cats")).following, true);
    const { id } = await bob.statuses.post({ status: "Hello #cats" });
    assertEquals((await alice.timelines.home()).items.map((status) => status.id), [id]);
    assertEquals((await alice.followedTags.list()).items.map((tag) => tag.name), ["Cats"]);
    assertEquals((await test.client.tags.get("cats")).following, undefined);

    assertEquals((await alice.tags.unfollow("cats")).following, false);
    assertEquals((await alice.followedTags.list()).items, []);
});

Deno.test("a user makes an exclusive list, reads it, changes it, and deletes it", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const bobs = await test.as("bob");
    const { id: bob } = await test.client.accounts.lookup("bob");
    await alice.accounts.follow(bob);

    const list = await alice.lists.create({ title: "Friends", exclusive: true });
    assertEquals([list.title, list.replies_policy, list.exclusive], ["Friends", "list", true]);
    await alice.lists.addAccounts(list.id, [bob]);
    const { id: posted } = await bobs.statuses.post({ status: "Hello" });
    assertEquals((await alice.timelines.list(list.id)).items.map((status) => status.id), [posted]);
    assertEquals((await alice.timelines.home()).items, []);
    assertEquals((await alice.lists.accounts(list.id)).items.map((account) => account.id), [bob]);
    assertEquals((await alice.accounts.lists(bob)).map((each) => each.id), [list.id]);

    assertEquals((await alice.lists.update(list.id, { title: "Pals" })).title, "Pals");
    assertEquals((await alice.lists.get(list.id)).title, "Pals");
    await alice.lists.removeAccounts(list.id, [bob]);
    assertEquals((await alice.lists.accounts(list.id)).items, []);

    await alice.lists.delete(list.id);
    assertEquals(await alice.lists.list(), []);
});

Deno.test("a user makes a filter, changes its keywords and statuses, and deletes it", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const { id: posted } = await alice.statuses.post({ status: "Cats" });

    const filter = await alice.filters.create({
        title: "Pets",
        context: ["home", "public"],
        keywords_attributes: [{ keyword: "cat" }],
    });
    assertEquals([filter.filter_action, filter.expires_at], ["warn", null]);
    const [cat] = filter.keywords ?? [];
    assertEquals([cat.keyword, cat.whole_word], ["cat", true]);

    const changed = await alice.filters.update(filter.id, {
        filter_action: "hide",
        keywords_attributes: [{ id: cat.id, _destroy: true }, { keyword: "dog" }],
    });
    assertEquals(changed.filter_action, "hide");
    const [dog] = await alice.filters.keywords(filter.id);
    assertEquals(dog.keyword, "dog");
    const kept = await alice.filters.updateKeyword(dog.id, { whole_word: false });
    assertEquals(await alice.filters.keyword(dog.id), kept);
    const bird = await alice.filters.addKeyword(filter.id, { keyword: "bird" });
    await alice.filters.removeKeyword(bird.id);

    const status = await alice.filters.addStatus(filter.id, posted);
    assertEquals(await alice.filters.status(status.id), { id: status.id, status_id: posted });
    assertEquals(await alice.filters.statuses(filter.id), [status]);
    await alice.filters.removeStatus(status.id);

    assertEquals((await alice.filters.get(filter.id)).keywords, [kept]);
    await alice.filters.delete(filter.id);
    assertEquals(await alice.filters.list(), []);
});

Deno.test("a user mutes the thread of a status, and unmutes it", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const { id } = await alice.statuses.post({ status: "Hello" });

    assertEquals((await alice.statuses.mute(id)).muted, true);
    assertEquals((await alice.statuses.get(id)).muted, true);
    assertEquals((await alice.statuses.unmute(id)).muted, false);
});

Deno.test("a user reads a thread and a status's edits, and pins a status", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const bob = await test.as("bob");
    const { id: aliceId } = await test.client.accounts.lookup("alice");

    const { id } = await alice.statuses.post({ status: "First" });
    const reply = await bob.statuses.post({ status: "Second", in_reply_to_id: id });
    await alice.statuses.edit(id, { status: "First, edited" });

    assertEquals((await alice.statuses.context(reply.id)).ancestors.map((s) => s.id), [id]);
    assertEquals((await alice.statuses.context(id)).descendants.map((s) => s.id), [reply.id]);
    assertEquals((await alice.statuses.history(id)).map((edit) => edit.content), [
        "<p>First</p>",
        "<p>First, edited</p>",
    ]);

    assertEquals((await alice.statuses.pin(id)).pinned, true);
    const pinned = await test.client.accounts.statuses(aliceId, { pinned: true });
    assertEquals(pinned.items.map((status) => status.id), [id]);
    assertEquals((await alice.statuses.unpin(id)).pinned, false);
});

Deno.test("a user reads the home, public and hashtag timelines", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const bob = await test.as("bob");
    const { id: aliceId } = await test.client.accounts.lookup("alice");
    await bob.accounts.follow(aliceId);

    const both = await alice.statuses.post({ status: "Look #cats #dogs" });
    const cats = await alice.statuses.post({ status: "Just #cats" });
    const ids = async (page: Promise<{ items: readonly { id: string }[] }>) =>
        (await page).items.map((status) => status.id);

    assertEquals(await ids(bob.timelines.home()), [cats.id, both.id]);
    assertEquals(await ids(test.client.timelines.public({ local: true })), [cats.id, both.id]);
    assertEquals(await ids(test.client.timelines.public({ remote: true })), []);
    assertEquals(await ids(test.client.timelines.tag("cats")), [cats.id, both.id]);
    assertEquals(await ids(test.client.timelines.tag("cats", { all: ["dogs"] })), [both.id]);
    assertEquals(await ids(test.client.timelines.tag("cats", { none: ["dogs"] })), [cats.id]);
});

Deno.test("a user reads, counts and dismisses their notifications, alone or grouped", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const bob = await test.as("bob");
    const carol = await test.as("carol");
    const { id: bobId } = await test.client.accounts.lookup("bob");
    const { id: aliceId } = await test.client.accounts.lookup("alice");

    const { id } = await alice.statuses.post({ status: "Hello" });
    await bob.statuses.favourite(id);
    await carol.statuses.favourite(id);
    await bob.accounts.follow(aliceId);
    await drain(test.ctx, queues);

    const all = await alice.notifications.list();
    const [follow] = (await alice.notifications.list({ types: ["follow"] })).items;
    assertEquals(all.items.map((n) => n.type), ["follow", "favourite", "favourite"]);
    assertEquals((await alice.notifications.get(follow.id)).account.id, bobId);
    assertEquals(await alice.notifications.unreadCount({ exclude_types: ["follow"] }), 2);

    const grouped = await alice.groupedNotifications.list();
    const [, liked] = grouped.items;
    assertEquals(grouped.items.map((g) => [g.type, g.notifications_count]), [
        ["follow", 1],
        ["favourite", 2],
    ]);
    assertEquals(grouped.body.statuses.map((status) => status.id), [id]);
    assertEquals((await alice.groupedNotifications.get(liked.group_key)).statuses[0].id, id);
    assertEquals(
        (await alice.groupedNotifications.accounts(liked.group_key)).items.length,
        2,
    );
    assertEquals(await alice.groupedNotifications.unreadCount(), 2);

    await alice.groupedNotifications.dismiss(liked.group_key);
    assertEquals(await alice.notifications.unreadCount(), 1);
    await alice.notifications.dismiss(follow.id);
    assertEquals((await alice.notifications.list()).items, []);

    await bob.statuses.reblog(id);
    await drain(test.ctx, queues);
    await alice.notifications.clear();
    assertEquals((await alice.groupedNotifications.list()).items, []);

    await bob.statuses.unreblog(id);
    await bob.statuses.reblog(id);
    await drain(test.ctx, queues);
    assertEquals((await alice.notifications.list()).items.map((n) => n.type), ["reblog"]);
    await alice.groupedNotifications.clear();
    assertEquals((await alice.notifications.list()).items, []);
});

Deno.test("a user saves where they read up to, and the unread count follows it", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const bob = await test.as("bob");
    const { id: aliceId } = await test.client.accounts.lookup("alice");
    await bob.accounts.follow(aliceId);
    await drain(test.ctx, queues);
    const [follow] = (await alice.notifications.list()).items;

    const set = await alice.markers.set({ notifications: { last_read_id: follow.id } });
    const got = await alice.markers.get(["home", "notifications"]);

    assertEquals(set.notifications?.last_read_id, follow.id);
    assertEquals(got.home, undefined);
    assertEquals(got.notifications?.last_read_id, follow.id);
    assertEquals(await alice.notifications.unreadCount(), 0);
});

Deno.test("a user searches for accounts, statuses and hashtags", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    await test.as("bob");
    await alice.accounts.updateCredentials({ indexable: true });
    const posted = await alice.statuses.post({ status: "Purple elephants at the #zoo" });

    // The test accounts and statuses are made without being indexed.
    await indexUnindexedAccounts(test.ctx);
    await indexUnindexed(test.ctx);
    const found = await alice.search({ q: "elephants" });
    const hashtags = await alice.search({ q: "#zoo", type: "hashtags" });
    const accounts = await alice.search({ q: "bob", type: "accounts" });

    assertEquals(found.statuses.map((status) => status.id), [posted.id]);
    assertEquals(hashtags.hashtags.map((tag) => tag.name), ["zoo"]);
    assertEquals(accounts.accounts.map((account) => account.username), ["bob"]);
    assertEquals((await test.client.search({ q: "elephants" })).statuses, []);
});

Deno.test("a user adds, changes and deletes custom emojis, their own or global", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    await createRole(test.ctx, "Admin", ["emojis"]);
    await giveRole(test.ctx, "alice", "Admin");

    const picture = () => new File([png(8, 8)], "blob.png", { type: "image/png" });
    const added = await alice.emojis.create({
        shortcode: "blob",
        element: picture(),
        alt: "A blob",
    });
    assertEquals([added.url, added.global, added.description], [null, false, "A blob"]);

    await drain(test.ctx, queues);
    assert((await alice.emojis.get(added.id)).url !== null);
    assertEquals((await alice.emojis.list()).map((emoji) => emoji.shortcode), ["blob"]);
    assertEquals(await test.client.emojis.list(), []);

    const renamed = await alice.emojis.update(added.id, { shortcode: "blobby", global: true });
    const repictured = await alice.emojis.update(added.id, { element: picture() });
    assertEquals([renamed.shortcode, renamed.global], ["blobby", true]);
    assertEquals(repictured.url, null);
    await drain(test.ctx, queues);
    assertEquals((await test.client.emojis.list()).map((emoji) => emoji.shortcode), ["blobby"]);

    await alice.emojis.delete(added.id);
    assertEquals(await alice.emojis.list(), []);
});

Deno.test("a role manager creates, gives, takes and deletes a role below their own", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    await test.as("bob");
    const { id: bobId } = await test.client.accounts.lookup("bob");
    await createRole(test.ctx, "Admin", ["roles", "emojis"]);
    await test.ctx.db.updateTable("roles").set({ priority: 100 }).where("id", "=", "Admin")
        .execute();
    await giveRole(test.ctx, "alice", "Admin");

    const created = await alice.roles.create({
        name: "Emoji keeper",
        permissions: ["emojis"],
        priority: 10,
        color: "#ff3838",
    });
    const changed = await alice.roles.update(created.id, { description: "Keeps emojis" });
    await alice.roles.give(bobId, created.id);

    assertEquals((await alice.roles.list()).map((role) => role.name), ["Admin", "Emoji keeper"]);
    assertEquals((await alice.roles.get(created.id)).permissions, ["emojis"]);
    assertEquals(changed.description, "Keeps emojis");
    assertEquals((await alice.roles.ofAccount(bobId)).map((role) => role.id), [created.id]);
    const refused = await assertRejects(
        () => alice.roles.create({ name: "Over", priority: 200 }),
        ApiError,
    );
    assertEquals(refused.status, 403);

    await alice.roles.take(bobId, created.id);
    assertEquals(await alice.roles.ofAccount(bobId), []);
    await alice.roles.delete(created.id);
    assertEquals((await alice.roles.list()).map((role) => role.name), ["Admin"]);
});

/** A browser's keys for a push subscription, in URL-safe base64. */
const browserKeys = async () => {
    const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
    );
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    return {
        p256dh: raw.toBase64({ alphabet: "base64url", omitPadding: true }),
        auth: crypto.getRandomValues(new Uint8Array(16))
            .toBase64({ alphabet: "base64url", omitPadding: true }),
    };
};

Deno.test("a user subscribes to pushes, changes which, and unsubscribes", async () => {
    await using test = await open();
    const alice = await test.as("alice");
    const keys = await browserKeys();

    const subscribed = await alice.push.subscribe(
        { endpoint: "https://push.example/a", keys },
        { alerts: { follow: true, reaction: true }, policy: "followed" },
    );
    const changed = await alice.push.update({ alerts: { mention: true } });

    assertEquals(subscribed.endpoint, "https://push.example/a");
    assertEquals([subscribed.alerts.follow, subscribed.alerts.mention], [true, false]);
    assertEquals([subscribed.alerts.reaction, subscribed.policy], [true, "followed"]);
    assertEquals((await alice.push.get()).id, subscribed.id);
    assertEquals([changed.alerts.follow, changed.alerts.mention, changed.policy], [
        false,
        true,
        "all",
    ]);

    await alice.push.unsubscribe();
    assertEquals((await assertRejects(() => alice.push.get(), ApiError)).status, 404);
});

/** The next `count` events of `stream`, by what each says. */
const next = async (stream: Stream, count: number) => {
    const events: string[] = [];
    if (count === 0) return events;

    for await (const event of stream) {
        events.push(describe(event));
        if (events.length === count) break;
    }
    return events;
};

const describe = (event: StreamEvent) => {
    switch (event.event) {
        case "update":
        case "status.update":
            return `${event.stream.join(",")} ${event.event} ${event.status.id}`;
        case "delete":
            return `${event.stream.join(",")} delete ${event.id}`;
        case "notification":
            return `${event.stream.join(",")} notification ${event.notification.type}`;
        case "unknown":
            return `${event.stream.join(",")} ${event.name}`;
        case "error":
            return `error ${event.status} ${event.error}`;
    }
};

Deno.test("a user streams statuses and notifications as they happen", async () => {
    await using test = await open();
    await using server = test.listen();
    const alice = await test.as("alice");
    const bob = await test.as("bob");
    const { id: aliceId } = await test.client.accounts.lookup("alice");

    assertEquals(await alice.streaming.health(), true);
    await using stream = await alice.streaming.connect({
        url: server.url,
        subscribe: [{ stream: "user" }, { stream: "hashtag", tag: "Cats" }],
    });
    stream.subscribe({ stream: "hashtag" });
    assertEquals(await next(stream, 1), ["error 400 Missing tag name parameter"]);

    const posted = await alice.statuses.post({ status: "Hi #cats" });
    assertEquals((await next(stream, 2)).sort(), [
        `hashtag,Cats update ${posted.id}`,
        `user update ${posted.id}`,
    ]);

    stream.unsubscribe({ stream: "hashtag", tag: "cats" });
    await alice.statuses.edit(posted.id, { status: "Hi again" });
    assertEquals(await next(stream, 1), [`user status.update ${posted.id}`]);
    await alice.statuses.delete(posted.id);
    assertEquals(await next(stream, 1), [`user delete ${posted.id}`]);

    await bob.accounts.follow(aliceId);
    await drain(test.ctx, queues);
    assertEquals(await next(stream, 1), ["user notification follow"]);

    assertEquals((await stream.close()).code, 1000);
    assertEquals(await next(stream, 0), []);
});

Deno.test("a user streams the statuses of one of their lists", async () => {
    await using test = await open();
    await using server = test.listen();
    const alice = await test.as("alice");
    const bob = await test.as("bob");
    const { id: bobId } = await test.client.accounts.lookup("bob");
    await alice.accounts.follow(bobId);
    const list = await alice.lists.create({ title: "Friends" });
    await alice.lists.addAccounts(list.id, [bobId]);

    await using stream = await alice.streaming.connect({
        url: server.url,
        subscribe: [{ stream: "list", list: list.id }],
    });
    stream.subscribe({ stream: "list", list: "missing" });
    assertEquals(await next(stream, 1), ["error 401 Not authorized to stream this list"]);

    const posted = await bob.statuses.post({ status: "Hi" });
    assertEquals(await next(stream, 1), [`list,${list.id} update ${posted.id}`]);
});

Deno.test("a stream without a user's token doesn't open", async () => {
    await using test = await open();
    await using server = test.listen();

    await assertRejects(() => test.client.streaming.connect({ url: server.url }));
});
