import type { Class, Program } from "oxc-parser";
import { walk } from "oxc-walker";
import { checkIsController } from "./checkIsController";
import { logger } from "./constants";

/**
 * Find and return the first @Controller() class declaration in a parsed program.
 */
export const parseController = (program: Program): Class | undefined => {
	let result: Class | undefined;

	walk(program, {
		enter(node) {
			if (node.type === "ClassDeclaration" && node.id) {
				if (checkIsController(node)) {
					logger.current.debug?.(`found controller ${node.id.name}`);
					result = node;
				}
			}
		},
	});

	return result;
};
