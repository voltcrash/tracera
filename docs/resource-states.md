# Settings and history resources

History, sign-in methods, and provider-key metadata use `useResource` and
`AsyncResource`. Each resource belongs to one owner and has three read states:

| State     | Data                                         | Meaning                             |
| --------- | -------------------------------------------- | ----------------------------------- |
| `loading` | Previous confirmed data or `null`            | A read is pending                   |
| `ready`   | Successful response, including an empty list | Current read succeeded              |
| `error`   | Previous confirmed data or `null`            | The read failed; retry is available |

A failed read never manufactures an empty list. Cached history and account data remain
visible with an error notice when refresh fails. Without prior data, sign-in methods
remain unknown instead of appearing unlinked. Retry performs only the read.

Each refresh supersedes earlier reads. Only the current generation can publish data
or write the session cache. Cleanup cancels that generation and deactivates the resource,
so a late callback cannot restart reads after its workspace has unmounted. Effect setup
reactivates it, including React's development cleanup/setup cycle. Changing owners creates
a fresh resource; changing unrelated profile fields does not reload it.
Account-menu hover no longer starts an independent, untracked account-cache writer.

Provider-key mutations separately move through `idle`, `pending`, `failed`, and `succeeded`.
A successful save, activation, or deletion remains successful even if the following metadata
read fails. Previous metadata is then shown with a warning and mutation controls stay disabled
until a read succeeds. Retry refreshes metadata without verifying, saving, switching, or deleting
the key again. Synchronous duplicate actions share the pending guard, and unmounted settings
ignore mutation completions.

History refresh starts when submission returns an accepted run, independently of opening
its report. A response arriving after the composer unmounts can therefore update the surviving
workspace's history without navigating away from the current page. Terminal progress also
refreshes the history status and score. A failed refresh retains previously confirmed rows.
