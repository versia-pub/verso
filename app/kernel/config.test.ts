import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseConfig } from "./config.ts";

const minimal = `
domain = "social.example"

[database]
sqlite = "verso.db"
`;

Deno.test("a minimal config gets the defaults", () => {
  assertEquals(parseConfig(minimal), {
    ok: true,
    config: {
      domain: "social.example",
      database: { sqlite: "verso.db" },
      http: { port: 8080 },
      logging: { level: "info" },
    },
  });
});

Deno.test("a full config is read as written", () => {
  const result = parseConfig(`
domain = "Social.Example"

[database]
postgres = "postgresql://verso@/verso?host=/run/postgresql"

[http]
port = 3000

[logging]
level = "debug"
`);
  assertEquals(result, {
    ok: true,
    config: {
      domain: "social.example",
      database: { postgres: "postgresql://verso@/verso?host=/run/postgresql" },
      http: { port: 3000 },
      logging: { level: "debug" },
    },
  });
});

Deno.test("bad configs explain what is wrong", () => {
  const errors = (toml: string) => {
    const result = parseConfig(toml);
    assertEquals(result.ok, false, toml);
    return result.ok ? "" : result.error;
  };
  assertStringIncludes(errors(""), "domain");
  assertStringIncludes(
    errors(minimal.replace("social.example", "social.example:8080")),
    "domain",
  );
  assertStringIncludes(errors(minimal + "[http]\nport = 0"), "http.port");
  assertStringIncludes(errors('domian = "typo.example"' + minimal), "domian");
  assertStringIncludes(
    errors(minimal + '[logging]\nlevel = "loud"'),
    "logging.level",
  );
  const exactlyOne = 'Set exactly one of "postgres" or "sqlite"';
  assertStringIncludes(errors('domain = "social.example"'), exactlyOne);
  assertStringIncludes(
    errors(minimal + 'postgres = "postgresql:///verso"'),
    exactlyOne,
  );
  assertStringIncludes(errors("domain = "), "Invalid TOML");
});
