/**
 * `verso admin roles …`.
 * @module
 */
import { Command, EnumType, ValidationError } from "@cliffy/command";
import { createRole, listRoles } from "../accounts/role_queries.ts";
import { RoleName } from "../accounts/roles.ts";
import { permissions } from "../kernel/permissions.ts";
import { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

/** The `roles` group of commands. */
export const rolesCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Manage roles, which give accounts permissions.")
        .action(missingCommand)
        .command("create <name:string>", "Create a role, and print it.")
        .type("permission", new EnumType(permissions))
        .option("-p, --permissions <permissions:permission[]>", "What it allows.", { default: [] })
        .option("--priority <priority:integer>", "Higher roles manage lower ones.", { default: 0 })
        .action(async ({ config, permissions, priority }, name) => {
            // The same rules as the API's, so a role created here can be changed there.
            const checked = RoleName.safeParse(name);
            if (!checked.success) {
                throw new ValidationError(checked.error.issues[0]?.message ?? "Invalid name");
            }

            const role = await io.withContext(
                config,
                (ctx) => createRole(ctx, { name: checked.data, permissions, priority }),
            );
            if (!role) throw new AdminError(`There is already a role named ${name}`);

            io.print(JSON.stringify(role));
        })
        .command("list", "Print every role, highest priority first.")
        .action(async ({ config }) => {
            io.print(JSON.stringify(await io.withContext(config, listRoles)));
        })
        .reset();
