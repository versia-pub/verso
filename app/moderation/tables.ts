import type { Generated } from "kysely";

/** An instance Verso doesn't federate with, blocked by an admin, with its subdomains. */
export type DomainBlocksTable = {
    id: string;
    /** In the form signatures name it. */
    domain: string;
    /**
     * Why it was blocked, which the instance's public list of blocks may show. Empty if none was
     * given.
     */
    reason: string;
    /** Why it was blocked, for other moderators only. */
    private_comment: string | null;
    /** Whether the instance's public list of blocks shows the domain partly masked. */
    obfuscate: Generated<boolean>;
    created_at: Date;
};
