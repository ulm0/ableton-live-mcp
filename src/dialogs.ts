import type { ExtensionContext } from "@ableton-extensions/sdk";
import { UsageError } from "./errors.js";

type Ctx = ExtensionContext<"1.0.0">;

// Live's modal dialogs (index.d.mts Ui.showModalDialog): a page that closes
// itself by posting close_and_send to the host, which resolves the promise
// with that string. Live cannot close a dialog from code and sets no timeout,
// so dialogs are tracked here, outside the per-request McpServer: show_dialog
// can return at once (wait:false) and dialog_result picks up the answer later.

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The host's message handler, as a page script expression: WebKit (macOS) or WebView2 (Windows).
export const DIALOG_BRIDGE = "(window.webkit?.messageHandlers?.live??window.chrome?.webview)";

// A closed dialog's answer is kept this long, and at most this many closed ones.
export const DIALOG_RESULT_TTL_MS = 10 * 60_000;
const MAX_CLOSED_DIALOGS = 20;

export type DialogKind = "html" | "url" | "form" | "status";

export type DialogRecord = {
  id: string;
  kind: DialogKind;
  openedAt: number; // ms since the epoch
  closedAt?: number;
  status: "open" | "closed" | "failed";
  result?: string; // what the page sent with close_and_send
  error?: string;
  // form dialogs: turns the page's result into the caller's answer
  answer?: (raw: string) => Record<string, unknown>;
};

export class DialogStore {
  private readonly records = new Map<string, DialogRecord>(); // in opening order
  private seq = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly context: Ctx) {}

  // The dialog this server opened that Live has not reported closed yet.
  openDialog(): DialogRecord | undefined {
    return [...this.records.values()].reverse().find((r) => r.status === "open");
  }

  get(id: string): DialogRecord | undefined {
    this.purge();
    return this.records.get(id);
  }

  // The last dialog opened by show_dialog (not the Status dialog).
  latest(): DialogRecord | undefined {
    this.purge();
    return [...this.records.values()].reverse().find((r) => r.kind !== "status");
  }

  // Opens a dialog unless one is open already (`force` opens it anyway: for a
  // dialog the user closed without Live reporting it). Returns at once; the
  // record changes when Live reports the dialog closed or failed.
  open(
    url: string,
    width: number,
    height: number,
    kind: DialogKind,
    opts: { force?: boolean; answer?: DialogRecord["answer"] } = {},
  ): DialogRecord {
    const current = this.openDialog();
    if (current && !opts.force) {
      const age = Math.round((Date.now() - current.openedAt) / 1000);
      throw new UsageError(
        `A dialog is already open in Live (dialog_id ${JSON.stringify(current.id)}, opened ${age} s ago). ` +
          "One dialog is shown at a time. Wait for its answer with dialog_result, or ask the user to close it. " +
          "If the user already closed it, pass force:true.",
      );
    }
    this.purge();
    const record: DialogRecord = {
      id: `dialog-${++this.seq}`,
      kind,
      openedAt: Date.now(),
      status: "open",
      answer: opts.answer,
    };
    this.records.set(record.id, record);
    const settle = (patch: Partial<DialogRecord>) => {
      Object.assign(record, patch, { closedAt: Date.now() });
      for (const wake of [...this.waiters]) wake();
    };
    // A dialog the user closes without close_and_send (if Live allows that)
    // is assumed to settle the promise as well: the API does not say.
    this.context.ui.showModalDialog(url, width, height).then(
      (result) => settle({ status: "closed", result: String(result ?? "") }),
      (e: unknown) => {
        const error = e instanceof Error ? e.message : e === undefined ? "Live rejected the dialog without details" : String(e);
        console.error(`[ableton-live-mcp] ${record.id} (${kind}) could not be shown: ${error}`);
        settle({ status: "failed", error });
      },
    );
    return record;
  }

  // Resolves once `record` is no longer open, after `ms`, or once `signal`
  // aborts (the client went away; the dialog stays open in Live).
  wait(record: DialogRecord, ms: number, signal?: AbortSignal): Promise<void> {
    if (record.status !== "open" || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const check = () => {
        if (record.status !== "open") finish();
      };
      const timer = Number.isFinite(ms) ? setTimeout(finish, ms) : undefined;
      this.waiters.add(check);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  // Closed dialogs are forgotten DIALOG_RESULT_TTL_MS after closing, and
  // beyond the newest MAX_CLOSED_DIALOGS; open ones are always kept.
  private purge() {
    const now = Date.now();
    const closed = [...this.records.values()].filter((r) => r.status !== "open");
    closed.forEach((r, i) => {
      if (now - (r.closedAt ?? now) > DIALOG_RESULT_TTL_MS || i < closed.length - MAX_CLOSED_DIALOGS)
        this.records.delete(r.id);
    });
  }
}

// The answer of a dialog as show_dialog and dialog_result report it.
export function dialogOutcome(r: DialogRecord, now = Date.now()): Record<string, unknown> {
  const head = { dialog_id: r.id, status: r.status };
  if (r.status === "open") return { ...head, open_s: Math.round((now - r.openedAt) / 1000) };
  if (r.status === "failed") return { ...head, error: r.error };
  const raw = r.result ?? "";
  return { ...head, ...(r.answer ? r.answer(raw) : { result: raw }) };
}

// showModalDialog loads file:, data:, https: and http://localhost URLs
// (index.d.mts); data: pages are what `html` is for.
export function checkDialogUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`Invalid url ${JSON.stringify(raw)}: give an absolute URL.`);
  }
  if (u.protocol === "https:" || u.protocol === "file:" || (u.protocol === "http:" && u.hostname === "localhost"))
    return u.href;
  throw new UsageError(
    `url must be https:, file: or http://localhost (the schemes Live's dialogs load), not ${u.protocol}//${u.host}. ` +
      "For a page of your own, pass it as html.",
  );
}

// -- form dialogs --------------------------------------------------------------

export type FormField = {
  name: string;
  label?: string;
  type: "text" | "textarea" | "number" | "checkbox" | "select";
  default?: string | number | boolean;
  options?: string[];
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
};
export type FormSpec = { title?: string; message?: string; fields?: FormField[]; choices?: string[] };

// The buttons of a form: `choices`, or OK (and Cancel when there are fields).
// Throws if the form contradicts itself; nothing is shown then.
export function formChoices(form: FormSpec): string[] {
  const fields = form.fields ?? [];
  if (!form.title && !form.message && !fields.length)
    throw new UsageError("form needs a title, a message or fields.");
  const names = new Set<string>();
  fields.forEach((f, i) => {
    const where = `form.fields[${i}] (${JSON.stringify(f.name)})`;
    if (names.has(f.name)) throw new UsageError(`${where}: the field name is used twice.`);
    names.add(f.name);
    if ((f.type === "select") !== (f.options !== undefined))
      throw new UsageError(`${where}: options go with type "select", and a select needs them.`);
    if (f.type !== "number" && (f.min !== undefined || f.max !== undefined || f.step !== undefined))
      throw new UsageError(`${where}: min, max and step only apply to type "number".`);
    if (f.min !== undefined && f.max !== undefined && f.min > f.max)
      throw new UsageError(`${where}: min ${f.min} is above max ${f.max}.`);
    if (f.default === undefined) return;
    const want = f.type === "checkbox" ? "boolean" : f.type === "number" ? "number" : "string";
    if (typeof f.default !== want) throw new UsageError(`${where}: a ${f.type} field's default is a ${want}.`);
    if (f.type === "select" && !f.options?.includes(f.default as string))
      throw new UsageError(`${where}: the default must be one of the options.`);
  });
  const choices = form.choices ?? (fields.length ? ["OK", "Cancel"] : ["OK"]);
  if (new Set(choices).size !== choices.length) throw new UsageError("form.choices: each button label once.");
  return choices;
}

// The page's script. It holds no caller text: field names and types are read
// back from escaped data-* attributes, and the result is
// {"choice_index": n, "values": {...}} (numbers as numbers or null, checkboxes
// as booleans). Buttons are plain type="button" outside any <form>, so Enter
// never picks a choice (no accidental "Delete").
const FORM_SCRIPT = `(function () {
  var host = ${DIALOG_BRIDGE};
  function values() {
    var out = {};
    document.querySelectorAll("[data-field]").forEach(function (el) {
      var name = el.getAttribute("data-field");
      var type = el.getAttribute("data-type");
      if (type === "checkbox") out[name] = !!el.checked;
      else if (type === "number") {
        var v = String(el.value).trim();
        out[name] = v === "" || !isFinite(Number(v)) ? null : Number(v);
      } else out[name] = String(el.value);
    });
    return out;
  }
  document.querySelectorAll("button[data-choice]").forEach(function (b) {
    b.addEventListener("click", function () {
      var answer = { choice_index: Number(b.getAttribute("data-choice")), values: values() };
      host.postMessage({ method: "close_and_send", params: [JSON.stringify(answer)] });
    });
  });
})();`;

const FORM_STYLE =
  "body{font-family:sans-serif;font-size:13px;background:#363636;color:#b5b5b5;padding:16px;margin:0}" +
  "h3{margin:0 0 8px;color:#fff}p{white-space:pre-wrap;margin:0 0 12px}" +
  ".row{margin:0 0 10px}.row label{display:block;margin:0 0 3px}" +
  ".check{display:flex;align-items:center;gap:6px}.check label{display:inline;margin:0}" +
  "input:not([type=checkbox]),textarea,select{box-sizing:border-box;width:100%;background:#1e1e1e;" +
  "color:#e0e0e0;border:1px solid #555;padding:4px;font:inherit}" +
  ".buttons{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:14px}" +
  "button{background:#4b4b4b;color:#e0e0e0;border:1px solid #666;padding:5px 14px;font:inherit}" +
  "button.primary{background:#ffad56;color:#1e1e1e;border-color:#ffad56}";

// A form dialog page: every caller string is HTML-escaped into text or
// attribute values, so a title or label can never become markup.
export function formHtml(form: FormSpec, choices: string[]): string {
  const e = escapeHtml;
  const field = (f: FormField, i: number) => {
    const id = `f${i}`;
    const attrs =
      `id="${id}" data-field="${e(f.name)}" data-type="${f.type}"` +
      (i === 0 ? " autofocus" : "") +
      (f.placeholder !== undefined ? ` placeholder="${e(f.placeholder)}"` : "");
    const label = `<label for="${id}">${e(f.label ?? f.name)}</label>`;
    const text = f.default === undefined ? "" : e(String(f.default));
    switch (f.type) {
      case "checkbox":
        return `<div class="row check"><input type="checkbox" ${attrs}${f.default === true ? " checked" : ""}>${label}</div>`;
      case "textarea":
        return `<div class="row">${label}<textarea rows="4" ${attrs}>${text}</textarea></div>`;
      case "select": {
        const options = (f.options ?? [])
          .map((o) => `<option value="${e(o)}"${o === f.default ? " selected" : ""}>${e(o)}</option>`)
          .join("");
        return `<div class="row">${label}<select ${attrs}>${options}</select></div>`;
      }
      case "number": {
        const range = (["min", "max", "step"] as const)
          .map((k) => (f[k] !== undefined ? ` ${k}="${f[k]}"` : ""))
          .join("");
        return `<div class="row">${label}<input type="number" ${attrs} value="${text}"${range}></div>`;
      }
      default:
        return `<div class="row">${label}<input type="text" ${attrs} value="${text}"></div>`;
    }
  };
  const buttons = choices
    .map((c, i) => `<button type="button" data-choice="${i}"${i === 0 ? ' class="primary"' : ""}>${e(c)}</button>`)
    .join("");
  return (
    `<!doctype html><meta charset="utf-8"><style>${FORM_STYLE}</style><body>` +
    (form.title ? `<h3>${e(form.title)}</h3>` : "") +
    (form.message ? `<p>${e(form.message)}</p>` : "") +
    (form.fields ?? []).map(field).join("") +
    `<div class="buttons">${buttons}</div>` +
    `<script>${FORM_SCRIPT}</script></body>`
  );
}

// The caller's answer from a form page's result: the button (`choice`, its
// `choice_index`) and, with fields, `values` by field name — each of the
// field's type (number: a number or null; checkbox: a boolean). Anything else
// (e.g. a dialog closed without a button, if Live allows it) is choice null
// with the raw result.
export function formAnswer(form: FormSpec, choices: string[], raw: string): Record<string, unknown> {
  let data: { choice_index?: unknown; values?: Record<string, unknown> } | undefined;
  try {
    data = JSON.parse(raw);
  } catch {
    data = undefined;
  }
  const index = data?.choice_index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= choices.length)
    return { choice: null, result: raw, problem: "the dialog closed without one of the form's buttons" };
  const fields = form.fields ?? [];
  const got = typeof data?.values === "object" && data.values !== null ? data.values : {};
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    const v = Object.prototype.hasOwnProperty.call(got, f.name) ? got[f.name] : undefined;
    values[f.name] =
      f.type === "checkbox"
        ? v === true
        : f.type === "number"
          ? typeof v === "number" && Number.isFinite(v)
            ? v
            : null
          : typeof v === "string"
            ? v
            : "";
  }
  return { choice: choices[index], choice_index: index, values: fields.length ? values : undefined };
}
