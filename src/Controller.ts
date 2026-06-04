import type { Class, Program } from "oxc-parser";

/**
 * Simple wrapper holding the parsed program and controller AST node.
 */
export class Controller {
	constructor(
		public readonly program: Program,
		public readonly controller: Class,
	) {}
}
