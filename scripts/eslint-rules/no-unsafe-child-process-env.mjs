const CHILD_PROCESS_MODULES = new Set(["node:child_process", "child_process"]);
const EXECA_MODULES = new Set(["execa"]);
const NAMED_CHILD_PROCESS_FUNCTIONS = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);
const EXECA_FUNCTIONS = new Set([
  "execa",
  "execaCommand",
  "execaCommandSync",
  "execaNode",
  "execaSync",
]);
const ALLOWED_ENV_BUILDERS = new Set(["buildGhEnv", "buildRunnerEnv"]);
const ALLOWED_ENV_BUILDER_MODULES = new Set(["@cattyneo/autokit-core"]);

export const noUnsafeChildProcessEnv = {
  meta: {
    type: "problem",
    docs: {
      description: "Require explicit autokit child-process env builders.",
    },
    messages: {
      directProcessEnv: "Do not pass process.env directly to child-process env options.",
      missingEnv: "Child process calls must pass env from buildGhEnv() or buildRunnerEnv().",
      spreadProcessEnv: "Do not spread process.env into child-process env objects.",
      wrongEnvBuilder: "Child process env must be built with buildGhEnv() or buildRunnerEnv().",
    },
    schema: [],
  },
  create(context) {
    const childProcessIdentifiers = new Set();
    const childProcessNamespaces = new Set();
    const execaIdentifiers = new Set();
    const execaNamespaces = new Set();
    const envBuilderFunctionIdentifiers = new Set();
    const envBuilderIdentifiers = new Set();

    return {
      ImportDeclaration(node) {
        if (CHILD_PROCESS_MODULES.has(node.source.value)) {
          for (const specifier of node.specifiers) {
            if (
              specifier.type === "ImportSpecifier" &&
              NAMED_CHILD_PROCESS_FUNCTIONS.has(specifier.imported.name)
            ) {
              childProcessIdentifiers.add(specifier.local.name);
            }
            if (specifier.type === "ImportNamespaceSpecifier") {
              childProcessNamespaces.add(specifier.local.name);
            }
          }
        }

        if (EXECA_MODULES.has(node.source.value)) {
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportDefaultSpecifier") {
              execaIdentifiers.add(specifier.local.name);
            }
            if (
              specifier.type === "ImportSpecifier" &&
              EXECA_FUNCTIONS.has(specifier.imported.name)
            ) {
              execaIdentifiers.add(specifier.local.name);
            }
            if (specifier.type === "ImportNamespaceSpecifier") {
              execaNamespaces.add(specifier.local.name);
            }
          }
        }

        if (isAllowedEnvBuilderModule(node.source.value)) {
          for (const specifier of node.specifiers) {
            if (
              specifier.type === "ImportSpecifier" &&
              ALLOWED_ENV_BUILDERS.has(specifier.imported.name)
            ) {
              envBuilderFunctionIdentifiers.add(specifier.local.name);
            }
          }
        }
      },

      VariableDeclarator(node) {
        if (
          node.parent?.kind === "const" &&
          node.id.type === "Identifier" &&
          isAllowedEnvBuilderCall(node.init, { envBuilderFunctionIdentifiers })
        ) {
          envBuilderIdentifiers.add(node.id.name);
        }
      },

      CallExpression(node) {
        const childProcessKind = getProcessRunnerKind(node.callee, {
          childProcessIdentifiers,
          childProcessNamespaces,
          execaIdentifiers,
          execaNamespaces,
        });
        if (childProcessKind === undefined) {
          return;
        }

        const envNode = getEnvOptionNode(childProcessKind, node.arguments);
        if (envNode === undefined) {
          context.report({ node, messageId: "missingEnv" });
          return;
        }

        validateEnvNode(context, envNode, {
          envBuilderFunctionIdentifiers,
          envBuilderIdentifiers,
        });
      },
    };
  },
};

function getProcessRunnerKind(callee, imports) {
  if (callee.type === "Identifier" && imports.childProcessIdentifiers.has(callee.name)) {
    return callee.name;
  }
  if (callee.type === "Identifier" && imports.execaIdentifiers.has(callee.name)) {
    return "execa";
  }

  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    imports.childProcessNamespaces.has(callee.object.name) &&
    callee.property.type === "Identifier" &&
    NAMED_CHILD_PROCESS_FUNCTIONS.has(callee.property.name)
  ) {
    return callee.property.name;
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    imports.execaNamespaces.has(callee.object.name) &&
    callee.property.type === "Identifier" &&
    EXECA_FUNCTIONS.has(callee.property.name)
  ) {
    return "execa";
  }

  return undefined;
}

function getEnvOptionNode(kind, args) {
  const candidateIndexes = getOptionCandidateIndexes(kind);

  for (const index of candidateIndexes) {
    const optionNode = args[index];
    if (optionNode?.type !== "ObjectExpression") {
      continue;
    }

    const envProperty = optionNode.properties.find(
      (property) =>
        property.type === "Property" &&
        !property.computed &&
        getPropertyName(property.key) === "env",
    );

    if (envProperty?.type === "Property") {
      return envProperty.value;
    }
  }

  return undefined;
}

function getOptionCandidateIndexes(kind) {
  if (kind === "spawn" || kind === "spawnSync") {
    return [2, 1];
  }
  if (kind === "exec" || kind === "execSync") {
    return [1];
  }
  if (kind === "execa") {
    return [2, 1, 0];
  }
  return [2, 1];
}

function validateEnvNode(context, envNode, imports) {
  if (isProcessEnv(envNode)) {
    context.report({ node: envNode, messageId: "directProcessEnv" });
    return;
  }

  if (envNode.type === "ObjectExpression") {
    for (const property of envNode.properties) {
      if (property.type === "SpreadElement" && isProcessEnv(property.argument)) {
        context.report({ node: property, messageId: "spreadProcessEnv" });
        return;
      }
    }
    context.report({ node: envNode, messageId: "wrongEnvBuilder" });
    return;
  }

  if (
    isAllowedEnvBuilderCall(envNode, imports) ||
    (envNode.type === "Identifier" && imports.envBuilderIdentifiers.has(envNode.name))
  ) {
    return;
  }

  context.report({ node: envNode, messageId: "wrongEnvBuilder" });
}

function getPropertyName(key) {
  if (key.type === "Identifier") {
    return key.name;
  }
  if (key.type === "Literal") {
    return String(key.value);
  }
  return undefined;
}

function isAllowedEnvBuilderCall(node, imports) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    imports.envBuilderFunctionIdentifiers.has(node.callee.name)
  );
}

function isAllowedEnvBuilderModule(sourceValue) {
  return (
    ALLOWED_ENV_BUILDER_MODULES.has(sourceValue) ||
    sourceValue.endsWith("/env-allowlist.js") ||
    sourceValue.endsWith("/env-allowlist.ts") ||
    sourceValue === "./env-allowlist.js" ||
    sourceValue === "./env-allowlist.ts"
  );
}

function isProcessEnv(node) {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    node.property.type === "Identifier" &&
    node.property.name === "env"
  );
}
