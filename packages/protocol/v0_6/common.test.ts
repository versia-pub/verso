import { assertEquals } from "@std/assert";
import { ContentFormat, Entity, Rfc3339 } from "./common.ts";

const image = {
  "image/png": {
    content:
      "https://cdn.example.com/attachments/ece2f9d9-27d7-457d-b657-4ce9172bdcf8.png",
    remote: true,
    description: "A jolly horse running through mountains",
    size: 453933,
    hash: "91714fc336210d459d4f9d9233de663be2b87ffe923f1cfd76ece9d06f7c965d",
    thumbhash: "3OcRJYB4d3h/iIeHeEh3eIhw+j2w",
    width: 1920,
    height: 1080,
  },
};

Deno.test("the spec's ContentFormat examples are valid", () => {
  assertEquals(ContentFormat.safeParse(image).success, true);
  assertEquals(
    ContentFormat.safeParse({
      "text/plain": { content: "Hello", remote: false },
      "text/html": { content: "<p>Hello</p>", remote: false },
    }).success,
    true,
  );
});

Deno.test("optional fields may be missing or null", () => {
  const text = { content: "Hello", remote: false };
  assertEquals(ContentFormat.safeParse({ "text/plain": text }).success, true);
  assertEquals(
    ContentFormat.safeParse({ "text/plain": { ...text, size: null } }).success,
    true,
  );
});

Deno.test("invalid ContentFormat values are rejected", () => {
  const png = image["image/png"];
  for (
    const bad of [
      { "image/png": { ...png, hash: "not hex" } },
      { "image/png": { ...png, width: -1 } },
      { "image/png": { ...png, size: 1.5 } },
      { "image/png": { ...png, remote: undefined } },
      { "not a mime type": png },
    ]
  ) {
    assertEquals(ContentFormat.safeParse(bad).success, false);
  }
});

Deno.test("dates need a time zone", () => {
  assertEquals(Rfc3339.safeParse("2021-01-01T00:00:00.000Z").success, true);
  assertEquals(Rfc3339.safeParse("2023-04-13T08:00:00+02:00").success, true);
  assertEquals(Rfc3339.safeParse("2021-01-01T00:00:00").success, false);
  assertEquals(Rfc3339.safeParse("13-12-1337").success, false);
});

Deno.test("the spec's example entity with extensions is valid", () => {
  const entity = {
    id: "f0aacf0b-df7a-4ee5-a2ba-6c4acafd8642",
    type: "org.space:Zlorbs/Zlorb",
    created_at: "2023-04-13T08:00:00Z",
    extensions: {
      "org.space:zlorbs": { zlorb_type: "giant", zlorb_size: "huge" },
      "pub.versia:location": { latitude: 37.7749, longitude: -122.4194 },
    },
  };
  assertEquals(Entity.safeParse(entity).success, true);
  assertEquals(Entity.safeParse({ ...entity, id: "has space" }).success, false);
  assertEquals(
    Entity.safeParse({ ...entity, extensions: { "no-namespace": 1 } }).success,
    false,
  );
});
