import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function AccountRequired({ feature }: { feature: string }) {
  return (
    <Card className="mx-auto my-16 max-w-lg rounded-3xl p-2 text-center sm:my-24">
      <CardHeader>
        <CardTitle className="text-3xl font-extrabold tracking-[-.04em]">
          Sign in to open {feature}
        </CardTitle>
        <CardDescription className="mt-2 leading-relaxed">
          Log in or create an account to revisit checks and follow their evidence trails.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center gap-3">
        <Button render={<Link href="/login" />} size="lg">
          Log in
        </Button>
        <Button render={<Link href="/signup" />} size="lg" variant="secondary">
          Create account
        </Button>
      </CardContent>
    </Card>
  );
}
