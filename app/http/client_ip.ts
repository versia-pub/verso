import { type Cidr, inCidr, parseIp } from "../kernel/ip.ts";

const trusted = (address: string, proxies: readonly Cidr[]) => {
    const parsed = parseIp(address);
    return parsed !== undefined && proxies.some((cidr) => inCidr(parsed, cidr));
};

/**
 * The client's IP address. Behind a reverse proxy, every connection comes from the proxy, which
 * names the client in `X-Forwarded-For`. That header is only trusted when the connection comes from
 * a trusted proxy, and only as far back as proxies are trusted, since anyone can send it. Each
 * proxy appends who connected to it, so the client is the last address that is not a trusted proxy.
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For#selecting_an_ip_address
 */
export const clientIp = (
    peer: string,
    forwardedFor: string | undefined,
    proxies: readonly Cidr[],
): string => {
    const chain = [
        ...(forwardedFor ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
        peer,
    ];

    let index = chain.length - 1;
    while (index > 0 && trusted(chain[index], proxies)) index--;

    return chain[index];
};
