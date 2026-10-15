import { assertEquals } from "@std/assert";
import { grants } from "./scopes.ts";

Deno.test("a scope covers the granular scopes under it, as in Mastodon", () => {
    assertEquals(grants(["read:statuses"], "read:statuses"), true);
    assertEquals(grants(["read"], "read:statuses"), true);
    assertEquals(grants(["admin:read"], "admin:read:accounts"), true);

    assertEquals(grants(["read"], "write:statuses"), false);
    assertEquals(grants(["read"], "admin:read:accounts"), false);
    assertEquals(grants(["read:statuses"], "read"), false);
});

Deno.test("follow covers the scopes it was split into", () => {
    assertEquals(grants(["follow"], "write:follows"), true);
    assertEquals(grants(["follow"], "read:mutes"), true);
    assertEquals(grants(["follow"], "write:statuses"), false);
});

Deno.test("reading accounts covers the profile", () => {
    assertEquals(grants(["read"], "profile"), true);
    assertEquals(grants(["read:accounts"], "profile"), true);
    assertEquals(grants(["profile"], "read:accounts"), false);
    assertEquals(grants(["write"], "profile"), false);
});
