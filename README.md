# @esmaeel_emadi/pactify

AST-powered Swagger/OpenAPI auto-generation for NestJS controllers.

Parses TypeScript controller source files at **build time** to extract DTOs from
return types, thrown exceptions, guard classes, and validation pipes — no manual
`@ApiResponse()` decorators needed.

## Install

```bash
pnpm add @esmaeel_emadi/pactify
```

Peer dependencies (your project should already have these):
- `@nestjs/common` ≥ 10
- `@nestjs/swagger` ≥ 7
- `oxc-parser` ≥ 0.50
- `oxc-walker` ≥ 0.5
- `ts-pattern` ≥ 5

## Usage

```ts
// main.ts
import { pactify } from "@esmaeel_emadi/pactify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Standard OpenAPI metadata
  const config = new DocumentBuilder()
    .setTitle("My API")
    .setDescription("Auto-generated API docs")
    .setVersion("1.0")
    .addBearerAuth()
    .build();

  // pactify scans all *.controller.ts files, walks their AST,
  // and auto-resolves DTOs for every endpoint.
  const doc = await pactify(app, config, "api");

  SwaggerModule.setup("openapi", app, doc, {
    jsonDocumentUrl: "openapi/json",
  });

  await app.listen(3000);
}
```

## How it works

1. **Scans** `src/**/*.controller.ts` for `@Controller()` classes.
2. **Walks the AST** of each method to find:
   - `return new OkDto(...)` / `throw new NotFoundDto()`
   - Arrow expression returns (`r => new OkDto(new UserDto(r))`)
   - Decorator-based throws (`@UseGuards(AuthGuard)` → walks AuthGuard's AST)
   - Pipe-based throws (`@Body(ValidationPipe)` → walks ValidationPipe's AST)
   - Recursive tracing into service method calls
3. **Maps DTO class names** to HTTP status codes (OkDto → 200, NotFoundDto → 404, etc.)
4. **Requires the compiled JS** to extract class metadata (decorators, properties).
5. **Injects** responses into the OpenAPI document.

## Conventions pactify expects

- **Controller files** end with `.controller.ts`
- **DTO classes** end with `Dto` (e.g., `OkDto`, `UserDto`, `NotFoundDto`)
- **HTTP method decorators** use standard NestJS: `@Get()`, `@Post()`, `@Patch()`, etc.
- **Version** decorator: `@Version("1")`
- **Path aliases** resolve via the project's `tsconfig.json`

## API

### `pactify(app, config, basePath, opts?)`

| Param | Type | Description |
|-------|------|-------------|
| `app` | `INestApplication` | The NestJS app instance |
| `config` | `Omit<OpenAPIObject, "paths">` | OpenAPI metadata (from `DocumentBuilder`) |
| `basePath` | `string` | Version prefix, e.g. `"api"` |
| `opts` | `PactifyOptions` | Optional config |

Returns: `Promise<OpenAPIObject>`

### Advanced exports

```ts
import {
  findControllerFiles,       // scan filesystem for controllers
  extractMethodDtos,         // extract DTOs from a method AST
  extractDecoratorThrows,    // extract DTOs from decorator guards
  extractParamDecoratorThrows, // extract DTOs from pipe decorators
  extractDtoStatusCode,      // walk a DTO class AST to find its status code
  addDtosToSwagger,          // inject DTOs into Swagger paths
} from "@esmaeel_emadi/pactify";
```

## License

MIT
