import { assertEquals, assertStringIncludes } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { createTestApp } from "../testing/app.ts";
import { docsRoute } from "./docs.ts";

const scalar =
    "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.74.0/dist/browser/standalone.js";

Deno.test("the docs page runs only pinned Scalar, which talks only to Verso", async () => {
    await using test = await createTestContext();
    const app = createTestApp(test.ctx, [docsRoute], { checkResponses: true });

    const response = await app.request("/docs");
    const page = await response.text();

    assertEquals(response.status, 200);
    assertEquals(
        response.headers.get("content-security-policy"),
        `default-src 'none'; script-src ${scalar}; style-src 'unsafe-inline'; img-src 'self' data:; ` +
            "connect-src 'self'; frame-ancestors 'none'",
    );
    assertStringIncludes(page, `src="${scalar}"`);
    assertStringIncludes(
        page,
        'integrity="sha384-VXnKAz61Xwc3tbw1P+KKrUP7YbcsSl1Ik4is5UnogJyw9XEYZ5Ay/T1i0zPYtSZH"',
    );
    assertStringIncludes(page, 'data-url="/openapi.json"');

    const configuration = JSON.parse(
        /data-configuration="([^"]*)"/.exec(page)?.[1].replaceAll("&quot;", '"') ?? "{}",
    );
    assertEquals(
        [
            configuration.telemetry,
            configuration.withDefaultFonts,
            configuration.proxyUrl,
            configuration.agent,
            configuration.mcp,
            configuration.showDeveloperTools,
        ],
        [false, false, "", { disabled: true }, { disabled: true }, "never"],
    );

    const sdkButtons = [".explore-scalar-cta", ".generate-sdk-button", ".selected-client-action"];
    for (const button of sdkButtons) assertStringIncludes(configuration.customCss, button);
});
