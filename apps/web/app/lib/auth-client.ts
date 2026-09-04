import { createAuthClient } from "better-auth/react";
import { serverOrigin } from "./api";

export const authClient = createAuthClient(serverOrigin ? { baseURL: serverOrigin } : {});
