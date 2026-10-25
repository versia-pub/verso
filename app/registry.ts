import { v0_6 } from "@versia/protocol";
import { userType } from "./accounts/federation.ts";
import { deleteType } from "./federation/delete.ts";
import { messagingExtension } from "./federation/messaging.ts";
import { createRegistry } from "./federation/registry.ts";
import { followCollections, followTypes } from "./graph/federation.ts";
import { likeTypes, noteLikeCollections, userLikeCollections } from "./interactions/federation.ts";
import { noteReactionCollections, reactionType } from "./interactions/reaction_federation.ts";
import { noteShareCollections, shareType } from "./interactions/share_federation.ts";
import { noteCollections, noteType, removeNotesOfDeletedUser } from "./notes/federation.ts";

/** Users, with the collections other modules add, and their notes removed before they are. */
const user = {
    ...userType,
    prepareDelete: removeNotesOfDeletedUser,
    collections: {
        ...userType.collections,
        ...followCollections,
        ...noteCollections,
        ...userLikeCollections,
    },
};

/** Notes, with the collections other modules add. */
const note = {
    ...noteType,
    collections: {
        ...noteType.collections,
        ...noteLikeCollections,
        ...noteShareCollections,
        ...noteReactionCollections,
    },
};

/** The types of entities Verso keeps. Extensions add theirs here. */
const types = [user, note, ...likeTypes, shareType, reactionType];

/**
 * Every Versia entity type Verso knows: the ones it keeps, Delete, which deletes them, and the
 * transient ones follows are sent as, and the extensions that add no types.
 */
export const registry = createRegistry(
    [...types, deleteType(types), ...followTypes],
    [v0_6.customEmojisKey, messagingExtension],
);
