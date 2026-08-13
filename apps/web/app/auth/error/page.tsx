import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Sign-in problem | Tracera",
  robots: {
    index: false,
    follow: false,
  },
};

const ERROR_MESSAGES = new Map<string, string>(
  Object.entries({
    access_denied: "Google sign-in was cancelled.",
    no_code: "Google sign-in was cancelled or could not be completed.",
    state_mismatch: "Your sign-in request expired or could not be verified. Please try again.",
    state_not_found: "Your sign-in request expired or could not be verified. Please try again.",
    state_invalid: "Your sign-in request expired or could not be verified. Please try again.",
    email_not_found: "Google did not provide an email address for this account.",
    account_already_linked_to_different_user:
      "This Google account is already connected to another Tracera account.",
    oauth_provider_not_found:
      "Google sign-in is temporarily unavailable. Please try again shortly.",
    invalid_code: "The sign-in response could not be verified. Please try again.",
    invalid_callback_request: "The sign-in response could not be verified. Please try again.",
  }),
);

type AuthErrorPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AuthErrorPage({ searchParams }: AuthErrorPageProps) {
  const params = await searchParams;
  const errorCode = first(params.error) ?? "unknown";
  const retryURL = first(params.flow) === "signup" ? "/signup" : "/login";
  const message =
    ERROR_MESSAGES.get(errorCode) ?? "We could not complete sign-in. Please try again shortly.";

  return (
    <main className="paper-grid flex min-h-screen items-center justify-center bg-[#f4f6f2] p-6 text-emerald-950">
      <section className="w-full max-w-md rounded-3xl border border-emerald-950/10 bg-white p-8 shadow-sm">
        <Link href="/" className="text-lg font-extrabold tracking-tight">
          tracera<span className="text-emerald-500">.</span>
        </Link>
        <p className="mt-10 text-xs font-black tracking-[.18em] text-amber-700">SIGN-IN PAUSED</p>
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-emerald-950">
          Sign-in wasn&apos;t completed
        </h1>
        <p className="mt-4 leading-7 text-slate-600">{message}</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href={retryURL}
            className="rounded-xl bg-emerald-950 px-5 py-3 text-center text-sm font-bold text-white transition hover:bg-emerald-900"
          >
            Try again
          </Link>
          <Link
            href="/"
            className="rounded-xl border border-slate-300 px-5 py-3 text-center text-sm font-bold text-slate-700 transition hover:border-emerald-800 hover:text-emerald-950"
          >
            Return home
          </Link>
        </div>
      </section>
    </main>
  );
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
