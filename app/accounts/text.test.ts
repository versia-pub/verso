import { assertEquals } from "@std/assert";
import { escapeHtml, textToHtml } from "./text.ts";

Deno.test("plain text becomes escaped paragraphs and line breaks, with links", () => {
    assertEquals(
        textToHtml("Hi <b>all</b>\nsecond line\r\n\r\nnew 'paragraph' at https://a.example"),
        "<p>Hi &lt;b&gt;all&lt;/b&gt;<br>second line</p><p>new 'paragraph' at " +
            '<a href="https://a.example" rel="nofollow noopener noreferrer" target="_blank">' +
            "https://a.example</a></p>",
    );
});

Deno.test("blank text is no HTML at all", () => {
    assertEquals(textToHtml(""), "");
    assertEquals(textToHtml(" \n\n \n"), "");
});

Deno.test("one line is escaped, without a paragraph", () => {
    assertEquals(
        escapeHtml(`<a href="x">me</a> & co`),
        "&lt;a href=&quot;x&quot;&gt;me&lt;/a&gt; &amp; co",
    );
});
