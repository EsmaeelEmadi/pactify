import { HttpStatus } from "@nestjs/common";
import { readFileSync } from "node:fs";

/**
 * Build an inline OpenAPI schema for a paginated response wrapper.
 *
 * Paginated*Dto classes extend `PaginatedDto<InnerDto>` but NestJS
 * Swagger can't resolve the generic type parameter, leaving `data`
 * typed as `string[]` and `limit`/`totalPages` as empty objects.
 * We generate the correct schema here.
 */
function buildPaginatedSchema(innerRef: string) {
  return {
    type: "object",
    properties: {
      data: {
        type: "array",
        items: { $ref: `#/components/schemas/${innerRef}` },
      },
      total: { type: "number" },
      page: { type: "number" },
      limit: { type: "number", nullable: true },
      totalPages: { type: "number", nullable: true },
    },
    required: ["data", "total", "page"],
  };
}

/**
 * Parse a Paginated*Dto source file to extract its inner generic type.
 *
 * @example
 *   class PaginatedUsersDto extends PaginatedDto<ExtendedUserDto> { ... }
 *   → "ExtendedUserDto"
 */
function extractPaginatedInnerType(
  filePath: string,
  className: string,
): string | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    // Match `extends PaginatedDto<InnerType>`
    const regex = new RegExp(
      `class\\s+${className}\\s+extends\\s+PaginatedDto\\s*<\\s*(\\w+)\\s*>`,
    );
    const match = content.match(regex);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Add extracted DTOs as response schemas on a Swagger path+method.
 *
 * Maps DTO class names to HTTP status codes (e.g., OkDto → 200,
 * CreatedDto → 201, NotFoundDto → 404) and adds the appropriate
 * `$ref` schema references to the OpenAPI document.
 */
export const addDtosToSwagger = (
	// biome-ignore lint/suspicious/noExplicitAny: swagger doc is dynamic
	swaggerDoc: any,
	path: string,
	method: string,
	dtos: Array<{
		className: string;
		filePath: string;
		type: "return" | "throw";
		statusCode?: number;
		nestedDtos?: Array<{ className: string; filePath: string }>;
	}>,
	basePath: string | null,
	version: string | null,
): void => {
	let finalPath = "";

	if (basePath) {
		finalPath += `/${basePath}`;
	}

	if (version) {
		finalPath += version;
	}

	finalPath += path;

	// Ensure schema container exists
	if (!swaggerDoc.components) {
		swaggerDoc.components = {};
	}
	if (!swaggerDoc.components.schemas) {
		swaggerDoc.components.schemas = {};
	}

	// Ensure path+method container exists
	if (!swaggerDoc.paths[finalPath]) {
		swaggerDoc.paths[finalPath] = {};
	}
	if (!swaggerDoc.paths[finalPath][method]) {
		swaggerDoc.paths[finalPath][method] = { responses: {} };
	}

	const responses = swaggerDoc.paths[finalPath][method].responses;

	for (const dto of dtos) {
		const statusCode = dto.statusCode || getStatusCodeFromDto(dto.className);

		if (!statusCode) {
			continue;
		}

		if (dto.nestedDtos && dto.nestedDtos.length > 0) {
			const nestedDto = dto.nestedDtos[0];

			// Array-wrapped DTOs — prefix "[]" marks extraction from array literal or .map()
			if (nestedDto.className.startsWith("[]")) {
				const innerRef = nestedDto.className.slice(2);
				responses[statusCode] = {
					description: `${dto.className}<${innerRef}[]>`,
					content: {
						"application/json": {
							schema: {
								allOf: [
									{ $ref: `#/components/schemas/${dto.className}` },
									{
										type: "object",
										properties: {
											data: {
												type: "array",
												items: { $ref: `#/components/schemas/${innerRef}` },
											},
										},
										required: ["data"],
									},
								],
							},
						},
					},
				};
			// Paginated response — generate inline schema with correct inner type
			} else if (nestedDto.className.startsWith("Paginated")) {
				const innerType = extractPaginatedInnerType(
					nestedDto.filePath,
					nestedDto.className,
				);
				const dataSchema = innerType
					? buildPaginatedSchema(innerType)
					: { $ref: `#/components/schemas/${nestedDto.className}` };

				responses[statusCode] = {
					description: `${dto.className}<${nestedDto.className}>`,
					content: {
						"application/json": {
							schema: {
								allOf: [
									{ $ref: `#/components/schemas/${dto.className}` },
									{
										type: "object",
										properties: { data: dataSchema },
										required: ["data"],
									},
								],
							},
						},
					},
				};
			} else {
				responses[statusCode] = {
					description: `${dto.className}<${nestedDto.className}>`,
					content: {
						"application/json": {
							schema: {
								allOf: [
									{ $ref: `#/components/schemas/${dto.className}` },
									{
										type: "object",
										properties: {
											data: {
												$ref: `#/components/schemas/${nestedDto.className}`,
											},
										},
										required: ["data"],
									},
								],
							},
						},
					},
				};
			}
		} else {
			responses[statusCode] = {
				description: dto.className,
				content: {
					"application/json": {
						schema: { $ref: `#/components/schemas/${dto.className}` },
					},
				},
			};
		}
	}

	// For GET methods, add a 304 Not Modified response with the same schema as 200.
	// Skip when the 200 response has no JSON content (e.g. raw @Res() endpoints
	// like file/stream or image responses).
	if (method === "get" && responses[200]?.content?.["application/json"]) {
		const content304 = JSON.parse(
			JSON.stringify(responses[200].content["application/json"]),
		);
		const schema304 = content304.schema;
		if (!schema304) return;

		const statusCodeOverride = {
			type: "object",
			properties: {
				statusCode: {
					type: "number",
					example: 304,
				},
			},
		};

		if (schema304.allOf) {
			schema304.allOf.push(statusCodeOverride);
		} else {
			schema304.allOf = [{ $ref: schema304.$ref }, statusCodeOverride];
			delete schema304.$ref;
		}

		responses[304] = {
			description: "Not Modified",
			content: { "application/json": content304 },
		};
	}
};

// ────────────────────────────────────────────────────────────
// Map DTO class name → HTTP status code
// ────────────────────────────────────────────────────────────

const getStatusCodeFromDto = (dtoName: string): number | undefined => {
	const statusMap: Record<string, number> = {
		ContinueDto: HttpStatus.CONTINUE,
		SwitchingProtocolsDto: HttpStatus.SWITCHING_PROTOCOLS,
		ProcessingDto: HttpStatus.PROCESSING,
		EarlyhintsDto: HttpStatus.EARLYHINTS,
		OkDto: HttpStatus.OK,
		CreatedDto: HttpStatus.CREATED,
		AcceptedDto: HttpStatus.ACCEPTED,
		NonAuthoritativeInformationDto: HttpStatus.NON_AUTHORITATIVE_INFORMATION,
		NoContentDto: HttpStatus.NO_CONTENT,
		ResetContentDto: HttpStatus.RESET_CONTENT,
		PartialContentDto: HttpStatus.PARTIAL_CONTENT,
		AmbiguousDto: HttpStatus.AMBIGUOUS,
		MovedPermanentlyDto: HttpStatus.MOVED_PERMANENTLY,
		FoundDto: HttpStatus.FOUND,
		SeeOtherDto: HttpStatus.SEE_OTHER,
		NotModifiedDto: HttpStatus.NOT_MODIFIED,
		TemporaryRedirectDto: HttpStatus.TEMPORARY_REDIRECT,
		PermanentRedirectDto: HttpStatus.PERMANENT_REDIRECT,
		BadRequestDto: HttpStatus.BAD_REQUEST,
		UnauthorizedDto: HttpStatus.UNAUTHORIZED,
		PaymentRequiredDto: HttpStatus.PAYMENT_REQUIRED,
		ForbiddenDto: HttpStatus.FORBIDDEN,
		NotFoundDto: HttpStatus.NOT_FOUND,
		MethodNotAllowedDto: HttpStatus.METHOD_NOT_ALLOWED,
		NotAcceptableDto: HttpStatus.NOT_ACCEPTABLE,
		ProxyAuthenticationRequiredDto: HttpStatus.PROXY_AUTHENTICATION_REQUIRED,
		RequestTimeoutDto: HttpStatus.REQUEST_TIMEOUT,
		ConflictDto: HttpStatus.CONFLICT,
		GoneDto: HttpStatus.GONE,
		LengthRequiredDto: HttpStatus.LENGTH_REQUIRED,
		PreconditionFailedDto: HttpStatus.PRECONDITION_FAILED,
		PayloadTooLargeDto: HttpStatus.PAYLOAD_TOO_LARGE,
		UriTooLongDto: HttpStatus.URI_TOO_LONG,
		UnsupportedMediaTypeDto: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
		RequestedRangeNotSatisfiableDto: HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
		ExpectationFailedDto: HttpStatus.EXPECTATION_FAILED,
		IAmATeapotDto: HttpStatus.I_AM_A_TEAPOT,
		MisdirectedDto: HttpStatus.MISDIRECTED,
		UnprocessableEntityDto: HttpStatus.UNPROCESSABLE_ENTITY,
		FailedDependencyDto: HttpStatus.FAILED_DEPENDENCY,
		PreconditionRequiredDto: HttpStatus.PRECONDITION_REQUIRED,
		TooManyRequestsDto: HttpStatus.TOO_MANY_REQUESTS,
		InternalServerErrorDto: HttpStatus.INTERNAL_SERVER_ERROR,
		NotImplementedDto: HttpStatus.NOT_IMPLEMENTED,
		BadGatewayDto: HttpStatus.BAD_GATEWAY,
		ServiceUnavailableDto: HttpStatus.SERVICE_UNAVAILABLE,
		GatewayTimeoutDto: HttpStatus.GATEWAY_TIMEOUT,
		HttpVersionNotSupportedDto: HttpStatus.HTTP_VERSION_NOT_SUPPORTED,
	};

	return statusMap[dtoName];
};
