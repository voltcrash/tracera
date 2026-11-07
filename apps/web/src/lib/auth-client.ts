import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export function currentClientSession() {
  // Better Auth always creates this atom; its public store type is an indexed record.
  return authClient.$store.atoms.session!.get() as ReturnType<typeof authClient.useSession>;
}
