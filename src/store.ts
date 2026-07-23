import { DataModelObject, type ApiVersion } from "@ableton-extensions/sdk";

type Obj = DataModelObject<ApiVersion>;

// Objects are cached by handle id. Handles invalidate when the object is
// deleted or moved, or when the Live Set is closed — stale access throws and
// the tool wrapper turns that into a "re-list" hint for the client.
const objects = new Map<string, Obj>();

export function remember<T extends Obj>(obj: T): string {
  const id = obj.handle.id.toString();
  objects.set(id, obj);
  return id;
}

export function resolve<T extends Obj>(
  id: string,
  type: abstract new (...args: never) => T,
): T {
  const obj = objects.get(id);
  if (!obj) {
    throw new Error(
      `Unknown object id "${id}". Ids are discovered via listing tools ` +
        `(song_get, track_get, device_get, ...) — call one of those first.`,
    );
  }
  if (!(obj instanceof type)) {
    throw new Error(
      `Object "${id}" is a ${(obj.constructor as { className?: string }).className ?? obj.constructor.name}, ` +
        `expected ${(type as unknown as { className?: string }).className ?? type.name}.`,
    );
  }
  return obj;
}

export function clear(): void {
  objects.clear();
}
