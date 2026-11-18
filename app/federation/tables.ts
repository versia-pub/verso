/** An entity queued for delivery, stored once for all the instances it goes to. */
export type DeliveryBodiesTable = {
    id: string;
    /** The entity, serialised when queued, so later changes can't alter what is sent. */
    body: string;
    /** When it was queued. Its deliveries are given up on by this. */
    created_at: Date;
    /** The entity's own `id`, if it has one, so its deliveries can be dropped once it is deleted. */
    entity_id: string | null;
    /** The local id of the entity's author, so a deleted user's deliveries can be dropped. */
    author_id: string | null;
};

/** A local entity that was deleted, remembered so fetching it answers `410 Gone`. */
export type DeletedEntitiesTable = {
    /** The entity's local id. Ids are unique across types. */
    id: string;
    /** Its Versia type name, like `pub.versia:social/Note` or `User`. */
    type: string;
    deleted_at: Date;
};
