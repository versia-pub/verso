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

Deno.test("interfaces and enums are reported", () => {
    assertEquals(problems("interface A { a: string }"), 1);
    assertEquals(problems("export interface B extends A { b: number }"), 1);
    assertEquals(problems("enum C { X, Y }"), 1);
    assertEquals(problems('const enum D { X = "x" }'), 1);
});

Deno.test("type aliases and string unions are allowed", () => {
    assertEquals(problems("type A = { a: string };"), 0);
    assertEquals(problems("type B = A & { b: number };"), 0);
    assertEquals(problems('type C = "x" | "y";'), 0);
});

Deno.test("an interface and an enum are each told what to use instead", () => {
    const messages = (source: string) =>
        Deno.lint.runPlugin(plugin, "sample.ts", source).map((problem) => problem.message);

    assertEquals(messages("interface A {}"), ["Use a `type` alias instead of `interface`."]);
    assertEquals(messages("enum C { X }"), ["Use a union of string literals instead of `enum`."]);
});
