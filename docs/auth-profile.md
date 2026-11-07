# Authentication and profile transitions

`AuthProvider` distinguishes pending, authenticated, anonymous, and unavailable sessions.
Only a confirmed empty session or unauthorized response redirects to sign-in. Other errors
hide the workspace and offer a retry. A retry keeps that boundary closed until the session
check finishes, even though Better Auth clears its error when refetching starts.

Initial pending sessions still mount the guarded route outlet: server route guards have
already authorized the request, and TanStack Start needs the outlet to finish SSR and
hydration. Each document keeps its first authorized owner. Once the browser confirms a
different owner from that identity or the active route context, the workspace
stops rendering its children, clears session caches, and reloads the document. The server
then authorizes the current URL for the new account. This discards prior-owner drafts,
streams, local form state, and cached loader reports.

`ProfileEditor` owns optimistic name/avatar edits and pending requests for the provider's
lifetime. A request is bound to its owner and field. A second write to the same field is
refused while the first is pending; different fields can save independently. Leaving Settings does not
remove that guard. Changed owners invalidate old completion callbacks.

| Result                                         | Behavior                                                        |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Write succeeds, fresh session read succeeds    | Clear that confirmed field and follow the server value          |
| Write succeeds, refresh fails or is superseded | Keep the confirmed save outcome and unmatched optimistic fields |
| Write fails                                    | Remove only that field's optimistic edit and allow retry        |
| Another owner's response arrives               | Ignore its UI effects                                           |
| Session changes                                | Clear the prior owner's optimistic edits                        |

Better Auth's session refetch resolves without throwing ordinary fetch errors. The editor
therefore reads the resulting session snapshot. Pending edits clear only when their values
match the server. Confirmed edits follow the next fresh server value, including a newer edit
from another writer. One field's refresh cannot erase another field's pending edit.

First-party profile writes carry `x-tracera-profile-owner`. The auth handler compares it
with the request's session before delegating to Better Auth. A changed or missing expected
owner returns a reload instruction, so an older tab cannot mutate a newly selected account.
Existing open tabs need to reload after this protocol change. Previously admitted requests
may finish for their original session.

Sign-in startup handles thrown and returned failures and permits retry. Sign-out requests
share one pending operation per session and preserve failures for retry. A confirmed sign-out
is anonymous even if a subsequent session refresh fails; a new session with the same owner
is a distinct session and can authenticate normally. An expired or revoked session still
delegates sign-out to Better Auth so its cookie is cleared. The expected-owner check rejects
sign-out only when another account has an active session.
