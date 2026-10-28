import { assertEquals, assertThrows } from "@std/assert";
import { HttpError } from "../http/errors.ts";
import { parseStatusQuery } from "./query.ts";

/** A term of `kind` for `values`, negated if `negated`. */
const termOf = (kind: "words" | "phrase" | "hashtag") => (values: string[], negated = false) => ({
    kind,
    values,
    negated,
});
const words = termOf("words");
const phrase = termOf("phrase");
const hashtag = (name: string, negated = false) => termOf("hashtag")([name], negated);

/** The terms of `query`. */
const termsOf = (query: string) => parseStatusQuery(query).terms;

Deno.test("a query is read as words a status must or mustn't have", () => {
    assertEquals(termsOf("Hello  +Wörld -bye"), [
        words(["hello"]),
        words(["world"]),
        words(["bye"], true),
    ]);
    // A term's words go together.
    assertEquals(termsOf("good-bye"), [words(["good", "bye"])]);
    assertEquals(termsOf("-good-bye"), [words(["good", "bye"], true)]);
    assertEquals(termsOf('a"b foo#bar'), [words(["a", "b"]), words(["foo", "bar"])]);

    for (const query of ["", " -- ", "-", "+", '""', "#", "-#"]) {
        assertEquals(termsOf(query), [], query);
    }
});

Deno.test("a query's quoted phrases and hashtags are read as such", () => {
    assertEquals(termsOf('"Hello  world" -"good bye" "open'), [
        phrase(["hello", "world"]),
        phrase(["good", "bye"], true),
        phrase(["open"]),
    ]);
    assertEquals(termsOf("#Nix -#rust +#go"), [
        hashtag("nix"),
        hashtag("rust", true),
        hashtag("go"),
    ]);
});

Deno.test("a query's prefixes Mastodon doesn't know are read as words", () => {
    assertEquals(termsOf('foo:bar -lang:"a b" foo: :bar'), [
        words(["foo", "bar"]),
        words(["lang", "a", "b"], true),
        words(["foo"]),
        words(["bar"]),
    ]);
    assertEquals(termsOf("tag:#nix"), [words(["tag", "nix"])]);
    // A prefix has no colon.
    assertEquals(termsOf('a:b:"c d"'), [words(["a", "b", "c"]), words(["d"])]);
});

Deno.test("a query's prefixes Mastodon knows are read as what a status must or mustn't have", () => {
    assertEquals(termsOf('from:me -FROM:@bob@b.example from:"alice"'), [
        { kind: "from", account: "me", negated: false },
        { kind: "from", account: "@bob@b.example", negated: true },
        { kind: "from", account: "alice", negated: false },
    ]);
    assertEquals(termsOf("has:media -is:reply IS:Sensitive"), [
        { kind: "property", property: "media", negated: false },
        { kind: "property", property: "reply", negated: true },
        // Values are as written, as on Mastodon.
        { kind: "property", property: "Sensitive", negated: false },
    ]);
    assertEquals(termsOf("language:en-US -language:PT_br language:de lang:fr"), [
        { kind: "language", language: "en", negated: false },
        { kind: "language", language: "pt", negated: true },
        { kind: "language", language: "de", negated: false },
        words(["lang", "fr"]),
    ]);
});

Deno.test("a query's dates are days in UTC or milliseconds, and others are refused", () => {
    const day = (text: string) => new Date(`${text}T00:00:00Z`);
    assertEquals(termsOf("before:2024-03-01 after:2024-02-28 -during:2024-02-29"), [
        { kind: "created", since: null, until: day("2024-03-01"), negated: false },
        { kind: "created", since: day("2024-02-29"), until: null, negated: false },
        { kind: "created", since: day("2024-02-29"), until: day("2024-03-01"), negated: true },
    ]);
    assertEquals(termsOf("before:5 after:5 during:0"), [
        { kind: "created", since: null, until: new Date(5), negated: false },
        { kind: "created", since: new Date(6), until: null, negated: false },
        { kind: "created", since: new Date(0), until: new Date(1), negated: false },
    ]);

    for (
        const value of [
            "2024-02-30",
            "2023-02-29",
            "2024-13-01",
            "2024-1-01",
            "yesterday",
            "9999999999999999999",
            "12345678901234567890",
            "-5",
        ]
    ) {
        for (const prefix of ["before", "after", "during"]) {
            const error = assertThrows(() => termsOf(`${prefix}:${value}`), HttpError);
            assertEquals([error.status, error.message], [422, `Invalid date ${value}`], value);
        }
    }
});

Deno.test("a query's `in:` says which statuses to search, whatever its sign", () => {
    assertEquals(parseStatusQuery("fox"), { terms: [words(["fox"])], scope: null });
    assertEquals(parseStatusQuery("in:library fox"), { terms: [words(["fox"])], scope: "library" });
    assertEquals(parseStatusQuery("-IN:public").scope, "public");
    assertEquals(parseStatusQuery("in:all").scope, "all");
    assertEquals(parseStatusQuery("in:Library").scope, "all");
    // The last.
    assertEquals(parseStatusQuery('in:public in:"library"').scope, "library");
});
