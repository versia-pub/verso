import { z } from "zod";
import { ReferenceText, TransientEntity } from "./common.ts";

/** `author` asks to follow `followee`. https://versia.pub/entities/follow */
export const Follow = TransientEntity.extend({
  type: z.literal("Follow"),
  author: ReferenceText,
  followee: ReferenceText,
});
export type Follow = z.infer<typeof Follow>;

/** `author` accepts `follower`. https://versia.pub/entities/follow-accept */
export const FollowAccept = TransientEntity.extend({
  type: z.literal("FollowAccept"),
  author: ReferenceText,
  follower: ReferenceText,
});
export type FollowAccept = z.infer<typeof FollowAccept>;

/** `author` rejects `follower`. https://versia.pub/entities/follow-reject */
export const FollowReject = TransientEntity.extend({
  type: z.literal("FollowReject"),
  author: ReferenceText,
  follower: ReferenceText,
});
export type FollowReject = z.infer<typeof FollowReject>;

/** `author` stops following `followee`. https://versia.pub/entities/unfollow */
export const Unfollow = TransientEntity.extend({
  type: z.literal("Unfollow"),
  author: ReferenceText,
  followee: ReferenceText,
});
export type Unfollow = z.infer<typeof Unfollow>;
