export const dynamic = "force-dynamic";

const TRACERA_API_URL = process.env.TRACERA_API_URL ?? "https://api.tracera.voltcrash.com";

export async function GET() {
  try {
    const response = await fetch(`${TRACERA_API_URL}/health`, {
      cache: "no-store",
    });
    const payload = await response.json();
    return Response.json(payload, { status: response.status });
  } catch (error) {
    return Response.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Health check failed",
      },
      { status: 503 },
    );
  }
}
