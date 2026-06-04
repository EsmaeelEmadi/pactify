import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { parseController } from "./parseController";

export const createRawController = (filePath: string) => {
	const content = readFileSync(filePath, "utf-8");
	const ast = parseSync(filePath, content);
	const program = ast.program;
	const controller = parseController(program);

	if (controller) {
		return { program, controller };
	}

	return null;
};
