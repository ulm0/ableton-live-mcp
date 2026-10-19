import {
  DataModelObject,
  type ContextMenuScope,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";
import { num } from "./serialize.js";
import { remember } from "./store.js";

type Ctx = ExtensionContext<"1.0.0">;
export type SelectionScope = ContextMenuScope<"1.0.0">;

// The host hands the user's selection to an extension only as the argument of
// a context-menu command (index.d.mts ContextMenuScope, ArrangementSelection,
// ClipSlotSelection): there is no selection getter. So every scope gets a
// "MCP: Use as selection" entry, and the last capture is kept here, outside
// the per-request McpServer, for selection_get / selection_wait.

// Every scope of API 1.0.0. The first nine pass the clicked object's handle,
// the other three a selection.
export const SELECTION_SCOPES = [
  "AudioClip",
  "AudioTrack",
  "ClipSlot",
  "DrumRack",
  "MidiClip",
  "MidiTrack",
  "Sample",
  "Scene",
  "Simpler",
  "ClipSlotSelection",
  "AudioTrack.ArrangementSelection",
  "MidiTrack.ArrangementSelection",
] as const satisfies readonly SelectionScope[];
// Fails to compile if the SDK gains a scope that is not listed above.
type NoScopeMissing<T extends never> = T;
export type AllScopesListed = NoScopeMissing<Exclude<SelectionScope, (typeof SELECTION_SCOPES)[number]>>;

export const SELECTION_MENU_TITLE = "MCP: Use as selection";
export const selectCommandId = (scope: SelectionScope) => `ableton-live-mcp.select.${scope}`;

// A ClipSlotSelection can span the whole session: keep a bounded number.
const MAX_CAPTURED = 1000;

export type CapturedObject = { object: DataModelObject<"1.0.0">; id: string } | { error: string };

export type Selection = {
  seq: number;
  capturedAt: number; // ms since the epoch
  scope: SelectionScope;
  kind: "object" | "clip_slots" | "arrangement";
  objects: CapturedObject[];
  // arrangement selections: the time selection, in beats
  time?: { start: number; end: number };
  // what in the command argument did not match the documented shape
  problems?: string[];
};

// Only what the host hands out: a bigint id (index.d.mts Handle). JSON (e.g.
// execute_command arguments) cannot carry a bigint, so handles can't be forged.
const isHandle = (h: unknown): h is Handle =>
  typeof h === "object" && h !== null && typeof (h as { id?: unknown }).id === "bigint";

const isTime = (v: unknown): v is number | bigint =>
  (typeof v === "number" && Number.isFinite(v)) || typeof v === "bigint";

export class SelectionStore {
  private last: Selection | undefined;
  private seq = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly context: Ctx) {}

  latest(): Selection | undefined {
    return this.last;
  }

  get latestSeq(): number {
    return this.last?.seq ?? 0;
  }

  // A context-menu command fired: resolve what it carries, each handle on its
  // own (one stale or unknown handle must not lose the others), and keep it.
  capture(scope: SelectionScope, arg: unknown): Selection {
    const kind =
      scope === "ClipSlotSelection" ? "clip_slots" : scope.endsWith(".ArrangementSelection") ? "arrangement" : "object";
    const problems: string[] = [];
    const record = typeof arg === "object" && arg !== null ? (arg as Record<string, unknown>) : undefined;
    let handles: unknown[] = [];
    let time: Selection["time"];
    if (kind === "object") {
      // documented: the handle; a list is accepted too
      handles = Array.isArray(arg) ? arg : [arg];
    } else {
      const list = record?.[kind === "clip_slots" ? "selected_clip_slots" : "selected_lanes"];
      if (Array.isArray(list)) handles = list;
      else problems.push(`the argument has no ${kind === "clip_slots" ? "selected_clip_slots" : "selected_lanes"} list`);
      if (kind === "arrangement") {
        const start = record?.time_selection_start;
        const end = record?.time_selection_end;
        // in order, whichever way the user dragged
        if (isTime(start) && isTime(end))
          time = { start: Math.min(num(start), num(end)), end: Math.max(num(start), num(end)) };
        else problems.push("the argument has no numeric time_selection_start / time_selection_end");
      }
    }
    if (handles.length > MAX_CAPTURED) {
      problems.push(`only the first ${MAX_CAPTURED} of ${handles.length} selected objects were kept`);
      handles = handles.slice(0, MAX_CAPTURED);
    }
    const selection: Selection = {
      seq: ++this.seq,
      capturedAt: Date.now(),
      scope,
      kind,
      objects: handles.map((h) => this.resolve(h)),
      time,
      problems: problems.length ? problems : undefined,
    };
    this.last = selection;
    console.log(
      `[ableton-live-mcp] selection ${selection.seq} captured from ${scope}: ${selection.objects.length} object(s)`,
    );
    for (const wake of [...this.waiters]) wake();
    return selection;
  }

  private resolve(h: unknown): CapturedObject {
    if (!isHandle(h)) {
      const what =
        h === undefined
          ? "nothing"
          : h === null
            ? "null"
            : typeof h === "object"
              ? "an object without a bigint id"
              : `a ${typeof h}`;
      return { error: `Live passed ${what} where an object handle was expected` };
    }
    try {
      const object = this.context.getObjectFromHandle(h, DataModelObject);
      return { object, id: remember(object) };
    } catch (e) {
      return { error: `Live could not resolve the object: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // The latest capture once it is newer than `after` (only the latest one is
  // kept), or undefined after `ms` or once `signal` aborts (the client went away).
  wait(after: number, ms: number, signal?: AbortSignal): Promise<Selection | undefined> {
    const newer = () => (this.last && this.last.seq > after ? this.last : undefined);
    if (newer() || signal?.aborted) return Promise.resolve(newer());
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener("abort", finish);
        resolve(newer());
      };
      const check = () => {
        if (newer()) finish();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.add(check);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
}

// One "MCP: Use as selection" entry per scope, each bound to its own command
// (ableton-live-mcp.select.<scope>) so the capture knows which shape it got.
// A scope that fails to register is logged and skipped.
export function registerSelectionMenus(context: Ctx, store: SelectionStore): void {
  for (const scope of SELECTION_SCOPES) {
    const commandId = selectCommandId(scope);
    try {
      context.commands.registerCommand(commandId, (...args: unknown[]) => {
        try {
          store.capture(scope, args[0]);
        } catch (e) {
          console.error(`[ableton-live-mcp] could not capture the ${scope} selection:`, e);
        }
      });
      context.ui
        .registerContextMenuAction(scope, SELECTION_MENU_TITLE, commandId)
        .catch((e: unknown) => console.error(`[ableton-live-mcp] could not add the ${scope} menu entry:`, e));
    } catch (e) {
      console.error(`[ableton-live-mcp] could not register the ${scope} selection command:`, e);
    }
  }
}
