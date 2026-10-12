import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { serverEnv } from "./env";
import { readSessionUser, signInOptions } from "./session.server";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  createdAt: string;
};
export type SocialProvider = "google" | "github";
export type SignInOptions = {
  providers: SocialProvider[];
  identities: { id: string; name: string }[] | null;
};

export const getSession = createServerFn({ method: "GET" }).handler(() =>
  readSessionUser(serverEnv(), getRequest()),
);

export const getSignInOptions = createServerFn({ method: "GET" }).handler(() =>
  signInOptions(serverEnv(), new URL(getRequest().url).origin),
);
