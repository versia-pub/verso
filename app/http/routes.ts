import { accountRoutes } from "../accounts/routes.ts";
import { authRoutes } from "../auth/routes.ts";
import type { Limits } from "../kernel/config.ts";
import type { Route } from "./route.ts";

/** Every module's routes, with what they accept held to the configured limits. */
export const routes = (limits: Limits): readonly Route[] => [
    ...authRoutes,
    ...accountRoutes(limits),
];
