import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { z } from "zod";
import { CidrText } from "../kernel/ip.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { captureLogs } from "../testing/logs.ts";
import { memoryRateLimitStore } from "./rate_limits.ts";
import { redactedTarget, requestId } from "./request_log.ts";
import { defineRoute } from "./route.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const proxies = [CidrText.parse("10.0.0.0/8")];

const thing = defineRoute({
    method: "GET",
    path: "/api/v1/thing/:id",
    summary: "Answers, or fails",
    params: z.object({ id: z.string() }),
    responses: { 200: z.object({}) },
    handler: (_, { params }) => {
        if (params.id === "broken") throw new Error("boom");
        return Promise.resolve({ status: 200, body: {} });
    },
});

const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, [thing], { trustedProxies: proxies });

    /** The response to a request from `peer`, its body read. */
    const request = async (
        path: string,
        init: RequestInit = {},
        peer = "203.0.113.9",
    ) => {
        const response = await app.request(path, init, { remoteAddr: { hostname: peer } });
        await response.body?.cancel();
        return response;
    };

    return { ...test, app, request };
};

Deno.test("a request ID from a trusted proxy is kept, without characters Rails drops", () => {
    assertEquals(requestId("abc-123_@x", "10.1.2.3", proxies), "abc-123_@x");
    assertEquals(requestId("a b\nc;d", "10.1.2.3", proxies), "abcd");
    assertEquals(requestId("x".repeat(300), "10.1.2.3", proxies), "x".repeat(255));
});

Deno.test("a request ID from anyone else, or with nothing left, is replaced by a new one", () => {
    assertMatch(requestId("abc", "203.0.113.9", proxies), uuid);
    assertMatch(requestId("abc", undefined, proxies), uuid);
    assertMatch(requestId(" !", "10.1.2.3", proxies), uuid);
    assertMatch(requestId(undefined, "10.1.2.3", proxies), uuid);
    assertNotEquals(
        requestId(undefined, "10.1.2.3", proxies),
        requestId(undefined, "10.1.2.3", proxies),
    );
});

Deno.test("secret query parameters are filtered from logged URLs, and nothing else", () => {
    assertEquals(
        redactedTarget(
            "https://social.example/api/v1/streaming?stream=user&access_token=abc&Code=x&state=s",
        ),
        "/api/v1/streaming?stream=user&access_token=[FILTERED]&Code=[FILTERED]&state=[FILTERED]",
    );
    assertEquals(
        redactedTarget("https://social.example/oauth/token?token=a&my_token=b&tokens=c&password=p"),
        "/oauth/token?token=[FILTERED]&my_token=b&tokens=c&password=[FILTERED]",
    );
    assertEquals(redactedTarget("https://social.example/a?max_id=5"), "/a?max_id=5");
    assertEquals(redactedTarget("https://social.example/a"), "/a");
});

Deno.test("every response says its request ID, errors and preflights too", async () => {
    await using test = await open();

    const ok = await test.request("/api/v1/thing/a");
    const broken = await test.request("/api/v1/thing/broken");
    const missing = await test.request("/nothing");
    const preflight = await test.request("/api/v1/thing/a", {
        method: "OPTIONS",
        headers: { origin: "https://elk.example", "access-control-request-method": "GET" },
    });

    assertEquals([ok.status, broken.status, missing.status], [200, 500, 404]);
    assertEquals(preflight.status, 204);
    for (const response of [ok, broken, missing, preflight]) {
        assertMatch(response.headers.get("x-request-id") ?? "", uuid);
    }
});

Deno.test("a rate-limited response says its request ID", async () => {
    await using test = await createTestContext();
    const policy = { limit: 1, windowSeconds: 30 };
    const app = createTestApp(test.ctx, [thing], {
        rateLimits: { store: memoryRateLimitStore(test.clock), policy, instancePolicy: policy },
    });

    await (await app.request("/api/v1/thing/a")).body?.cancel();
    const limited = await app.request("/api/v1/thing/a");
    await limited.body?.cancel();

    assertEquals(limited.status, 429);
    assertMatch(limited.headers.get("x-request-id") ?? "", uuid);
});

Deno.test("only a trusted proxy's request ID is sent back", async () => {
    await using test = await open();
    const headers = { "x-request-id": "from-proxy" };

    const proxied = await test.request("/api/v1/thing/a", { headers }, "10.0.0.1");
    const direct = await test.request("/api/v1/thing/a", { headers });

    assertEquals(proxied.headers.get("x-request-id"), "from-proxy");
    assertMatch(direct.headers.get("x-request-id") ?? "", uuid);
});

Deno.test("each request is logged at debug once answered, with its ID and a filtered URL", async () => {
    await using test = await open();
    await using logs = await captureLogs();

    const response = await test.request("/api/v1/thing/a?access_token=secret&x=1");

    const [line] = logs.records;
    assertEquals(logs.records.length, 1);
    assertEquals(line.level, "debug");
    assertEquals(line.category, ["verso", "http", "access"]);
    assertEquals(line.properties.method, "GET");
    assertEquals(line.properties.url, "/api/v1/thing/a?access_token=[FILTERED]&x=1");
    assertEquals(line.properties.status, 200);
    assertEquals(typeof line.properties.responseTime, "number");
    assertEquals(line.properties.requestId, response.headers.get("x-request-id"));
});

Deno.test("a failed request's error log has its request ID", async () => {
    await using test = await open();
    await using logs = await captureLogs();

    const response = await test.request("/api/v1/thing/broken");

    const error = logs.records.find((record) => record.level === "error");
    assert(error);
    assertEquals(error.properties.requestId, response.headers.get("x-request-id"));
    assertEquals(logs.records.at(-1)?.properties.status, 500);
});

Deno.test("health checks aren't logged", async () => {
    await using test = await open();
    await using logs = await captureLogs();

    await test.request("/health");
    await test.request("/health/ready");
    await test.request("/healthy");

    assertEquals(logs.records.map((record) => record.properties.url), ["/healthy"]);
});
