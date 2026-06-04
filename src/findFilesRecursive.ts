import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const findFilesRecursive = (
	dirPath: string,
	condition: (filename: string) => boolean,
): string[] => {
	const result: string[] = [];

	try {
		const walk = (currentPath: string) => {
			const entries = readdirSync(currentPath);

			for (const entry of entries) {
				const fullPath = join(currentPath, entry);
				const stats = statSync(fullPath);

				if (stats.isDirectory()) {
					walk(fullPath);
				} else if (condition(entry)) {
					result.push(fullPath);
				}
			}
		};

		walk(dirPath);
		return result;
	} catch (error) {
		throw new Error(`Error reading ${dirPath}: ${error}`);
	}
};
