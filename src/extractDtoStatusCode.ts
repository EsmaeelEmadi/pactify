import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { walk } from "oxc-walker";

// ────────────────────────────────────────────────────────────
// Resolve an import path to an absolute file path.
// ────────────────────────────────────────────────────────────

const resolveImportPath = (
  importPath: string,
  sourceFilePath: string,
): string => {
  if (importPath.startsWith("~")) {
    const aliasPath = importPath.replace(/^~/, "src/");
    return resolve(
      process.cwd(),
      aliasPath.endsWith(".ts") ? aliasPath : `${aliasPath}.ts`,
    );
  }

  if (importPath.startsWith("src/")) {
    return resolve(
      process.cwd(),
      importPath.endsWith(".ts") ? importPath : `${importPath}.ts`,
    );
  }

  return resolve(
    dirname(sourceFilePath),
    importPath.endsWith(".ts") ? importPath : `${importPath}.ts`,
  );
};

// ────────────────────────────────────────────────────────────
// Extract the HTTP status code from a DTO class by walking its
// AST and its base class chain to find a `statusCode` property.
// ────────────────────────────────────────────────────────────

export const extractDtoStatusCode = (
  dtoFilePath: string,
  dtoClassName: string,
  visited = new Set<string>(),
): number | null => {
  const key = `${dtoFilePath}:${dtoClassName}`;

  if (visited.has(key)) {
    return null;
  }
  visited.add(key);

  try {
    const content = readFileSync(dtoFilePath, "utf-8");
    const ast = parseSync(dtoFilePath, content);

    let statusCode: number | null = null;
    let baseClassName: string | null = null;
    let baseClassFile: string | null = null;

    walk(ast.program, {
      enter(node) {
        if (
          node.type === "ClassDeclaration" &&
          node.id?.name === dtoClassName
        ) {
          if (node.superClass?.type === "Identifier") {
            baseClassName = node.superClass.name;
          }

          walk(node.body, {
            enter(member) {
              if (
                member.type === "PropertyDefinition" &&
                member.key.type === "Identifier" &&
                member.key.name === "statusCode"
              ) {
                // @ts-expect-error AST node type narrowing for NumericLiteral
                if (member.value?.type === "NumericLiteral") {
                  // @ts-expect-error AST node type narrowing
                  statusCode = member.value.value;
                }
              }
            },
          });
        }
      },
    });

    if (statusCode !== null) {
      return statusCode;
    }

    // Recurse into the base class
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
                baseClassFile = resolveImportPath(
                  importNode.source.value,
                  dtoFilePath,
                );
              }
            }
          }
        },
      });

      if (baseClassFile) {
        return extractDtoStatusCode(baseClassFile, baseClassName, visited);
      }
    }

    return null;
  } catch (e) {
    console.error(`Error extracting status code from ${dtoClassName}:`, e);
    return null;
  }
};
