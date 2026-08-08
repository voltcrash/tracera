export const dynamic = "force-dynamic";

export async function GET() {
  const apiUrl = (
    process.env.TRACERA_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:3001"
  ).replace(/\/$/, "");
  try {
    const response = await fetch(`${apiUrl}/health`, { cache: "no-store" });
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
