import { findFilesRecursive } from "./findFilesRecursive";

export const findControllerFiles = (rootDir = "./src"): string[] => {
	return findFilesRecursive(rootDir, (filename: string) =>
		filename.endsWith(".controller.ts"),
	);
};
