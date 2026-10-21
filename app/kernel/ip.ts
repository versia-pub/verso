/**
 * IP addresses and CIDR ranges, such as `10.0.0.0/8` or `fd00::/8`.
 * @module
 */
import {
    convertIPv4MappedIPv6ToIPv4,
    convertIPv4ToBinary,
    convertIPv6ToBinary,
    distinctRemoteAddr,
    isIPv4MappedIPv6,
} from "@hono/hono/utils/ipaddr";
import { z } from "zod";

/** An address as a number, with how many bits it has: 32 for IPv4, 128 for IPv6. */
export type Address = { readonly bits: 32 | 128; readonly value: bigint };

/** All addresses whose first `prefix` bits are those of `network`. */
export type Cidr = { readonly network: Address; readonly prefix: number };

/**
 * Parses an IPv4 or IPv6 address, or returns `undefined` if it isn't one. An IPv4 address written
 * as IPv6, such as `::ffff:192.0.2.1`, is read as IPv4, so it matches IPv4 ranges.
 */
export const parseIp = (text: string): Address | undefined => {
    try {
        switch (distinctRemoteAddr(text)) {
            case "IPv4":
                return { bits: 32, value: convertIPv4ToBinary(text) };

            case "IPv6": {
                const value = convertIPv6ToBinary(text);
                return isIPv4MappedIPv6(value)
                    ? { bits: 32, value: convertIPv4MappedIPv6ToIPv4(value) }
                    : { bits: 128, value };
            }

            default:
                return undefined;
        }
    } catch {
        return undefined;
    }
};

const notCidr = "Must be an IP address or a CIDR range";

/**
 * An address or a CIDR range, such as `127.0.0.1` or `fd00::/8`, as a range. A lone address is a
 * range of one.
 */
export const CidrText = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()], { error: notCidr })
    .transform((text, ctx) => {
        const [address, prefix] = text.split("/");
        const network = parseIp(address);

        // An IPv4 range written as IPv6, such as `::ffff:10.0.0.0/104`, counts the 96 bits before
        // the IPv4 part, which are always the same.
        const before = address.includes(":") && network?.bits === 32 ? 96 : 0;
        const bits = prefix === undefined ? network?.bits : Number(prefix) - before;

        if (!network || bits === undefined || bits < 0) {
            ctx.addIssue({ code: "custom", message: notCidr });
            return z.NEVER;
        }

        return { network, prefix: bits } satisfies Cidr;
    });

export const inCidr = (address: Address, cidr: Cidr): boolean => {
    if (address.bits !== cidr.network.bits) return false;

    const hostBits = BigInt(address.bits - cidr.prefix);
    return address.value >> hostBits === cidr.network.value >> hostBits;
};
