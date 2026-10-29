import { assertEquals } from "@std/assert";
import { mastodonPermissions } from "./permissions.ts";

Deno.test("Mastodon sees only the permissions it has a flag for", () => {
    assertEquals(mastodonPermissions([]), "0");
    assertEquals(mastodonPermissions(["read:account", "owner:account"]), "0");
    assertEquals(mastodonPermissions(["roles", "roles", "read:account"]), "131072");
    // Manage Custom Emojis and Manage Roles.
    assertEquals(mastodonPermissions(["emojis", "roles"]), "147456");
});
