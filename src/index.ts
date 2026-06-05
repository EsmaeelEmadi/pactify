import { readFileSync } from "node:fs";
import type { INestApplication, LoggerService } from "@nestjs/common";
import { type OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { parseSync } from "oxc-parser";
import { walk } from "oxc-walker";
import { addDtosToSwagger } from "./addDtosToSwagger";
import { checkIsController } from "./checkIsController";
import { HTTP_METHODS, logger } from "./constants";
import { extractDecoratorThrows } from "./extractDecoratorThrows";
import { extractMethodDtos } from "./extractMethodDtos";
import { extractParamDecoratorThrows } from "./extractParamDecoratorThrows";
import { findControllerFiles } from "./findControllerFiles";
import { getApiVersion } from "./getApiVersion";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: AST node type from oxc-parser
const parseControllerBasePath = (node: any) => {
  const firstDecorator = node.decorators[0];
  if (firstDecorator.expression.type === "CallExpression") {
    const argument = firstDecorator.expression.arguments?.find(
      (arg: { type: string; value?: string }) => arg.type === "Literal",
    );
    return argument?.value ?? "";
  }
  return "";
};

// ────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────

export interface PactifyOptions {
  /**
   * Override the logger. Defaults to `console`.
   * Pass a NestJS Logger instance for structured logging.
   */
  logger?: LoggerService | Console;
}

// ────────────────────────────────────────────────────────────
// pactify()
// ────────────────────────────────────────────────────────────

/**
 * AST-powered Swagger/OpenAPI auto-generation for NestJS controllers.
 *
 * Parses TypeScript controller source files at **build time** to
 * extract DTOs from return types, thrown exceptions, guard classes,
 * and validation pipes.  No manual `@ApiResponse()` decorators needed.
 *
 * @example
 * ```ts
 * import { pactify } from "pactify";
 *
 * const doc = await pactify(app, {
 *   openapi: {
 *     info: { title: "My API", version: "1.0" },
 *   },
 *   basePath: "/api",
 * });
 *
 * SwaggerModule.setup("openapi", app, doc);
 * ```
 *
 * @param app           The NestJS application instance.
 * @param config        A partial OpenAPIObject (must include `info`).
 * @param basePath      The version prefix, e.g. `"api"`.
 * @param opts          Optional configuration (logger override, etc.).
 * @returns             A complete OpenAPI document with auto-resolved paths.
 */
export const pactify = async (
  app: INestApplication,
  config: Omit<OpenAPIObject, "paths">,
  basePath: string,
  opts?: PactifyOptions,
): Promise<OpenAPIObject> => {
  // Apply logger override if provided
  if (opts?.logger) {
    logger.current = opts.logger;
  }

  const start = Date.now();
  logger.current.log?.("pactify: scanning controllers...");

  const allDtos = new Map<string, { className: string; filePath: string }>();
  const pathMethods: Array<{
    path: string;
    version: string | null;
    method: string;
    dtos: Array<{
      className: string;
      filePath: string;
      type: "return" | "throw";
      nestedDtos?: Array<{ className: string; filePath: string }>;
    }>;
  }> = [];

  const controllerFiles = findControllerFiles();

  logger.current.debug?.(`Found ${controllerFiles.length} controller file(s)`);

  for (const controllerPath of controllerFiles) {
    const controllerContent = readFileSync(controllerPath, "utf-8");
    const ast = parseSync(controllerPath, controllerContent);
    const program = ast.program;

    walk(program, {
      enter(node) {
        if (node.type === "ClassDeclaration" && node.id) {
          const isCtrl = checkIsController(node);
          if (!isCtrl) return;

          const controllerName = node.id.name;
          const controllerBasePath = parseControllerBasePath(node);

          logger.current.debug?.(
            `Found controller "${controllerName}" with base path "${controllerBasePath}"`,
          );

          walk(node.body, {
            enter(ctrlNode) {
              if (
                ctrlNode.type === "MethodDefinition" &&
                ctrlNode.decorators.length > 0 &&
                ctrlNode.value.type === "FunctionExpression"
              ) {
                let methodPath = "";
                let httpMethod = "";
                let version: string | null = null;

                const decoratorDtos: Array<{
                  className: string;
                  filePath: string;
                  type: "return" | "throw";
                  nestedDtos?: Array<{ className: string; filePath: string }>;
                }> = [];

                // ── Param decorator throws (e.g., @Body(ValidationPipe)) ──
                for (const param of ctrlNode.value.params) {
                  const decorators =
                    param.type === "Identifier"
                      ? param.decorators
                      : param.type === "AssignmentPattern" &&
                          param.left.type === "Identifier"
                        ? param.left.decorators
                        : null;

                  if (decorators) {
                    for (const paramDec of decorators) {
                      const paramThrows = extractParamDecoratorThrows(
                        paramDec,
                        controllerPath,
                      );

                      for (const dto of paramThrows) {
                        allDtos.set(dto.className, {
                          className: dto.className,
                          filePath: dto.filePath,
                        });

                        decoratorDtos.push({
                          ...dto,
                          type: "throw",
                          nestedDtos: undefined,
                        });
                      }
                    }
                  }
                }

                // ── Method decorators ──
                for (const dec of ctrlNode.decorators) {
                  if (
                    dec.expression.type === "CallExpression" &&
                    dec.expression.callee.type === "Identifier" &&
                    HTTP_METHODS.includes(dec.expression.callee.name)
                  ) {
                    version = getApiVersion(ctrlNode.decorators);
                    httpMethod = dec.expression.callee.name.toLowerCase();
                    methodPath =
                      (dec.expression.arguments.find(
                        (arg) => arg.type === "Literal",
                      )?.value as string) ?? "";
                  } else {
                    const decoratorThrows = extractDecoratorThrows(
                      dec,
                      controllerPath,
                    );

                    for (const dto of decoratorThrows) {
                      allDtos.set(dto.className, {
                        className: dto.className,
                        filePath: dto.filePath,
                      });

                      decoratorDtos.push({
                        ...dto,
                        type: "throw",
                        nestedDtos: undefined,
                      });
                    }
                  }
                }

                // ── Method body DTOs (return types + nested DTOs) ──
                let methodDtos = extractMethodDtos(ctrlNode, controllerPath);

                methodDtos = [...methodDtos, ...decoratorDtos];

                if (methodDtos.length > 0) {
                  for (const dto of methodDtos) {
                    allDtos.set(dto.className, {
                      className: dto.className,
                      filePath: dto.filePath,
                    });

                    if (dto.nestedDtos) {
                      for (const nested of dto.nestedDtos) {
                        allDtos.set(nested.className, {
                          className: nested.className,
                          filePath: nested.filePath,
                        });
                      }
                    }
                  }

                  const fullPath =
                    `/${controllerBasePath}/${methodPath}`.replace(/\/+/g, "/");
                  pathMethods.push({
                    version,
                    path: fullPath,
                    method: httpMethod,
                    dtos: methodDtos,
                  });
                }
              }
            },
          });
        }
      },
    });
  }

  logger.current.debug?.(`Found ${allDtos.size} unique DTO(s)`);

  // ── Import HTTP status DTOs from ts-exc for extraModels ──
  // Only load DTOs that pactify actually discovered in controller methods.
  // These are needed so $ref: "#/components/schemas/OkDto" resolves.
  const dtoClasses: Array<new (...args: Array<unknown>) => unknown> = [];
  try {
    const consumerRequire = require("module").createRequire(
      require("node:path").resolve(process.cwd(), "package.json"),
    );
    const tsExc = consumerRequire("@esmaeel_emadi/ts-exc");
    // Only add plain success DTOs (OkDto, CreatedDto, etc.) to extraModels.
    // Error DTOs (NotFoundDto, BadRequestDto, etc.) extend HttpException and
    // cause circular dependency conflicts with NestJS's own HttpException.
    // Success DTOs don't extend anything — they're safe.
    const httpExClass = (tsExc as Record<string, unknown>).HttpException;
    const httpExPrototype =
      typeof httpExClass === "function"
        ? (httpExClass as new (...a: unknown[]) => unknown).prototype
        : null;
    const added = new Set<string>();
    for (const [, info] of allDtos) {
      const cls = (tsExc as Record<string, unknown>)[info.className];
      if (
        typeof cls === "function" &&
        !added.has(info.className) &&
        // Skip error DTOs that extend HttpException
        !(
          httpExPrototype &&
          Object.prototype.isPrototypeOf.call(
            httpExPrototype,
            (cls as new (...a: unknown[]) => unknown).prototype,
          )
        )
      ) {
        added.add(info.className);
        dtoClasses.push(cls as new (...args: Array<unknown>) => unknown);
      }
    }
  } catch {
    logger.current.warn?.(
      "@esmaeel_emadi/ts-exc not found — install it for full Swagger schema support",
    );
  }

  // ── Create base Swagger document ──
  const doc = SwaggerModule.createDocument(app, config, {
    extraModels: dtoClasses,
  });

  // ── Filter to versioned paths only ──
  const filteredPaths: Record<string, unknown> = {};

  for (const [path, pathItem] of Object.entries(doc.paths)) {
    if (path.startsWith(`/${basePath}`)) {
      filteredPaths[path] = pathItem;
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: OpenAPI PathsObject type
  doc.paths = filteredPaths as any;

  // ── Add extracted DTOs to each path+method ──
  for (const methodInfo of pathMethods) {
    let methodPath = methodInfo.path.replace(/:([^/]+)/g, "{$1}");
    if (methodPath.endsWith("/")) {
      methodPath = methodPath.slice(0, -1);
    }

    addDtosToSwagger(
      doc,
      methodPath,
      methodInfo.method,
      methodInfo.dtos,
      basePath,
      methodInfo.version,
    );
  }

  logger.current.log?.(`pactify: done in ${Date.now() - start}ms`);

  return doc;
};

// ────────────────────────────────────────────────────────────
// Re-export sub-modules for advanced use
// ────────────────────────────────────────────────────────────
export { findControllerFiles } from "./findControllerFiles";
export { extractMethodDtos } from "./extractMethodDtos";
export { extractDecoratorThrows } from "./extractDecoratorThrows";
export { extractParamDecoratorThrows } from "./extractParamDecoratorThrows";
export { extractDtoStatusCode } from "./extractDtoStatusCode";
export { addDtosToSwagger } from "./addDtosToSwagger";
