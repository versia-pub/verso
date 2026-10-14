import { assertEquals } from "@std/assert";
import { formatReference, parseReference } from "./reference.ts";

const id = "6e0204a2-746c-4972-8602-c4f37fc63bbe";

Deno.test("a bare id refers to the instance the entity came from", () => {
  assertEquals(parseReference(id, "example.com"), { host: "example.com", id });
});

Deno.test("a hostname before the last colon is the entity's instance", () => {
  for (
    const host of [
      "test.org",
      "example.com:3000",
      "xn--ls8h.xn--ls8h",
      "[2001:db8::1]",
      "[2001:db8::1]:3000",
    ]
  ) {
    assertEquals(parseReference(`${host}:${id}`, "example.com"), { host, id });
  }
});

Deno.test("hostnames are stored in canonical form", () => {
  for (
    const [written, canonical] of [
      ["Test.ORG", "test.org"],
      ["test.org:443", "test.org"],
      ["[2001:DB8:0:0:0:0:0:1]", "[2001:db8::1]"],
    ]
  ) {
    assertEquals(
      parseReference(`${written}:${id}`, "example.com")?.host,
      canonical,
    );
  }
  assertEquals(parseReference(id, "Example.com")?.host, "example.com");
});

Deno.test("invalid references are rejected", () => {
  for (
    const text of [
      "",
      ":abc",
      "test.org:",
      "test.org:has space",
      "test.org:a.b",
      "2001:db8::1:abc",
      "ü.example:abc",
      "example.com:99999:abc",
      "user@test.org:abc",
      "test.org/path:abc",
    ]
  ) {
    assertEquals(parseReference(text, "example.com"), undefined, text);
  }
});

Deno.test("references from the origin are formatted as a bare id", () => {
  assertEquals(formatReference({ host: "example.com", id }, "example.com"), id);
  assertEquals(formatReference({ host: "example.com", id }, "EXAMPLE.com"), id);
  assertEquals(
    formatReference({ host: "test.org", id }, "example.com"),
    `test.org:${id}`,
  );
});
