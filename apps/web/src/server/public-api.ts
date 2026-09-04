export const PUBLIC_API_VERSION = "v1";

export type PublicAnalysisInput =
  | { text: string }
  | { url: string }
  | { image: string; imageMimeType?: string };

export type PublicInputResult =
  | { success: true; data: PublicAnalysisInput }
  | { success: false; error: string };

export type FirstPartyAnalysisInput = PublicAnalysisInput & {
  forceReanalysis?: boolean;
  visibility?: "public" | "private";
  sourceUrl?: string;
  recheckOf?: string;
};

export function parsePublicAnalysisInput(value: unknown): PublicInputResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("The request body must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  const supplied = ["text", "url", "image"].filter(
    (key) => typeof body[key] === "string" && body[key].trim().length > 0,
  );
  if (supplied.length !== 1) {
    return invalid("Provide exactly one of text, url, or image.");
  }

  if (supplied[0] === "text") {
    if (hasUnknownKeys(body, ["text"])) {
      return invalid("Text requests may only contain the text field.");
    }
    const text = (body.text as string).trim();
    return text.length <= 50_000
      ? { success: true, data: { text } }
      : invalid("Text must not exceed 50,000 characters.");
  }

  if (supplied[0] === "url") {
    if (hasUnknownKeys(body, ["url"])) {
      return invalid("URL requests may only contain the url field.");
    }
    const url = (body.url as string).trim();
    if (url.length > 2_048) return invalid("URL must not exceed 2,048 characters.");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return invalid("URL must use HTTP or HTTPS.");
      }
      return { success: true, data: { url: parsed.href } };
    } catch {
      return invalid("URL must be a valid absolute HTTP(S) URL.");
    }
  }

  const image = (body.image as string).trim();
  if (hasUnknownKeys(body, ["image", "imageMimeType"])) {
    return invalid("Image requests may only contain image and imageMimeType.");
  }
  if (image.length > 7_000_000) {
    return invalid("Encoded image must not exceed 7,000,000 characters.");
  }
  if (!image.startsWith("data:image/") && !isPublicImageUrl(image)) {
    return invalid("Image must be an image data URI or an HTTP(S) URL.");
  }
  const imageMimeType = typeof body.imageMimeType === "string" ? body.imageMimeType.trim() : "";
  if (imageMimeType && !/^image\/[a-z0-9.+-]+$/i.test(imageMimeType)) {
    return invalid("imageMimeType must be a valid image media type.");
  }
  return {
    success: true,
    data: {
      image,
      ...(imageMimeType ? { imageMimeType } : {}),
    },
  };
}

export function parseFirstPartyAnalysisInput(
  value: unknown,
): { success: true; data: FirstPartyAnalysisInput } | { success: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("The request body must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  const allowed = [
    "text",
    "url",
    "image",
    "imageMimeType",
    "forceReanalysis",
    "visibility",
    "sourceUrl",
    "recheckOf",
  ];
  if (hasUnknownKeys(body, allowed)) return invalid("The request contains unsupported fields.");

  const core = Object.fromEntries(
    ["text", "url", "image", "imageMimeType"]
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]]),
  );
  const parsed = parsePublicAnalysisInput(core);
  if (!parsed.success) return parsed;
  if (body.forceReanalysis !== undefined && typeof body.forceReanalysis !== "boolean") {
    return invalid("forceReanalysis must be a boolean.");
  }
  if (
    body.visibility !== undefined &&
    body.visibility !== "public" &&
    body.visibility !== "private"
  ) {
    return invalid('visibility must be either "public" or "private".');
  }
  if (body.recheckOf !== undefined && typeof body.recheckOf !== "string") {
    return invalid("recheckOf must be a string.");
  }

  let sourceUrl: string | undefined;
  if (body.sourceUrl !== undefined) {
    if (typeof body.sourceUrl !== "string" || body.sourceUrl.length > 2_048) {
      return invalid("sourceUrl must be an HTTP(S) URL no longer than 2,048 characters.");
    }
    try {
      const parsedUrl = new URL(body.sourceUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error();
      sourceUrl = parsedUrl.href;
    } catch {
      return invalid("sourceUrl must be a valid absolute HTTP(S) URL.");
    }
  }

  return {
    success: true,
    data: {
      ...parsed.data,
      ...(body.forceReanalysis === true ? { forceReanalysis: true } : {}),
      ...(body.visibility ? { visibility: body.visibility as "public" | "private" } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(typeof body.recheckOf === "string" ? { recheckOf: body.recheckOf } : {}),
    },
  };
}

export async function authenticatePublicApiKey(
  provided: string | undefined,
  configured: string | undefined,
): Promise<{ authenticated: boolean }> {
  const allowed = (configured ?? "")
    .split(/[\n,]/)
    .map((key) => key.trim())
    .filter(Boolean);
  if (!provided || allowed.length === 0) return { authenticated: false };

  const providedHash = await sha256(provided);
  const allowedHashes = await Promise.all(allowed.map(sha256));
  const authenticated = allowedHashes.some((hash) => constantTimeEqual(hash, providedHash));
  return { authenticated };
}

export const publicOpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Tracera Public API",
    version: "1.0.0",
    description:
      "Submit news text, links, or images for evidence-backed claim verification and retrieve public traces.",
  },
  servers: [{ url: "https://tracera.voltcrash.com/api/tracera" }],
  security: [{ ApiKey: [] }],
  paths: {
    "/v1/checks": {
      get: {
        summary: "Search public traces",
        parameters: [
          {
            name: "q",
            in: "query",
            schema: { type: "string", maxLength: 200 },
          },
          {
            name: "page",
            in: "query",
            schema: { type: "integer", minimum: 1 },
          },
          {
            name: "pageSize",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100 },
          },
        ],
        responses: {
          "200": {
            description: "A paginated list of public traces.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CheckListResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        summary: "Analyze a public submission",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    required: ["text"],
                    properties: { text: { type: "string", maxLength: 50_000 } },
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    required: ["url"],
                    properties: {
                      url: { type: "string", format: "uri", maxLength: 2_048 },
                    },
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    required: ["image"],
                    properties: {
                      image: { type: "string", maxLength: 7_000_000 },
                      imageMimeType: { type: "string", pattern: "^image/" },
                    },
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "A recent identical trace was reused.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AnalysisResponse" },
              },
            },
          },
          "201": {
            description: "A new trace was completed and stored.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AnalysisResponse" },
              },
            },
          },
          "400": { description: "The request did not match the input schema." },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { description: "No checkable claim could be extracted." },
        },
      },
    },
    "/v1/checks/{id}": {
      get: {
        summary: "Retrieve a public trace",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "The complete public trace.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CheckResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { description: "The trace was not found." },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKey: { type: "apiKey", in: "header", name: "x-api-key" },
    },
    responses: {
      Unauthorized: {
        description: "A valid Tracera API key is required.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
          },
        },
      },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        required: ["apiVersion", "error"],
        properties: {
          apiVersion: { const: PUBLIC_API_VERSION },
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      CheckSummary: {
        type: "object",
        required: ["id", "summary", "traceraScore", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          summary: { type: "string" },
          traceraScore: { type: "object", additionalProperties: true },
          createdAt: { type: "string", format: "date-time" },
          sourceDomain: { type: ["string", "null"] },
          sourceUrl: { type: ["string", "null"], format: "uri" },
          publishedAt: { type: ["string", "null"], format: "date-time" },
          appearanceCount: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      CheckListResponse: {
        type: "object",
        required: ["apiVersion", "data", "pagination"],
        properties: {
          apiVersion: { const: PUBLIC_API_VERSION },
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/CheckSummary" },
          },
          pagination: {
            type: "object",
            required: ["page", "pageSize", "total", "totalPages"],
            properties: {
              page: { type: "integer", minimum: 1 },
              pageSize: { type: "integer", minimum: 1, maximum: 100 },
              total: { type: "integer", minimum: 0 },
              totalPages: { type: "integer", minimum: 0 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      AnalysisResponse: {
        type: "object",
        required: ["apiVersion", "cached", "check", "claims", "traceraScore"],
        properties: {
          apiVersion: { const: PUBLIC_API_VERSION },
          cached: { type: "boolean" },
          check: { type: "object", additionalProperties: true },
          claims: { type: "array", items: { type: "object" } },
          traceraScore: { type: "object", additionalProperties: true },
          framingAnalysis: {
            type: ["object", "null"],
            additionalProperties: true,
          },
          groundZero: { type: ["object", "null"], additionalProperties: true },
          inputMetadata: {
            type: ["object", "null"],
            additionalProperties: true,
          },
          reuse: { type: "object", additionalProperties: true },
        },
        additionalProperties: true,
      },
      CheckResponse: {
        type: "object",
        required: ["apiVersion", "data"],
        properties: {
          apiVersion: { const: PUBLIC_API_VERSION },
          data: {
            type: "object",
            required: ["id", "input", "claims", "traceraScore", "createdAt"],
            properties: {
              id: { type: "string", format: "uuid" },
              input: { type: "object", additionalProperties: true },
              claims: { type: "array", items: { type: "object" } },
              traceraScore: { type: "object", additionalProperties: true },
              framingAnalysis: {
                type: ["object", "null"],
                additionalProperties: true,
              },
              groundZero: {
                type: ["object", "null"],
                additionalProperties: true,
              },
              createdAt: { type: "string", format: "date-time" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
} as const;

function invalid(error: string): PublicInputResult {
  return { success: false, error };
}

function hasUnknownKeys(body: Record<string, unknown>, allowed: string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(body).some((key) => !allowedKeys.has(key));
}

function isPublicImageUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
