import { assertEquals } from "@std/assert";
import { fallbackOf } from "./fallback.ts";

const bob = { acct: "bob", url: "https://a.example/@bob" };
const carol = { acct: "c&<ar>\"ol'@b.example", url: "https://b.example/@c?x=1&y=<2>\"'" };

Deno.test("only a type that isn't Mastodon's baseline has a fallback, for a client that listed its types", () => {
    for (const type of ["mention", "reblog", "follow", "favourite", "quote", "update"] as const) {
        assertEquals(fallbackOf(type, ["follow_request"], [bob]), undefined);
    }

    assertEquals(fallbackOf("reaction", undefined, [bob]), undefined);
    assertEquals(fallbackOf("reaction", ["reaction"], [bob]), undefined);
    assertEquals(fallbackOf("reaction", [], [bob])?.description, null);
    assertEquals(
        fallbackOf("reaction", ["mention"], [bob])?.summary,
        "Your app doesn't support this kind of notification.",
    );
});

Deno.test("a fallback names the newest account, and how many others", () => {
    const title = (accounts: typeof bob[]) => fallbackOf("reaction", [], accounts)?.title;

    assertEquals(title([bob]), '<a href="https://a.example/@bob">@bob</a> reacted to your post');
    assertEquals(
        title([carol, bob]),
        '<a href="https://b.example/@c?x=1&amp;y=&lt;2&gt;&quot;&#39;">' +
            "@c&amp;&lt;ar&gt;&quot;ol&#39;@b.example</a> and one other reacted to your post",
    );
    assertEquals(title([bob, carol, bob])?.includes(" and 2 others reacted"), true);
    assertEquals(title([]), "Someone reacted to your post");
});
