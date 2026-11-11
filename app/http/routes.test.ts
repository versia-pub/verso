import denoConfig from "../../deno.json" with { type: "json" };
import { assertEquals } from "@std/assert";
import { defaultSettings } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { createTestApp } from "../testing/app.ts";
import snapshot from "./openapi.json" with { type: "json" };
import { routes } from "./routes.ts";

const fetchDocument = async (name?: string) => {
    await using test = await createTestContext();
    const settings = defaultSettings();
    const app = createTestApp(
        test.ctx,
        routes({ ...settings, instance: { ...settings.instance, name } }),
        {
            checkResponses: true,
        },
    );

    const response = await app.request("/openapi.json");
    return { status: response.status, body: await response.json() };
};

Deno.test("the API is described by an OpenAPI document, titled with the instance's name", async () => {
    const { status, body } = await fetchDocument();
    assertEquals(status, 200);
    assertEquals(body.info, { title: "social.example", version: denoConfig.version });
    assertEquals(Object.keys(body.paths["/openapi.json"]), ["get"]);
    assertEquals(Object.keys(body.paths["/api/v1/accounts/{id}"]), ["get"]);

    assertEquals((await fetchDocument("Example")).body.info.title, "Example");
});

/**
 * Changes to the API show up in review as changes to `openapi.json`. When they are intended, `deno
 * task update-openapi` rewrites it.
 */
Deno.test("the OpenAPI document is unchanged", async () => {
    const { body } = await fetchDocument();

    if (Deno.env.get("UPDATE_OPENAPI") === "1") {
        await Deno.writeTextFile(
            new URL("./openapi.json", import.meta.url),
            `${JSON.stringify(body, null, 4)}\n`,
        );
        return;
    }

    assertEquals(body, snapshot);
});

Deno.test("a user that moved may only call the migration, settings and streaming routes", () => {
    const allowed = routes(defaultSettings())
        .filter((route) => route.auth?.whileMoved)
        .map((route) => `${route.method} ${route.path}`)
        .sort();

    assertEquals(allowed, [
        "DELETE /api/v1/migration/move",
        "DELETE /api/v1/migration/previous",
        "DELETE /api/v1/profile/avatar",
        "DELETE /api/v1/profile/header",
        "GET /api/v1/accounts/verify_credentials",
        "GET /api/v1/migration",
        "GET /api/v1/preferences",
        "GET /api/v1/profile",
        "GET /api/v1/streaming",
        "PATCH /api/v1/accounts/update_credentials",
        "PATCH /api/v1/profile",
        "POST /api/v1/migration/move",
        "PUT /api/v1/migration/previous",
    ]);
});
