import { assertEquals } from "@std/assert";
import { formatReference, isDomain, parseReference } from "./reference.ts";

const id = "1hydmskagrdtnq544w";

Deno.test("the spec's valid domains are domains", () => {
    for (
        const domain of [
            "example.com",
            "test.localhost",
            "sus.example.org",
            "xn--bcher-kva.example",
            "1.0.1.7.0.8.0.0.0.0.7.4.0.1.0.0.2.ip6.arpa",
        ]
    ) {
        assertEquals(isDomain(domain), true, domain);
        assertEquals(parseReference(`${domain}:${id}`), { host: domain, id }, domain);
    }
});

Deno.test("the spec's invalid domains, and other non-canonical forms, aren't", () => {
    for (
        const domain of [
            "example.com:3000",
            "test..localhost",
            "example.com.",
            "example.org/",
            "example.org/sus",
            "bücher.example",
            "Example.com",
            "https://a.example",
            "192.0.2.1",
            "localhost",
            "[2001:db8::1]",
            "example.com:443",
            "ex%61mple.com",
            "",
        ]
    ) {
        assertEquals(isDomain(domain), false, domain);
        assertEquals(parseReference(`${domain}:${id}`), undefined, domain);
    }
});

Deno.test("ids are 1 to 18 lowercase letters, digits, _ and -", () => {
    for (const valid of ["a", "0", "_", "-", "a".repeat(18), "1j0q0j3wb4v0hgtw6w", "a_b-c"]) {
        assertEquals(parseReference(`example.com:${valid}`)?.id, valid, valid);
    }

    for (const invalid of ["", "a".repeat(19), "A", "1J0Q", "a b", "a.b", "é"]) {
        assertEquals(parseReference(`example.com:${invalid}`), undefined, invalid);
    }
});

Deno.test("a reference has exactly one colon, with a domain before it", () => {
    for (const text of [id, `:${id}`, `example.com:${id}:`, `example.com::${id}`, "example.com:"]) {
        assertEquals(parseReference(text), undefined, text);
    }
});

Deno.test("a reference always formats with its domain", () => {
    assertEquals(formatReference({ host: "example.com", id }), `example.com:${id}`);
});
