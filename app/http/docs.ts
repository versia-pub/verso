/**
 * The API documentation, as Scalar shows the OpenAPI document.
 * @see https://github.com/scalar/scalar
 * @module
 */
import { html } from "@hono/hono/html";
import { defineRoute, Page, type Route } from "./route.ts";

/** Pinned, and checked against its hash, so a changed file on the CDN doesn't run. */
const scalar = {
    url: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.74.0/dist/browser/standalone.js",
    integrity: "sha384-VXnKAz61Xwc3tbw1P+KKrUP7YbcsSl1Ik4is5UnogJyw9XEYZ5Ay/T1i0zPYtSZH",
};

/**
 * Nothing goes to Scalar's services: no telemetry, no fonts, no AI agent, no offers of its MCP and
 * SDK services or its developer tools, and requests tried from the page go straight to Verso, not
 * through Scalar's proxy, which would see their tokens.
 * @see https://github.com/scalar/scalar/blob/main/documentation/configuration.md
 */
const configuration = {
    telemetry: false,
    withDefaultFonts: false,
    proxyUrl: "",
    agent: { disabled: true },
    mcp: { disabled: true },
    showDeveloperTools: "never",
    // Buttons offering Scalar's SDK service, which no setting turns off.
    customCss: ".explore-scalar-cta, .generate-sdk-button, .selected-client-action " +
        "{ display: none !important; }",
};

/** The page loads only Scalar, and talks only to Verso. */
const policy = [
    "default-src 'none'",
    `script-src ${scalar.url}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
].join("; ");

export const docsRoute: Route = defineRoute({
    method: "GET",
    path: "/docs",
    summary: "This API's documentation",
    tags: ["docs"],
    pagePolicy: policy,
    responses: { 200: Page },
    handler: () =>
        Promise.resolve({
            status: 200,
            page: html`
                <!doctype html>
                <html lang="en">
                    <head>
                        <meta charset="utf-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1">
                        <title>API documentation</title>
                    </head>
                    <body>
                        <script
                            id="api-reference"
                            type="application/json"
                            data-url="/openapi.json"
                            data-configuration="${JSON.stringify(configuration)}"
                        ></script>
                        <script
                            src="${scalar.url}"
                            integrity="${scalar.integrity}"
                            crossorigin="anonymous"
                        ></script>
                    </body>
                </html>
            `,
        }),
});
