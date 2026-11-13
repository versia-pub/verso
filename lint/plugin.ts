/** Verso's own lint rules, for conventions `deno lint` has no built-in rule for. */
const plugin: Deno.lint.Plugin = {
    name: "verso",
    rules: {
        // Arrow functions only, so there's one way to write a function. Methods and generators are
        // left alone, since they have no arrow form.
        "prefer-arrow-functions": {
            create(context) {
                const message = "Use an arrow function instead of `function`.";

                return {
                    FunctionDeclaration(node) {
                        if (!node.generator) context.report({ node, message });
                    },

                    FunctionExpression(node) {
                        const parent = node.parent;
                        const isMethod = parent.type === "MethodDefinition" ||
                            (parent.type === "Property" &&
                                (parent.method || parent.kind !== "init"));

                        if (!node.generator && !isMethod) {
                            context.report({ node, message });
                        }
                    },
                };
            },
        },

        // One way to declare an object type. Enums emit runtime code, and a union of string literals
        // does the same job without any.
        "prefer-type-aliases": {
            create(context) {
                return {
                    TSInterfaceDeclaration(node) {
                        context.report({
                            node,
                            message: "Use a `type` alias instead of `interface`.",
                        });
                    },

                    TSEnumDeclaration(node) {
                        context.report({
                            node,
                            message: "Use a union of string literals instead of `enum`.",
                        });
                    },
                };
            },
        },
    },
};

export default plugin;
