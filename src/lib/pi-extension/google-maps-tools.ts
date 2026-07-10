import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { textResult } from "./tool-results";
import { z } from "zod/v4";

const PLACES_TEXT_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchText";
const PLACE_DETAILS_URL = "https://places.googleapis.com/v1/places";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

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
] as const;

const SEARCH_PLACE_FIELDS = [
  ...BASIC_PLACE_FIELDS.map((field) => `places.${field}`),
] as const;

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
] as const;

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

type Place = z.infer<typeof PlaceSchema>;

const TextSearchResponseSchema = z
  .object({
    places: z.array(PlaceSchema).optional(),
  })
  .passthrough();

const SearchParams = Type.Object({
  query: Type.String({
    description:
      "Place search query, such as restaurants, vegan food, pharmacy, or Target.",
  }),
  near: Type.Optional(
    Type.String({
      description:
        "Optional address, neighborhood, city, or landmark to search near. The tool appends this to the text query rather than geocoding it.",
    }),
  ),
  openNow: Type.Optional(
    Type.Boolean({
      description: "When true, ask Google Places to return only open places.",
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum places to return. Defaults to 5, max 10.",
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
    }),
  ),
  includedType: Type.Optional(
    Type.String({
      description:
        "Optional Google place type, such as restaurant, cafe, grocery_store, or hardware_store.",
    }),
  ),
  minRating: Type.Optional(
    Type.Number({
      description: "Optional minimum rating from 0.0 to 5.0.",
      minimum: 0,
      maximum: 5,
    }),
  ),
  regionCode: Type.Optional(
    Type.String({
      description:
        "Optional two-letter region code, such as US. Useful for ambiguous addresses.",
    }),
  ),
  languageCode: Type.Optional(
    Type.String({
      description: "Optional BCP-47 language code, such as en-US.",
    }),
  ),
});

const PlaceDetailsParams = Type.Object({
  placeId: Type.String({
    description:
      "Google Places place ID or resource name returned by maps_search_places.",
  }),
  fieldSet: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("storefront")], {
      description:
        "basic returns identity/location fields. storefront also returns Enterprise-billed fields: hours, phone, website, rating, and price. Defaults to basic.",
    }),
  ),
  languageCode: Type.Optional(
    Type.String({
      description: "Optional BCP-47 language code, such as en-US.",
    }),
  ),
  regionCode: Type.Optional(
    Type.String({
      description: "Optional two-letter region code, such as US.",
    }),
  ),
});

export default function googleMapsToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "maps_search_places",
      label: "Search Google Maps Places",
      description:
        "Search Google Maps Places for restaurants, stores, services, or other places, optionally near a user-provided address or area.",
      promptSnippet:
        "Use maps_search_places for live place lookup, especially restaurants or stores near an address. For hours, phone, or website, follow up with maps_place_details on the chosen place ID.",
      promptGuidelines: [
        "Prefer this over general web search for live local place results.",
        "Use near for user-provided addresses or neighborhoods; do not guess an address.",
        "Return a short list with names, addresses, business status when present, and Google Maps links.",
        "If results are ambiguous, say so and ask which place to inspect before using maps_place_details.",
        "Do not fetch hours, phone, website, rating, or price unless the user explicitly asks for those details.",
      ],
      parameters: SearchParams,
      async execute(_toolCallId, params, signal) {
        const input = normalizeSearchInput(params);
        const fieldMask = SEARCH_PLACE_FIELDS.join(",");
        const data = await postGoogleJson(
          PLACES_TEXT_SEARCH_URL,
          buildSearchBody(input),
          fieldMask,
          signal,
        );
        const parsed = TextSearchResponseSchema.parse(data);
        const places = parsed.places ?? [];
        return textResult(formatSearchResults(places), {
          count: places.length,
          fieldMask,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "maps_place_details",
      label: "Get Google Maps Place Details",
      description:
        "Get Google Maps metadata for a place ID, including address, Maps link, hours, phone number, website, rating, and price when requested.",
      promptSnippet:
        "Use maps_place_details after maps_search_places when someone asks for store metadata like hours, phone number, website, address, or whether a place is open.",
      promptGuidelines: [
        "Use fieldSet: storefront only when the user explicitly asks for hours, phone, website, rating, price, or similar storefront metadata.",
        "Use fieldSet: basic when only confirming identity, address, or Maps link.",
        "Cite the returned Google Maps link when sharing place metadata.",
      ],
      parameters: PlaceDetailsParams,
      async execute(_toolCallId, params, signal) {
        const input = normalizePlaceDetailsInput(params);
        const fieldMask = detailsFieldMask(input.fieldSet);
        const url = placeDetailsUrl(input);
        const data = await getGoogleJson(url, fieldMask, signal);
        const place = PlaceSchema.parse(data);
        return textResult(formatPlaceDetails(place), {
          placeId: place.id ?? input.placeId,
          fieldSet: input.fieldSet,
          fieldMask,
        });
      },
    }),
  );
}

type SearchInput = {
  query: string;
  near?: string;
  openNow?: boolean;
  maxResults: number;
  includedType?: string;
  minRating?: number;
  regionCode?: string;
  languageCode?: string;
};

type PlaceDetailsInput = {
  placeId: string;
  fieldSet: "basic" | "storefront";
  regionCode?: string;
  languageCode?: string;
};

function normalizeSearchInput(params: {
  query: string;
  near?: string;
  openNow?: boolean;
  maxResults?: number;
  includedType?: string;
  minRating?: number;
  regionCode?: string;
  languageCode?: string;
}): SearchInput {
  const input: SearchInput = {
    query: requireNonEmpty(params.query, "query"),
    maxResults: clampInteger(
      params.maxResults,
      DEFAULT_SEARCH_LIMIT,
      1,
      MAX_SEARCH_LIMIT,
    ),
  };
  const near = readNonEmpty(params.near);
  const includedType = readNonEmpty(params.includedType);
  const regionCode = normalizeRegionCode(params.regionCode);
  const languageCode = readNonEmpty(params.languageCode);
  const minRating = normalizeRating(params.minRating);

  if (near) input.near = near;
  if (params.openNow !== undefined) input.openNow = params.openNow;
  if (includedType) input.includedType = includedType;
  if (minRating !== undefined) input.minRating = minRating;
  if (regionCode) input.regionCode = regionCode;
  if (languageCode) input.languageCode = languageCode;
  return input;
}

function normalizePlaceDetailsInput(params: {
  placeId: string;
  fieldSet?: "basic" | "storefront";
  regionCode?: string;
  languageCode?: string;
}): PlaceDetailsInput {
  const input: PlaceDetailsInput = {
    placeId: normalizePlaceId(params.placeId),
    fieldSet: params.fieldSet === "storefront" ? "storefront" : "basic",
  };
  const regionCode = normalizeRegionCode(params.regionCode);
  const languageCode = readNonEmpty(params.languageCode);
  if (regionCode) input.regionCode = regionCode;
  if (languageCode) input.languageCode = languageCode;
  return input;
}

function buildSearchBody(input: SearchInput): Record<string, unknown> {
  return removeUndefined({
    textQuery: input.near ? `${input.query} near ${input.near}` : input.query,
    pageSize: input.maxResults,
    openNow: input.openNow,
    includedType: input.includedType,
    minRating: input.minRating,
    regionCode: input.regionCode,
    languageCode: input.languageCode,
  });
}

function detailsFieldMask(fieldSet: "basic" | "storefront"): string {
  return (
    fieldSet === "basic" ? BASIC_PLACE_FIELDS : STOREFRONT_PLACE_FIELDS
  ).join(",");
}

function placeDetailsUrl(input: PlaceDetailsInput): string {
  const url = new URL(
    `${PLACE_DETAILS_URL}/${encodeURIComponent(input.placeId)}`,
  );
  if (input.languageCode)
    url.searchParams.set("languageCode", input.languageCode);
  if (input.regionCode) url.searchParams.set("regionCode", input.regionCode);
  return url.toString();
}

async function postGoogleJson(
  url: string,
  body: Record<string, unknown>,
  fieldMask: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return googleFetch(url, fieldMask, signal, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function getGoogleJson(
  url: string,
  fieldMask: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return googleFetch(url, fieldMask, signal, { method: "GET" });
}

async function googleFetch(
  url: string,
  fieldMask: string,
  signal: AbortSignal | undefined,
  init: { method: "GET" | "POST"; body?: string },
): Promise<unknown> {
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (signal) signals.push(signal);

  const requestInit: RequestInit = {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": readGoogleMapsApiKey(),
      "X-Goog-FieldMask": fieldMask,
    },
    signal: AbortSignal.any(signals),
  };
  if (init.body !== undefined) requestInit.body = init.body;

  const response = await fetch(url, requestInit);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Google Maps API error (${response.status}): ${errorBody.slice(0, 500)}`,
    );
  }

  const parsed: unknown = await response.json();
  return parsed;
}

function readGoogleMapsApiKey(): string {
  const value =
    process.env["SANDI_GOOGLE_MAPS_API_KEY"]?.trim() ||
    process.env["GOOGLE_MAPS_API_KEY"]?.trim();
  if (value) return value;
  throw new Error(
    "Google Maps API key not configured. Set SANDI_GOOGLE_MAPS_API_KEY or GOOGLE_MAPS_API_KEY.",
  );
}

function formatSearchResults(places: readonly Place[]): string {
  if (places.length === 0) return "No Google Maps places found.";
  return places
    .map((place, index) => formatSearchResult(place, index))
    .join("\n\n");
}

function formatSearchResult(place: Place, index: number): string {
  return [
    `${index + 1}. ${placeName(place)}`,
    place.formattedAddress ? `Address: ${place.formattedAddress}` : undefined,
    formatRating(place),
    place.priceLevel
      ? `Price: ${formatPriceLevel(place.priceLevel)}`
      : undefined,
    place.businessStatus
      ? `Status: ${formatBusinessStatus(place.businessStatus)}`
      : undefined,
    place.id ? `Place ID: ${place.id}` : undefined,
    place.googleMapsUri ? `Maps: ${place.googleMapsUri}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatPlaceDetails(place: Place): string {
  return [
    placeName(place),
    place.formattedAddress ? `Address: ${place.formattedAddress}` : undefined,
    place.businessStatus
      ? `Status: ${formatBusinessStatus(place.businessStatus)}`
      : undefined,
    formatOpenNow(place.currentOpeningHours),
    formatHours("Current hours", place.currentOpeningHours),
    formatHours("Regular hours", place.regularOpeningHours),
    place.nationalPhoneNumber
      ? `Phone: ${place.nationalPhoneNumber}`
      : undefined,
    place.internationalPhoneNumber
      ? `International phone: ${place.internationalPhoneNumber}`
      : undefined,
    place.websiteUri ? `Website: ${place.websiteUri}` : undefined,
    formatRating(place),
    place.priceLevel
      ? `Price: ${formatPriceLevel(place.priceLevel)}`
      : undefined,
    place.id ? `Place ID: ${place.id}` : undefined,
    place.googleMapsUri ? `Maps: ${place.googleMapsUri}` : undefined,
    formatLocation(place),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function placeName(place: Place): string {
  return place.displayName?.text ?? place.name ?? place.id ?? "Unnamed place";
}

function formatRating(place: Place): string | undefined {
  if (place.rating === undefined) return undefined;
  const count =
    place.userRatingCount === undefined
      ? ""
      : ` (${place.userRatingCount.toLocaleString("en-US")} ratings)`;
  return `Rating: ${place.rating.toFixed(1)}${count}`;
}

function formatOpenNow(
  hours: Place["currentOpeningHours"],
): string | undefined {
  if (hours?.openNow === undefined) return undefined;
  return `Open now: ${hours.openNow ? "yes" : "no"}`;
}

function formatHours(
  label: string,
  hours: Place["currentOpeningHours"],
): string | undefined {
  if (!hours?.weekdayDescriptions || hours.weekdayDescriptions.length === 0) {
    return undefined;
  }
  return `${label}:\n${hours.weekdayDescriptions
    .map((line) => `- ${line}`)
    .join("\n")}`;
}

function formatLocation(place: Place): string | undefined {
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  if (latitude === undefined || longitude === undefined) return undefined;
  return `Coordinates: ${latitude}, ${longitude}`;
}

function formatBusinessStatus(status: string): string {
  return status
    .replace(/^OPERATIONAL$/, "operational")
    .replace(/_/g, " ")
    .toLowerCase();
}

function formatPriceLevel(priceLevel: string): string {
  return priceLevel
    .replace(/^PRICE_LEVEL_/, "")
    .replace(/_/g, " ")
    .toLowerCase();
}

function normalizePlaceId(value: string): string {
  const trimmed = requireNonEmpty(value, "placeId");
  return trimmed.startsWith("places/")
    ? trimmed.slice("places/".length)
    : trimmed;
}

function normalizeRegionCode(value: string | undefined): string | undefined {
  const trimmed = readNonEmpty(value);
  if (!trimmed) return undefined;
  return trimmed.toUpperCase();
}

function normalizeRating(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(5, Math.max(0, value));
}

function clampInteger(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty.`);
  return trimmed;
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function removeUndefined(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== undefined),
  );
}
