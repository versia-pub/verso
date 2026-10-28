import { assertEquals } from "@std/assert";
import { parseStatusQuery } from "./query.ts";
import type { NoteTerm } from "./search_queries.ts";

/** A term of `kind` for `values`, negated if `negated`. */
const termOf = (kind: NoteTerm["kind"]) => (values: string[], negated = false): NoteTerm => ({
    kind,
    values,
    negated,
});
const words = termOf("words");
const phrase = termOf("phrase");
const hashtag = (name: string, negated = false) => termOf("hashtag")([name], negated);

Deno.test("a query is read as words a status must or mustn't have", () => {
    assertEquals(parseStatusQuery("Hello  +Wörld -bye"), [
        words(["hello"]),
        words(["world"]),
        words(["bye"], true),
    ]);
    // A term's words go together.
    assertEquals(parseStatusQuery("good-bye"), [words(["good", "bye"])]);
    assertEquals(parseStatusQuery("-good-bye"), [words(["good", "bye"], true)]);
    assertEquals(parseStatusQuery('a"b foo#bar'), [words(["a", "b"]), words(["foo", "bar"])]);

    for (const query of ["", " -- ", "-", "+", '""', "#", "-#"]) {
        assertEquals(parseStatusQuery(query), [], query);
    }
});

Deno.test("a query's quoted phrases and hashtags are read as such", () => {
    assertEquals(parseStatusQuery('"Hello  world" -"good bye" "open'), [
        phrase(["hello", "world"]),
        phrase(["good", "bye"], true),
        phrase(["open"]),
    ]);
    assertEquals(parseStatusQuery("#Nix -#rust +#go"), [
        hashtag("nix"),
        hashtag("rust", true),
        hashtag("go"),
    ]);
});

Deno.test("a query's prefixes Mastodon doesn't know are read as words", () => {
    assertEquals(parseStatusQuery('foo:bar -lang:"a b" foo: :bar'), [
        words(["foo", "bar"]),
        words(["lang", "a", "b"], true),
        words(["foo"]),
        words(["bar"]),
    ]);
    assertEquals(parseStatusQuery("tag:#nix"), [words(["tag", "nix"])]);
    // A prefix has no colon.
    assertEquals(parseStatusQuery('a:b:"c d"'), [words(["a", "b", "c"]), words(["d"])]);
});
