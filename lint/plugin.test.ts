import { assertEquals } from "@std/assert";
import plugin from "./plugin.ts";

const problems = (source: string) => Deno.lint.runPlugin(plugin, "sample.ts", source).length;

Deno.test("function declarations and expressions are reported", () => {
    assertEquals(problems("function a() {}"), 1);
    assertEquals(problems("export function a(): void {}"), 1);
    assertEquals(problems("const a = function () {};"), 1);
    assertEquals(problems("const o = { f: function () {} };"), 1);
});

Deno.test("arrow functions, methods and generators are allowed", () => {
    assertEquals(problems("const a = () => {};"), 0);
    assertEquals(problems("const o = { m() {}, get x() { return 1; } };"), 0);
    assertEquals(problems("class C { m() {} }"), 0);
    assertEquals(problems("function* g() { yield 1; }"), 0);
});
