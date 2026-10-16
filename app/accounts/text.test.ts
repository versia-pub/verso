import { assertEquals } from "@std/assert";
import { escapeHtml, textToHtml } from "./text.ts";

Deno.test("plain text becomes escaped paragraphs and line breaks", () => {
    assertEquals(
        textToHtml("Hi <b>all</b>\nsecond line\r\n\r\nnew 'paragraph'"),
        "<p>Hi &lt;b&gt;all&lt;/b&gt;<br>second line</p><p>new &#39;paragraph&#39;</p>",
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
