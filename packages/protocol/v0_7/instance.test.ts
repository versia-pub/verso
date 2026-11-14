import { assertEquals } from "@std/assert";
import { ReferenceCollection } from "./collection.ts";
import { InstanceMetadata, WellKnown } from "./instance.ts";

// The spec's example.
const metadata = {
    type: "InstanceMetadata",
    name: "Jim's Jolly Jimjams",
    software: { name: "Versia Server", version: "1.2.0-beta.3" },
    compatibility: {
        extensions: [
            "pub.versia:social@1",
            "pub.versia:reactions@1",
            "pub.versia:polls@1",
            "pub.versia:reports@1",
        ],
    },
    description: "Server for Jim's Jolly Jimjams, a social network for fans of Jimjams.",
    domain: "social.example",
    public_key: {
        algorithm: "ed25519",
        key: "MCowBQYDK2VwAyEA9zhEMtQZetRl4QrLcz99i7jOa6ZVjX7aLfRUsMuKByI=",
    },
    logo: { url: "https://social.example/files/logo.webp", media_type: "image/webp" },
    created_at: "2021-07-01T00:00:00Z",
    extensions: { "com.example:stats": { monthly_active_users: 1000 } },
};

Deno.test("the spec's example InstanceMetadata is valid", () => {
    assertEquals(InstanceMetadata.safeParse(metadata).success, true);
});

Deno.test("extensions are listed with their version", () => {
    for (const extension of ["pub.versia:social", "pub.versia:social@0", "pub.versia:social@v1"]) {
        assertEquals(
            InstanceMetadata.safeParse({ ...metadata, compatibility: { extensions: [extension] } })
                .success,
            false,
            extension,
        );
    }
});

Deno.test("the domain is a lowercase hostname with no port", () => {
    for (const domain of ["Social.example", "social.example:3000", "127.0.0.1", "localhost"]) {
        assertEquals(InstanceMetadata.safeParse({ ...metadata, domain }).success, false, domain);
    }
});

Deno.test("the well-known endpoint lists versions as 0.X.Y", () => {
    assertEquals(WellKnown.safeParse({ versions: ["0.7.0", "0.6.0"] }).success, true);

    for (const version of ["0.7", "v0.7.0", "0.07.0", ""]) {
        assertEquals(WellKnown.safeParse({ versions: [version] }).success, false, version);
    }
});

Deno.test("a reference collection holds references with their domain", () => {
    const collection = {
        total: 46,
        items: ["versia.example:1jgbhq5cvq4k0pgd99", "bob.example:1j20v8s5bkrx3pbsfq"],
    };

    assertEquals(ReferenceCollection.safeParse(collection).success, true);
    assertEquals(
        ReferenceCollection.safeParse({ ...collection, items: ["1jgbhq5cvq4k0pgd99"] }).success,
        false,
    );
    assertEquals(ReferenceCollection.safeParse({ ...collection, total: -1 }).success, false);
});
