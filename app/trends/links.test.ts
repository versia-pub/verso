import { assertEquals } from "@std/assert";
import { cardState, websiteDomains } from "./review.ts";

Deno.test("a website's domains are its own and each it is a subdomain of, the most specific first", () => {
    assertEquals(websiteDomains("https://a.b.news.example/x?y=1"), [
        "a.b.news.example",
        "b.news.example",
        "news.example",
        "example",
    ]);
    // Domain names are in lower case, and internationalised ones in ASCII.
    assertEquals(websiteDomains("https://News.Example/"), ["news.example", "example"]);
    assertEquals(websiteDomains("https://bücher.example/"), [
        "xn--bcher-kva.example",
        "example",
    ]);
    assertEquals(websiteDomains("http://127.0.0.1:8080/"), ["127.0.0.1", "0.0.1", "0.1", "1"]);
});

Deno.test("a card trends by its own decision, else its website's most specific, else the default", () => {
    const card = (trendable: boolean | null) => ({ url: "https://www.news.example/a", trendable });
    const decisions = new Map([["news.example", false], ["www.news.example", true]]);

    assertEquals(cardState(card(null), new Map(), false), "pending");
    assertEquals(cardState(card(null), new Map(), true), "approved");
    assertEquals(cardState(card(null), decisions, false), "approved");
    assertEquals(cardState(card(null), new Map([["news.example", false]]), true), "rejected");
    assertEquals(cardState(card(false), decisions, true), "rejected");
    assertEquals(cardState(card(true), new Map([["example", false]]), false), "approved");
});
