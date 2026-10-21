import { assert, assertEquals } from "@std/assert";
import { type Cidr, CidrText, inCidr, parseIp } from "./ip.ts";

const cidr = (text: string): Cidr => CidrText.parse(text);

const matches = (address: string, range: string) => {
    const parsed = parseIp(address);
    assert(parsed, address);
    return inCidr(parsed, cidr(range));
};

Deno.test("addresses are IPv4 or IPv6, and anything else isn't one", () => {
    assertEquals(parseIp("192.0.2.1"), { bits: 32, value: 0xc0000201n });
    assertEquals(parseIp("2001:db8::1"), { bits: 128, value: (0x20010db8n << 96n) + 1n });

    for (const bad of ["", "localhost", "192.0.2", "192.0.2.256", "01.2.3.4", "2001:db8:::1"]) {
        assertEquals(parseIp(bad), undefined, bad);
    }
});

Deno.test("an IPv4 address written as IPv6 is read as IPv4", () => {
    assertEquals(parseIp("::ffff:192.0.2.1"), parseIp("192.0.2.1"));
    assert(matches("::ffff:10.1.2.3", "10.0.0.0/8"));
});

Deno.test("a range holds the addresses that share its prefix", () => {
    assert(matches("10.255.0.1", "10.0.0.0/8"));
    assert(!matches("11.0.0.1", "10.0.0.0/8"));
    assert(matches("192.0.2.1", "192.0.2.1"));
    assert(!matches("192.0.2.2", "192.0.2.1"));
    assert(matches("203.0.113.9", "0.0.0.0/0"));

    assert(matches("fd12:3456::1", "fd00::/8"));
    assert(!matches("fe80::1", "fd00::/8"));
    assert(!matches("10.0.0.1", "::/0"));
});

Deno.test("an IPv4 range written as IPv6 is read as the IPv4 range", () => {
    assertEquals(cidr("::ffff:10.0.0.0/104"), cidr("10.0.0.0/8"));
    assertEquals(cidr("::ffff:192.0.2.1"), cidr("192.0.2.1"));
    assertEquals(CidrText.safeParse("::ffff:0.0.0.0/90").success, false);
});

Deno.test("a range needs a prefix no longer than its address", () => {
    assertEquals(cidr("::/128").prefix, 128);
    assertEquals(cidr("10.0.0.1").prefix, 32);

    for (const bad of ["10.0.0.0/33", "::/129", "10.0.0.0/", "10.0.0.0/-1", "10.0.0.0/8/8", "/8"]) {
        assertEquals(CidrText.safeParse(bad).success, false, bad);
    }
});
