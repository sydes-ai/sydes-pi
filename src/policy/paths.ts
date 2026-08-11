import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

export function canonicalRepoRelativePath(repoRoot: string, rawPath: string | undefined): string | undefined {
  if (!rawPath) {
    return undefined;
  }

  const root = safeRealpath(resolve(repoRoot));
  const cleaned = rawPath.replace(/^\.\/+/, "");
  const absolute = safeRealpath(cleaned.startsWith("/") ? resolve(cleaned) : resolve(root, cleaned));
  const direct = toRepoRelative(root, absolute);
  if (direct && existsSync(absolute)) {
    return direct;
  }
  if (cleaned.startsWith("/") || rawPath.startsWith(root)) {
    return direct;
  }

  if (!cleaned.startsWith("/")) {
    const suffixMatch = findUniqueRepoSuffix(root, cleaned);
    if (suffixMatch) {
      return suffixMatch;
    }
    if (direct) {
      return direct;
    }
  }

  return direct;
}

export function normalizeRepoPathList(repoRoot: string, paths: Array<string | undefined>): string[] {
  return unique(paths.map((path) => canonicalRepoRelativePath(repoRoot, path)).filter(isString));
}

function toRepoRelative(repoRoot: string, absolutePath: string): string | undefined {
  const rel = relative(repoRoot, absolutePath).split(/[\\/]+/).join("/");
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) {
    return undefined;
  }
  return rel;
}

function findUniqueRepoSuffix(repoRoot: string, rawPath: string): string | undefined {
  const suffix = rawPath.split(/[\\/]+/).filter(Boolean).join("/");
  if (!suffix) {
    return undefined;
  }
  const candidates = listRepoFiles(repoRoot).filter((file) => file === suffix || file.endsWith(`/${suffix}`));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function listRepoFiles(repoRoot: string): string[] {
  try {
    return execFileSync("git", ["ls-files"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 2_000_000
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
