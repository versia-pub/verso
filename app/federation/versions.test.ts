import { assertEquals } from "@std/assert";
import { isDiscardedVersion } from "./versions.ts";

const held = {
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-06-01T12:00:00.000Z"),
};
const received = { created_at: "2025-01-01T00:00:00.000Z", updated_at: "2025-06-01T12:00:00.000Z" };

Deno.test("a version older than the held one is discarded", () => {
    const older = { ...received, updated_at: "2025-06-01T11:59:59.999Z" };

    assertEquals(isDiscardedVersion(held, older), true);
});

Deno.test("a newer version and one with the same time are kept", () => {
    const newer = { ...received, updated_at: "2025-06-01T12:00:00.001Z" };

    assertEquals(isDiscardedVersion(held, newer), false);
    assertEquals(isDiscardedVersion(held, received), false);
});

Deno.test("a version is kept if either side has no updated_at", () => {
    const old = { created_at: received.created_at, updated_at: "2020-01-01T00:00:00Z" };

    assertEquals(isDiscardedVersion({ ...held, updatedAt: null }, old), false);
    assertEquals(isDiscardedVersion(held, { created_at: received.created_at }), false);
    assertEquals(isDiscardedVersion(held, { ...received, updated_at: null }), false);
});

Deno.test("a version with another created_at is discarded, even without updated_at", () => {
    const other = { created_at: "2025-01-01T00:00:01.000Z" };

    assertEquals(isDiscardedVersion(held, { ...received, ...other }), true);
    assertEquals(isDiscardedVersion({ ...held, updatedAt: null }, other), true);
});

Deno.test("the same instant written another way is not a different version", () => {
    const written = {
        created_at: "2025-01-01T02:00:00.00000+02:00",
        updated_at: "2025-06-01T12:00:00+00:00",
    };

    assertEquals(isDiscardedVersion(held, written), false);
    assertEquals(
        isDiscardedVersion(held, { ...written, created_at: "2025-01-01T00:00:00Z" }),
        false,
    );
});
