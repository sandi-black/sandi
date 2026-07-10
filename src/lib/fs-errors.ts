// Distinguishes "the file is not there" from real filesystem failures, so
// callers can treat absence as a normal state (first run, nothing staged yet)
// while permission and I/O errors still surface instead of masquerading as
// empty data.
//
// Two predicates because callers legitimately differ on ENOTDIR (a parent
// path segment being a file where a directory belongs): defaulting stores
// treat only ENOENT as absence so a blocked path surfaces as the
// data-integrity failure it is, while path-probing callers (does this
// config overlay exist at all?) also accept ENOTDIR as "not there".
export function isMissingFileError(error: unknown): boolean {
  return errnoCode(error) === "ENOENT";
}

export function isMissingPathError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function errnoCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}
