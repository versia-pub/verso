import { assertAlmostEquals, assertEquals } from "@std/assert";
import { decayed, statusScore, tagScore } from "./scoring.ts";

Deno.test("a hashtag scores the square of how far today's accounts exceed yesterday's, over them", () => {
    assertEquals(tagScore(5, 1), 16);
    assertEquals(tagScore(9, 3), 12);
    // Nobody yesterday counts as one.
    assertEquals(tagScore(5, 0), 16);
});

Deno.test("a hashtag scores nothing below the threshold, or when fewer used it than yesterday", () => {
    assertEquals(tagScore(4, 1), 0);
    assertEquals(tagScore(0, 0), 0);
    assertEquals(tagScore(6, 7), 0);
    assertEquals(tagScore(5, 5), 0);
});

Deno.test("a score halves every half-life", () => {
    assertEquals(decayed(16, 0, 1000), 16);
    assertEquals(decayed(16, 1000, 1000), 8);
    assertAlmostEquals(decayed(16, 500, 1000), 16 / Math.SQRT2);
});

Deno.test("a status scores the square of its likes and boosts less one, halved every hour", () => {
    const now = new Date("2026-01-01T12:00:00Z");

    assertEquals(statusScore(5, now, now), 16);
    assertEquals(statusScore(5, new Date("2026-01-01T11:00:00Z"), now), 8);
    assertEquals(statusScore(11, new Date("2026-01-01T10:00:00Z"), now), 25);
});

Deno.test("a status with too few likes and boosts scores nothing, and one from the future hasn't aged", () => {
    const now = new Date("2026-01-01T12:00:00Z");

    assertEquals(statusScore(4, now, now), 0);
    assertEquals(statusScore(5, new Date("2026-01-02T12:00:00Z"), now), 16);
});
