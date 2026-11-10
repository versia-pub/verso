import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseToml } from "@std/toml";
import { parseConfig } from "./config.ts";
import { Permissions } from "./config_sections.ts";
import { settingsOf } from "./settings.ts";

const minimal = `
domain = "social.example"
media.storage.filesystem = "media"

[database]
sqlite = "verso.db"
`;

Deno.test("a minimal config gets the defaults", async () => {
    assertEquals(await parseConfig(minimal), {
        ok: true,
        config: {
            mode: "production",
            domain: "social.example",
            database: { sqlite: "verso.db" },
            media: {
                storage: { filesystem: "media" },
                max_pixels: 8_294_400,
                max_upload_bytes: 16_777_216,
                max_emoji_bytes: 262_144,
                unattached_hours: 24,
                cache_remote_media: true,
            },
            http: {
                port: 8080,
                trusted_proxies: [],
                rate_limit: { limit: 300, window_seconds: 300, store: "memory" },
            },
            auth: { issuers: [], dev_login: false, timeout_seconds: 15 },
            federation: {
                allow_internal_addresses: false,
                extra_web_ports: [],
                blocked_domains: [],
                silent_blocks: false,
                unreachable_days: 7,
                delivery_hours: 48,
                rate_limit: { limit: 3000, window_seconds: 300 },
                fetch_limit: { limit: 600, window_seconds: 300 },
            },
            instance: {
                description: "",
                contact: {},
                rules: [],
                show_peers: true,
                show_activity: true,
                show_blocks: "none",
                show_block_reasons: "none",
                show_trends: true,
                trendable_by_default: false,
                suggested_accounts: [],
            },
            limits: {
                display_name: 60,
                note: 10_000,
                fields: 16,
                field_name: 255,
                field_value: 255,
                status: 10_000,
                attachments: 16,
                mentions: 100,
                media_description: 4000,
                poll_options: 20,
                poll_option: 60,
                poll_min_seconds: 300,
                poll_max_seconds: 2_629_746,
            },
            permissions: {
                anonymous: [
                    "read:account",
                    "read:account_follows",
                    "read:note",
                    "read:note_likes",
                    "read:note_boosts",
                    "read:reaction",
                    "search",
                ],
                default: [
                    "read:account",
                    "read:account_follows",
                    "read:note",
                    "read:note_likes",
                    "read:note_boosts",
                    "read:reaction",
                    "read:emoji",
                    "search",
                    "owner:account",
                    "owner:block",
                    "owner:bookmark",
                    "owner:boost",
                    "owner:emoji",
                    "owner:filter",
                    "owner:follow",
                    "owner:like",
                    "owner:list",
                    "owner:media",
                    "owner:mute",
                    "owner:note",
                    "owner:notification",
                    "owner:reaction",
                    "owner:report",
                ],
            },
            streaming: { sockets_per_account: 10, subscriptions: 100, tag_length: 100 },
            search: { query_length: 500, max_offset: 10_000 },
            timelines_access: {
                live_feeds: { local: "public", remote: "public" },
                topic_feeds: { local: "public", remote: "public" },
            },
            push: { timeout_seconds: 10 },
            jobs: { dead_letter_days: 30 },
            metrics: {},
            logging: { level: "info" },
        },
    });
});

Deno.test("remote media is cached unless config says not to, up to the upload limit", async () => {
    const byDefault = await parseConfig(minimal);
    assertEquals(byDefault.ok && settingsOf(byDefault.config).cacheRemoteMedia, true);

    const result = await parseConfig(`
domain = "social.example"
media.storage.filesystem = "media"
media.cache_remote_media = false
media.max_upload_bytes = 1000

[database]
sqlite = "verso.db"
`);
    assert(result.ok);
    const { cacheRemoteMedia, maxUploadBytes } = settingsOf(result.config);
    assertEquals([cacheRemoteMedia, maxUploadBytes], [false, 1000]);
});

Deno.test("remote statuses are kept for good by default", async () => {
    const result = await parseConfig(minimal);
    assertEquals(result.ok && settingsOf(result.config).remoteStatusMs, null);
    assertEquals(result.ok && settingsOf(result.config).previewCardMs, null);
});

Deno.test("a full config is read as written", async () => {
    const result = await parseConfig(`
domain = "Social.Example"

[database]
postgres = "postgresql://verso@/verso?host=/run/postgresql"
pool_size = 50
statement_timeout_seconds = 0

[media]
storage = { filesystem = "/var/lib/verso/media" }
max_pixels = 1000000
unattached_hours = 12
preview_card_days = 30
cache_remote_media = false
max_upload_bytes = 1000
max_emoji_bytes = 100

[http]
port = 3000
rate_limit = { limit = 30, window_seconds = 60, store = "database" }

[[auth.issuers]]
name = "Example ID"
url = "https://id.example"
client_id = "verso"
client_secret = "first"

[[auth.issuers]]
name = "Partner ID"
url = "https://id.partner.example"
client_id = "verso"
client_secret = "s3cret"
username_claim = "nickname"
scopes = ["groups"]
registration = { claim = "groups", contains = "versia-users" }

[[auth.issuers.roles]]
claim = "groups"
contains = "verso-admins"
role = "Admin"

[instance]
name = " Example Social "
description = " A place to talk. "
contact = { email = "admin@social.example", account = "admin" }
privacy_policy = { text = " We keep little. ", updated = 2026-10-01 }
terms_of_service = { text = "Be kind.", updated = 2026-09-01T12:00:00Z }
show_peers = false
show_activity = false
show_blocks = "users"
show_block_reasons = "all"

[[instance.rules]]
text = " Be kind "

[[instance.rules]]
text = "No spam"
hint = " Ads included "
translations = { fr = { text = " Pas de spam ", hint = " Pubs comprises " } }

[limits]
note = 500
fields = 4
mentions = 20
media_description = 1500
poll_options = 10

[permissions]
anonymous = []
default = ["owner:account"]

[federation]
extra_web_ports = [8443]
unreachable_days = 3
delivery_hours = 24
remote_status_days = 30

[streaming]
sockets_per_account = 4
subscriptions = 20
tag_length = 50

[search]
query_length = 200
max_offset = 1000

[timelines_access.live_feeds]
local = "authenticated"
remote = "disabled"

[timelines_access.topic_feeds]
local = "authenticated"
remote = "authenticated"

[push]
timeout_seconds = 5

[jobs]
dead_letter_days = 14

[metrics]
token = "a-token-long-enough-for-config-0123456789"

[logging]
level = "debug"
`);

    assertEquals(result, {
        ok: true,
        config: {
            mode: "production",
            domain: "social.example",
            database: {
                postgres: "postgresql://verso@/verso?host=/run/postgresql",
                pool_size: 50,
                connect_timeout_seconds: 10,
                statement_timeout_seconds: 0,
            },
            media: {
                storage: { filesystem: "/var/lib/verso/media" },
                max_pixels: 1_000_000,
                max_upload_bytes: 1000,
                max_emoji_bytes: 100,
                unattached_hours: 12,
                preview_card_days: 30,
                cache_remote_media: false,
            },
            http: {
                port: 3000,
                trusted_proxies: [],
                rate_limit: { limit: 30, window_seconds: 60, store: "database" },
            },
            auth: {
                issuers: [
                    {
                        name: "Example ID",
                        url: "https://id.example",
                        client_id: "verso",
                        client_secret: "first",
                        username_claim: "preferred_username",
                        scopes: [],
                        registration: "closed",
                        roles: [],
                    },
                    {
                        name: "Partner ID",
                        url: "https://id.partner.example",
                        client_id: "verso",
                        client_secret: "s3cret",
                        username_claim: "nickname",
                        scopes: ["groups"],
                        registration: { claim: "groups", contains: "versia-users" },
                        roles: [{ claim: "groups", contains: "verso-admins", role: "Admin" }],
                    },
                ],
                dev_login: false,
                timeout_seconds: 15,
            },
            federation: {
                allow_internal_addresses: false,
                extra_web_ports: [8443],
                blocked_domains: [],
                silent_blocks: false,
                unreachable_days: 3,
                delivery_hours: 24,
                remote_status_days: 30,
                rate_limit: { limit: 3000, window_seconds: 300 },
                fetch_limit: { limit: 600, window_seconds: 300 },
            },
            instance: {
                name: "Example Social",
                description: "A place to talk.",
                contact: { email: "admin@social.example", account: "admin" },
                rules: [
                    { text: "Be kind", hint: "", translations: {} },
                    {
                        text: "No spam",
                        hint: "Ads included",
                        translations: { fr: { text: "Pas de spam", hint: "Pubs comprises" } },
                    },
                ],
                privacy_policy: { text: "We keep little.", updated: new Date("2026-10-01") },
                terms_of_service: {
                    text: "Be kind.",
                    updated: new Date("2026-09-01T12:00:00Z"),
                },
                show_peers: false,
                show_activity: false,
                show_blocks: "users",
                show_block_reasons: "all",
                show_trends: true,
                trendable_by_default: false,
                suggested_accounts: [],
            },
            limits: {
                display_name: 60,
                note: 500,
                fields: 4,
                field_name: 255,
                field_value: 255,
                status: 10_000,
                attachments: 16,
                mentions: 20,
                media_description: 1500,
                poll_options: 10,
                poll_option: 60,
                poll_min_seconds: 300,
                poll_max_seconds: 2_629_746,
            },
            permissions: { anonymous: [], default: ["owner:account"] },
            streaming: { sockets_per_account: 4, subscriptions: 20, tag_length: 50 },
            search: { query_length: 200, max_offset: 1000 },
            timelines_access: {
                live_feeds: { local: "authenticated", remote: "disabled" },
                topic_feeds: { local: "authenticated", remote: "authenticated" },
            },
            push: { timeout_seconds: 5 },
            jobs: { dead_letter_days: 14 },
            metrics: { token: "a-token-long-enough-for-config-0123456789" },
            logging: { level: "debug" },
        },
    });
    assertEquals(result.ok && settingsOf(result.config).pushTimeoutMs, 5000);
    assertEquals(result.ok && settingsOf(result.config).remoteStatusMs, 30 * 86_400_000);
    assertEquals(result.ok && settingsOf(result.config).previewCardMs, 30 * 86_400_000);
});

const errors = async (toml: string) => {
    const result = await parseConfig(toml);
    assertEquals(result.ok, false, toml);
    return result.ok ? "" : result.error;
};

Deno.test("a rule's translations need a language and a text", async () => {
    const rule = (translations: string) =>
        `${minimal}[[instance.rules]]\ntext = "Be kind"\ntranslations = ${translations}`;

    assertStringIncludes(await errors(rule('{ "" = { text = "Sois gentil" } }')), "translations");
    assertStringIncludes(await errors(rule('{ fr = { text = " " } }')), "text");
    assertStringIncludes(await errors(rule('{ fr = { hint = "Toujours" } }')), "text");
    assertStringIncludes(await errors(rule('{ fr = { text = "a", note = "b" } }')), "note");
    assertEquals((await parseConfig(rule('{ fr = { text = "Sois gentil" } }'))).ok, true);
});

Deno.test("local hashtag timelines can't be disabled, but the others can", async () => {
    const feeds = (section: string, key: string, access: string) =>
        `${minimal}[timelines_access.${section}]\n${key} = "${access}"`;

    assertStringIncludes(
        await errors(feeds("topic_feeds", "local", "disabled")),
        "timelines_access.topic_feeds.local",
    );
    assertStringIncludes(
        await errors(feeds("live_feeds", "local", "private")),
        "timelines_access.live_feeds.local",
    );
    for (
        const toml of [
            feeds("live_feeds", "local", "disabled"),
            feeds("live_feeds", "remote", "disabled"),
            feeds("topic_feeds", "remote", "disabled"),
        ]
    ) {
        assertEquals((await parseConfig(toml)).ok, true, toml);
    }
});

Deno.test("bad configs explain what is wrong", async () => {
    assertStringIncludes(await errors(""), "domain");
    assertStringIncludes(
        await errors(minimal.replace("social.example", "social.example:8080")),
        "domain",
    );
    assertStringIncludes(await errors(minimal + "[http]\nport = 0"), "http.port");
    for (const port of ["0", "65536", "1.5"]) {
        assertStringIncludes(
            await errors(minimal + `[federation]\nextra_web_ports = [${port}]`),
            "federation.extra_web_ports",
        );
    }
    assertStringIncludes(await errors('domian = "typo.example"' + minimal), "domian");
    assertStringIncludes(await errors(minimal + '[metrics]\ntoken = "short"'), "metrics.token");
    assertStringIncludes(
        await errors(minimal + '[logging]\nlevel = "loud"'),
        "logging.level",
    );
    assertStringIncludes(
        await errors(minimal + "[limits]\npoll_min_seconds = 600\npoll_max_seconds = 300"),
        "limits.poll_min_seconds",
    );
    assertStringIncludes(
        await errors(minimal + '[permissions]\ndefault = ["owner:poll"]'),
        "Unknown permission\n  → at permissions.default[0]",
    );

    const exactlyOne = 'Set exactly one of "postgres" or "sqlite"';
    assertStringIncludes(await errors('domain = "social.example"'), exactlyOne);
    assertStringIncludes(
        await errors(minimal + 'postgres = "postgresql:///verso"'),
        exactlyOne,
    );

    // Without a directory of its own, uploads would land wherever Verso happened to start.
    assertStringIncludes(
        await errors(minimal.replace('media.storage.filesystem = "media"', "")),
        "→ at media",
    );
    assertStringIncludes(
        await errors(minimal.replace('"media"', '""')),
        "→ at media.storage.filesystem",
    );

    for (const pixels of ["0", "1.5"]) {
        assertStringIncludes(
            await errors(
                `${minimal}\n[media]\nmax_pixels = ${pixels}`.replace("media.storage", "storage"),
            ),
            "→ at media.max_pixels",
        );
    }

    // Less than a card is reused for.
    assertStringIncludes(
        await errors(
            `${minimal}\n[media]\npreview_card_days = 13`.replace("media.storage", "storage"),
        ),
        "→ at media.preview_card_days",
    );

    // More than a deleted status's message can carry.
    assertStringIncludes(
        await errors(`${minimal}[limits]\nmentions = 151`),
        "→ at limits.mentions",
    );
    assertEquals((await parseConfig(`${minimal}[limits]\nmentions = 150`)).ok, true);

    assertStringIncludes(await errors("domain = "), "Invalid TOML");
});

Deno.test("uploads can be kept in an S3 bucket instead, but not in both", async () => {
    const s3 = `
domain = "social.example"
database.sqlite = "verso.db"

[media.storage.s3]
endpoint = "http://localhost:3900"
region = "garage"
bucket = "media"
access_key_id = "GK0123"
secret_access_key = "secret"
`;
    const result = await parseConfig(s3);
    assertEquals(result.ok && result.config.media.storage, {
        s3: {
            endpoint: "http://localhost:3900",
            region: "garage",
            bucket: "media",
            access_key_id: "GK0123",
            secret_access_key: "secret",
            timeout_seconds: 120,
        },
    });

    const prefixed = await parseConfig(
        s3.replace('bucket = "media"', '$&\nprefix = "verso/media/"'),
    );
    assertEquals(
        prefixed.ok && "s3" in prefixed.config.media.storage &&
            prefixed.config.media.storage.s3.prefix,
        "verso/media",
    );

    const withPublicUrl = await parseConfig(
        s3.replace('bucket = "media"', '$&\npublic_url = "https://cdn.example/media"'),
    );
    assertEquals(
        withPublicUrl.ok && "s3" in withPublicUrl.config.media.storage &&
            withPublicUrl.config.media.storage.s3.public_url,
        "https://cdn.example/media",
    );

    const exactlyOne = 'Set exactly one of "filesystem" or "s3"';
    const both = s3.replace("[media.storage.s3]", 'media.storage.filesystem = "m"\n\n$&');
    assertStringIncludes(await errors(both), exactlyOne);
    assertStringIncludes(
        await errors(s3.replace("[media.storage.s3]", "[media.storage]")),
        'Unrecognized keys: "endpoint", "region"',
    );
    assertStringIncludes(await errors(`${minimal.replace("filesystem", "s4")}`), "s4");
    assertStringIncludes(
        await errors(minimal.replace('media.storage.filesystem = "media"', "media.storage = {}")),
        exactlyOne,
    );
    for (
        const [from, to, path] of [
            ["http://", "ftp://", "endpoint"],
            ['region = "garage"', "", "region"],
            ['"media"', '""', "bucket"],
            ['"media"', '"My media"', "bucket"],
            ['bucket = "media"', 'bucket = "media"\nprefix = "/verso"', "prefix"],
            ['bucket = "media"', 'bucket = "media"\nprefix = "verso//media"', "prefix"],
            ['bucket = "media"', 'bucket = "media"\npublic_url = "cdn.example"', "public_url"],
        ]
    ) {
        assertStringIncludes(await errors(s3.replace(from, to)), `→ at media.storage.s3.${path}`);
    }
});

Deno.test("bad issuers explain what is wrong", async () => {
    const issuer = (fields: string) =>
        errors(`${minimal}[[auth.issuers]]\nname = "ID"\nclient_id = "verso"\n${fields}`);
    const secret = 'client_secret = "s"';
    assertStringIncludes(
        await issuer(`url = "http://id.example"\n${secret}`),
        "Must be an https URL",
    );
    assertStringIncludes(await issuer('url = "https://id.example"'), "client_secret");
    assertStringIncludes(
        await issuer(`url = "https://id.example"\nclient_secret_file = "/s"`),
        "client_secret_file",
    );
    assertStringIncludes(
        await issuer(`url = "https://id.example"\n${secret}\nregistration = "maybe"`),
        "registration",
    );
    assertStringIncludes(
        await issuer(`url = "https://id.example"\n${secret}\nscopes = ["read write"]`),
        "A scope can't contain spaces\n  → at auth.issuers[0].scopes[0]",
    );
    assertStringIncludes(
        await issuer(`url = "https://id.example"\n${secret}\nroles = [{ claim = "groups" }]`),
        "auth.issuers[0].roles[0].role",
    );
    assertStringIncludes(
        await errors(
            `${minimal}[[auth.issuers]]\nname = "A"\nurl = "https://id.example"\n` +
                `client_id = "a"\n${secret}\n` +
                `[[auth.issuers]]\nname = "B"\nurl = "https://id.example"\n` +
                `client_id = "b"\n${secret}`,
        ),
        "Each issuer URL can only be listed once",
    );
});

Deno.test("trusted proxies are addresses or CIDR ranges", async () => {
    const proxies = (list: string) => parseConfig(`${minimal}[http]\ntrusted_proxies = ${list}`);

    const result = await proxies('["127.0.0.1", "fd00::/8"]');
    assertEquals(result.ok && result.config.http.trusted_proxies, [
        { network: { bits: 32, value: 0x7f000001n }, prefix: 32 },
        { network: { bits: 128, value: 0xfdn << 120n }, prefix: 8 },
    ]);

    for (const bad of ['["10.0.0.0/33"]', '["proxy.example"]', '["10.0.0.0/8/8"]']) {
        const invalid = await proxies(bad);
        assertStringIncludes(
            invalid.ok ? "" : invalid.error,
            "Must be an IP address or a CIDR range",
            bad,
        );
    }
});

Deno.test("development settings need development mode", async () => {
    const local = '[http]\norigin = "http://localhost:8080"\n[auth]\ndev_login = true\n' +
        "[federation]\nallow_internal_addresses = true\n";
    const development = minimal.replace("social.example", "localhost");

    const production = await errors(development + local);
    assertStringIncludes(production, "http.origin");
    assertStringIncludes(production, "auth.dev_login");
    assertStringIncludes(production, "federation.allow_internal_addresses");
    assertStringIncludes(production, 'Only allowed with mode = "development"');

    const result = await parseConfig('mode = "development"\n' + development + local);
    assertEquals(
        result.ok && [
            result.config.http.origin,
            result.config.auth.dev_login,
            result.config.federation.allow_internal_addresses,
        ],
        ["http://localhost:8080", true, true],
    );
});

Deno.test("blocked domains are given as signatures name them", async () => {
    const result = await parseConfig(
        minimal + '[federation]\nblocked_domains = ["Evil.Example", "xn--bcher-kva.example"]\n',
    );
    assertEquals(
        result.ok && result.config.federation.blocked_domains,
        ["evil.example", "xn--bcher-kva.example"],
    );

    for (const bad of ["192.0.2.1", "evil.example:8443", "not a domain"]) {
        const error = await errors(minimal + `[federation]\nblocked_domains = ["${bad}"]\n`);
        assertStringIncludes(error, "Must be a domain name", bad);
    }
});

Deno.test("a development origin is a bare origin on the domain", async () => {
    const origin = (url: string) =>
        errors(`mode = "development"\n${minimal}[http]\norigin = "${url}"\n`);

    assertStringIncludes(await origin("http://localhost:8080"), "Must be on the domain");
    assertStringIncludes(await origin("http://social.example/verso"), "with no path");
    assertStringIncludes(await origin("ftp://social.example"), "http.origin");
    assertStringIncludes(await origin("http://social.example:8080"), "http on localhost");
    const valid = await parseConfig(
        `mode = "development"\n${minimal}[http]\norigin = "https://social.example:8443/"\n`,
    );
    assertEquals(valid.ok && valid.config.http.origin, "https://social.example:8443");

    for (const local of ["localhost", "verso.localhost", "127.0.0.1"]) {
        const config =
            `mode = "development"\ndomain = "${local}"\nmedia.storage.filesystem = "m"\n` +
            '[database]\nsqlite = "v.db"\n';
        const result = await parseConfig(`${config}[http]\norigin = "http://${local}:8080"\n`);
        assertEquals(result.ok, true, local);
    }
});

Deno.test("values can come from the environment or files, before they are checked", async () => {
    const sources = {
        env: (name: string) => name === "PGPASS" ? "hunter2" : undefined,
        readFile: () => Promise.reject(new Error("No such file")),
    };

    const filled = await parseConfig(
        'domain = "social.example"\nmedia.storage.filesystem = "m"\n[database]\n' +
            'postgres = "postgresql://verso:${env:PGPASS}@db/verso"',
        sources,
    );
    const missing = await parseConfig(minimal + '[http]\norigin = "${file:/origin}"', sources);

    assertEquals(filled.ok && filled.config.database, {
        postgres: "postgresql://verso:hunter2@db/verso",
        pool_size: 30,
        connect_timeout_seconds: 10,
        statement_timeout_seconds: 60,
    });
    assertEquals(missing, {
        ok: false,
        error: "✖ Can't read /origin: No such file\n  → at http.origin",
    });
});

Deno.test("bad instance details explain what is wrong", async () => {
    for (
        const [section, path] of [
            ['contact = { email = "admin" }', "instance.contact.email"],
            ['contact = { account = "" }', "instance.contact.account"],
            ['name = "  "', "instance.name"],
            ['rules = [{ text = " " }]', "instance.rules[0].text"],
            ['rules = [{ text = "Be kind", why = "" }]', "instance.rules[0]"],
            [
                'privacy_policy = { text = "  ", updated = 2026-10-01 }',
                "instance.privacy_policy.text",
            ],
            ['logo = "a.png"', "logo"],
        ]
    ) {
        assertStringIncludes(await errors(`${minimal}[instance]\n${section}`), path, section);
    }

    assertStringIncludes(
        await errors(
            `${minimal}[instance]\nterms_of_service = { text = "Hi", updated = "2026-10-01" }`,
        ),
        "Must be a date, such as 2026-10-01, without quotes\n  → at instance.terms_of_service.updated",
    );
});

Deno.test("the example config in the docs is valid", async () => {
    const example = await Deno.readTextFile(
        new URL("../../docs/config.example.toml", import.meta.url),
    );
    const result = await parseConfig(example, {
        env: (name) => name === "PGPASSWORD" ? "secret" : undefined,
        readFile: (path) => Promise.resolve(`Contents of ${path}`),
    });

    assertEquals(result.ok && [result.config.domain, result.config.instance.name], [
        "social.example",
        "Example Social",
    ]);
});

Deno.test("the example config's permissions, commented out, are the defaults", async () => {
    const example = await Deno.readTextFile(
        new URL("../../docs/config.example.toml", import.meta.url),
    );
    const section = example.split(/^\[permissions\]$/m)[1].split(/^\[/m)[0];
    // The settings and their lists, but not the comments that describe them.
    const settings = section.split("\n")
        .filter((line) => /^# ([a-z]+ = | {4}"|\])/.test(line))
        .map((line) => line.slice(2))
        .join("\n");

    assertEquals(parseToml(settings), Permissions.parse({}));
});
