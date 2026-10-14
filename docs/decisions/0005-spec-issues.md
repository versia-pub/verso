# 5. Gaps and mistakes in the Versia 0.6 spec

Where the spec is unclear or wrong, Verso does the following. Each of these
should be raised upstream.

| Issue                                                                                                                                                           | What Verso does                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [Signing](https://versia.pub/signatures) example code uses milliseconds; the text says seconds                                                                  | Seconds                                             |
| The query string isn't signed                                                                                                                                   | Uses it only for pagination                         |
| The destination host isn't signed, so a request can be replayed to another instance for 5 minutes                                                               | Nothing yet; needs a spec change                    |
| Optional fields must be `null` ([entities](https://versia.pub/entities#entity-definition)) or may be left out ([JSON](https://versia.pub/json#optional-fields)) | Accepts both; leaves unset fields out when sending  |
| User, InstanceMetadata and Collection examples leave out the required `remote`                                                                                  | Requires `remote`                                   |
| The Note example is invalid JSON (missing comma)                                                                                                                | Fixed in our tests                                  |
| Delete's `author` is required in its table, optional in the changelog                                                                                           | Optional; missing means the signing instance        |
| `compatibility.versions` should be `0.X`, but every example says `0.6.0`                                                                                        | Sends `0.6.0`, accepts any string                   |
| Note `group` keywords `public` and `followers` are also valid bare ids                                                                                          | Treats them as the keywords                         |
| Content rules written in prose (avatar is `image/*`, attachments are remote, …)                                                                                 | Enforces them                                       |
| Domains can't have a port, but references don't say                                                                                                             | References may have a port, for local testing       |
| Reference hostnames have no canonical form                                                                                                                      | Lowercase, no port 443, compressed IPv6, ASCII only |
| Extension keys that break the naming rules                                                                                                                      | Rejected with 422                                   |
