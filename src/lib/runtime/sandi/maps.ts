import { z } from "zod/v4";

const PLACES_TEXT_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchText";
const PLACE_DETAILS_URL = "https://places.googleapis.com/v1/places";
const REQUEST_TIMEOUT_MS = 30_000;

const BASIC_PLACE_FIELDS = [
  "id",
  "name",
  "displayName",
  "formattedAddress",
  "googleMapsUri",
  "businessStatus",
  "location",
  "primaryType",
  "types",
];

const SEARCH_PLACE_FIELDS = BASIC_PLACE_FIELDS.map(
  (field) => `places.${field}`,
);

const STOREFRONT_PLACE_FIELDS = [
  ...BASIC_PLACE_FIELDS,
  "currentOpeningHours",
  "regularOpeningHours",
  "internationalPhoneNumber",
  "nationalPhoneNumber",
  "priceLevel",
  "rating",
  "userRatingCount",
  "websiteUri",
];

const LocalizedTextSchema = z
  .object({
    text: z.string().optional(),
    languageCode: z.string().optional(),
  })
  .passthrough();

const LatLngSchema = z
  .object({
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  })
  .passthrough();

const OpeningHoursSchema = z
  .object({
    openNow: z.boolean().optional(),
    weekdayDescriptions: z.array(z.string()).optional(),
  })
  .passthrough();

const PlaceSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    displayName: LocalizedTextSchema.optional(),
    formattedAddress: z.string().optional(),
    googleMapsUri: z.string().optional(),
    businessStatus: z.string().optional(),
    location: LatLngSchema.optional(),
    primaryType: z.string().optional(),
    types: z.array(z.string()).optional(),
    priceLevel: z.string().optional(),
    rating: z.number().optional(),
    userRatingCount: z.number().optional(),
    currentOpeningHours: OpeningHoursSchema.optional(),
    regularOpeningHours: OpeningHoursSchema.optional(),
    internationalPhoneNumber: z.string().optional(),
    nationalPhoneNumber: z.string().optional(),
    websiteUri: z.string().optional(),
  })
  .passthrough();

const TextSearchResponseSchema = z
  .object({
    places: z.array(PlaceSchema).optional(),
  })
  .passthrough();

export type Place = z.infer<typeof PlaceSchema>;

export type SearchPlacesInput = {
  query: string;
  near?: string;
  openNow?: boolean;
  maxResults?: number;
  includedType?: string;
  minRating?: number;
  regionCode?: string;
  languageCode?: string;
};

export async function searchPlaces(input: SearchPlacesInput): Promise<Place[]> {
  const body = removeUndefined({
    textQuery: input.near ? `${input.query} near ${input.near}` : input.query,
    openNow: input.openNow,
    maxResultCount: clampNumber(input.maxResults, 5, 1, 10),
    includedType: input.includedType,
    minRating: input.minRating,
    regionCode: input.regionCode,
    languageCode: input.languageCode,
  });
  const data = await googleJson({
    url: PLACES_TEXT_SEARCH_URL,
    method: "POST",
    fieldMask: SEARCH_PLACE_FIELDS.join(","),
    body,
  });
  return TextSearchResponseSchema.parse(data).places ?? [];
}

export async function placeDetails(input: {
  placeId: string;
  fieldSet?: "basic" | "storefront";
  languageCode?: string;
  regionCode?: string;
}): Promise<Place> {
  const params = new URLSearchParams();
  if (input.languageCode) params.set("languageCode", input.languageCode);
  if (input.regionCode) params.set("regionCode", input.regionCode);
  const placeId = input.placeId.replace(/^places\//, "");
  const query = params.toString();
  const url = `${PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}${query ? `?${query}` : ""}`;
  const data = await googleJson({
    url,
    method: "GET",
    fieldMask: (input.fieldSet === "storefront"
      ? STOREFRONT_PLACE_FIELDS
      : BASIC_PLACE_FIELDS
    ).join(","),
  });
  return PlaceSchema.parse(data);
}

async function googleJson(input: {
  url: string;
  method: "GET" | "POST";
  fieldMask: string;
  body?: Record<string, unknown>;
}): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": readGoogleMapsApiKey(),
    "X-Goog-FieldMask": input.fieldMask,
  };
  const init: RequestInit = {
    method: input.method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (input.body) init.body = JSON.stringify(input.body);
  const response = await fetch(input.url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Google Maps API error (${response.status}): ${text.slice(0, 500)}`,
    );
  }
  return response.json();
}

function readGoogleMapsApiKey(): string {
  const key =
    process.env["SANDI_GOOGLE_MAPS_API_KEY"]?.trim() ??
    process.env["GOOGLE_MAPS_API_KEY"]?.trim();
  if (!key) throw new Error("Google Maps API key not configured.");
  return key;
}

function clampNumber(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function removeUndefined(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}
