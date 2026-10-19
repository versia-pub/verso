import { assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { entityUrl, urlBuilder, versiaUrl } from "./urls.ts";

const urls = urlBuilder("social.example");

Deno.test("urls are https on the instance's domain", () => {
    assertEquals([urls.domain, urls.origin], ["social.example", "https://social.example"]);
    assertEquals(
        urls.url`/api/v1/instance`,
        "https://social.example/api/v1/instance",
    );

    const id = "019b76da-a800-7000-8000-000000000001";
    assertEquals(
        urls.url`/api/v1/accounts/${id}/statuses`,
        `https://social.example/api/v1/accounts/${id}/statuses`,
    );
});

Deno.test("values are encoded so they stay in their segment", () => {
    assertEquals(
        urls.url`/tags/${"a/b?c#d@e.f"}`,
        "https://social.example/tags/a%2Fb%3Fc%23d%40e.f",
    );
    assertEquals(
        urls.url`/${"//evil.example"}`,
        "https://social.example/%2F%2Fevil.example",
    );
});

Deno.test("any value gives a URL with the same host and one segment for it", () => {
    fc.assert(
        fc.property(
            fc.string({ unit: "grapheme" }).filter((value) => !["", ".", ".."].includes(value)),
            (value) => {
                const url = new URL(urls.url`/tags/${value}/feed`);

                assertEquals(url.protocol, "https:");
                assertEquals(url.host, "social.example");
                assertEquals(url.search, "");
                assertEquals(url.hash, "");

                const [tags, segment, feed, ...rest] = url.pathname.slice(1)
                    .split("/");
                assertEquals([tags, decodeURIComponent(segment), feed, rest], [
                    "tags",
                    value,
                    "feed",
                    [],
                ]);
            },
        ),
    );
});

Deno.test("values that would bend the path are refused", () => {
    for (const value of ["", ".", ".."]) {
        assertThrows(() => urls.url`/tags/${value}`, Error, "path segment");
    }

    assertThrows(() => urls.url`api/v1/instance`, Error, 'start with "/"');
});

Deno.test("in development, URLs can use another origin", () => {
    const local = urlBuilder("localhost", "http://localhost:8080");

    // The domain has no port, unlike the origin.
    assertEquals([local.domain, local.origin], ["localhost", "http://localhost:8080"]);
    assertEquals(local.url`/oauth/callback`, "http://localhost:8080/oauth/callback");
});

Deno.test("another instance's Versia URLs are under its /.versia/v0.6", () => {
    assertEquals(versiaUrl("b.example", "/inbox").href, "https://b.example/.versia/v0.6/inbox");
    assertEquals(
        entityUrl("b.example", "pub.versia:likes/Like", "a/b").href,
        "https://b.example/.versia/v0.6/entities/pub.versia:likes/Like/a%2Fb",
    );
});
