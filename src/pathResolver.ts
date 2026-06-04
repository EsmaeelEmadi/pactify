import { dirname } from "node:path";
import {
	findConfigFile,
	parseJsonConfigFileContent,
	readConfigFile,
	resolveModuleName,
	sys,
} from "typescript";

// ────────────────────────────────────────────────────────────
// Resolve a TypeScript module specifier using the project's
// tsconfig.json paths/aliases.
// ────────────────────────────────────────────────────────────

const configPath = findConfigFile(
	process.cwd(),
	sys.fileExists,
	"tsconfig.json",
);

if (!configPath) {
	throw new Error("tsconfig.json not found in the project root");
}

const configFile = readConfigFile(configPath, sys.readFile);
if (!configFile) {
	throw new Error("Could not read tsconfig.json");
}

const parsed = parseJsonConfigFileContent(
	configFile.config,
	sys,
	dirname(configPath),
);

export function resolveAliasPath(
	specifier: string,
	containingFile: string,
): string | undefined {
	const result = resolveModuleName(
		specifier,
		containingFile,
		parsed.options,
		sys,
	);
	return result.resolvedModule?.resolvedFileName;
}
