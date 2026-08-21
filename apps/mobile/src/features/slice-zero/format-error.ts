export function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
