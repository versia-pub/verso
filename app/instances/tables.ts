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
