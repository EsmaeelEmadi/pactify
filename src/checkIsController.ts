import type { Class, Decorator } from "oxc-parser";

/**
 * Check whether a Class AST node is decorated with @Controller().
 */
export const checkIsController = (node: Class): boolean => {
	const validator = (decorator: Decorator) =>
		decorator.expression.type === "CallExpression" &&
		decorator.expression.callee.type === "Identifier" &&
		decorator.expression.callee.name === "Controller";

	return node.decorators.some(validator);
};
