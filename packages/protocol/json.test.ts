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

Deno.test("keys may only use the allowed characters", () => {
    for (
        const key of [
            "valid-key",
            "valid_key",
            "valid.key",
            "valid#key",
            "valid/key",
            "valid:key",
            "A9",
        ]
    ) {
        assertEquals(accepts(`{"${key}": 1}`), true, key);
    }

    for (const key of ["invalid key", "invalid@key", "", "\\u0020", "é"]) {
        assertEquals(accepts(`{"${key}": 1}`), false, key);
    }
});

Deno.test("keys are checked even with a lot of space before the colon", () => {
    assertEquals(accepts(`{"bad key"${" ".repeat(50)}: 1}`), false);
});

Deno.test("duplicate keys are rejected within one object only", () => {
    assertEquals(accepts('{"a": 1, "a": 2}'), false);
    assertEquals(accepts('{"a": {"a": 1}, "b": [{"a": 1}, {"a": 2}]}'), true);
    assertEquals(accepts('{"a": [{"b": 1, "b": 2}]}'), false);
});

Deno.test("strings that look like keys or numbers are left alone", () => {
    assertEquals(accepts('{"a": "b c: 1e3, 01"}'), true);
    assertEquals(accepts('["a b", "a b"]'), true);
});

Deno.test("numbers must be plain decimals", () => {
    for (
        const number of [
            "0",
            "1",
            "-1",
            "0.1",
            "-0.5",
            "1000",
            "9007199254740992",
            "-9007199254740992",
        ]
    ) {
        assertEquals(accepts(`{"n": ${number}}`), true, number);
    }

    for (
        const number of [
            "1e3",
            "1E3",
            "1.00",
            "1.0",
            "1.50",
            "-0",
            "-0.0",
            "9007199254740993",
            "9007199254740992.5",
            "18014398509481984",
        ]
    ) {
        assertEquals(accepts(`{"n": ${number}}`), false, number);
    }
});

Deno.test("syntax JSON.parse already rejects stays rejected", () => {
    for (const text of ["{", "01", ".1", "1.", "0x1A", "NaN", "{'a': 1}"]) {
        assertEquals(accepts(text), false, text);
    }
});

Deno.test("CRLF line endings and invalid UTF-8 are rejected", () => {
    assertEquals(accepts('{\r\n"a": 1\r\n}'), false);
    assertEquals(accepts('{\n"a": "\\r\\n"\n}'), true);
    assertEquals(parseJson(new Uint8Array([0x22, 0xff, 0x22])).ok, false);
});
