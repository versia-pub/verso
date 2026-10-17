import { assertEquals } from "@std/assert";
import { defaultSettings } from "../instances/testing.ts";
import { createTestContext } from "../kernel/testing.ts";
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
    assertEquals(body.info, { title: "social.example", version: "0.0.0" });
    assertEquals(Object.keys(body.paths["/openapi.json"]), ["get"]);
    assertEquals(Object.keys(body.paths["/api/v1/accounts/{id}"]), ["get"]);

    assertEquals((await fetchDocument("Example")).body.info.title, "Example");
});

/**
 * Changes to the API show up in review as changes to `openapi.json`. When they are meant,
 * `deno task update-openapi` rewrites it.
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
