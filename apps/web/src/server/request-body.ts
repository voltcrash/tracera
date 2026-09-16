export const MAX_ANALYSIS_BODY_BYTES = 7_100_000;

export type AnalysisRequestBody = { tooLarge: true } | { tooLarge: false; body: unknown };

export async function readAnalysisRequestBody(request: Request): Promise<AnalysisRequestBody> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ANALYSIS_BODY_BYTES)
    return { tooLarge: true };

  const stream = request.body;
  if (!stream) return { tooLarge: false, body: null };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_ANALYSIS_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { tooLarge: false, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { tooLarge: false, body: null };
  } finally {
    reader.releaseLock();
  }
}
