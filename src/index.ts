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

  // ── Import HTTP status DTOs from ts-exc ──
  // Success DTOs (OkDto, CreatedDto, etc.) go to extraModels.
  // Error DTOs (NotFoundDto, BadRequestDto, etc.) extend HttpException and
  // cause circular dependency conflicts with NestJS Swagger's schema factory
  // — their schemas are registered manually after createDocument().
  const dtoClasses: Array<new (...args: Array<unknown>) => unknown> = [];
  let tsExc: Record<string, unknown> | null = null;

  // Create a require function that resolves from the consumer project
  const consumerRequire = require("module").createRequire(
    require("node:path").resolve(process.cwd(), "package.json"),
  );

  try {
    tsExc = consumerRequire("@wrk-t/ts-exc") as Record<string, unknown>;
  } catch {
    logger.current.warn?.(
      "@wrk-t/ts-exc not found — install it for full Swagger schema support",
    );
  }

  const added = new Set<string>();

  // ── Resolve from ts-exc first (wrapper DTOs + error DTOs) ──
  if (tsExc) {
    const httpExClass = tsExc.HttpException;
    const httpExPrototype =
      typeof httpExClass === "function"
        ? (httpExClass as new (...a: unknown[]) => unknown).prototype
        : null;
    for (const [, info] of allDtos) {
      const cls = tsExc[info.className];
      if (
        typeof cls === "function" &&
        !added.has(info.className) &&
        // Skip error DTOs that extend HttpException (registered manually)
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
  }

  // ── Resolve application DTOs from their source files ──
  // DTOs like LoginResponseDto, PaginatedUsersDto are defined
  // in the project, not in ts-exc. Use the filePath collected
  // during AST parsing to require them directly.

  const debugLog: string[] = [];
  debugLog.push(`=== pactify DTO resolution ===`);
  debugLog.push(`allDtos count: ${allDtos.size}`);
  for (const [key, info] of allDtos) {
    debugLog.push(
      `  allDtos[${key}]: className=${info.className} filePath=${info.filePath}`,
    );
  }
  debugLog.push(`resolved from ts-exc: ${[...added].join(", ")}`);

  for (const [, info] of allDtos) {
    if (added.has(info.className)) continue;
    // Only process project-local DTOs (relative paths), skip
    // ts-exc .d.ts paths and node_modules paths
    if (
      info.filePath.includes("node_modules") ||
      info.filePath.endsWith(".d.ts")
    ) {
      continue;
    }
    try {
      // Application DTOs: resolve from the compiled dist/ directory.
      // In production the backend runs from dist/, not src/.
      const srcPath = require("node:path").resolve(
        process.cwd(),
        info.filePath,
      );
      // Try compiled .js first, then .ts (ts-node dev mode)
      const jsPath = srcPath
        .replace(/\/src\//, "/dist/")
        .replace(/\.tsx?$/, ".js");
      debugLog.push(`trying require("${jsPath}") for ${info.className}`);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(jsPath) as Record<string, unknown>;
      debugLog.push(
        `  require succeeded, keys: ${Object.keys(mod).join(", ")}`,
      );
      const cls = mod[info.className];
      debugLog.push(`  cls type: ${typeof cls}`);
      if (typeof cls === "function") {
        added.add(info.className);
        dtoClasses.push(cls as new (...args: Array<unknown>) => unknown);
        debugLog.push(`  ✅ added ${info.className}`);
      } else {
        debugLog.push(
          `  ❌ ${info.className} not found in module (type=${typeof cls})`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog.push(`  ❌ require failed: ${msg}`);
    }
  }

  // Write debug log to file in project root
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    fs.writeFileSync(
      path.resolve(process.cwd(), "pactify-debug.log"),
      debugLog.join("\n") + "\n",
      "utf-8",
    );
  } catch {
    // ignore
  }

  // ── Create base Swagger document ──
  const doc = SwaggerModule.createDocument(app, config, {
    extraModels: dtoClasses,
  });

  // ── Register error DTO schemas manually ──
  // Error DTOs extend HttpException, which causes NestJS Swagger's
  // SchemaObjectFactory to detect a circular dependency when walking
  // the prototype chain into NestJS's own HttpException class.
  // Instead, we build their schemas by instantiating each class and
  // reading the default property values set by class field initializers.
  if (tsExc) {
    const httpExClass = tsExc.HttpException;
    const httpExPrototype =
      typeof httpExClass === "function"
        ? (httpExClass as new (...a: unknown[]) => unknown).prototype
        : null;

    if (!doc.components) doc.components = {};
    if (!doc.components.schemas) doc.components.schemas = {};

    // Register ValidationErrorDto (referenced by error DTOs as errors: ValidationErrorDto[])
    const ValidationErrorDtoClass = tsExc.ValidationErrorDto;
    if (
      typeof ValidationErrorDtoClass === "function" &&
      !doc.components.schemas.ValidationErrorDto
    ) {
      doc.components.schemas.ValidationErrorDto = {
        type: "object",
        properties: {
          property: {
            type: "string",
            description: "Property that failed validation",
          },
          messages: {
            type: "array",
            items: { type: "string" },
            description: "Validation error messages",
          },
        },
        required: ["messages"],
      };
    }

    for (const [, info] of allDtos) {
      // Skip DTOs already registered (success DTOs handled by extraModels)
      if (doc.components.schemas[info.className]) continue;

      const cls = tsExc[info.className];
      if (typeof cls !== "function") continue;

      // Only process error DTOs (those extending HttpException)
      if (
        !httpExPrototype ||
        !Object.prototype.isPrototypeOf.call(
          httpExPrototype,
          (cls as new (...a: unknown[]) => unknown).prototype,
        )
      ) {
        continue;
      }

      // Instantiate the error DTO to read its default field values.
      // All error DTOs accept (errors?: ValidationErrorDto[] | string)
      // and their constructors are safe to call with no arguments.
      try {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic instantiation
        const instance = new (cls as new (...a: any[]) => any)();

        doc.components.schemas[info.className] = {
          type: "object",
          properties: {
            statusCode: {
              type: "number",
              example: instance.statusCode,
              description: "HTTP status code",
            },
            error: {
              type: "string",
              example: instance.error,
              description: "Error name",
            },
            message: {
              type: "string",
              example: instance.message,
              description: "Error message",
            },
            errors: {
              type: "array",
              items: { $ref: "#/components/schemas/ValidationErrorDto" },
              description: "Additional error details",
            },
          },
          required: ["statusCode", "error", "message"],
        };
      } catch {
        logger.current.warn?.(
          `pactify: failed to build schema for ${info.className}`,
        );
      }
    }
  }

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

  // ── Register missing application DTO schemas ────────────
  // pactify emits $ref to DTOs like LoginResponseDto,
  // PaginatedUsersDto etc. but those aren't in extraModels
  // (they're app-specific, not from ts-exc). Automatically
  // create a basic schema for any referenced but undefined DTO.
  if (doc.components?.schemas) {
    const schemas = doc.components.schemas as Record<string, unknown>;
    const missing = new Set<string>();

    // Walk all paths to collect $ref targets
    function collectRefs(obj: unknown): void {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        for (const item of obj) collectRefs(item);
        return;
      }
      const record = obj as Record<string, unknown>;
      if (typeof record.$ref === "string") {
        const name = record.$ref.replace("#/components/schemas/", "");
        if (!schemas[name]) missing.add(name);
        return;
      }
      for (const val of Object.values(record)) collectRefs(val);
    }
    collectRefs(doc.paths);

    for (const name of missing) {
      schemas[name] = { type: "object" };
    }
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
