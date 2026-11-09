/** An entity queued for delivery, stored once for all the instances it goes to. */
export type DeliveryBodiesTable = {
    id: string;
    /** The entity, serialised when queued, so later changes can't alter what is sent. */
    body: string;
    /** When it was queued. Its deliveries are given up on by this. */
    created_at: Date;
};
