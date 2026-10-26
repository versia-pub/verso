import type { Generated } from "kysely";

/** Another server this one knows of. This instance itself has no row. */
export type InstancesTable = {
    id: string;
    /**
     * Its domain, in lowercase. Versia domains have no port, but other protocols may give one.
     * @see https://versia.pub/api/basics#domain
     */
    domain: string;
    /** How to talk to it. Only `versia`, for now. */
    protocol: "versia";
    /**
     * Its public key, SPKI in base64, which every Versia instance has. Protocols whose keys are per
     * user, such as ActivityPub, have none here.
     */
    public_key: string | null;
    /** When the key was last fetched, so that a stale one can be fetched again. */
    key_fetched_at: Date | null;
    /** How many times in a row it couldn't be reached. */
    failures: Generated<number>;
    /** While set, deliveries wait for it to pass, when one of them probes whether it is back. */
    parked_until: Date | null;
    /** Since when it couldn't be reached, if it can't now. Nothing is sent to it after a while. */
    unreachable_since: Date | null;
    /**
     * Whether it said it accepts instance messages, when its key was last fetched.
     * @see https://versia.pub/extensions/instance-messaging
     */
    takes_messages: Generated<boolean>;
    created_at: Date;
};

/** This instance's key pairs. The newest one is current; the others were rotated out. */
export type InstanceKeysTable = {
    id: string;
    /** SPKI, in base64, as InstanceMetadata shows it. */
    public_key: string;
    /** PKCS #8, in base64. */
    private_key: string;
    created_at: Date;
};
