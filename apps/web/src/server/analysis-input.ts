type AnalysisInput = { text: string } | { url: string } | { image: string; imageMimeType?: string };

export type FirstPartyAnalysisInput = AnalysisInput & {
  forceReanalysis?: boolean;
  sourceUrl?: string;
  recheckOf?: string;
};

type InputResult = { success: true; data: AnalysisInput } | { success: false; error: string };

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
    "sourceUrl",
    "recheckOf",
  ];
  if (hasUnknownKeys(body, allowed)) return invalid("The request contains unsupported fields.");

  const core = Object.fromEntries(
    ["text", "url", "image", "imageMimeType"]
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]]),
  );
  const parsed = parseAnalysisInput(core);
  if (!parsed.success) return parsed;
  if (body.forceReanalysis !== undefined && typeof body.forceReanalysis !== "boolean") {
    return invalid("forceReanalysis must be a boolean.");
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
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(typeof body.recheckOf === "string" ? { recheckOf: body.recheckOf } : {}),
    },
  };
}

function parseAnalysisInput(body: Record<string, unknown>): InputResult {
  const supplied = ["text", "url", "image"].filter(
    (key) => typeof body[key] === "string" && body[key].trim().length > 0,
  );
  if (supplied.length !== 1) return invalid("Provide exactly one of text, url, or image.");

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
  if (!image.startsWith("data:image/") && !isImageUrl(image)) {
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

function invalid(error: string): { success: false; error: string } {
  return { success: false, error };
}

function hasUnknownKeys(body: Record<string, unknown>, allowed: string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(body).some((key) => !allowedKeys.has(key));
}

function isImageUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
