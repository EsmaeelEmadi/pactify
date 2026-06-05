import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Decorator } from "oxc-parser";
import { parseSync } from "oxc-parser";
import { walk } from "oxc-walker";
import { match, P } from "ts-pattern";
import { resolveAliasPath } from "./pathResolver";

/**
 * Extract DTOs thrown inside PipeTransform.transform() methods
 * referenced by parameter decorators (e.g., @Body(ValidationPipe)).
 *
 * Walks the pipe's AST to find `throw new BadRequestDto()` statements.
 */
export const extractParamDecoratorThrows = (
  decorator: Decorator,
  sourceFilePath: string,
): Array<{ className: string; filePath: string }> => {
  const throws: Array<{ className: string; filePath: string }> = [];

  if (decorator.expression.type !== "CallExpression") {
    return throws;
  }

  for (const arg of decorator.expression.arguments) {
    if (arg.type !== "Identifier") {
      continue;
    }

    const argName = arg.name;
    const sourceContent = readFileSync(sourceFilePath, "utf-8");
    const ast = parseSync(sourceFilePath, sourceContent);

    let importPath: string | null = null;

    walk(ast.program, {
      enter(node) {
        if (
          node.type === "ImportDeclaration" &&
          node.specifiers.some(
            (s) =>
              s.type === "ImportSpecifier" &&
              s.imported.type === "Identifier" &&
              s.imported.name === argName,
          )
        ) {
          importPath = node.source.value;
        }
      },
    });

    if (!importPath) {
      continue;
    }

    const resolvedPath = resolveAliasPath(importPath, "");

    if (!resolvedPath) {
      throw new Error(`Unable to resolve import: ${importPath}`);
    }

    const classContent = readFileSync(resolvedPath, "utf-8");
    const classAst = parseSync(resolvedPath, classContent);

    const dtoImports = new Map<string, string>();
    walk(classAst.program, {
      enter(node) {
        if (node.type === "ImportDeclaration") {
          for (const spec of node.specifiers) {
            if (
              spec.type === "ImportSpecifier" &&
              spec.imported.type === "Identifier"
            ) {
              const resolved = resolveAliasPath(
                node.source.value,
                sourceFilePath,
              );
              if (resolved) {
                dtoImports.set(spec.imported.name, resolved);
              }
            }
          }
        }
      },
    });

    // Walk classes that implement PipeTransform
    walk(classAst.program, {
      enter(node) {
        if (node.type !== "ClassDeclaration" || !node.id) {
          return;
        }

        const isPipe = node.implements?.some(
          (impl) =>
            impl.expression.type === "Identifier" &&
            impl.expression.name === "PipeTransform",
        );

        if (!isPipe) {
          return;
        }

        // Walk the transform() method body for throw statements
        walk(node.body, {
          enter(methodNode) {
            if (
              methodNode.type === "MethodDefinition" &&
              methodNode.key.type === "Identifier" &&
              methodNode.key.name === "transform" &&
              methodNode.value.type === "FunctionExpression"
            ) {
              walk(methodNode.value.body!, {
                enter(throwNode) {
                  if (
                    throwNode.type === "ThrowStatement" &&
                    throwNode.argument?.type === "NewExpression" &&
                    throwNode.argument.callee.type === "Identifier"
                  ) {
                    const filePath = match(
                      dtoImports.get(throwNode.argument.callee.name),
                    )
                      .with(P.string, (value) => {
                        return value;
                      })
                      .otherwise(() => {
                        throw new Error("Could not resolve import");
                      });

                    throws.push({
                      className: throwNode.argument.callee.name,
                      filePath,
                    });
                  } else if (
                    throwNode.type === "ThrowStatement" &&
                    throwNode.argument?.type === "CallExpression" &&
                    throwNode.argument.callee.type === "MemberExpression" &&
                    throwNode.argument.callee.object.type === "NewExpression" &&
                    throwNode.argument.callee.object.callee.type ===
                      "Identifier"
                  ) {
                    const filePath = match(
                      dtoImports.get(
                        throwNode.argument.callee.object.callee.name,
                      ),
                    )
                      .with(P.string, (value) => {
                        return value;
                      })
                      .otherwise(() => {
                        throw new Error("Could not resolve import");
                      });
                    throws.push({
                      className: throwNode.argument.callee.object.callee.name,
                      filePath,
                    });
                  }
                },
              });
            }
          },
        });
      },
    });
  }

  return throws;
};
