// An error in the caller's arguments that the server detects itself (index out
// of range, missing or conflicting field, wrong object type). The tool wrapper
// reports it without the stale-id hint, which only fits host-side failures.
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
