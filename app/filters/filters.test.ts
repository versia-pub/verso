import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { postNote } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { filterRoutes } from "./routes.ts";

/** alice and bob, who each posted a status, bob's a direct one to no one. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, filterRoutes, { checkResponses: true });
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);

    const post = async (accountId: string, visibility: "public" | "direct") => {
        const note = await postNote(test.ctx, accountId, {
            text: "Hi",
            format: "text/plain",
            spoilerText: "",
            visibility,
        });
        if (note === undefined) throw new Error("Not posted");
        return note.id;
    };
    const alices = await post("alice", "public");
    const bobs = await post("bob", "direct");

    /** Sends a request as `as`, with `body` as JSON, or as a form if it is `URLSearchParams`. */
    const request = async (method: string, path: string, body?: unknown, as = "alice") => {
        const form = body instanceof URLSearchParams;
        const headers: HeadersInit = {
            authorization: `Bearer ${await tokenFor(test.ctx, as)}`,
            ...body === undefined ? {} : {
                "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
            },
        };
        const response = await app.request(path, {
            method,
            headers,
            body: body === undefined ? undefined : form ? body.toString() : JSON.stringify(body),
        });

        return { status: response.status, body: await response.json() };
    };

    /** Makes a filter for `as` with `keywords`, and returns it. */
    const filter = async (keywords: string[] = [], as = "alice") =>
        (await request("POST", "/api/v2/filters", {
            title: "Pets",
            context: ["home"],
            keywords_attributes: keywords.map((keyword) => ({ keyword })),
        }, as)).body;

    return { ...test, alices, bobs, request, filter };
};

const keywordsOf = (filter: { keywords: { keyword: string; whole_word: boolean }[] }) =>
    filter.keywords.map((each) => [each.keyword, each.whole_word]);

Deno.test("a user makes filters, changes them, and deletes them", async () => {
    await using test = await open();

    const made = await test.request("POST", "/api/v2/filters", {
        title: "Pets",
        context: [" home", "", "public"],
        keywords_attributes: [{ keyword: "cat" }, { keyword: "dog", whole_word: false }],
    });
    assertEquals(made.status, 200);
    assertEquals(
        [made.body.title, made.body.context, made.body.filter_action, made.body.expires_at],
        ["Pets", ["home", "public"], "warn", null],
    );
    assertEquals(keywordsOf(made.body), [["cat", true], ["dog", false]]);
    assertEquals(made.body.statuses, []);
    const other = await test.filter();

    const [cat, dog] = made.body.keywords;
    const changed = await test.request("PUT", `/api/v2/filters/${made.body.id}`, {
        filter_action: "hide",
        keywords_attributes: [
            { id: cat.id, _destroy: true },
            { id: dog.id, keyword: "dogs" },
            { keyword: "bird" },
        ],
    });
    assertEquals([changed.body.title, changed.body.filter_action], ["Pets", "hide"]);
    assertEquals(keywordsOf(changed.body), [["dogs", false], ["bird", true]]);
    const shown = await test.request("GET", `/api/v2/filters/${made.body.id}`);
    assertEquals(shown.body, changed.body);
    const listed = await test.request("GET", "/api/v2/filters");
    assertEquals(listed.body.map((each: { id: string }) => each.id), [made.body.id, other.id]);

    assertEquals((await test.request("DELETE", `/api/v2/filters/${other.id}`)).body, {});
    assertEquals((await test.request("GET", `/api/v2/filters/${other.id}`)).status, 404);
    assertEquals((await test.request("GET", "/api/v2/filters")).body.length, 1);
});

Deno.test("a filter takes keywords from a form, as Rails reads them", async () => {
    await using test = await open();
    const form = new URLSearchParams([
        ["title", "Pets"],
        ["context[]", "home"],
        ["keywords_attributes[0][keyword]", "cat"],
        ["keywords_attributes[0][whole_word]", "false"],
        ["keywords_attributes[1][keyword]", "dog"],
        // Blank, so left out.
        ["keywords_attributes[2][keyword]", ""],
    ]);

    const made = await test.request("POST", "/api/v2/filters", form);
    assertEquals(keywordsOf(made.body), [["cat", false], ["dog", true]]);
});

Deno.test("a filter expires as many seconds from now as asked, or never", async () => {
    await using test = await open();
    const made = await test.request("POST", "/api/v2/filters", {
        title: "Pets",
        context: ["home"],
        expires_in: 3600,
    });
    const hour = new Date(test.clock.now().getTime() + 3600 * 1000).toISOString();
    assertEquals(made.body.expires_at, hour);

    const path = `/api/v2/filters/${made.body.id}`;
    assertEquals((await test.request("PUT", path, { title: "Cats" })).body.expires_at, hour);
    assertEquals((await test.request("PUT", path, { expires_in: "" })).body.expires_at, null);
});

Deno.test("a filter needs a title, a context and keywords that aren't blank", async () => {
    await using test = await open();
    const create = (body: Record<string, unknown>) =>
        test.request("POST", "/api/v2/filters", { title: "Pets", context: ["home"], ...body });

    assertEquals((await create({ title: " " })).status, 422);
    assertEquals((await create({ context: [] })).status, 422);
    assertEquals((await create({ context: ["home", "elsewhere"] })).status, 422);
    assertEquals((await create({ filter_action: "blur" })).status, 422);
    assertEquals(
        (await create({ keywords_attributes: [{ keyword: " ", whole_word: true }] })).status,
        422,
    );
    assertEquals(
        (await create({ keywords_attributes: [{ id: "1", keyword: "cat" }] })).status,
        404,
    );
    assertEquals((await test.request("GET", "/api/v2/filters")).body, []);
});

Deno.test("a filter's keywords are its own, and no one else sees or changes them", async () => {
    await using test = await open();
    const filter = await test.filter(["cat"]);
    const bobs = await test.filter(["dog"], "bob");
    const [dog] = bobs.keywords;

    // A keyword of another filter's isn't changed, nor is anything else.
    const changed = await test.request("PUT", `/api/v2/filters/${filter.id}`, {
        title: "Cats",
        keywords_attributes: [{ id: dog.id, keyword: "cats" }],
    });
    assertEquals(changed.status, 404);
    assertEquals((await test.request("GET", `/api/v2/filters/${filter.id}`)).body.title, "Pets");

    assertEquals((await test.request("GET", "/api/v2/filters", undefined, "bob")).body.length, 1);
    for (const method of ["GET", "PUT", "DELETE"]) {
        const body = method === "PUT" ? {} : undefined;
        const path = `/api/v2/filters/${filter.id}`;
        assertEquals((await test.request(method, path, body, "bob")).status, 404);
    }
    for (const method of ["GET", "PUT", "DELETE"]) {
        const body = method === "PUT" ? { keyword: "cats" } : undefined;
        const path = `/api/v2/filters/keywords/${dog.id}`;
        assertEquals((await test.request(method, path, body)).status, 404);
    }
    const path = `/api/v2/filters/${bobs.id}/keywords`;
    assertEquals((await test.request("GET", path)).status, 404);
    assertEquals((await test.request("POST", path, { keyword: "cats" })).status, 404);
});

Deno.test("a user adds keywords to a filter, changes them, and removes them", async () => {
    await using test = await open();
    const filter = await test.filter(["cat"]);
    const path = `/api/v2/filters/${filter.id}/keywords`;

    const added = await test.request("POST", path, { keyword: "dog" });
    assertEquals([added.body.keyword, added.body.whole_word], ["dog", true]);
    assertEquals((await test.request("POST", path, { keyword: "" })).status, 422);

    const keyword = `/api/v2/filters/keywords/${added.body.id}`;
    const changed = await test.request("PUT", keyword, { whole_word: false });
    assertEquals([changed.body.keyword, changed.body.whole_word], ["dog", false]);
    assertEquals((await test.request("PUT", keyword, { keyword: " " })).status, 422);
    assertEquals((await test.request("GET", keyword)).body, changed.body);
    const listed = await test.request("GET", path);
    assertEquals(listed.body.map((each: { keyword: string }) => each.keyword), ["cat", "dog"]);

    assertEquals((await test.request("DELETE", keyword)).body, {});
    assertEquals((await test.request("GET", keyword)).status, 404);
    assertEquals(keywordsOf((await test.request("GET", `/api/v2/filters/${filter.id}`)).body), [
        ["cat", true],
    ]);
});

Deno.test("a user adds statuses they can see to a filter, and removes them", async () => {
    await using test = await open();
    const filter = await test.filter();
    const path = `/api/v2/filters/${filter.id}/statuses`;

    const added = await test.request("POST", path, { status_id: test.alices });
    assertEquals(added.body.status_id, test.alices);
    assertEquals((await test.request("POST", path, { status_id: test.alices })).status, 422);
    assertEquals((await test.request("POST", path, { status_id: test.bobs })).status, 422);
    assertEquals((await test.request("POST", path, { status_id: "missing" })).status, 422);
    assertEquals((await test.request("POST", path, { status_id: test.alices }, "bob")).status, 404);

    const status = `/api/v2/filters/statuses/${added.body.id}`;
    assertEquals((await test.request("GET", status)).body, added.body);
    assertEquals((await test.request("GET", path)).body, [added.body]);
    assertEquals((await test.request("GET", status, undefined, "bob")).status, 404);
    assertEquals((await test.request("DELETE", status, undefined, "bob")).status, 404);

    assertEquals((await test.request("DELETE", status)).body, {});
    assertEquals((await test.request("GET", path)).body, []);

    // Deleting the status removes it from the filter too.
    await test.request("POST", path, { status_id: test.alices });
    await removeNote(test.ctx, test.alices);
    assertEquals((await test.request("GET", path)).body, []);
});
