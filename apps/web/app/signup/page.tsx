"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { GoogleAuthCard } from "../components/google-auth-card";
import { Button } from "@/components/ui/button";

export default function SignupPage() {
  return (
    <main className="paper-grid flex min-h-screen items-center justify-center bg-background p-6">
      <section className="w-full max-w-md">
        <Button asChild variant="ghost" size="sm" className="mb-8 -ml-3 text-muted-foreground">
          <Link href="/">
            <ArrowLeft />
            Back to Tracera
          </Link>
        </Button>
        <GoogleAuthCard mode="signup" />
      </section>
    </main>
  );
}
