import { assertEquals } from "@std/assert";
import { Entity, Extensions, Integer, Media, mediaOf, TransientEntity } from "./common.ts";

Deno.test("integers are whole numbers from 0 to 2⁵³−1", () => {
    for (const valid of [0, 1, 1e3, 1000.0, Number.MAX_SAFE_INTEGER]) {
        assertEquals(Integer.safeParse(valid).success, true, String(valid));
    }

    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 1e300, "1"]) {
        assertEquals(Integer.safeParse(invalid).success, false, String(invalid));
    }
});

Deno.test("extension values are objects, under namespaced keys", () => {
    assertEquals(Extensions.safeParse({ "pub.versia:likes": {} }).success, true);
    assertEquals(Extensions.safeParse({ "com.example:gps": { accuracy: 10 } }).success, true);

    for (const value of [[], "a", 1, true, null]) {
        assertEquals(
            Extensions.safeParse({ "pub.versia:likes": value }).success,
            false,
            JSON.stringify(value),
        );
    }

    for (const key of ["likes", "pub.versia:Likes", "pub.versia:likes/Like", "Pub.versia:likes"]) {
        assertEquals(Extensions.safeParse({ [key]: {} }).success, false, key);
    }
});

const entity = {
    id: "1hrck56vbp3k1zq615",
    type: "pub.versia:likes/Like",
    created_at: "2021-01-01T00:00:00Z",
};

Deno.test("an entity's id is 1 to 18 lowercase characters", () => {
    assertEquals(Entity.safeParse(entity).success, true);

    for (const id of ["", "a".repeat(19), "1HRCK56", "3e7e4750-afd4-4d99-a256-02f0710a0520"]) {
        assertEquals(Entity.safeParse({ ...entity, id }).success, false, id);
    }
});

Deno.test("updated_at is an optional RFC 3339 time, which transient entities don't have", () => {
    const updated = { ...entity, updated_at: "2021-01-01T01:00:00.000+01:00" };

    assertEquals(Entity.safeParse(updated).success, true);
    assertEquals(Entity.safeParse({ ...entity, updated_at: "2021-01-01" }).success, false);
    assertEquals(TransientEntity.parse(updated), {
        type: entity.type,
        created_at: entity.created_at,
    });
});

// The spec's example.
const image = {
    url: "https://cdn.example.com/attachments/ece2f9d9-27d7-457d-b657-4ce9172bdcf8.png",
    media_type: "image/png",
    description: "A jolly horse running through mountains",
    size: 453933,
    hash: "91714fc336210d459d4f9d9233de663be2b87ffe923f1cfd76ece9d06f7c965d",
    thumbhash: "3OcRJYB4d3h/iIeHeEh3eIhw+j2w",
    width: 1920,
    height: 1080,
};

Deno.test("media needs only a URL and a media type", () => {
    assertEquals(Media.safeParse(image).success, true);
    assertEquals(Media.safeParse({ url: image.url, media_type: "text/plain" }).success, true);

    for (const key of ["url", "media_type"]) {
        assertEquals(Media.safeParse({ ...image, [key]: undefined }).success, false, key);
    }
});

Deno.test("media fields are checked", () => {
    for (
        const [key, value] of [
            ["url", "javascript:alert(1)"],
            ["media_type", "png"],
            ["size", -1],
            ["width", 1.5],
            ["hash", image.hash.toUpperCase()],
            ["hash", image.hash.slice(1)],
            ["thumbhash", "not base64!"],
            ["duration", -1],
        ] as const
    ) {
        assertEquals(Media.safeParse({ ...image, [key]: value }).success, false, `${key} ${value}`);
    }

    assertEquals(Media.safeParse({ ...image, duration: 1.5 }).success, true);
});

Deno.test("media of a kind must have a media type of that kind", () => {
    assertEquals(mediaOf("image/").safeParse(image).success, true);
    assertEquals(mediaOf("image/").safeParse({ ...image, media_type: "Image/PNG" }).success, true);
    assertEquals(mediaOf("audio/").safeParse(image).success, false);
});
