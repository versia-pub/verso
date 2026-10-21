import { assertEquals } from "@std/assert";
import { batchesOf } from "./batches.ts";

Deno.test("a list is split into batches in order, the last holding what is left", () => {
    assertEquals(batchesOf([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assertEquals(batchesOf([1, 2], 2), [[1, 2]]);
    assertEquals(batchesOf([], 2), []);
    assertEquals(
        batchesOf(Array.from({ length: 2500 }, (_, i) => i)).map((batch) => batch.length),
        [
            1000,
            1000,
            500,
        ],
    );
});
