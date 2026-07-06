// Distinguishes "the file is not there" from real filesystem failures, so
// callers can treat absence as a normal state (first run, nothing staged yet)
// while permission and I/O errors still surface instead of masquerading as
// empty data.
export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
