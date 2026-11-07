export type AuthUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  createdAt: string;
};

export const PROFILE_OWNER_HEADER = "x-tracera-profile-owner";
export type AuthPhase = "pending" | "authenticated" | "anonymous" | "error";

export function authPhase(
  session: {
    isPending: boolean;
    isRefetching: boolean;
    error: { status?: number } | null;
    user: AuthUser | null;
  },
  failedCheck = false,
): AuthPhase {
  if (session.error?.status === 401) return "anonymous";
  if (session.error) return "error";
  if (session.isPending || (failedCheck && session.isRefetching)) return "pending";
  return session.user ? "authenticated" : "anonymous";
}

export type SignInState =
  | { status: "idle" | "starting" | "redirecting" }
  | { status: "failed"; error: string };

export async function startSocialSignIn(
  request: () => Promise<{ error?: { message?: string } | null }>,
  providerName: string,
): Promise<SignInState> {
  try {
    const result = await request();
    if (result.error)
      return {
        status: "failed",
        error: result.error.message ?? `${providerName} sign-in could not start.`,
      };
    return { status: "redirecting" };
  } catch {
    return {
      status: "failed",
      error: `${providerName} sign-in could not start. Please try again.`,
    };
  }
}
