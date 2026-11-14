import { assertEquals } from "@std/assert";
import { Delete } from "./delete.ts";
import { Migration } from "./migration.ts";
import { Report } from "./reports.ts";
import { Subscribe, SubscribeAccept, SubscribeReject, Unsubscribe } from "./subscribe.ts";

const subscription = {
    created_at: "2021-01-01T00:00:00Z",
    subscriber: "example.org:1hydmskagrdtnq544w",
    target: "example.com:1hvx6npss60nr8rva3",
    target_type: "User",
};

// The spec's examples, one per entity.
const examples = [
    [Subscribe, { ...subscription, type: "Subscribe" }],
    [SubscribeAccept, { ...subscription, type: "SubscribeAccept" }],
    [SubscribeReject, { ...subscription, type: "SubscribeReject" }],
    [Unsubscribe, { ...subscription, type: "Unsubscribe" }],
    [Delete, {
        type: "Delete",
        created_at: "2021-01-01T00:00:00Z",
        author: "example.com:1hydmskagrdtnq544w",
        deleted_type: "pub.versia:social/Note",
        deleted: "example.com:1hvx6npss60nr8rva3",
    }],
    [Migration, {
        type: "pub.versia:migration/Migration",
        author: "example.com:1jczcc0s69y0dgtfkb",
        created_at: "2021-01-01T00:00:00Z",
        destination: "other.example:1hmbsv42ynr64s63kp",
    }],
    [Report, {
        type: "pub.versia:reports/Report",
        created_at: "2021-01-01T00:00:00Z",
        author: "example.com:1je4x5phvf5nxtf832",
        reported: [
            { type: "User", reference: "example.org:1hqz83k3s5snvrxjvn" },
            { type: "pub.versia:social/Note", reference: "example.org:1j1dczns9m9aycdrhg" },
        ],
        tags: ["spam", "harassment"],
        comment: "This is spam.",
    }],
] as const;

// Fields each entity may leave out.
const optional = new Set([
    "Delete author",
    "pub.versia:reports/Report author",
    "pub.versia:reports/Report comment",
]);

Deno.test("the spec's examples are valid", () => {
    for (const [schema, example] of examples) {
        assertEquals(schema.safeParse(example).success, true, example.type);
    }
});

Deno.test("each schema rejects the others' examples", () => {
    for (const [schema] of examples) {
        const valid = examples.filter(([, example]) => schema.safeParse(example).success);
        assertEquals(valid.length, 1);
    }
});

Deno.test("required fields are required, and references need their domain", () => {
    for (const [schema, example] of examples) {
        for (const [key, value] of Object.entries(example)) {
            const name = `${example.type} ${key}`;

            assertEquals(
                schema.safeParse({ ...example, [key]: undefined }).success,
                optional.has(name),
                `without ${name}`,
            );

            if (typeof value === "string" && value.includes(":1")) {
                const bare = value.split(":")[1];
                assertEquals(
                    schema.safeParse({ ...example, [key]: bare }).success,
                    false,
                    `bare ${name}`,
                );
            }
        }
    }
});

Deno.test("a Report's entities each need a type and a reference with its domain", () => {
    const [, report] = examples[6];

    for (
        const reported of [
            [{ type: "User" }],
            [{ reference: "example.org:1hqz83k3s5snvrxjvn" }],
            [{ type: "User", reference: "1hqz83k3s5snvrxjvn" }],
            ["example.org:1hqz83k3s5snvrxjvn"],
        ]
    ) {
        assertEquals(
            Report.safeParse({ ...report, reported }).success,
            false,
            JSON.stringify(reported),
        );
    }
});
