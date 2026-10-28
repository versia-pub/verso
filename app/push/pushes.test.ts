import { assertEquals } from "@std/assert";
import { jwtVerify } from "@panva/jose";
import { createLocalAccount } from "../accounts/testing.ts";
import { registerTestApp } from "../auth/testing.ts";
import { issueToken } from "../auth/tokens.ts";
import { follow } from "../graph/follows.ts";
import { mute } from "../graph/mutes.ts";
import { drain } from "../jobs/worker.ts";
import { postNote } from "../notes/notes.ts";
import { createTestContext } from "../testing/context.ts";
import { vapidKey } from "./keys.ts";
import { pushHandler, pushQueue } from "./pushes.ts";
import { findSubscriptionById, replaceSubscription } from "./subscription_queries.ts";
import type { PushPolicy } from "./tables.ts";

const queues = { [pushQueue]: { handler: pushHandler, concurrency: 1 } };

const base64url = (bytes: Uint8Array) =>
    bytes.toBase64({ alphabet: "base64url", omitPadding: true });

const hkdf = async (
    salt: Uint8Array<ArrayBuffer>,
    ikm: Uint8Array<ArrayBuffer>,
    info: string,
    length: number,
) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    const info_ = new TextEncoder().encode(info);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            { name: "HKDF", hash: "SHA-256", salt, info: info_ },
            key,
            length * 8,
        ),
    );
};

/** A browser that subscribed: it decrypts what is pushed to it, as RFC 8291 has it. */
const browser = async () => {
    const curve = { name: "ECDH", namedCurve: "P-256" };
    const pair = await crypto.subtle.generateKey(curve, true, ["deriveBits"]);
    const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));

    const decrypt = async (body: Uint8Array<ArrayBuffer>) => {
        const salt = body.slice(0, 16);
        const serverKey = body.slice(21, 86);
        const sender = await crypto.subtle.importKey("raw", serverKey, curve, false, []);
        const shared = new Uint8Array(
            await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, pair.privateKey, 256),
        );

        const info = new Uint8Array([
            ...new TextEncoder().encode("WebPush: info\0"),
            ...p256dh,
            ...serverKey,
        ]);
        const key = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
        const ikm = new Uint8Array(
            await crypto.subtle.deriveBits(
                { name: "HKDF", hash: "SHA-256", salt: auth, info },
                key,
                256,
            ),
        );
        const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
        const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);

        const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
        const record = new Uint8Array(
            await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, body.slice(86)),
        );
        // The last record, with no padding.
        assertEquals(record.at(-1), 2);

        return JSON.parse(new TextDecoder().decode(record.slice(0, -1)));
    };

    return { p256dh: base64url(p256dh), auth: base64url(auth), decrypt };
};

const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    const { app } = await registerTestApp(test.ctx);

    /** What the push service was sent, as each push's path and decrypted payload. */
    const pushed: [string, Record<string, unknown>][] = [];
    const browsers = new Map<string, Awaited<ReturnType<typeof browser>>>();
    let answer = 201;
    test.transport.servers.set("push.example", async (request) => {
        const path = new URL(request.url).pathname;
        const body = new Uint8Array(await request.arrayBuffer());
        pushed.push([path, await browsers.get(path)?.decrypt(body)]);
        return new Response(null, { status: answer });
    });
    const answering = (status: number) => answer = status;

    /** Subscribes `accountId` at `/<name>` to `alerts`, with `policy`, returning its id. */
    const subscribe = async (
        accountId: string,
        name: string,
        alerts: string[] = ["mention", "follow", "favourite"],
        policy: PushPolicy = "all",
    ) => {
        const subscriber = await browser();
        browsers.set(`/${name}`, subscriber);
        const issued = await issueToken(test.ctx, app, accountId, ["push"]);
        const id = test.ctx.ids();
        await replaceSubscription(test.ctx, {
            id,
            token_id: issued.id,
            account_id: accountId,
            access_token: issued.token,
            endpoint: `https://push.example/${name}`,
            p256dh: subscriber.p256dh,
            auth: subscriber.auth,
            alerts,
            policy,
            created_at: test.clock.now(),
        });

        return { id, token: issued.token };
    };

    const post = async (accountId: string, text: string, spoilerText = "") => {
        const note = await postNote(test.ctx, accountId, {
            text,
            format: "text/plain",
            spoilerText,
        });
        if (note === undefined) throw new Error("Not posted");
        return note.id;
    };

    return { ...test, pushed, answering, subscribe, post, drain: () => drain(test.ctx, queues) };
};

Deno.test("a notification is pushed encrypted and signed, with what Mastodon pushes", async () => {
    await using test = await open();
    const { token } = await test.subscribe("alice", "a");

    await test.post("bob", "Hi @alice, how are you?");
    assertEquals(await test.drain(), 1);

    const [[path, payload]] = test.pushed;
    assertEquals(path, "/a");
    assertEquals(payload, {
        access_token: token,
        preferred_locale: "en",
        notification_id: payload.notification_id,
        notification_type: "mention",
        icon: payload.icon,
        title: "You were mentioned by bob",
        body: "Hi @alice, how are you?",
    });
    assertEquals(typeof payload.icon, "string");

    const [request] = test.transport.sent;
    assertEquals(
        [...["content-encoding", "content-type", "ttl", "urgency"].map((name) =>
            request.headers.get(name)
        )],
        ["aes128gcm", "application/octet-stream", "172800", "normal"],
    );
    const [, jwt] = /^vapid t=(\S+), k=/.exec(request.headers.get("authorization") ?? "") ?? [];
    const key = await crypto.subtle.importKey(
        "raw",
        (await vapidKey(test.ctx)).publicKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
    );
    const { payload: claims } = await jwtVerify(jwt, key, { currentDate: test.clock.now() });
    assertEquals([claims.aud, claims.sub], ["https://push.example", "https://social.example"]);
});

Deno.test("a push's body is the content warning, or the status cut to 140 characters", async () => {
    await using test = await open();
    await test.subscribe("alice", "a");

    await test.post("bob", "@alice Spoilers ahead", "The <b>ending</b>");
    await test.post("bob", `@alice ${"x".repeat(200)}`);
    await follow(test.ctx, "carol", "alice");
    await test.drain();

    assertEquals(test.pushed.map(([, payload]) => [payload.title, payload.body]), [
        ["You were mentioned by bob", "The <b>ending</b>"],
        ["You were mentioned by bob", `@alice ${"x".repeat(130)}...`],
        // Carol's profile says nothing.
        ["carol followed you", ""],
    ]);
});

Deno.test("only subscriptions that ask for a notification's type, from whom it is from, get it", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "bob");
    await follow(test.ctx, "carol", "alice");
    await test.subscribe("alice", "all");
    await test.subscribe("alice", "follows", ["mention"]);
    await test.subscribe("alice", "none", ["mention"], "none");
    await test.subscribe("alice", "followed", ["mention"], "followed");
    await test.subscribe("alice", "follower", ["mention"], "follower");
    await test.subscribe("alice", "favourites", ["favourite"]);
    await test.subscribe("bob", "bob");

    await test.post("bob", "Hi @alice");
    await test.post("carol", "Hi @alice");
    await follow(test.ctx, "bob", "alice");
    // Only those that ask for one are queued.
    assertEquals(await test.drain(), 7);

    const told = test.pushed.map(([path, payload]) => `${path} ${payload.title}`).toSorted();
    assertEquals(told, [
        "/all You were mentioned by bob",
        "/all You were mentioned by carol",
        "/all bob followed you",
        "/followed You were mentioned by bob",
        "/follower You were mentioned by carol",
        "/follows You were mentioned by bob",
        "/follows You were mentioned by carol",
    ]);
});

Deno.test("nothing is pushed if the user isn't shown the notification, or unsubscribed", async () => {
    await using test = await open();
    await test.subscribe("alice", "kept");
    const { id } = await test.subscribe("alice", "removed");

    // Muted after being notified, and unsubscribed after it was queued.
    await test.post("bob", "Hi @alice");
    await mute(test.ctx, "alice", "bob", { notifications: true, duration: 0 });
    await test.ctx.db.deleteFrom("push_subscriptions").where("id", "=", id).execute();

    assertEquals(await test.drain(), 2);
    assertEquals(test.pushed, []);
    // Done with, rather than given up on.
    assertEquals(
        await test.ctx.db.selectFrom("jobs").select("id").where("queue", "=", "push").execute(),
        [],
    );
});

Deno.test("a subscription its push service says is gone is deleted, and others are retried", async () => {
    await using test = await open();
    const gone = await test.subscribe("alice", "gone");
    const missing = await test.subscribe("bob", "missing");

    for (const status of [410, 404]) {
        test.answering(status);
        await test.post("carol", status === 410 ? "Hi @alice" : "Hi @bob");
        await test.drain();
    }
    assertEquals(await findSubscriptionById(test.ctx, gone.id), undefined);
    assertEquals(await findSubscriptionById(test.ctx, missing.id), undefined);

    await test.subscribe("alice", "a");
    test.answering(400);
    await test.post("carol", "Hi @alice");
    await test.drain();
    test.clock.advance(24 * 60 * 60 * 1000);
    await test.drain();
    // Refused, so not tried again.
    assertEquals(test.pushed.length, 3);

    for (const status of [503, 429, 201]) {
        test.answering(status);
        if (status === 503) await test.post("carol", "Hi again @alice");
        test.clock.advance(24 * 60 * 60 * 1000);
        await test.drain();
    }
    assertEquals(test.pushed.length, 6);
    // Pushed at last, so not again.
    test.clock.advance(24 * 60 * 60 * 1000);
    await test.drain();
    assertEquals(test.pushed.length, 6);
    const kept = await test.ctx.db.selectFrom("push_subscriptions").select("endpoint").execute();
    assertEquals(kept, [{ endpoint: "https://push.example/a" }]);
});
