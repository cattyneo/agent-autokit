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
const ALLOWED_ENV_BUILDER_MODULES = new Set([
  "@cattyneo/autokit-core",
  "./env-allowlist.js",
  "./env-allowlist.ts",
  "../../packages/core/src/env-allowlist.js",
  "../../packages/core/src/env-allowlist.ts",
]);

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
        trackRequireDeclarator(node, {
          childProcessIdentifiers,
          childProcessNamespaces,
          execaIdentifiers,
          execaNamespaces,
          envBuilderFunctionIdentifiers,
        });

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

function trackRequireDeclarator(node, imports) {
  const sourceValue = getRequireSource(node.init);
  if (sourceValue === undefined) {
    return;
  }

  if (CHILD_PROCESS_MODULES.has(sourceValue)) {
    trackChildProcessBinding(node.id, imports);
  }
  if (EXECA_MODULES.has(sourceValue)) {
    trackExecaBinding(node.id, imports);
  }
  if (isAllowedEnvBuilderModule(sourceValue)) {
    trackEnvBuilderBinding(node.id, imports);
  }
}

function trackChildProcessBinding(id, imports) {
  if (id.type === "Identifier") {
    imports.childProcessNamespaces.add(id.name);
    return;
  }
  if (id.type !== "ObjectPattern") {
    return;
  }

  for (const property of id.properties) {
    if (property.type !== "Property" || property.computed) {
      continue;
    }
    const importedName = getPropertyName(property.key);
    if (!NAMED_CHILD_PROCESS_FUNCTIONS.has(importedName)) {
      continue;
    }
    addBoundIdentifier(property.value, imports.childProcessIdentifiers);
  }
}

function trackExecaBinding(id, imports) {
  if (id.type === "Identifier") {
    imports.execaNamespaces.add(id.name);
    return;
  }
  if (id.type !== "ObjectPattern") {
    return;
  }

  for (const property of id.properties) {
    if (property.type !== "Property" || property.computed) {
      continue;
    }
    const importedName = getPropertyName(property.key);
    if (!EXECA_FUNCTIONS.has(importedName)) {
      continue;
    }
    addBoundIdentifier(property.value, imports.execaIdentifiers);
  }
}

function trackEnvBuilderBinding(id, imports) {
  if (id.type !== "ObjectPattern") {
    return;
  }

  for (const property of id.properties) {
    if (property.type !== "Property" || property.computed) {
      continue;
    }
    const importedName = getPropertyName(property.key);
    if (!ALLOWED_ENV_BUILDERS.has(importedName)) {
      continue;
    }
    addBoundIdentifier(property.value, imports.envBuilderFunctionIdentifiers);
  }
}

function addBoundIdentifier(pattern, identifiers) {
  if (pattern.type === "Identifier") {
    identifiers.add(pattern.name);
  }
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
  return ALLOWED_ENV_BUILDER_MODULES.has(sourceValue);
}

function getRequireSource(node) {
  if (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments[0]?.type === "Literal" &&
    typeof node.arguments[0].value === "string"
  ) {
    return node.arguments[0].value;
  }
  return undefined;
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
