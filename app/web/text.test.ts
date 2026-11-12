import { assertEquals } from "@std/assert";
import { emojify } from "./text.ts";

Deno.test("custom emojis are shown in names and text, but not in tags", () => {
    const emojis = [{
        shortcode: "blob",
        url: "https://a.example/blob.gif",
        static_url: 'https://a.example/blob.png?a="b"',
        visible_in_picker: true,
        category: null,
    }];

    assertEquals(
        emojify('<a title=":blob:">:blob: and :nope:</a>:blob:', emojis),
        '<a title=":blob:"><img class="emoji" src="https://a.example/blob.png?a=&quot;b&quot;" ' +
            'alt=":blob:" title=":blob:"> and :nope:</a><img class="emoji" ' +
            'src="https://a.example/blob.png?a=&quot;b&quot;" alt=":blob:" title=":blob:">',
    );
    assertEquals(emojify("no emojis :blob:", []), "no emojis :blob:");
});
