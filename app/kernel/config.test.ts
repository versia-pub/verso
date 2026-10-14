import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseConfig } from "./config.ts";

Deno.test("a minimal config gets the defaults", () => {
  assertEquals(parseConfig('domain = "social.example"'), {
    ok: true,
    config: { domain: "social.example", http: { port: 8080 } },
  });
});

Deno.test("a full config is read as written", () => {
  const result = parseConfig(`
domain = "Social.Example"

[http]
port = 3000
`);
  assertEquals(result, {
    ok: true,
    config: { domain: "social.example", http: { port: 3000 } },
  });
});

Deno.test("bad configs explain what is wrong", () => {
  const errors = (toml: string) => {
    const result = parseConfig(toml);
    assertEquals(result.ok, false, toml);
    return result.ok ? "" : result.error;
  };
  assertStringIncludes(errors(""), "domain");
  assertStringIncludes(errors('domain = "social.example:8080"'), "domain");
  assertStringIncludes(
    errors('domain = "social.example"\n[http]\nport = 0'),
    "http.port",
  );
  assertStringIncludes(
    errors('domain = "social.example"\ndomian = "typo.example"'),
    "domian",
  );
  assertStringIncludes(errors("domain = "), "Invalid TOML");
});
