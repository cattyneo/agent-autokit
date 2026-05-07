import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export type AssetBackupEntry = {
  relativePath: string;
  backupPath: string;
};

export type AssetWriteResult = "changed" | "skipped";

export type AssetsTransaction = {
  readonly repoRoot: string;
  readonly backupDir: string;
  readonly backups: readonly AssetBackupEntry[];
  readonly created: readonly string[];
  backupExisting(relativePath: string): boolean;
  writeFileIfAbsent(
    relativePath: string,
    content: string,
    options?: { mode?: number },
  ): AssetWriteResult;
  copyFileIfAbsent(sourcePath: string, targetRelativePath: string): AssetWriteResult;
  writeFileAtomic(relativePath: string, content: string, options?: { mode?: number }): "changed";
  copyFileAtomic(sourcePath: string, targetRelativePath: string): "changed";
  recordCreated(relativePath: string): void;
  rollback(options?: { beforeRemove?: (relativePath: string) => void }): void;
  cleanupBackup(): void;
};

export type ManifestEntry = {
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  sha256?: string;
  target?: string;
};

export type PruneBackupRetentionOptions = {
  retentionDays: number;
  now?: () => Date;
  hooks?: {
    remove?: (path: string) => void;
  };
};

export function createAssetsTransaction(options: {
  repoRoot: string;
  backupDir: string;
}): AssetsTransaction {
  const repoRoot = realpathSync(options.repoRoot);
  const backupDir = options.backupDir;
  const backups: AssetBackupEntry[] = [];
  const created: string[] = [];

  mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  return {
    repoRoot,
    backupDir,
    get backups() {
      return backups;
    },
    get created() {
      return created;
    },
    backupExisting(relativePath: string): boolean {
      const normalized = validateRelativePath(relativePath);
      const sourcePath = join(repoRoot, normalized);
      if (!pathExists(sourcePath)) {
        return false;
      }
      const backupPath = join(backupDir, normalized);
      mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
      cpSync(sourcePath, backupPath, { recursive: true, force: true, preserveTimestamps: true });
      backups.push({ relativePath: normalized.split(sep).join("/"), backupPath });
      return true;
    },
    writeFileIfAbsent(
      relativePath: string,
      content: string,
      options: { mode?: number } = {},
    ): AssetWriteResult {
      const normalized = validateRelativePath(relativePath);
      const targetPath = join(repoRoot, normalized);
      if (pathExists(targetPath)) {
        return "skipped";
      }
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      writeFileSync(targetPath, content, { mode: options.mode ?? 0o600, flag: "wx" });
      pushUnique(created, normalized.split(sep).join("/"));
      return "changed";
    },
    copyFileIfAbsent(sourcePath: string, targetRelativePath: string): AssetWriteResult {
      const normalized = validateRelativePath(targetRelativePath);
      const targetPath = join(repoRoot, normalized);
      if (pathExists(targetPath)) {
        return "skipped";
      }
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      copyFileSync(sourcePath, targetPath, constants.COPYFILE_EXCL);
      pushUnique(created, normalized.split(sep).join("/"));
      return "changed";
    },
    writeFileAtomic(
      relativePath: string,
      content: string,
      options: { mode?: number } = {},
    ): "changed" {
      const normalized = validateRelativePath(relativePath);
      const targetPath = join(repoRoot, normalized);
      prepareAtomicWrite(repoRoot, backupDir, backups, created, normalized);
      const tempPath = atomicTempPath(targetPath);
      try {
        writeFileSync(tempPath, content, { mode: options.mode ?? 0o600, flag: "wx" });
        renameSync(tempPath, targetPath);
      } catch (error) {
        rmSync(tempPath, { force: true });
        throw error;
      }
      return "changed";
    },
    copyFileAtomic(sourcePath: string, targetRelativePath: string): "changed" {
      const normalized = validateRelativePath(targetRelativePath);
      const targetPath = join(repoRoot, normalized);
      prepareAtomicWrite(repoRoot, backupDir, backups, created, normalized);
      const tempPath = atomicTempPath(targetPath);
      try {
        copyFileSync(sourcePath, tempPath, constants.COPYFILE_EXCL);
        renameSync(tempPath, targetPath);
      } catch (error) {
        rmSync(tempPath, { force: true });
        throw error;
      }
      return "changed";
    },
    recordCreated(relativePath: string): void {
      pushUnique(created, validateRelativePath(relativePath).split(sep).join("/"));
    },
    rollback(options: { beforeRemove?: (relativePath: string) => void } = {}): void {
      for (const relativePath of [...created].reverse()) {
        options.beforeRemove?.(relativePath);
        rmSync(join(repoRoot, relativePath), { recursive: true, force: true });
      }
      for (const backup of [...backups].reverse()) {
        const restorePath = join(repoRoot, backup.relativePath);
        mkdirSync(dirname(restorePath), { recursive: true, mode: 0o700 });
        cpSync(backup.backupPath, restorePath, {
          recursive: true,
          force: true,
          preserveTimestamps: true,
        });
      }
    },
    cleanupBackup(): void {
      rmSync(backupDir, { recursive: true, force: true });
    },
  };
}

export function repoBackupId(repoRoot: string): string {
  return createHash("sha256").update(realpathSync(repoRoot)).digest("hex").slice(0, 16);
}

export function timestampForBackup(value: string): string {
  return value.replace(/:/g, ".").replace(/[^0-9A-Za-z.-]/g, "-");
}

export function createPresetBackupDir(options: {
  repoRoot: string;
  timestamp: string;
  stateHome?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const stateHome =
    options.stateHome ?? options.env?.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const backupDir = join(
    stateHome,
    "autokit",
    "backup",
    repoBackupId(options.repoRoot),
    timestampForBackup(options.timestamp),
  );
  ensurePrivateDirectoryChain(backupDir, stateHome);
  return backupDir;
}

export function ensurePrivateDirectoryChain(targetDir: string, stopAt?: string): void {
  const normalizedTarget = normalize(targetDir);
  const normalizedStop = stopAt === undefined ? dirname(normalizedTarget) : normalize(stopAt);
  const rel = relative(normalizedStop, normalizedTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`backup directory must be inside ${normalizedStop}`);
  }

  mkdirSync(normalizedStop, { recursive: true, mode: 0o700 });
  let current = normalizedStop;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    mkdirSync(current, { recursive: true, mode: 0o700 });
    chmodSync(current, 0o700);
  }
}

export function pruneBackupRetention(
  backupRoot: string,
  options: PruneBackupRetentionOptions,
): void {
  if (!pathExists(backupRoot)) {
    return;
  }
  const backupRootStat = lstatSync(backupRoot);
  if (backupRootStat.isSymbolicLink() || !backupRootStat.isDirectory()) {
    throw new Error(`backup retention root must be a directory: ${backupRoot}`);
  }
  if (!Number.isInteger(options.retentionDays) || options.retentionDays <= 0) {
    throw new Error("retentionDays must be a positive integer");
  }
  const cutoffMs =
    (options.now?.() ?? new Date()).getTime() - options.retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(backupRoot)) {
    if (entry.startsWith(".")) {
      continue;
    }
    const entryPath = join(backupRoot, entry);
    if (lstatSync(entryPath).mtimeMs > cutoffMs) {
      continue;
    }
    try {
      options.hooks?.remove?.(entryPath) ?? rmSync(entryPath, { recursive: true, force: false });
    } catch (error) {
      throw new Error(
        `backup retention prune failed: ${entryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export function manifestDirectory(root: string): ManifestEntry[] {
  if (!pathExists(root)) {
    return [];
  }
  const base = realpathSync(root);
  const entries: ManifestEntry[] = [];

  const walk = (absolutePath: string) => {
    const stat = lstatSync(absolutePath);
    const rel = relative(base, absolutePath).split(sep).join("/");
    if (rel !== "") {
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        entries.push({ path: rel, type: "symlink", mode, target: readlinkSync(absolutePath) });
      } else if (stat.isDirectory()) {
        entries.push({ path: rel, type: "directory", mode });
      } else if (stat.isFile()) {
        entries.push({
          path: rel,
          type: "file",
          mode,
          sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
        });
      }
    }

    if (!stat.isDirectory()) {
      return;
    }
    for (const child of readdirSync(absolutePath).sort()) {
      walk(join(absolutePath, child));
    }
  };

  walk(base);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function validateRelativePath(relativePath: string): string {
  if (relativePath.includes("\0") || isAbsolute(relativePath)) {
    throw new Error(`invalid relative asset path: ${relativePath}`);
  }
  const normalized = normalize(relativePath);
  if (normalized === "." || normalized.startsWith("..") || isAbsolute(normalized)) {
    throw new Error(`invalid relative asset path: ${relativePath}`);
  }
  return normalized;
}

function prepareAtomicWrite(
  repoRoot: string,
  backupDir: string,
  backups: AssetBackupEntry[],
  created: string[],
  normalizedRelativePath: string,
): void {
  const normalizedPosix = normalizedRelativePath.split(sep).join("/");
  const targetPath = join(repoRoot, normalizedRelativePath);
  if (pathExists(targetPath)) {
    const targetWasCreatedInTransaction = created.includes(normalizedPosix);
    if (
      !targetWasCreatedInTransaction &&
      !backups.some((backup) => backup.relativePath === normalizedPosix)
    ) {
      const backupPath = join(backupDir, normalizedRelativePath);
      mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
      cpSync(targetPath, backupPath, { recursive: true, force: true, preserveTimestamps: true });
      backups.push({ relativePath: normalizedPosix, backupPath });
    }
  } else {
    pushUnique(created, normalizedPosix);
  }
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function atomicTempPath(targetPath: string): string {
  return join(
    dirname(targetPath),
    `.${createHash("sha256").update(`${targetPath}:${Date.now()}:${process.pid}`).digest("hex").slice(0, 16)}.autokit-tmp`,
  );
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
