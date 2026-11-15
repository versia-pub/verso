import { instancesHosting } from "../accounts/account_queries.ts";
import type { Audience } from "../federation/deliver.ts";
import type { Context } from "../kernel/context.ts";
import { everyone } from "../notes/audience.ts";
import type { NoteRow } from "../notes/note_queries.ts";

/**
 * The remote instances a local user's like or reaction to `note` is sent to: the instance of the
 * status's author, which must be told, and for a status anyone may see, those of the user's
 * followers, which Versia specifies. Other instances aren't told of interactions with statuses they
 * may not see.
 */
export const audienceOfInteraction = async (
    ctx: Context,
    accountId: string,
    note: NoteRow,
): Promise<Audience> => {
    const author = await instancesHosting(ctx, [note.account_id]);

    return everyone.includes(note.visibility)
        ? { instanceIds: author, followersOf: accountId }
        : { instanceIds: author };
};
