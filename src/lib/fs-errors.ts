// Distinguishes "the file is not there" from real filesystem failures, so
// callers can treat absence as a normal state (first run, nothing staged yet)
// while permission and I/O errors still surface instead of masquerading as
// empty data. ENOTDIR is included alongside ENOENT because a parent path
// segment being a file (not a directory) also means the target is missing.
export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
