import { randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, serializeConfigYaml } from "@cattyneo/autokit-core";

export const INIT_MARKER_START = "<!-- autokit:init:start -->";
export const INIT_MARKER_END = "<!-- autokit:init:end -->";

const DEFAULT_CONFIG_YAML = serializeConfigYaml();

const DEFAULT_TASKS_YAML = `version: 1
generated_at: ""
tasks: []
`;

const AUDIT_HMAC_KEY = ".autokit/audit-hmac-key";
const INIT_AUDIT_LOG = ".autokit/init-audit.jsonl";

const PROVIDER_LINKS = [
  { path: ".claude/skills", target: "../.agents/skills" },
  { path: ".codex/skills", target: "../.agents/skills" },
  { path: ".claude/agents", target: "../.agents/agents" },
  { path: ".codex/agents", target: "../.agents/agents" },
] as const;

const MARKER_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export type InitOptions = {
  dryRun?: boolean;
  force?: boolean;
  assetRoot?: string;
  now?: () => string;
  failAfterAssets?: boolean;
  failDuringRollback?: boolean;
};

export type InitResult = {
  dryRun: boolean;
  changed: string[];
  skipped: string[];
  backupDir: string | null;
  audit: string[];
};

type BackupEntry = {
  relativePath: string;
  backupPath: string;
};

export function runInit(cwd: string, options: InitOptions = {}): InitResult {
  const root = realpathSync(cwd);
  const assetRoot = options.assetRoot ?? defaultAssetRoot();
  const changed: string[] = [];
  const skipped: string[] = [];
  const backupDir = join(
    root,
    ".autokit",
    ".backup",
    timestamp(options.now?.() ?? new Date().toISOString()),
  );
  const backups: BackupEntry[] = [];
  const created: string[] = [];
  const audit: string[] = [];

  assertDirectory(assetRoot, "assets source");
  accessSync(root, constants.W_OK);
  assertNoBackupResidue(root, options.force === true);
  assertBackupBlacklist(root);
  validateExistingProviderLinks(root);
  validateMarkerTargets(root);
  validateWriteParents(root);

  const assetFiles = listAssetFiles(assetRoot);
  const plannedChanges = [
    ".autokit/config.yaml",
    ".autokit/tasks.yaml",
    ...assetFiles.map((file) => join(".agents", file).split(sep).join("/")),
    ...PROVIDER_LINKS.map((link) => link.path),
    ...MARKER_FILES,
  ];

  if (options.dryRun === true) {
    return { dryRun: true, changed: plannedChanges, skipped: [], backupDir: null, audit: [] };
  }

  try {
    mkdirSafe(root, ".autokit");
    writeAuditHmacKey(root, changed, created);
    mkdirSafe(root, ".autokit/.backup");
    mkdirSafe(root, relativePath(root, backupDir));
    mkdirSafe(root, relativePath(root, join(backupDir, "staging")));
    writeNewFile(root, ".autokit/config.yaml", DEFAULT_CONFIG_YAML, changed, skipped, created);
    writeNewFile(root, ".autokit/tasks.yaml", DEFAULT_TASKS_YAML, changed, skipped, created);

    for (const file of assetFiles) {
      const relativeTarget = join(".agents", file);
      writeCopiedAsset(root, assetRoot, file, relativeTarget, changed, skipped, created);
    }

    for (const link of PROVIDER_LINKS) {
      createProviderLink(root, link.path, link.target, changed, skipped, created);
    }

    if (options.failDuringRollback === true) {
      created.push("__inject_rollback_failure__");
    }

    if (options.failAfterAssets === true) {
      throw new Error("injected init failure after assets");
    }

    for (const markerFile of MARKER_FILES) {
      appendMarker(root, markerFile, backupDir, backups, changed, skipped, created);
    }

    rmSync(backupDir, { recursive: true, force: true });
    removeEmptyDir(dirname(backupDir));
    return { dryRun: false, changed, skipped, backupDir: null, audit };
  } catch (error) {
    try {
      rollback(root, backups, created);
      appendInitAudit(root, "init_rollback", { backupDir: safeRelative(root, backupDir) });
      audit.push("init_rollback");
      rmSync(backupDir, { recursive: true, force: true });
      rmSync(join(root, INIT_AUDIT_LOG), { force: true });
      removeEmptyDir(dirname(backupDir));
      pruneEmptyDirs(join(root, ".autokit"));
    } catch (rollbackError) {
      appendInitAudit(root, "init_rollback_failed", {
        backupDir: safeRelative(root, backupDir),
        residue: listResidue(root),
      });
      audit.push("init_rollback_failed");
      throw new Error(
        `init rollback failed; backup retained at ${safeRelative(root, backupDir)}; residue=${listResidue(root).join(",")}; cause=${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw error;
  }
}

export function promptContractAssetNames(assetRoot = defaultAssetRoot()): string[] {
  const promptDir = join(assetRoot, "prompts");
  return readdirSync(promptDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .sort();
}

export function listInitResidue(cwd: string): string[] {
  return listResidue(realpathSync(cwd));
}

function defaultAssetRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets");
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    throw new Error(`${label} not found: ${path}`);
  }
}

function assertNoBackupResidue(root: string, force: boolean): void {
  const backupRoot = join(root, DEFAULT_CONFIG.init.backup_dir);
  if (!existsSync(backupRoot)) {
    return;
  }
  const entries = readdirSync(backupRoot).filter((entry) => !entry.startsWith("."));
  if (entries.length > 0 && !force) {
    throw new Error("existing init backup requires autokit init --force");
  }
}

function assertBackupBlacklist(root: string): void {
  for (const pattern of DEFAULT_CONFIG.init.backup_blacklist) {
    for (const candidate of expandSimpleGlob(root, pattern)) {
      if (existsSync(candidate)) {
        throw new Error(`backup blacklist conflict: ${pattern}`);
      }
    }
  }
}

function expandSimpleGlob(root: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    return [join(root, pattern)];
  }
  const prefix = pattern.slice(0, pattern.indexOf("*"));
  const parent = dirname(join(root, prefix));
  if (!existsSync(parent)) {
    return [];
  }
  const basePrefix = prefix.slice(prefix.lastIndexOf("/") + 1);
  return readdirSync(parent)
    .filter((entry) => entry.startsWith(basePrefix))
    .map((entry) => join(parent, entry));
}

function validateExistingProviderLinks(root: string): void {
  for (const link of PROVIDER_LINKS) {
    const targetPath = join(root, link.path);
    if (!pathExists(targetPath)) {
      continue;
    }
    const stat = lstatSync(targetPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`symlink_invalid: ${link.path}`);
    }
    let resolved: string;
    try {
      resolved = realpathSync(targetPath);
    } catch {
      throw new Error(`symlink_invalid: ${link.path}`);
    }
    if (!isInside(join(root, ".agents"), resolved)) {
      throw new Error(`symlink_invalid: ${link.path}`);
    }
  }
}

function validateMarkerTargets(root: string): void {
  for (const markerFile of MARKER_FILES) {
    const path = join(root, markerFile);
    if (pathExists(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`symlink_invalid: ${markerFile}`);
    }
  }
}

function validateWriteParents(root: string): void {
  const targets = [
    ".autokit/config.yaml",
    ".autokit/tasks.yaml",
    AUDIT_HMAC_KEY,
    INIT_AUDIT_LOG,
    ".autokit/.backup",
    ".autokit/.backup/staging",
    ".agents/skills",
    ".agents/agents",
    ".agents/prompts",
    ".claude/skills",
    ".codex/skills",
    ".claude/agents",
    ".codex/agents",
    ...MARKER_FILES,
  ];
  for (const target of targets) {
    assertNoSymlinkParent(root, target);
  }
}

function assertNoSymlinkParent(root: string, relativePath: string): void {
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (pathExists(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`symlink_invalid: ${relativePath}`);
    }
  }
}

function mkdirSafe(root: string, relativePath: string): void {
  assertNoSymlinkParent(root, `${relativePath}/child`);
  const target = join(root, relativePath);
  if (pathExists(target)) {
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) {
      throw new Error(`symlink_invalid: ${relativePath}`);
    }
    return;
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
}

function listAssetFiles(assetRoot: string): string[] {
  const files: string[] = [];
  const walk = (relativeDir: string) => {
    const absoluteDir = join(assetRoot, relativeDir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const child = join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  walk("");
  return files.sort();
}

function writeNewFile(
  root: string,
  relativePath: string,
  content: string,
  changed: string[],
  skipped: string[],
  created: string[],
): void {
  const target = join(root, relativePath);
  if (pathExists(target)) {
    skipped.push(relativePath);
    return;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, content, { mode: 0o600, flag: "wx" });
  changed.push(relativePath);
  created.push(relativePath);
}

function writeCopiedAsset(
  root: string,
  assetRoot: string,
  sourceRelative: string,
  targetRelative: string,
  changed: string[],
  skipped: string[],
  created: string[],
): void {
  const target = join(root, targetRelative);
  if (pathExists(target)) {
    skipped.push(targetRelative);
    return;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(join(assetRoot, sourceRelative), target, constants.COPYFILE_EXCL);
  changed.push(targetRelative);
  created.push(targetRelative);
}

function createProviderLink(
  root: string,
  relativePath: string,
  target: string,
  changed: string[],
  skipped: string[],
  created: string[],
): void {
  const path = join(root, relativePath);
  if (pathExists(path)) {
    skipped.push(relativePath);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  symlinkSync(target, path, "dir");
  changed.push(relativePath);
  created.push(relativePath);
}

function appendMarker(
  root: string,
  relativePath: string,
  backupDir: string,
  backups: BackupEntry[],
  changed: string[],
  skipped: string[],
  created: string[],
): void {
  const path = join(root, relativePath);
  const existing = pathExists(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(INIT_MARKER_START) && existing.includes(INIT_MARKER_END)) {
    skipped.push(relativePath);
    return;
  }
  if (pathExists(path)) {
    const backupPath = join(backupDir, relativePath);
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    copyFileSync(path, backupPath);
    backups.push({ relativePath, backupPath });
  } else {
    created.push(relativePath);
  }
  appendFileSync(
    path,
    `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${markerBlock()}`,
    {
      mode: 0o600,
    },
  );
  changed.push(relativePath);
}

function writeAuditHmacKey(root: string, changed: string[], created: string[]): void {
  const path = join(root, AUDIT_HMAC_KEY);
  if (pathExists(path)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, `${randomBytes(32).toString("hex")}\n`);
  } finally {
    closeSync(fd);
  }
  changed.push(AUDIT_HMAC_KEY);
  created.push(AUDIT_HMAC_KEY);
}

function appendInitAudit(
  root: string,
  kind: "init_rollback" | "init_rollback_failed",
  data: Record<string, unknown>,
): void {
  const path = join(root, INIT_AUDIT_LOG);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), kind, ...data })}\n`, {
    mode: 0o600,
  });
}

function markerBlock(): string {
  return `${INIT_MARKER_START}
Autokit manages .autokit runtime state and .agents assets in this repository.
Do not edit files inside the marker block by hand; update autokit assets instead.
${INIT_MARKER_END}
`;
}

function rollback(root: string, backups: BackupEntry[], created: string[]): void {
  for (const relativePath of [...created].reverse()) {
    if (relativePath === "__inject_rollback_failure__") {
      throw new Error("injected rollback failure");
    }
    rmSync(join(root, relativePath), { recursive: true, force: true });
  }
  for (const backup of backups.reverse()) {
    mkdirSync(dirname(join(root, backup.relativePath)), { recursive: true, mode: 0o700 });
    cpSync(backup.backupPath, join(root, backup.relativePath), { recursive: true, force: true });
  }
  pruneEmptyDirs(join(root, ".claude"));
  pruneEmptyDirs(join(root, ".codex"));
  pruneEmptyDirs(join(root, ".agents"));
  rmSync(join(root, INIT_AUDIT_LOG), { force: true });
  pruneEmptyDirs(join(root, ".autokit"));
}

function listResidue(root: string): string[] {
  const paths = [".autokit", ".agents", ".claude", ".codex", "AGENTS.md", "CLAUDE.md"];
  return paths.filter((entry) => pathExists(join(root, entry)));
}

function removeEmptyDir(path: string): void {
  try {
    if (pathExists(path) && lstatSync(path).isDirectory() && readdirSync(path).length === 0) {
      rmdirSync(path);
    }
  } catch {
    // Best-effort cleanup only; original failure remains the visible cause.
  }
}

function pruneEmptyDirs(path: string): void {
  if (!pathExists(path) || !lstatSync(path).isDirectory()) {
    return;
  }
  for (const entry of readdirSync(path)) {
    pruneEmptyDirs(join(path, entry));
  }
  removeEmptyDir(path);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function timestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z.-]/g, "-");
}

function relativePath(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel.startsWith("..") || rel.startsWith(sep)) {
    throw new Error(`symlink_invalid: ${path}`);
  }
  return rel;
}

function safeRelative(root: string, path: string): string {
  const rel = relative(root, path);
  return rel.startsWith("..") || rel.startsWith(sep) ? path : rel;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(realpathSync(parent), child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}
