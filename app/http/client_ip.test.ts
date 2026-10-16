import { assertEquals } from "@std/assert";
import { z } from "zod";
import { CidrText } from "../kernel/ip.ts";
import { clientIp } from "./client_ip.ts";

const proxies = z.array(CidrText).parse(["10.0.0.0/8", "fd00::/8"]);

Deno.test("without a trusted proxy, the connection is the client", () => {
    assertEquals(clientIp("203.0.113.9", undefined, proxies), "203.0.113.9");
    assertEquals(clientIp("203.0.113.9", "198.51.100.1", proxies), "203.0.113.9");
    assertEquals(clientIp("10.0.0.1", "198.51.100.1", []), "10.0.0.1");
});

Deno.test("behind trusted proxies, the client is the last address they didn't add", () => {
    assertEquals(clientIp("10.0.0.1", "198.51.100.1", proxies), "198.51.100.1");
    assertEquals(clientIp("fd00::1", "198.51.100.1, 10.0.0.2", proxies), "198.51.100.1");
});

Deno.test("addresses a client puts in X-Forwarded-For itself are ignored", () => {
    assertEquals(clientIp("10.0.0.1", "1.2.3.4, 198.51.100.1", proxies), "198.51.100.1");
    assertEquals(clientIp("10.0.0.1", "10.0.0.3, 198.51.100.1", proxies), "198.51.100.1");
});

Deno.test("if every address is a trusted proxy, the first one is the client", () => {
    assertEquals(clientIp("10.0.0.1", "10.0.0.2", proxies), "10.0.0.2");
    assertEquals(clientIp("10.0.0.1", " , ", proxies), "10.0.0.1");
});
