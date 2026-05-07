import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AutokitConfig,
  ConfigParseError,
  createAssetsTransaction,
  createAutokitLogger,
  createPresetBackupDir,
  DEFAULT_CONFIG,
  manifestDirectory,
  parseConfig,
  parseConfigYaml,
  pruneBackupRetention,
  repoBackupId,
  sanitizeLogString,
  serializeConfigYaml,
} from "@cattyneo/autokit-core";
import { minimatch } from "minimatch";
import { parseDocument } from "yaml";

type PresetSource = "local" | "bundled";
type PresetFailureCode = "preset_path_traversal" | "preset_blacklist_hit";

export type PresetCliDeps = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  now?: () => string;
  presetAssetRoot?: string;
  presetPostApplyCheck?: (input: { repoRoot: string; presetName: string }) => void;
};

export type PresetInfo = {
  name: string;
  source: PresetSource;
  root: string;
};

type PresetEntry = {
  relativePath: string;
  absolutePath: string;
  type: "file" | "directory";
};

type PresetFailure = {
  code: PresetFailureCode;
  category: string;
};

class PresetCliError extends Error {
  readonly code: PresetFailureCode;
  readonly category: string;

  constructor(failure: PresetFailure) {
    super(`${failure.code}: ${failure.category}`);
    this.code = failure.code;
    this.category = failure.category;
  }
}

const presetSubtrees = new Set(["prompts", "skills", "agents"]);
const protectedArrayPaths = [
  "logging.redact_patterns",
  "init.backup_blacklist",
  "permissions.claude.allowed_tools",
] as const;

export function commandPresetList(deps: PresetCliDeps): number {
  const presets = discoverPresets(deps.cwd, deps.presetAssetRoot);
  deps.stdout.write("NAME\tsource\n");
  for (const preset of presets) {
    deps.stdout.write(`${preset.name}\t${preset.source}\n`);
  }
  return 0;
}

export function commandPresetShow(name: string, deps: PresetCliDeps): number {
  try {
    const preset = resolvePreset(deps.cwd, name, deps.presetAssetRoot);
    const currentConfig = loadCurrentConfig(deps.cwd);
    const { entries, configSource, configPatch } = inspectPreset(preset, currentConfig);
    deps.stdout.write(`preset\t${preset.name}\t${preset.source}\n`);
    for (const entry of entries.filter((item) => item.type === "file")) {
      deps.stdout.write(`file\t${entry.relativePath}\n`);
    }
    for (const path of protectedArrayPaths) {
      if (hasPath(configPatch, path.split("."))) {
        deps.stdout.write(`protected\t${path}\tmodified\n`);
      }
    }
    if (configSource !== null) {
      deps.stdout.write(`config\n${sanitizeForPreset(configSource, currentConfig, deps.cwd)}`);
    }
    return 0;
  } catch (error) {
    return handlePresetError(error, deps, loadCurrentConfigSafe(deps.cwd));
  }
}

export function commandPresetApply(
  name: string,
  options: { allowProtectedReplace?: boolean },
  deps: PresetCliDeps,
): number {
  const repoRoot = realpathSync(deps.cwd);
  const currentConfig = loadCurrentConfigSafe(repoRoot);
  try {
    const preset = resolvePreset(repoRoot, name, deps.presetAssetRoot);
    const { assetFiles, mergedConfig } = preparePresetApply(preset, currentConfig, {
      allowProtectedReplace: options.allowProtectedReplace === true,
    });
    assertAgentsPreflight(repoRoot, currentConfig);

    const now = deps.now?.() ?? new Date().toISOString();
    const stateHome = deps.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    const backupRoot = join(stateHome, "autokit", "backup", repoBackupId(repoRoot));
    pruneBackupRetention(backupRoot, {
      retentionDays: currentConfig.init.backup.retention_days,
      now: () => new Date(now),
    });
    const backupDir = createPresetBackupDir({ repoRoot, timestamp: now, stateHome });
    const transaction = createAssetsTransaction({ repoRoot, backupDir });
    const logger = createPresetLogger(repoRoot, currentConfig);
    const agentsBefore = manifestDirectory(join(repoRoot, ".agents"));
    const stagingRelative = `.agents.autokit-staging-${Date.now()}-${process.pid}`;
    const previousRelative = `.agents.autokit-prev-${Date.now()}-${process.pid}`;
    const stagingDir = join(repoRoot, stagingRelative);
    const previousAgentsDir = join(repoRoot, previousRelative);
    let agentsRenamed = false;

    try {
      logger.auditOperation("preset_apply_started", {
        preset: preset.name,
        source: preset.source,
      });
      transaction.backupExisting(".agents");
      transaction.backupExisting(".autokit/config.yaml");
      stageAgentsTree(repoRoot, stagingDir, assetFiles);
      assertPromptNames(stagingDir, mergedConfig);
      transaction.writeFileAtomic(".autokit/config.yaml", serializeConfigYaml(mergedConfig));
      replaceAgentsTree(repoRoot, stagingDir, previousAgentsDir);
      agentsRenamed = true;
      deps.presetPostApplyCheck?.({ repoRoot, presetName: preset.name });
      rmSync(previousAgentsDir, { recursive: true, force: true });
      logger.auditOperation("preset_apply_finished", {
        preset: preset.name,
        backup_id: repoBackupId(repoRoot),
      });
      logger.close();
      deps.stdout.write(`preset applied\t${preset.name}\n`);
      return 0;
    } catch (error) {
      logger.auditOperation("preset_apply_rollback_started", { preset: preset.name });
      try {
        if (agentsRenamed) {
          restoreRenamedAgents(repoRoot, previousAgentsDir);
        }
        transaction.rollback();
        rmSync(stagingDir, { recursive: true, force: true });
        rmSync(previousAgentsDir, { recursive: true, force: true });
        assertManifestEqual(agentsBefore, manifestDirectory(join(repoRoot, ".agents")));
        logger.auditOperation("preset_apply_rollback_finished", { preset: preset.name });
        logger.auditOperation("preset_apply_finished", {
          preset: preset.name,
          result: "rolled_back",
        });
        logger.close();
        deps.stderr.write(
          `preset apply validation failed; restored previous .agents state; cause=${publicMessage(
            error,
            currentConfig,
            repoRoot,
          )}\n`,
        );
        return 1;
      } catch (rollbackError) {
        logger.auditOperation("preset_apply_rollback_failed", {
          preset: preset.name,
          backup_id: repoBackupId(repoRoot),
        });
        logger.close();
        deps.stderr.write(
          `preset apply rollback failed; inspect backup ${sanitizeForPreset(
            backupDir,
            currentConfig,
            repoRoot,
          )}; cause=${publicMessage(rollbackError, currentConfig, repoRoot)}\n`,
        );
        return 1;
      }
    }
  } catch (error) {
    return handlePresetError(error, deps, currentConfig);
  }
}

export function discoverPresets(repoRoot: string, bundledRoot = defaultPresetRoot()): PresetInfo[] {
  const byName = new Map<string, PresetInfo>();
  for (const preset of listPresetRoot(bundledRoot, "bundled")) {
    byName.set(preset.name, preset);
  }
  for (const preset of listPresetRoot(join(repoRoot, ".autokit", "presets"), "local")) {
    byName.set(preset.name, preset);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function resolvePreset(
  repoRoot: string,
  name: string,
  bundledRoot = defaultPresetRoot(),
): PresetInfo {
  const preset = discoverPresets(repoRoot, bundledRoot).find((item) => item.name === name);
  if (preset === undefined) {
    throw new Error(`preset not found: ${name}`);
  }
  return preset;
}

function inspectPreset(
  preset: PresetInfo,
  currentConfig: AutokitConfig,
): {
  entries: PresetEntry[];
  configSource: string | null;
  configPatch: unknown;
} {
  const entries = collectPresetEntries(preset.root, currentConfig);
  const configEntry = entries.find((entry) => entry.relativePath === "config.yaml");
  const configSource =
    configEntry === undefined ? null : readFileSync(configEntry.absolutePath, "utf8");
  const configPatch = configSource === null ? {} : parseConfigPatch(configSource);
  return { entries, configSource, configPatch };
}

function preparePresetApply(
  preset: PresetInfo,
  currentConfig: AutokitConfig,
  options: { allowProtectedReplace: boolean },
): { assetFiles: PresetEntry[]; mergedConfig: AutokitConfig } {
  const { entries, configSource, configPatch } = inspectPreset(preset, currentConfig);
  const mergedConfig =
    configSource === null
      ? currentConfig
      : mergePresetConfig(currentConfig, configPatch, options.allowProtectedReplace);
  const assetFiles = entries.filter((entry) => {
    const [topLevel] = entry.relativePath.split("/");
    return entry.type === "file" && topLevel !== undefined && presetSubtrees.has(topLevel);
  });
  return { assetFiles, mergedConfig };
}

function listPresetRoot(root: string, source: PresetSource): PresetInfo[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((entry) => {
      const path = join(root, entry);
      return lstatSync(path).isDirectory();
    })
    .map((name) => ({ name, source, root: join(root, name) }));
}

function collectPresetEntries(presetRoot: string, config: AutokitConfig): PresetEntry[] {
  if (lstatSync(presetRoot).isSymbolicLink()) {
    throw new PresetCliError({ code: "preset_path_traversal", category: "<symlink>" });
  }
  const rootReal = realpathSync(presetRoot);
  const entries: PresetEntry[] = [];
  const walk = (absolutePath: string) => {
    const stat = lstatSync(absolutePath);
    const relativePath = relative(rootReal, absolutePath).split(sep).join("/");
    if (relativePath.includes("\0") || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new PresetCliError({ code: "preset_path_traversal", category: "<path-traversal>" });
    }
    if (relativePath !== "") {
      const blacklist = blacklistCategory(relativePath, config);
      if (blacklist !== null) {
        throw new PresetCliError({ code: "preset_blacklist_hit", category: blacklist });
      }
      if (stat.isSymbolicLink()) {
        throw new PresetCliError({ code: "preset_path_traversal", category: "<symlink>" });
      }
      const entryReal = realpathSync(absolutePath);
      if (!isInside(rootReal, entryReal)) {
        throw new PresetCliError({ code: "preset_path_traversal", category: "<path-traversal>" });
      }
      const type = stat.isDirectory() ? "directory" : "file";
      entries.push({ relativePath, absolutePath, type });
      if (type === "file") {
        const contentSignature = contentSignatureCategory(readFileSync(absolutePath, "utf8"));
        if (contentSignature !== null) {
          throw new PresetCliError({ code: "preset_blacklist_hit", category: contentSignature });
        }
      }
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolutePath).sort()) {
        walk(join(absolutePath, child));
      }
    }
  };
  walk(rootReal);
  return entries;
}

function parseConfigPatch(source: string): unknown {
  const document = parseDocument(source, {
    prettyErrors: false,
    stringKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error("Invalid preset config YAML");
  }
  return document.toJSON() ?? {};
}

function mergePresetConfig(
  currentConfig: AutokitConfig,
  patch: unknown,
  allowProtectedReplace: boolean,
): AutokitConfig {
  const merged = mergeValue(currentConfig, patch, [], currentConfig, allowProtectedReplace);
  return parseConfig(merged);
}

function mergeValue(
  currentValue: unknown,
  patchValue: unknown,
  path: string[],
  currentConfig: AutokitConfig,
  allowProtectedReplace: boolean,
): unknown {
  if (patchValue === null) {
    return valueAtPath(DEFAULT_CONFIG, path) ?? undefined;
  }
  const protectedPath = path.join(".");
  if (protectedArrayPaths.includes(protectedPath as (typeof protectedArrayPaths)[number])) {
    return mergeProtectedArray(protectedPath, currentValue, patchValue, allowProtectedReplace);
  }
  if (Array.isArray(patchValue)) {
    return patchValue;
  }
  if (isRecord(currentValue) && isRecord(patchValue)) {
    const output: Record<string, unknown> = { ...currentValue };
    for (const [key, value] of Object.entries(patchValue)) {
      output[key] = mergeValue(
        output[key],
        value,
        [...path, key],
        currentConfig,
        allowProtectedReplace,
      );
    }
    return output;
  }
  return patchValue;
}

function mergeProtectedArray(
  path: string,
  currentValue: unknown,
  patchValue: unknown,
  allowProtectedReplace: boolean,
): unknown {
  if (!Array.isArray(patchValue)) {
    return patchValue;
  }
  if (allowProtectedReplace) {
    return patchValue;
  }
  if (path === "permissions.claude.allowed_tools") {
    if (!arraysEqual(asStringArray(currentValue), patchValue)) {
      throw new PresetCliError({
        code: "preset_blacklist_hit",
        category: `<protected-array:${path}>`,
      });
    }
    return currentValue;
  }
  if (patchValue.length === 0) {
    throw new PresetCliError({
      code: "preset_blacklist_hit",
      category: `<protected-array:${path}>`,
    });
  }
  return [...new Set([...asStringArray(currentValue), ...patchValue.map(String)])];
}

function assertAgentsPreflight(repoRoot: string, config: AutokitConfig): void {
  const agentsPath = join(repoRoot, ".agents");
  assertNoSymlinkParent(repoRoot, agentsPath);
  if (!existsSync(agentsPath)) {
    return;
  }
  if (lstatSync(agentsPath).isSymbolicLink()) {
    throw new PresetCliError({ code: "preset_path_traversal", category: "<symlink>" });
  }
  for (const entry of collectTreeEntries(agentsPath)) {
    const category = blacklistCategory(entry.relativePath, config);
    if (category !== null) {
      throw new PresetCliError({ code: "preset_blacklist_hit", category });
    }
    if (entry.type === "file") {
      const contentCategory = contentSignatureCategory(readFileSync(entry.absolutePath, "utf8"));
      if (contentCategory !== null) {
        throw new PresetCliError({ code: "preset_blacklist_hit", category: contentCategory });
      }
    }
  }
}

function collectTreeEntries(root: string): PresetEntry[] {
  const rootReal = realpathSync(root);
  const entries: PresetEntry[] = [];
  const walk = (absolutePath: string) => {
    const stat = lstatSync(absolutePath);
    const relativePath = relative(rootReal, absolutePath).split(sep).join("/");
    if (relativePath !== "") {
      if (stat.isSymbolicLink()) {
        throw new PresetCliError({ code: "preset_path_traversal", category: "<symlink>" });
      }
      entries.push({
        relativePath,
        absolutePath,
        type: stat.isDirectory() ? "directory" : "file",
      });
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolutePath)) {
        walk(join(absolutePath, child));
      }
    }
  };
  walk(rootReal);
  return entries;
}

function stageAgentsTree(repoRoot: string, stagingDir: string, assetFiles: PresetEntry[]): void {
  rmSync(stagingDir, { recursive: true, force: true });
  const agentsDir = join(repoRoot, ".agents");
  if (existsSync(agentsDir)) {
    cpSync(agentsDir, stagingDir, { recursive: true, force: true, preserveTimestamps: true });
  } else {
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  }
  for (const file of assetFiles) {
    const [, ...rest] = file.relativePath.split("/");
    const target = join(stagingDir, file.relativePath.split("/")[0] ?? "", ...rest);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(file.absolutePath, target, { force: true, preserveTimestamps: true });
  }
}

function assertPromptNames(stagingDir: string, config: AutokitConfig): void {
  const promptsDir = join(stagingDir, "prompts");
  if (!existsSync(promptsDir)) {
    return;
  }
  const expected: string[] = Object.values(config.phases)
    .map((phase) => phase.prompt_contract)
    .sort();
  const actual = readdirSync(promptsDir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.slice(0, -".md".length))
    .sort();
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `prompt contract mismatch: missing=${missing.join(",") || "-"} extra=${extra.join(",") || "-"}`,
    );
  }
}

function replaceAgentsTree(repoRoot: string, stagingDir: string, previousAgentsDir: string): void {
  const agentsDir = join(repoRoot, ".agents");
  rmSync(previousAgentsDir, { recursive: true, force: true });
  if (existsSync(agentsDir)) {
    renameSync(agentsDir, previousAgentsDir);
  }
  renameSync(stagingDir, agentsDir);
}

function restoreRenamedAgents(repoRoot: string, previousAgentsDir: string): void {
  const agentsDir = join(repoRoot, ".agents");
  rmSync(agentsDir, { recursive: true, force: true });
  if (existsSync(previousAgentsDir)) {
    renameSync(previousAgentsDir, agentsDir);
  }
}

function handlePresetError(error: unknown, deps: PresetCliDeps, config: AutokitConfig): number {
  if (error instanceof PresetCliError) {
    const repoRoot = realpathSync(deps.cwd);
    const logger = createPresetLogger(repoRoot, config);
    logger.auditFailure({
      failure: {
        phase: "preset",
        code: error.code,
        message: error.category,
        ts: deps.now?.() ?? new Date().toISOString(),
      },
      payload: { category: error.category },
    });
    logger.close();
    deps.stderr.write(`${error.code}: ${error.category}\n`);
    return 1;
  }
  if (error instanceof ConfigParseError) {
    if (error.issues.some((issue) => issue.path.join(".") === "permissions.claude.allowed_tools")) {
      return handlePresetError(
        new PresetCliError({
          code: "preset_blacklist_hit",
          category: "<protected-array:permissions.claude.allowed_tools>",
        }),
        deps,
        config,
      );
    }
    deps.stderr.write(`preset config invalid: ${error.message}\n`);
    return 1;
  }
  deps.stderr.write(`${publicMessage(error, config, deps.cwd)}\n`);
  return 1;
}

function createPresetLogger(repoRoot: string, config: AutokitConfig) {
  return createAutokitLogger({
    logDir: join(repoRoot, ".autokit", "logs"),
    config,
  });
}

function loadCurrentConfig(repoRoot: string): AutokitConfig {
  const configPath = join(repoRoot, ".autokit", "config.yaml");
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  return parseConfigYaml(readFileSync(configPath, "utf8"));
}

function loadCurrentConfigSafe(repoRoot: string): AutokitConfig {
  try {
    return loadCurrentConfig(repoRoot);
  } catch {
    return DEFAULT_CONFIG;
  }
}

function blacklistCategory(relativePath: string, config: AutokitConfig): string | null {
  const normalized = relativePath.split(sep).join("/");
  const lower = normalized.toLowerCase();
  const parts = lower.split("/");
  const base = basename(lower);
  if (base.startsWith(".env")) {
    return "<blacklist:env>";
  }
  if (parts.includes(".codex") || lower === ".autokit/audit-hmac-key") {
    return "<blacklist:credentials>";
  }
  if (parts.includes(".claude") && base.startsWith("credentials")) {
    return "<blacklist:credentials>";
  }
  if (base.startsWith("id_rsa") || base.endsWith(".pem") || base.endsWith(".key")) {
    return "<blacklist:ssh-key>";
  }
  const patterns = [
    ".env*",
    ".codex/**",
    ".claude/credentials*",
    "id_rsa*",
    "*.pem",
    "*.key",
    ".autokit/audit-hmac-key",
    ...config.init.backup_blacklist,
  ];
  for (const pattern of patterns) {
    if (
      minimatch(normalized, pattern, { dot: true, nocase: true }) ||
      minimatch(base, pattern, { dot: true, nocase: true })
    ) {
      return "<blacklist:credentials>";
    }
  }
  return null;
}

function contentSignatureCategory(content: string): string | null {
  if (/BEGIN OPENSSH PRIVATE KEY/.test(content)) {
    return "<content-signature:openssh-private-key>";
  }
  if (/BEGIN (RSA |EC |DSA )?PRIVATE KEY/.test(content)) {
    return "<content-signature:private-key>";
  }
  if (/ssh-rsa AAAA[A-Za-z0-9+/]{20,}/.test(content)) {
    return "<content-signature:ssh-public-key>";
  }
  if (/ghp_[A-Za-z0-9]{20,}/.test(content)) {
    return "<content-signature:github-token>";
  }
  if (/sk-[A-Za-z0-9]{20,}/.test(content)) {
    return "<content-signature:api-key>";
  }
  if (/xox[baprs]-[A-Za-z0-9-]+/.test(content)) {
    return "<content-signature:slack-token>";
  }
  if (/"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----/.test(content)) {
    return "<content-signature:gcp-private-key>";
  }
  return null;
}

function assertNoSymlinkParent(repoRoot: string, targetPath: string): void {
  const rootReal = realpathSync(repoRoot);
  const normalizedTarget = normalize(targetPath);
  const rel = relative(rootReal, normalizedTarget);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.includes("\0")) {
    throw new PresetCliError({ code: "preset_path_traversal", category: "<path-traversal>" });
  }
  let current = rootReal;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      continue;
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new PresetCliError({ code: "preset_path_traversal", category: "<symlink>" });
    }
    const currentReal = realpathSync(current);
    if (!isInside(rootReal, currentReal)) {
      throw new PresetCliError({ code: "preset_path_traversal", category: "<path-traversal>" });
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertManifestEqual(
  left: ReturnType<typeof manifestDirectory>,
  right: ReturnType<typeof manifestDirectory>,
): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error("rollback manifest mismatch");
  }
}

function publicMessage(error: unknown, config: AutokitConfig, repoRoot: string): string {
  return sanitizeForPreset(
    error instanceof Error ? error.message : String(error),
    config,
    repoRoot,
  );
}

function sanitizeForPreset(value: string, config: AutokitConfig, repoRoot: string): string {
  return sanitizeLogString(value.replaceAll(repoRoot, "<repo>"), config, false, {
    repoRoot,
    homeDir: homedir(),
  });
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function arraysEqual(left: string[], right: unknown[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === String(right[index]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasPath(value: unknown, path: string[]): boolean {
  let current = value;
  for (const part of path) {
    if (!isRecord(current) || !(part in current)) {
      return false;
    }
    current = current[part];
  }
  return true;
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function defaultPresetRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "presets");
}
