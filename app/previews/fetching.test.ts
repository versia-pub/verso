import { assertEquals } from "@std/assert";
import { decodePage } from "./fetching.ts";

Deno.test("a page is decoded in the charset the header or the page names", () => {
    const bytes = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    const of = (type: string, body: Uint8Array<ArrayBuffer>) =>
        decodePage({
            url: new URL("https://a.example/"),
            headers: new Headers({ "content-type": type }),
            body,
            truncated: false,
        });

    assertEquals(of("text/html; charset=iso-8859-1", bytes), "café");
    assertEquals(
        of(
            "text/html",
            Uint8Array.from([...new TextEncoder().encode('<meta charset="latin1">'), ...bytes]),
        ),
        '<meta charset="latin1">café',
    );
    assertEquals(
        of(
            "text/html; charset=iso-8859-1",
            Uint8Array.from([...new TextEncoder().encode('<meta charset="utf-8">'), ...bytes]),
        ),
        '<meta charset="utf-8">café',
    );
    assertEquals(of("text/html; charset=nonsense", new TextEncoder().encode("café")), "café");
    assertEquals(of("text/html", new TextEncoder().encode("café")), "café");
});
