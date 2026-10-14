import { assertEquals, assertExists } from "@std/assert";
import fc from "fast-check";
import { formatReference, parseReference } from "./reference.ts";

const origin = "origin.example";
const ids = fc.stringMatching(/^[A-Za-z0-9_-]+$/);
// Port 443 is the HTTPS default, which is never written out.
const ports = fc.integer({ min: 1, max: 65535 }).filter((port) => port !== 443);
const domains = fc
    .tuple(fc.domain(), fc.option(ports, { nil: undefined }))
    .map(([name, port]) => port === undefined ? name : `${name}:${port}`);
const ipv6Hosts = fc
    .tuple(fc.ipV6(), fc.option(ports, { nil: undefined }))
    .map(([address, port]) => port === undefined ? `[${address}]` : `[${address}]:${port}`);

Deno.test("a domain reference parses to its parts and formats back to the same text", () => {
    fc.assert(fc.property(domains, ids, (host, id) => {
        const text = `${host}:${id}`;
        const reference = parseReference(text, origin);
        assertEquals(reference, { host, id });
        assertEquals(formatReference({ host, id }, origin), text);
    }));
});

Deno.test("any IPv6 address in brackets is accepted", () => {
    fc.assert(fc.property(ipv6Hosts, ids, (host, id) => {
        assertExists(parseReference(`${host}:${id}`, origin));
    }));
});

Deno.test("an accepted reference survives formatting and parsing again", () => {
    const hosts = fc.oneof(domains, ipv6Hosts, fc.constant(origin));
    fc.assert(fc.property(hosts, ids, (host, id) => {
        const reference = parseReference(`${host}:${id}`, origin);
        assertExists(reference);
        assertEquals(
            parseReference(formatReference(reference, origin), origin),
            reference,
        );
    }));
});

Deno.test("the case of a hostname doesn't matter", () => {
    fc.assert(fc.property(domains, ids, (host, id) => {
        assertEquals(
            parseReference(`${host.toUpperCase()}:${id}`, origin),
            parseReference(`${host}:${id}`, origin),
        );
    }));
});
