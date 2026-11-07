# Composer transitions

`apps/web/src/lib/composer.ts` owns a mounted composer's state. The home route subscribes
through `useSyncExternalStore`, so handlers check the same synchronous state before React
renders another frame. Text, link, and screenshot inputs use the same submission path.

| State                 | Event                                            | Result                                                          |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| Idle or failed        | Submit a valid draft                             | Submitting; editing and attachment changes lock                 |
| Submitting            | Another submit                                   | Ignored                                                         |
| Submitting            | Error or rejected response                       | Failed; draft remains editable                                  |
| Failed                | Retry unchanged effective input as the same user | Submitting with the original idempotency key                    |
| Idle or failed        | Submit changed input or as another user          | Submitting with a new idempotency key                           |
| Submitting            | Response contains an accepted run                | Opening that run; acceptance cannot become a submission failure |
| Opening               | Navigation fails                                 | Accepted; show the saved run link and allow opening it again    |
| Accepted              | Open again                                       | Opening the same run without another start request              |
| Any pending operation | Leave the composer                               | Ignore subsequent completion updates and automatic navigation   |

Request identity lasts for the mounted composer and uses the server's existing idempotency
retention period. Reloading or leaving and returning starts a new draft; drafts and pending
requests are not persisted in browser storage.

Only a response with `code: analysis_start_failed` and `status: failed` confirms that no run
was saved. A retry then uses a fresh key, avoiding replay of the cached failure. Transport
failures, unconfirmed persistence, and in-progress responses retain the request identity.

A settled Workflow failure replays with HTTP 503 and a saved run ID. That response still
opens the saved run and refreshes history. The shared acceptance check excludes
`analysis_start_failed` responses, whose run ID does not confirm persistence.

Attachment reads have their own version. Selecting, pasting, or dropping an image starts
reading and blocks submission, even when text is already present. A newer selection or
removal invalidates the previous read. Late successes and failures cannot replace the
latest selection. Replacing an attachment clears its preview while reading; the text draft
is preserved. A read failure returns to the text draft with an error.

`apps/web/test/composer.test.ts` covers concurrent operations and navigation failures.
`apps/web/e2e/composer.e2e.ts` exercises the real Worker after a lost accepted response,
rapid submits, controlled out-of-order file reads, and removal during reading.
