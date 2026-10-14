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
            if (!node.generator && !isMethod) context.report({ node, message });
          },
        };
      },
    },
  },
};

export default plugin;
