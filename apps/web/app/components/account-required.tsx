import Link from "next/link";

export function AccountRequired({ feature }: { feature: string }) {
  return (
    <section className="mx-auto my-16 max-w-lg rounded-[2rem] border border-emerald-950/10 bg-white p-8 text-center shadow-[0_25px_70px_-42px_rgba(16,34,31,.55)] sm:my-24 sm:p-10">
      <p className="text-[10px] font-black tracking-[.2em] text-emerald-700">
        YOUR TRACERA ACCOUNT
      </p>
      <h1 className="mt-4 text-3xl font-black tracking-[-.05em] text-emerald-950">
        Sign in to open {feature}.
      </h1>
      <p className="mt-3 leading-7 text-emerald-950/60">
        Log in or create an account to revisit checks and follow their evidence trails.
      </p>
      <div className="mt-7 flex justify-center gap-3">
        <Link
          href="/login"
          className="rounded-xl bg-emerald-950 px-5 py-3 text-sm font-black text-white transition hover:-translate-y-0.5 hover:bg-emerald-800"
        >
          Log in
        </Link>
        <Link
          href="/signup"
          className="rounded-xl border border-emerald-950/15 bg-emerald-50 px-5 py-3 text-sm font-black text-emerald-950 transition hover:-translate-y-0.5 hover:bg-emerald-100"
        >
          Create account
        </Link>
      </div>
    </section>
  );
}
