import type { Decorator } from "oxc-parser";

/**
 * Extract the API version string from a method's decorators.
 * Looks for `@Version("1")` and returns "1".
 */
export const getApiVersion = (decorators: Decorator[]): string | null => {
	for (const dec of decorators) {
		if (
			dec.expression.type === "CallExpression" &&
			dec.expression.callee.type === "Identifier" &&
			dec.expression.callee.name === "Version" &&
			dec.expression.arguments[0]?.type === "Literal"
		) {
			return dec.expression.arguments[0].value as string;
		}
	}
	return null;
};
