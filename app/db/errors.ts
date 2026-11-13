/**
 * Whether the database refused a change because it would repeat a value that must be unique. It
 * recognises both databases: Postgres says so with the error code 23505, and SQLite only in words.
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const isUniqueViolation = (error: unknown): boolean =>
    error instanceof Error && (
        ("code" in error && error.code === "23505") ||
        error.message.startsWith("UNIQUE constraint failed")
    );
