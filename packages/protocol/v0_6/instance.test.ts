import { assertEquals } from "@std/assert";
import { InstanceMetadata } from "./instance.ts";

// The spec's example, with `remote` added to the logo's ContentFormat: the example leaves it out,
// but the ContentFormat definition requires it.
const instance = {
  type: "InstanceMetadata",
  name: "Jim's Jolly Jimjams",
  software: { name: "Versia Server", version: "1.2.0-beta.3" },
  compatibility: {
    versions: ["0.3.0", "0.4.0", "0.5.0"],
    extensions: [
      "pub.versia:reactions",
      "pub.versia:polls",
      "pub.versia:reports",
    ],
  },
  description:
    "Server for Jim's Jolly Jimjams, a social network for fans of Jimjams.",
  domain: "social.jimjams.com",
  logo: {
    "image/png": {
      content: "https://social.jimjams.com/files/logo.png",
      remote: true,
    },
    "image/webp": {
      content: "https://social.jimjams.com/files/logo.webp",
      remote: true,
    },
  },
  public_key: {
    algorithm: "ed25519",
    key: "MCowBQYDK2VwAyEA9zhEMtQZetRl4QrLcz99i7jOa6ZVjX7aLfRUsMuKByI=",
  },
  banner: null,
  created_at: "2021-07-01T00:00:00Z",
  extensions: { "example.extension:monthly_active_users": 1000 },
};

Deno.test("the spec's example InstanceMetadata is valid", () => {
  assertEquals(InstanceMetadata.safeParse(instance).success, true);
});

Deno.test("invalid InstanceMetadata is rejected", () => {
  const text = { "text/plain": { content: "logo", remote: false } };
  for (
    const bad of [
      { ...instance, name: undefined },
      { ...instance, software: { name: "Verso" } },
      { ...instance, compatibility: { versions: ["0.6.0"] } },
      { ...instance, domain: "social.jimjams.com:8443" },
      { ...instance, domain: "https://social.jimjams.com" },
      { ...instance, public_key: { ...instance.public_key, algorithm: "rsa" } },
      {
        ...instance,
        public_key: { ...instance.public_key, key: "not base64!" },
      },
      { ...instance, logo: text },
      { ...instance, banner: text },
    ]
  ) {
    assertEquals(
      InstanceMetadata.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  }
});
