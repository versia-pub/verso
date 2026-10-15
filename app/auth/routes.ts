import type { Route } from "../http/route.ts";
import { appRoutes } from "./app_routes.ts";
import { loginRoutes } from "./login_routes.ts";
import { tokenRoutes } from "./token_routes.ts";

export const authRoutes: readonly Route[] = [...appRoutes, ...loginRoutes, ...tokenRoutes];
