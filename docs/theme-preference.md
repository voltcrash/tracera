# Theme preference transitions

The preference is `light`, `dark`, or `system`. System preference follows the current
color-scheme media query; explicit light/dark choices do not change with that query.

The provider also records the preference's source:

| Source    | Behavior                                                                    |
| --------- | --------------------------------------------------------------------------- |
| `storage` | Read the persisted preference; retain the last observed value if reads fail |
| `memory`  | Use this document's selected preference after persistence fails             |

A selection enters memory before attempting to save. Successful persistence returns it
to the storage source. Failed writes leave the choice active in memory through client-side
navigation; a full document reload can only recover persisted choices or the system default.

Storage events for the theme key or a local-storage clear adopt the other tab's preference.
Removal and invalid values resolve to `system`. Unrelated keys and session-storage events
do not replace an in-memory choice. Subscriptions clean up their event listeners.

The head script applies the theme before hydration. Its storage read has an independent
failure boundary so unavailable storage still permits the system-theme fallback.
