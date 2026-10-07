import { useToast } from "@kalcode/ui/components";
import { useEffect, useRef } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../RuntimeProvider.tsx";
import { useWorkspaces } from "../WorkspaceProvider.tsx";
import { captureDesk } from "./capture.ts";
import { useRecipeLibrary } from "./RecipeLaunchProvider.tsx";

export const RECIPE_CAPTURE_EVENT = "kalcode:recipe-capture";

/** Asks the mounted capture listener to save the current Code desk as a Recipe. */
export function requestRecipeCapture(): void {
  window.dispatchEvent(new Event(RECIPE_CAPTURE_EVENT));
}

/** A name like "<project> desk" that no existing Recipe uses ("… desk 2", …). */
export function uniqueDeskName(project: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.toLocaleLowerCase()));
  const base = `${project} desk`.slice(0, 120);
  let name = base;
  for (let n = 2; used.has(name.toLocaleLowerCase()); n += 1) name = `${base.slice(0, 110)} ${n}`;
  return name;
}

/** Mount once under the Recipe provider: handles "kalcode:recipe-capture". */
export function useRecipeCapture(): void {
  const { client } = useRuntime();
  const { active } = useWorkspaces();
  const library = useRecipeLibrary();
  const toast = useToast();
  const latest = useRef({ client, active, library, toast });
  latest.current = { client, active, library, toast };
  useEffect(() => {
    const onCapture = () => {
      const { client, active, library, toast } = latest.current;
      if (!active) {
        toast.show({ tone: "info", title: "Open a project first", description: "A Recipe saves a project's desk." });
        return;
      }
      let captured: Awaited<ReturnType<typeof captureDesk>> | null = null;
      void (async () => {
        const name = uniqueDeskName(
          active.name,
          library.recipes.map((r) => r.name),
        );
        captured = await captureDesk(client, active.id, name);
        const saved = await library.save({ ...captured, position: library.recipes.length });
        library.editor.open(saved);
      })().catch((cause) => {
        // Not saved (for example the plan's Recipe limit): keep the captured desk open in the
        // editor so its Save explains the problem inline and nothing is lost.
        if (captured) library.editor.open(captured);
        else
          toast.show({
            tone: "danger",
            title: "Couldn't read this desk",
            description: toKalCodeError(cause).message,
          });
      });
    };
    window.addEventListener(RECIPE_CAPTURE_EVENT, onCapture);
    return () => window.removeEventListener(RECIPE_CAPTURE_EVENT, onCapture);
  }, []);
}
