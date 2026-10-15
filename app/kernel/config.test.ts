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
            auth: { issuers: [] },
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

[[auth.issuers]]
name = "Example ID"
url = "https://id.example"
client_id = "verso"
client_secret_file = "/run/secrets/verso-oidc"

[[auth.issuers]]
name = "Partner ID"
url = "https://id.partner.example"
client_id = "verso"
client_secret = "s3cret"
username_claim = "nickname"
registration = { claim = "groups", contains = "versia-users" }

[logging]
level = "debug"
`);

    assertEquals(result, {
        ok: true,
        config: {
            domain: "social.example",
            database: {
                postgres: "postgresql://verso@/verso?host=/run/postgresql",
            },
            http: { port: 3000 },
            auth: {
                issuers: [
                    {
                        name: "Example ID",
                        url: "https://id.example",
                        client_id: "verso",
                        client_secret_file: "/run/secrets/verso-oidc",
                        username_claim: "preferred_username",
                        registration: "closed",
                    },
                    {
                        name: "Partner ID",
                        url: "https://id.partner.example",
                        client_id: "verso",
                        client_secret: "s3cret",
                        username_claim: "nickname",
                        registration: { claim: "groups", contains: "versia-users" },
                    },
                ],
            },
            logging: { level: "debug" },
        },
    });
});

const errors = (toml: string) => {
    const result = parseConfig(toml);
    assertEquals(result.ok, false, toml);
    return result.ok ? "" : result.error;
};

Deno.test("bad configs explain what is wrong", () => {
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

Deno.test("bad issuers explain what is wrong", () => {
    const issuer = (fields: string) =>
        errors(`${minimal}[[auth.issuers]]\nname = "ID"\nclient_id = "verso"\n${fields}`);
    const secret = 'client_secret = "s"';
    assertStringIncludes(
        issuer(`url = "http://id.example"\n${secret}`),
        "Must be an https URL",
    );
    const oneSecret = 'Set exactly one of "client_secret" or "client_secret_file"';
    assertStringIncludes(issuer('url = "https://id.example"'), oneSecret);
    assertStringIncludes(
        issuer(`url = "https://id.example"\n${secret}\nclient_secret_file = "/s"`),
        oneSecret,
    );
    assertStringIncludes(
        issuer(`url = "https://id.example"\n${secret}\nregistration = "maybe"`),
        "registration",
    );
    assertStringIncludes(
        errors(
            `${minimal}[[auth.issuers]]\nname = "A"\nurl = "https://id.example"\n` +
                `client_id = "a"\n${secret}\n` +
                `[[auth.issuers]]\nname = "B"\nurl = "https://id.example"\n` +
                `client_id = "b"\n${secret}`,
        ),
        "Each issuer URL can only be listed once",
    );
});
