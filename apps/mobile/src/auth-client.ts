import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

const expoPlugin = expoClient({
  scheme: "tracera",
  storagePrefix: "tracera",
  cookiePrefix: "tracera",
  storage: SecureStore,
});

const client = createAuthClient({
  baseURL: "https://tracera.voltcrash.com",
  // pnpm gives the Expo and web clients distinct React peer graphs in this
  // monorepo. Their runtime plugin contract is identical, but the duplicated
  // generic type identities are not assignable to one another.
  plugins: [expoPlugin as never],
});

export const authClient = client as typeof client & {
  getCookie(): string;
};
