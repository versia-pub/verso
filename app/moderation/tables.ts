/** An instance Verso doesn't federate with, blocked by an admin, with its subdomains. */
export type DomainBlocksTable = {
    /** In the form signatures name it. */
    domain: string;
    /** Why it was blocked, for other admins. Empty if none was given. */
    reason: string;
    created_at: Date;
};
