import { CidrText, inCidr, parseIp } from "./ip.ts";

/**
 * Sends an HTTP request to another server and resolves with its response, or rejects when the
 * server can't be reached, like `fetch`. Every outgoing request goes through it, so tests can
 * replace the network.
 */
export type Transport = (request: Request) => Promise<Response>;

/** For servers the admin configured, such as identity providers, which may be on their network. */
export const fetchTransport: Transport = (request: Request): Promise<Response> => fetch(request);

/** The addresses a name resolves to, or none if it doesn't resolve. */
export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

const systemResolver: DnsResolver = async (hostname) => {
    const answers = await Promise.allSettled([
        Deno.resolveDns(hostname, "A"),
        Deno.resolveDns(hostname, "AAAA"),
    ]);

    return answers.flatMap((answer) => answer.status === "fulfilled" ? answer.value : []);
};

/**
 * Addresses that aren't on the public internet: this machine, private and shared networks,
 * link-local ones such as cloud metadata at 169.254.169.254, reserved, documentation and multicast
 * ranges, and IPv6 ranges that carry an IPv4 address (NAT64, 6to4 and Teredo), which could carry
 * an internal one.
 * @see https://www.iana.org/assignments/iana-ipv4-special-registry
 * @see https://www.iana.org/assignments/iana-ipv6-special-registry
 */
const internalRanges = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/3",
    "::/127",
    "64:ff9b::/96",
    "64:ff9b:1::/48",
    "100::/64",
    "2001::/32",
    "2001:db8::/32",
    "2002::/16",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
].map((range) => CidrText.parse(range));

const isInternal = (text: string) => {
    const address = parseIp(text);
    return address === undefined || internalRanges.some((range) => inCidr(address, range));
};

export type FederationTransportOptions = {
    /** Lets requests reach internal addresses, for instances on a local network. Development only. */
    readonly allowInternal?: boolean;
    readonly fetch?: (request: Request, init: RequestInit) => Promise<Response>;
    readonly resolve?: DnsResolver;
};

/**
 * For other instances, which anyone can name, such as in a signature's `Versia-Signed-By`. Names
 * that resolve to an internal address are refused, so a request can't make Verso reach into its
 * own network, and redirects aren't followed, since they could point anywhere and Versia's
 * endpoints don't redirect: the redirect itself is the response.
 *
 * `fetch` resolves the name again, so a name whose answer changes in between could still get
 * through. Closing that needs an HTTP client that connects to the address checked: `node:https`
 * with a `lookup` does, still checking the certificate against the name, but gives up HTTP/2 and
 * `fetch`'s pool, so it waits for the outbound proxy work.
 */
export const federationTransport = (options: FederationTransportOptions = {}): Transport => {
    const send = options.fetch ?? fetch;
    const resolve = options.resolve ?? systemResolver;

    return async (request) => {
        if (!options.allowInternal) {
            const hostname = new URL(request.url).hostname.replace(/^\[(.*)\]$/, "$1");
            const addresses = parseIp(hostname) ? [hostname] : await resolve(hostname);

            if (addresses.length === 0 || addresses.some(isInternal)) {
                throw new TypeError(`${hostname} isn't a public address`);
            }
        }

        return await send(request, { redirect: "manual" });
    };
};
