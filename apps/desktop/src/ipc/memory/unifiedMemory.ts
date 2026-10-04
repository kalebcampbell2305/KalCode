import type { MemoryInput, MemoryRecord, MemorySettings } from "@kalcode/protocol";
import type { DashboardHandlers } from "./dashboard.ts";

/** Test transport only. Production memory is persisted and validated by the native store. */
export function createUnifiedMemory(): { handlers: DashboardHandlers } {
  const records = new Map<string, MemoryRecord>();
  const settings = new Map<string, MemorySettings>();
  let nextId = 1;
  const preferences = (id: string) => settings.get(id) ?? { autoCapture: true, sharingEnabled: true };
  const handlers: DashboardHandlers = {
    unified_memory_retrieve: (args) =>
      preferences(String(args?.workspaceId)).sharingEnabled
        ? [...records.values()]
            .filter(
              (record) =>
                record.workspaceId === args?.workspaceId &&
                !record.stale &&
                (record.pinned ||
                  `${record.title} ${record.content}`.toLowerCase().includes(String(args?.query ?? "").toLowerCase())),
            )
            .map((record) => `${record.title}: ${record.content}`)
            .join("\n")
            .slice(0, 4096)
        : "",
    unified_memory_list: (args) =>
      [...records.values()].filter(
        (item) =>
          item.workspaceId === args?.workspaceId &&
          `${item.title} ${item.content}`.toLowerCase().includes(String(args?.query ?? "").toLowerCase()),
      ),
    unified_memory_save: (args) => {
      const input = args?.input as MemoryInput;
      const workspaceId = String(args?.workspaceId);
      const old = args?.id ? records.get(String(args.id)) : null;
      if (args?.id && (!old || old.workspaceId !== workspaceId))
        throw {
          category: "validation",
          code: "memory_missing",
          message: "That memory no longer exists.",
          retryable: false,
        };
      if (!input.title.trim() || !input.content.trim())
        throw {
          category: "validation",
          code: "memory_empty",
          message: "Add a title and some knowledge to remember.",
          retryable: false,
        };
      const now = new Date().toISOString();
      const saved: MemoryRecord = {
        ...input,
        id: old?.id ?? `memory-${nextId++}`,
        workspaceId,
        fileHash: null,
        stale: old?.stale ?? false,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
      };
      records.set(saved.id, saved);
      return saved;
    },
    unified_memory_review: (args) => {
      const item = records.get(String(args?.id));
      if (!item || item.workspaceId !== args?.workspaceId)
        throw {
          category: "validation",
          code: "memory_missing",
          message: "That memory no longer exists.",
          retryable: false,
        };
      const reviewed = { ...item, stale: false, updatedAt: new Date().toISOString() };
      records.set(item.id, reviewed);
      return reviewed;
    },
    unified_memory_delete: (args) => {
      const item = records.get(String(args?.id));
      if (item && item.workspaceId === args?.workspaceId) records.delete(item.id);
    },
    unified_memory_preferences: (args) => preferences(String(args?.workspaceId)),
    unified_memory_set_preferences: (args) => {
      const value = args?.settings as MemorySettings;
      settings.set(String(args?.workspaceId), value);
      return value;
    },
  };
  return { handlers };
}
