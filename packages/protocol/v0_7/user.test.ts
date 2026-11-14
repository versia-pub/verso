import { assertEquals } from "@std/assert";
import { Decorations } from "./decorations.ts";
import { Profile } from "./profile.ts";
import { User } from "./user.ts";

// The spec's example.
const user = {
    id: "1hv0842q1hexgh24zk",
    type: "User",
    created_at: "2024-04-09T01:38:51Z",
    avatar: { url: "https://cdn.example.com/avatars/april.png", media_type: "image/png" },
    display_name: "April The Pink (limited Sand Edition)",
    extensions: {
        "pub.versia:custom_emojis": { emojis: [] },
        "pub.versia:profile": {
            bio: "<p>🌸🌸🌸</p>",
            fields: [{
                key: "Website",
                value: '<a href="https://april.example">april.example</a>',
            }],
        },
    },
    username: "april",
    manually_approves_subscribers: false,
    indexable: false,
    url: "https://versia.example/@april",
};

Deno.test("the spec's example User is valid", () => {
    assertEquals(User.safeParse(user).success, true);
    assertEquals(Profile.safeParse(user.extensions["pub.versia:profile"]).success, true);
});

Deno.test("a User needs a username and its two flags", () => {
    for (const key of ["username", "manually_approves_subscribers", "indexable"]) {
        assertEquals(User.safeParse({ ...user, [key]: undefined }).success, false, key);
    }

    for (const username of ["", "a b", "a.b", "é"]) {
        assertEquals(User.safeParse({ ...user, username }).success, false, username);
    }
    assertEquals(User.safeParse({ ...user, username: "April_-1" }).success, true);
});

Deno.test("a User's avatar must be an image", () => {
    const audio = { url: "https://cdn.example.com/a.mp3", media_type: "audio/mpeg" };

    assertEquals(User.safeParse({ ...user, avatar: audio }).success, false);
});

// The spec's example.
const profile = {
    bio: "<p>Writes about trains.</p>",
    fields: [{ key: "Website", value: '<a href="https://trains.example">trains.example</a>' }],
    pronouns: { "en-US": "he/they", fr: "il/iel" },
    birthday: "--04-12",
    location: "New York, NY",
    timezone: "America/New_York",
};

Deno.test("every Profile field is optional", () => {
    assertEquals(Profile.safeParse(profile).success, true);
    assertEquals(Profile.safeParse({}).success, true);
});

Deno.test("a birthday is a full date, or a month and day", () => {
    for (const birthday of ["1990-04-12", "--04-12", "--12-31", "2000-02-29"]) {
        assertEquals(Profile.safeParse({ birthday }).success, true, birthday);
    }

    for (const birthday of ["1990-4-12", "-04-12", "--13-01", "--04-32", "1990-02-30", "04-12"]) {
        assertEquals(Profile.safeParse({ birthday }).success, false, birthday);
    }
});

Deno.test("a time zone is an IANA name, not an offset", () => {
    for (const timezone of ["America/New_York", "UTC", "Europe/Paris", "Etc/GMT+1"]) {
        assertEquals(Profile.safeParse({ timezone }).success, true, timezone);
    }

    for (const timezone of ["+01:00", "Mars/Olympus_Mons", "", "america new york"]) {
        assertEquals(Profile.safeParse({ timezone }).success, false, timezone);
    }
});

Deno.test("pronouns are keyed by language tag", () => {
    assertEquals(Profile.safeParse({ pronouns: { "zh-Hant-TW": "他" } }).success, true);
    assertEquals(Profile.safeParse({ pronouns: { "not a tag": "x" } }).success, false);
    assertEquals(Profile.safeParse({ pronouns: { en: 1 } }).success, false);
});

const png = { url: "https://cdn.example.com/decorations/stars.png", media_type: "image/png" };
const mp3 = { url: "https://cdn.example.com/decorations/theme.mp3", media_type: "audio/mpeg" };

Deno.test("decorations are images, except the audio", () => {
    const decorations = {
        header: png,
        avatar_overlays: [png, png],
        avatar_mask: png,
        background: png,
        audio: mp3,
    };

    assertEquals(Decorations.safeParse(decorations).success, true);
    assertEquals(Decorations.safeParse({}).success, true);

    for (const key of ["header", "avatar_mask", "background"]) {
        assertEquals(Decorations.safeParse({ [key]: mp3 }).success, false, key);
    }
    assertEquals(Decorations.safeParse({ avatar_overlays: [mp3] }).success, false);
    assertEquals(Decorations.safeParse({ audio: png }).success, false);
});
