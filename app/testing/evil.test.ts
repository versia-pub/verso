import { assertEquals, assertRejects } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { BadReply, fetchSigned } from "../federation/request.ts";
import { appServices } from "../services.ts";
import { addEvilInstance } from "./evil.ts";
import { createNetwork } from "./network.ts";

const bobUrl = "https://a.test/.versia/v0.6/entities/User/bob";

Deno.test("an evil instance's requests are signed with a key the others can fetch", async () => {
    await using network = await createNetwork(["a.test"]);
    await createLocalAccount(network.instances["a.test"].ctx, "bob");
    const evil = await addEvilInstance(network, "evil.test");

    assertEquals((await evil.send(bobUrl)).status, 200);
    assertEquals((await evil.send(bobUrl, { signedBy: "b.test" })).status, 401);
    assertEquals(
        (await evil.send(bobUrl, { signedAt: new Date(network.clock.now().getTime() - 3_600_000) }))
            .status,
        422,
    );
});

Deno.test("an evil instance's rotated key is refused until the others fetch it again", async () => {
    await using network = await createNetwork(["a.test"]);
    await createLocalAccount(network.instances["a.test"].ctx, "bob");
    const evil = await addEvilInstance(network, "evil.test");

    await evil.send(bobUrl);
    await evil.rotateKey();

    // a.test fetches a key again at most every five minutes.
    assertEquals((await evil.send(bobUrl)).status, 401);
    network.clock.advance(5 * 60_000);

    assertEquals((await evil.send(bobUrl)).status, 200);
});

Deno.test("an evil instance answers what it serves, signed unless told not to", async () => {
    await using network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const evil = await addEvilInstance(network, "evil.test");
    evil.serve("/signed", { type: "User" });
    evil.serve("/unsigned", { type: "User" }, { signed: false });

    const reply = await fetchSigned(a, appServices(), new URL("https://evil.test/signed"));
    assertEquals(JSON.parse(new TextDecoder().decode(reply.body)), { type: "User" });

    await assertRejects(
        () => fetchSigned(a, appServices(), new URL("https://evil.test/unsigned")),
        BadReply,
    );
    assertEquals(
        (await fetchSigned(a, appServices(), new URL("https://evil.test/other"))).status,
        404,
    );
});
