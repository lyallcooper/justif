/** Shared by every layer that reports a failure to user code: an `onSkip`
 * reason is prose an author has to act on, so it carries the message and not
 * the constructor name a template literal would prepend. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
