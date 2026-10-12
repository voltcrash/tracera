import { Button } from "@/components/ui/button";
import type { SignInOptions as Options } from "@/server/session";
import { SocialSignInButton } from "./social-sign-in-button";

export function SignInOptions({ options }: { options: Options }) {
  if (options.identities && options.identities.length > 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-soft">Local development identities</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          {options.identities.map((identity) => (
            <Button
              key={identity.id}
              render={
                <a
                  href={`/api/auth/dev-login?identity=${identity.id}`}
                  aria-label={`Continue as ${identity.name}`}
                />
              }
              variant="brand"
              size="lg"
              nativeButton={false}
              className="color-sweep-button story-auth-cta"
            >
              Continue as {identity.name}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  if (options.providers.length === 0) {
    return <p className="text-sm text-ink-faint">Sign-in is not available right now.</p>;
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      {options.providers.map((provider) => (
        <SocialSignInButton
          key={provider}
          provider={provider}
          variant="brand"
          size="lg"
          className="color-sweep-button story-auth-cta"
        />
      ))}
    </div>
  );
}
