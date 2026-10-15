/** A user on this instance or another. */
export type AccountsTable = {
    id: string;
    /** Unique per instance, ignoring case. */
    username: string;
    /** The instance the account lives on, or `null` for this one. */
    instance_id: string | null;
    /** The account's id on its own instance, opaque to us, or `null` for local accounts. */
    remote_id: string | null;
    created_at: Date;
};

/** A login at an OpenID issuer, linked to a local account. */
export type IdentitiesTable = {
    /** The issuer URL, as configured. */
    issuer: string;
    /** The ID token's `sub` claim, which the issuer never reuses. */
    subject: string;
    account_id: string;
    created_at: Date;
};
