/** Browser API traffic stays on the Tracera origin unless a dev server overrides it. */
export const serverOrigin = process.env.NEXT_PUBLIC_SERVER_ORIGIN ?? "";
export const apiUrl = `${serverOrigin}/api/tracera`;
