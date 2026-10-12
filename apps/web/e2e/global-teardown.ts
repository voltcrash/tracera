import { cleanBrowserUsers } from "./support/d1";

export default function globalTeardown() {
  cleanBrowserUsers();
}
