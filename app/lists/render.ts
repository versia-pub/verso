import type { List } from "@versia/client-api";
import type { ListRow } from "./list_queries.ts";

/** A list as Mastodon renders it. */
export const renderList = (row: ListRow): List => ({
    id: row.id,
    title: row.title,
    replies_policy: row.replies_policy,
    exclusive: row.exclusive,
});
