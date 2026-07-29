import { readFileSync } from "node:fs";
import type { MethodDefinition } from "oxc-parser";
import { parseSync } from "oxc-parser";
import { walk } from "oxc-walker";
import { resolveAliasPath } from "./pathResolver";

// ────────────────────────────────────────────────────────────
// Resolve a module import path to an absolute file path.
// Uses TypeScript's module resolution for all import types.
// ────────────────────────────────────────────────────────────

const resolveImportPath = (
  importPath: string,
  sourceFilePath: string,
): string | null => {
  // Use TypeScript's module resolution for everything
  const resolved = resolveAliasPath(importPath, sourceFilePath);
  return resolved ?? null;
};

// ────────────────────────────────────────────────────────────
// Internal: walk a method body AST and collect DTOs from
// return statements, throw statements, and service method calls.
// ────────────────────────────────────────────────────────────

const analyzeMethodForDtos = (
  // biome-ignore lint/suspicious/noExplicitAny: AST node shapes vary
  methodBody: any,
  sourceFilePath: string,
  visitedMethods: Set<string>,
  dtos: Array<{
    className: string;
    filePath: string;
    type: "return" | "throw";
    nestedDtos?: string[];
  }>,
  dtoImportsCache: Map<string, Map<string, string>>,
) => {
  walk(methodBody, {
    enter(node) {
      // Arrow function expression returns (e.g., `r => new OkDto(new UserDto(r))`)
      if (node.type === "ArrowFunctionExpression" && node.expression === true) {
        const nestedDtos: string[] = [];

	        // @ts-expect-error AST node type narrowing (arrow expression body)
	        if (Array.isArray(node.body?.arguments)) {
	          // @ts-expect-error AST node type narrowing
	          for (const arg of node.body.arguments) {
	            if (
	              arg.type === "NewExpression" &&
	              arg.callee.type === "Identifier" &&
	              arg.callee.name.endsWith("Dto")
	            ) {
	              nestedDtos.push(arg.callee.name);
	            }
	            // Extract DTOs from array arguments
	            if (arg.type === "ArrayExpression") {
	              for (const elem of arg.elements) {
	                if (
	                  elem?.type === "NewExpression" &&
	                  elem.callee?.type === "Identifier" &&
	                  elem.callee.name.endsWith("Dto")
	                ) {
	                  nestedDtos.push("[]" + elem.callee.name);
	                }
	              }
	            }
	            // Extract DTOs from array method calls with inline callbacks
	            if (
	              arg.type === "CallExpression" &&
	              arg.callee?.type === "MemberExpression" &&
	              arg.callee.property?.type === "Identifier"
	            ) {
	              const methodName = arg.callee.property.name;
	              if (
	                ["map", "filter", "forEach", "find", "flatMap"].includes(methodName) &&
	                arg.arguments.length > 0 &&
	                (arg.arguments[0].type === "ArrowFunctionExpression" ||
	                  arg.arguments[0].type === "FunctionExpression")
	              ) {
	                const cb = arg.arguments[0];
	                
	                if (cb.body) {
	                  walk(cb.body, {
	                    enter(cbNode) {
	                      if (
	                        cbNode.type === "NewExpression" &&
	                        cbNode.callee?.type === "Identifier" &&
	                        cbNode.callee.name.endsWith("Dto")
	                      ) {
	                        nestedDtos.push("[]" + cbNode.callee.name);
	                      }
	                    },
	                  });
	                }
	              }
	            }
	          }
	        }

        if (!dtoImportsCache.has(sourceFilePath)) {
          const fileImports = new Map<string, string>();
          try {
            const content = readFileSync(sourceFilePath, "utf-8");
            const ast = parseSync(sourceFilePath, content);
            walk(ast.program, {
              enter(importNode) {
                if (importNode.type === "ImportDeclaration") {
                  for (const spec of importNode.specifiers) {
                    if (
                      spec.type === "ImportSpecifier" &&
                      spec.imported.type === "Identifier"
                    ) {
                      const importPath = resolveImportPath(
                        importNode.source.value,
                        sourceFilePath,
                      );
                      if (importPath) {
                        fileImports.set(spec.imported.name, importPath);
                      }
                    }
                  }
                }
              },
            });
          } catch (e) {
            console.error(e);
          }
          dtoImportsCache.set(sourceFilePath, fileImports);
        }

        const fileImports = dtoImportsCache.get(sourceFilePath)!;
        const resolvedPath =
          // @ts-expect-error AST node type narrowing (arrow expression callee)
          fileImports.get(node.body?.callee?.name ?? "") || sourceFilePath;

        // @ts-expect-error AST node type narrowing
        if (node.body?.callee?.name) {
          dtos.push({
            // @ts-expect-error AST node type narrowing
            className: node.body.callee.name,
            filePath: resolvedPath,
            type: "return",
            nestedDtos: nestedDtos.length > 0 ? nestedDtos : undefined,
          });
        }
      }

	      // Return / Throw statements with `new XxxDto()`
	      if (
	        (node.type === "ReturnStatement" || node.type === "ThrowStatement") &&
	        node.argument?.type === "NewExpression" &&
	        node.argument.callee.type === "Identifier" &&
	        node.argument.callee.name.endsWith("Dto")
	      ) {
	        const nestedDtos: string[] = [];

	        for (const arg of node.argument.arguments) {
	          if (
	            arg.type === "NewExpression" &&
	            arg.callee.type === "Identifier" &&
	            arg.callee.name.endsWith("Dto")
	          ) {
	            nestedDtos.push(arg.callee.name);
	          }
	          // Extract DTOs from array arguments — e.g. new OkDto([new XDto(a), new XDto(b)])
	          if (arg.type === "ArrayExpression") {
	            for (const elem of arg.elements) {
	              if (
	                elem?.type === "NewExpression" &&
	                elem.callee?.type === "Identifier" &&
	                elem.callee.name.endsWith("Dto")
	              ) {
	                nestedDtos.push("[]" + elem.callee.name);
	              }
	            }
	          }
	          // Extract DTOs from array method calls with inline callbacks
	          // e.g. new OkDto(tenants.map((t) => new TenantDto(t)))
	          if (
	            arg.type === "CallExpression" &&
	            arg.callee?.type === "MemberExpression" &&
	            arg.callee.property?.type === "Identifier"
	          ) {
	            const methodName = arg.callee.property.name;
	            if (
	              ["map", "filter", "forEach", "find", "flatMap"].includes(methodName) &&
	              arg.arguments.length > 0 &&
	              (arg.arguments[0].type === "ArrowFunctionExpression" ||
	                arg.arguments[0].type === "FunctionExpression")
	            ) {
	              const cb = arg.arguments[0];
	              
	              if (cb.body) {
	                walk(cb.body, {
	                  enter(cbNode) {
	                    if (
	                      cbNode.type === "NewExpression" &&
	                      cbNode.callee?.type === "Identifier" &&
	                      cbNode.callee.name.endsWith("Dto")
	                    ) {
	                      nestedDtos.push("[]" + cbNode.callee.name);
	                    }
	                  },
	                });
	              }
	            }
	          }
	        }

        if (!dtoImportsCache.has(sourceFilePath)) {
          const fileImports = new Map<string, string>();
          try {
            const content = readFileSync(sourceFilePath, "utf-8");
            const ast = parseSync(sourceFilePath, content);
            walk(ast.program, {
              enter(importNode) {
                if (importNode.type === "ImportDeclaration") {
                  for (const spec of importNode.specifiers) {
                    if (
                      spec.type === "ImportSpecifier" &&
                      spec.imported.type === "Identifier"
                    ) {
                      const importPath = resolveImportPath(
                        importNode.source.value,
                        sourceFilePath,
                      );
                      if (importPath) {
                        fileImports.set(spec.imported.name, importPath);
                      }
                    }
                  }
                }
              },
            });
          } catch (e) {
            console.error(e);
          }
          dtoImportsCache.set(sourceFilePath, fileImports);
        }

        const fileImports = dtoImportsCache.get(sourceFilePath)!;
        const resolvedPath =
          fileImports.get(node.argument.callee.name) || sourceFilePath;

        dtos.push({
          className: node.argument.callee.name,
          filePath: resolvedPath,
          type: node.type === "ReturnStatement" ? "return" : "throw",
          nestedDtos: nestedDtos.length > 0 ? nestedDtos : undefined,
        });
      }

      // Method calls — trace into the called method's body recursively
      if (node.type === "CallExpression" || node.type === "AwaitExpression") {
        const callExpr = node.type === "AwaitExpression" ? node.argument : node;
        if (callExpr?.type !== "CallExpression") {
          return;
        }

        let functionName: string | null = null;
        let serviceProp: string | null = null;
        let isSuperCall = false;

        if (callExpr.callee.type === "Identifier") {
          functionName = callExpr.callee.name;
        } else if (
          callExpr.callee.type === "MemberExpression" &&
          callExpr.callee.property.type === "Identifier"
        ) {
          functionName = callExpr.callee.property.name;

          if (callExpr.callee.object.type === "Super") {
            isSuperCall = true;
          } else if (
            callExpr.callee.object.type === "MemberExpression" &&
            callExpr.callee.object.object.type === "Super"
          ) {
            isSuperCall = true;
          } else if (
            callExpr.callee.object.type === "MemberExpression" &&
            callExpr.callee.object.object.type === "ThisExpression" &&
            callExpr.callee.object.property.type === "Identifier"
          ) {
            serviceProp = callExpr.callee.object.property.name;
          }
        }

	        if (!functionName) {
	          return;
	        }

	        // ── Array methods with inline callbacks (map, filter, etc.) ──
	        // Trace into the callback to extract nested DTOs.
	        // e.g. tenants.map((t) => new TenantDto(t))
	        const ARRAY_METHODS = ["map", "filter", "forEach", "find", "flatMap"];
	        if (
	          ARRAY_METHODS.includes(functionName) &&
	          callExpr.arguments.length > 0 &&
	          (callExpr.arguments[0].type === "ArrowFunctionExpression" ||
	            callExpr.arguments[0].type === "FunctionExpression")
	        ) {
	          const cb = callExpr.arguments[0];
	          if (cb.body) {
	            walk(cb.body, {
	            enter(cbNode) {
	              if (
	                cbNode.type === "NewExpression" &&
	                cbNode.callee?.type === "Identifier" &&
	                cbNode.callee.name.endsWith("Dto")
	              ) {
	                dtos.push({
	                  className: cbNode.callee.name,
	                  filePath: sourceFilePath,
	                  type: "return",
	                });
	              }
	            },
	          });
	          }
	        }

	        let targetFile = sourceFilePath;

        // ── Resolve super.method() calls to the base class ──
        if (isSuperCall) {
          try {
            const sourceContent = readFileSync(sourceFilePath, "utf-8");
            const ast = parseSync(sourceFilePath, sourceContent);
            let baseClassName: string | null = null;

            walk(ast.program, {
              enter(clsNode) {
                if (
                  clsNode.type === "ClassDeclaration" &&
                  clsNode.superClass?.type === "Identifier"
                ) {
                  baseClassName = clsNode.superClass.name;
                }
              },
            });

            if (baseClassName) {
              walk(ast.program, {
                enter(importNode) {
                  if (importNode.type === "ImportDeclaration") {
                    for (const spec of importNode.specifiers) {
                      if (
                        spec.type === "ImportSpecifier" &&
                        spec.imported.type === "Identifier" &&
                        spec.imported.name === baseClassName
                      ) {
                        const importPath = resolveImportPath(
                          importNode.source.value,
                          sourceFilePath,
                        );
                        if (importPath) {
                          targetFile = importPath;
                        }
                      }
                    }
                  }
                },
              });
            }
          } catch (e) {
            console.error(e);
            return;
          }
        }
        // ── Resolve this.service.method() calls to the service class ──
        else if (serviceProp) {
          try {
            const sourceContent = readFileSync(sourceFilePath, "utf-8");
            const ast = parseSync(sourceFilePath, sourceContent);
            let serviceClassName: string | null = null;

            walk(ast.program, {
              enter(clsNode) {
                if (clsNode.type === "ClassDeclaration") {
                  walk(clsNode.body, {
                    enter(member) {
                      if (
                        member.type === "MethodDefinition" &&
                        member.kind === "constructor" &&
                        member.value.type === "FunctionExpression"
                      ) {
                        for (const param of member.value.params) {
                          if (param.type === "TSParameterProperty") {
                            // biome-ignore lint/suspicious/noExplicitAny: oxc-parser type narrowing
                            const p = param.parameter as any;
                            if (
                              p.type === "Identifier" &&
                              p.name === serviceProp &&
                              p.typeAnnotation?.type === "TSTypeAnnotation" &&
                              p.typeAnnotation.typeAnnotation?.type ===
                                "TSTypeReference"
                            ) {
                              serviceClassName =
                                p.typeAnnotation.typeAnnotation.typeName.name;
                            }
                          }
                        }
                      }
                    },
                  });
                }
              },
            });

            if (serviceClassName) {
              walk(ast.program, {
                enter(importNode) {
                  if (importNode.type === "ImportDeclaration") {
                    for (const spec of importNode.specifiers) {
                      if (
                        spec.type === "ImportSpecifier" &&
                        spec.imported.type === "Identifier" &&
                        spec.imported.name === serviceClassName
                      ) {
                        const importPath = resolveImportPath(
                          importNode.source.value,
                          sourceFilePath,
                        );
                        if (importPath) {
                          targetFile = importPath;
                        }
                      }
                    }
                  }
                },
              });
            }
          } catch (e) {
            console.error(e);
            return;
          }
        }

        const callKey = `${targetFile}:${functionName}`;
        if (visitedMethods.has(callKey)) {
          return;
        }
        visitedMethods.add(callKey);

        // ── Open the target file and find the method body ──
        try {
          const targetContent = readFileSync(targetFile, "utf-8");
          const targetAst = parseSync(targetFile, targetContent);

          walk(targetAst.program, {
            enter(topNode) {
              // Variable declaration: `const fn = () => { ... }`
              if (topNode.type === "VariableDeclaration") {
                for (const decl of topNode.declarations) {
                  if (
                    decl.id.type === "Identifier" &&
                    decl.id.name === functionName
                  ) {
                    if (
                      decl.init?.type === "ArrowFunctionExpression" ||
                      decl.init?.type === "FunctionExpression"
                    ) {
                      const body =
                        decl.init.body!.type === "BlockStatement"
                          ? decl.init.body!
                          : decl.init.body!;
                      analyzeMethodForDtos(
                        body,
                        targetFile,
                        visitedMethods,
                        dtos,
                        dtoImportsCache,
                      );
                    }
                  }
                }
              }
              // Function declaration: `function fn() { ... }`
              else if (
                topNode.type === "FunctionDeclaration" &&
                topNode.id?.name === functionName
              ) {
                if (topNode.body) {
                  analyzeMethodForDtos(
                    topNode.body,
                    targetFile,
                    visitedMethods,
                    dtos,
                    dtoImportsCache,
                  );
                }
              }
              // Class method
              else if (topNode.type === "ClassDeclaration") {
                let methodFound = false;
                walk(topNode.body, {
                  enter(methodNode) {
                    if (
                      methodNode.type === "MethodDefinition" &&
                      methodNode.key.type === "Identifier" &&
                      methodNode.key.name === functionName &&
                      methodNode.value.type === "FunctionExpression"
                    ) {
                      methodFound = true;
                      analyzeMethodForDtos(
                        methodNode.value.body,
                        targetFile,
                        visitedMethods,
                        dtos,
                        dtoImportsCache,
                      );
                    }
                  },
                });

                // If not found, try the base class
                if (!methodFound && topNode.superClass?.type === "Identifier") {
                  const baseClassName = topNode.superClass.name;
                  let baseClassFile: string | null = null;

                  walk(targetAst.program, {
                    enter(importNode) {
                      if (importNode.type === "ImportDeclaration") {
                        for (const spec of importNode.specifiers) {
                          if (
                            spec.type === "ImportSpecifier" &&
                            spec.imported.type === "Identifier" &&
                            spec.imported.name === baseClassName
                          ) {
                            const importPath = resolveImportPath(
                              importNode.source.value,
                              targetFile,
                            );
                            if (importPath) {
                              baseClassFile = importPath;
                            }
                          }
                        }
                      }
                    },
                  });

                  if (baseClassFile) {
                    const baseCallKey = `${baseClassFile}:${functionName}`;
                    if (!visitedMethods.has(baseCallKey)) {
                      visitedMethods.add(baseCallKey);
                      try {
                        const baseContent = readFileSync(
                          baseClassFile,
                          "utf-8",
                        );
                        const baseAst = parseSync(baseClassFile, baseContent);

                        walk(baseAst.program, {
                          enter(baseNode) {
                            if (baseNode.type === "ClassDeclaration") {
                              walk(baseNode.body, {
                                enter(baseMethod) {
                                  if (
                                    baseMethod.type === "MethodDefinition" &&
                                    baseMethod.key.type === "Identifier" &&
                                    baseMethod.key.name === functionName &&
                                    baseMethod.value.type ===
                                      "FunctionExpression"
                                  ) {
                                    analyzeMethodForDtos(
                                      baseMethod.value.body,
                                      baseClassFile!,
                                      visitedMethods,
                                      dtos,
                                      dtoImportsCache,
                                    );
                                  }
                                },
                              });
                            }
                          },
                        });
                      } catch (e) {
                        console.error(e);
                      }
                    }
                  }
                }
              }
            },
          });
        } catch (e) {
          console.error(e);
          return;
        }
      }
    },
  });
};

// ────────────────────────────────────────────────────────────
// Public: extract DTOs from a controller method definition.
//
// Walks the method's AST to find:
//   1. Direct `return new XxxDto(...)` and `throw new XxxDto()`
//   2. Arrow expression returns (`r => new OkDto(...)`)
//   3. Recursive tracing into service method calls
// ────────────────────────────────────────────────────────────

export const extractMethodDtos = (
  method: MethodDefinition,
  sourceFilePath: string,
): Array<{
  className: string;
  filePath: string;
  type: "return" | "throw";
  nestedDtos?: Array<{ className: string; filePath: string }>;
}> => {
  const dtos: Array<{
    className: string;
    filePath: string;
    type: "return" | "throw";
    nestedDtos?: string[];
  }> = [];

  if (method.value.type !== "FunctionExpression") {
    return dtos as Array<{
      className: string;
      filePath: string;
      type: "return" | "throw";
      nestedDtos?: Array<{ className: string; filePath: string }>;
    }>;
  }

  const sourceContent = readFileSync(sourceFilePath, "utf-8");
  const sourceAst = parseSync(sourceFilePath, sourceContent);
  const dtoImports = new Map<string, string>();

  walk(sourceAst.program, {
    enter(node) {
      if (node.type === "ImportDeclaration") {
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier"
          ) {
            const importPath = resolveImportPath(
              node.source.value,
              sourceFilePath,
            );
            if (importPath) {
              dtoImports.set(spec.imported.name, importPath);
            }
          }
        }
      }
    },
  });

  const visitedMethods = new Set<string>();
  const dtoImportsCache = new Map<string, Map<string, string>>();
  dtoImportsCache.set(sourceFilePath, dtoImports);

  analyzeMethodForDtos(
    method.value.body,
    sourceFilePath,
    visitedMethods,
    dtos,
    dtoImportsCache,
  );

  	// Transform nestedDtos from string[] to resolved objects with file paths
  	for (const dto of dtos) {
  		if (
  			dto.nestedDtos &&
  			dto.nestedDtos.length > 0 &&
  			typeof dto.nestedDtos[0] === "string"
  		) {
  			const rawNested = dto.nestedDtos as unknown as string[];
  			const resolved = rawNested
  				.map((name: string) => {
  					// Strip "[]" prefix (marks array-extracted DTOs) before import lookup
  					const lookupName = name.startsWith("[]") ? name.slice(2) : name;
  					const fp = dtoImports.get(lookupName);
  					// Preserve the prefix in the result so addDtosToSwagger can detect it
  					return fp ? { className: name, filePath: fp } : null;
        })
        .filter(
          (x): x is { className: string; filePath: string } => x !== null,
        );
      (dto as Record<string, unknown>).nestedDtos =
        resolved.length > 0 ? resolved : undefined;
    }
  }

  return dtos as Array<{
    className: string;
    filePath: string;
    type: "return" | "throw";
    nestedDtos?: Array<{ className: string; filePath: string }>;
  }>;
};
