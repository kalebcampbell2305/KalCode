import { useEffect, useSyncExternalStore } from "react";
import { useNavigation } from "../../shell/navigation.tsx";

const listeners = new Set<() => void>();
let requested: string | null = null;
export function requestSettingsSection(id: string) {
  requested = id;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const snapshot = () => requested;

export function focusSettingsSection(id: string): boolean {
  const section = document.getElementById(id);
  if (!section) return false;
  const target = section.querySelector<HTMLElement>("h2") ?? section;
  target.tabIndex = -1;
  section.scrollIntoView?.({ block: "start" });
  target.focus({ preventScroll: true });
  return true;
}

export function useSettingsNavigation() {
  const request = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { recordLocation, registerRestorer } = useNavigation();
  useEffect(() => {
    if (!request) return;
    focusSettingsSection(request);
    requested = null;
    for (const listener of listeners) listener();
  }, [request]);
  useEffect(
    () =>
      registerRestorer?.((entry) => {
        if (entry.destination !== "settings" || entry.target?.kind !== "section") return undefined;
        return focusSettingsSection(entry.target.sectionId);
      }),
    [registerRestorer],
  );
  return (element: HTMLElement) => {
    const section =
      element.closest<HTMLElement>("[data-settings-section]") ?? element.closest<HTMLElement>("section[id]");
    if (!section?.id) return;
    recordLocation?.({
      destination: "settings",
      label: section.querySelector("h2")?.textContent ?? section.id,
      target: { kind: "section", sectionId: section.id },
    });
  };
}
