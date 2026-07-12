import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface CachedMethod {
  path: string;
  version: string | null;
  method: string;
  dtos: Array<{
    className: string;
    filePath: string;
    type: "return" | "throw";
    nestedDtos?: Array<{ className: string; filePath: string }>;
  }>;
}

export interface CachedControllerData {
  controllerName: string;
  controllerBasePath: string;
  pathMethods: CachedMethod[];
  dtos: Array<{ className: string; filePath: string }>;
}

export interface PactifyCacheEntry {
  hash: string;
  data: CachedControllerData;
}

interface PactifyCacheFile {
  version: 1;
  entries: Record<string, PactifyCacheEntry>;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const CACHE_FILENAME = "pactify-cache.json";
const CACHE_VERSION = 1;

/**
 * Resolve the cache directory path.
 */
const resolveCacheDir = (cacheDir: string): string => {
  return resolve(process.cwd(), cacheDir);
};

/**
 * Get a relative (to cwd) cache key for a controller file.
 */
const getCacheKey = (filePath: string): string => {
  return relative(process.cwd(), filePath);
};

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Load the pactify cache from disk. Returns empty entries if no cache exists.
 */
export const loadCache = (
  cacheDir: string,
): Record<string, PactifyCacheEntry> => {
  const dir = resolveCacheDir(cacheDir);
  const cachePath = join(dir, CACHE_FILENAME);

  if (!existsSync(cachePath)) {
    return {};
  }

  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as PactifyCacheFile;

    if (parsed.version !== CACHE_VERSION) {
      // Version mismatch — invalidate entire cache
      return {};
    }

    return parsed.entries ?? {};
  } catch {
    // Corrupt cache — start fresh
    return {};
  }
};

/**
 * Save the pactify cache to disk. Creates the cache directory if needed.
 * Removes stale entries (files that no longer exist as keys that weren't in
 * the current set of controller files).
 */
export const saveCache = (
  cacheDir: string,
  entries: Record<string, PactifyCacheEntry>,
  currentFiles: string[],
): void => {
  const dir = resolveCacheDir(cacheDir);

  // Create cache directory if it doesn't exist
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Remove stale entries (controllers that no longer exist)
  const currentKeys = new Set(currentFiles.map(getCacheKey));
  for (const key of Object.keys(entries)) {
    if (!currentKeys.has(key)) {
      delete entries[key];
    }
  }

  const cacheFile: PactifyCacheFile = {
    version: CACHE_VERSION,
    entries,
  };

  writeFileSync(
    join(dir, CACHE_FILENAME),
    JSON.stringify(cacheFile, null, 2),
    "utf-8",
  );
};

/**
 * Delete the cache file entirely.
 */
export const clearCache = (cacheDir: string): void => {
  const dir = resolveCacheDir(cacheDir);
  const cachePath = join(dir, CACHE_FILENAME);

  if (existsSync(cachePath)) {
    unlinkSync(cachePath);
  }
};
