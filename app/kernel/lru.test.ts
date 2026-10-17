import { assertEquals } from "@std/assert";
import { lru } from "./lru.ts";

Deno.test("an LRU cache drops the least recently used value first", () => {
    const cache = lru<string, number>(2);

    cache.set("a", 1);
    cache.set("b", 2);
    assertEquals(cache.get("a"), 1);
    cache.set("c", 3);

    assertEquals([cache.get("a"), cache.get("b"), cache.get("c")], [1, undefined, 3]);
});
