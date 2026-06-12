---
name: google-maps
description: Use Google Maps Places tools for live restaurant, store, service, address, hours, phone, website, and local place metadata lookups.
---

# Google Maps

Use this skill when the current conversation needs live place information from
Google Maps, especially:

- finding restaurants, cafes, stores, services, or other places near an address,
  neighborhood, city, or landmark;
- checking place metadata like address, business status, Google Maps link,
  hours, phone number, website, rating, or price;
- comparing a small set of local options.

Use code mode through `sandi_js_run`, importing maps helpers:

```ts
import { maps } from "./sandi/runtime.ts";
```

Available helpers:

- `maps.searchPlaces({ query, near, openNow, maxResults })`
- `maps.placeDetails({ placeId, fieldSet })`

Prefer this flow:

1. Use `maps.searchPlaces` for candidate places.
2. Share a compact list when the user is choosing among options.
3. Use `maps.placeDetails` with the default `fieldSet: basic` when the user
   needs identity, address, business status, coordinates, type, or a Google Maps
   link for a specific result.
4. Use `maps.placeDetails` with `fieldSet: storefront` only when the user
   explicitly asks for hours, whether a place is open, phone number, website,
   rating, price, or similar storefront metadata.
5. Include the Google Maps link when giving place results or metadata.

Guidance:

- Do not invent a location. If the user says "near me" and no usable address,
  neighborhood, remembered home/work context, or current thread context is
  available, ask for the area.
- For "near [address]" requests, put the address or area in the `near`
  parameter rather than doing a separate geocoding step.
- Keep result lists short. Five options is usually enough unless the user asks
  for more.
- If the search result is ambiguous, say what looks ambiguous and ask which
  place to inspect before calling `maps.placeDetails`.
- Treat storefront fields as explicit opt-in because they use a higher billing
  tier. Do not fetch hours, phone, website, rating, price, or open-now details
  just because they might be nice to have.
- For "find places to eat/shop near X", search first and return compact
  candidates. Fetch storefront details only for the specific place or places the
  user asks about.
- Be clear that Google Maps shaped the answer.
