const MAX_EXTERNAL_URL_LENGTH = 8_192;

export function parseExternalHttpUrl(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MAX_EXTERNAL_URL_LENGTH)
    return undefined;
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return undefined;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (!parsed.hostname || parsed.username || parsed.password)
      return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}
