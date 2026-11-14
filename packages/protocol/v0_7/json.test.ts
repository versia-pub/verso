import { assertEquals } from "@std/assert";
import { parseJson } from "./json.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const accepts = (text: string) => parseJson(encode(text)).ok;

Deno.test("valid JSON is parsed", () => {
    assertEquals(parseJson(encode('{"a": [1, -2.5, 0.1, true, null]}')), {
        ok: true,
        value: { a: [1, -2.5, 0.1, true, null] },
    });
});

Deno.test("any non-empty key is allowed", () => {
    for (
        const key of ["a", "pub.versia:likes", "image/svg+xml", "$schema", "a b", "é", "\\u0020"]
    ) {
        assertEquals(accepts(`{"${key}": 1}`), true, key);
    }

    assertEquals(accepts('{"": 1}'), false);
    assertEquals(accepts('{"a": {"": 1}}'), false);
    assertEquals(accepts('{"a": ""}'), true);
    assertEquals(accepts('[""]'), true);
});

Deno.test("keys are checked even with a lot of space before the colon", () => {
    assertEquals(accepts(`{""${" ".repeat(50)}: 1}`), false);
});

Deno.test("duplicate keys are rejected within one object only", () => {
    assertEquals(accepts('{"a": 1, "a": 2}'), false);
    assertEquals(accepts('{"a": 1, "\\u0061": 2}'), false);
    assertEquals(accepts('{"a": {"a": 1}, "b": [{"a": 1}, {"a": 2}]}'), true);
    assertEquals(accepts('{"a": [{"b": 1, "b": 2}]}'), false);
    assertEquals(accepts('["a", "a"]'), true);
});

Deno.test("numbers may take any form JSON allows", () => {
    for (const number of ["0", "-0", "1e3", "1E3", "1.0", "1.50", "-2.5e-3", "9007199254740993"]) {
        assertEquals(accepts(`{"n": ${number}}`), true, number);
    }
});

Deno.test("syntax JSON.parse already rejects stays rejected", () => {
    for (const text of ["{", "01", ".1", "1.", "0x1A", "NaN", "{'a': 1}", '"a\rb"']) {
        assertEquals(accepts(text), false, JSON.stringify(text));
    }
});

Deno.test("carriage returns are allowed between tokens, but not inside strings", () => {
    assertEquals(accepts('{\r\n"a": 1\r\n}'), true);
    assertEquals(accepts('{"a": "b\\nc"}'), true);

    for (const string of ["\\r", "\\r\\n", "\\u000d", "\\u000D"]) {
        assertEquals(accepts(`{"a": "${string}"}`), false, string);
        assertEquals(accepts(`{"${string}": 1}`), false, string);
    }
});

Deno.test("escaped quotes and backslashes don't end a string early", () => {
    assertEquals(accepts('{"a": "x\\"y", "b": "x\\\\"}'), true);
    assertEquals(accepts('{"a\\"": 1, "a\\"": 2}'), false);
});

Deno.test("lone surrogates and noncharacters are rejected, in keys and values", () => {
    for (
        const string of ["\\ud800", "\\udfff", "a\\udc00b", "\\ufffe", "\\uffff", "\\ufdd0", "﷯"]
    ) {
        assertEquals(accepts(`{"a": "${string}"}`), false, string);
        assertEquals(accepts(`{"${string}": 1}`), false, string);
    }

    // A pair of surrogates is one character, written escaped or not.
    assertEquals(accepts('{"a": "\\ud83d\\ude00 😀"}'), true);
    assertEquals(accepts('{"a": "\\ufffd"}'), true);
});

Deno.test("invalid UTF-8 is rejected", () => {
    assertEquals(parseJson(new Uint8Array([0x22, 0xff, 0x22])).ok, false);
    // A surrogate written directly in UTF-8.
    assertEquals(parseJson(new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22])).ok, false);
});
