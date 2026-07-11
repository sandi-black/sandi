// This value is part of both the model-facing tool schema and the desktop wire
// boundary. Keeping it in a dependency-free module prevents those two layers
// from drifting while leaving the regex implementation on the client.
export const MAX_LOCAL_GREP_PATTERN_CHARS = 16_384;
