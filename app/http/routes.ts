import { authRoutes } from "../auth/routes.ts";
import type { Route } from "./route.ts";

/** Every module's routes. */
export const routes: readonly Route[] = [...authRoutes];
