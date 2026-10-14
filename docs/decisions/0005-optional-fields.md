# 5. Optional fields: missing or null

The spec contradicts itself. The
[entities page](https://versia.pub/entities#entity-definition) says optional
fields must be present and set to `null`, never left out. The
[JSON page](https://versia.pub/json#optional-fields) says they may be `null` or
left out.

Verso accepts both when receiving, and leaves unset fields out when sending.
That's the smallest payload, and every peer that follows the JSON page
understands it.

This should be fixed upstream. If the spec settles on "always `null`", Verso
needs to start writing `null` for unset fields.
