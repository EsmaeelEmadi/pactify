import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Compute a SHA256 hash of a file's contents.
 * Used for cache invalidation — if the hash changes, the file changed.
 */
export const hashFile = (filePath: string): string => {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
};
