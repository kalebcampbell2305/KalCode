import { RecipeEditor } from "./RecipeEditor.tsx";
import { RecipeLaunchSheet } from "./RecipeLaunchSheet.tsx";
import { RecipeLaunchSummary } from "./RecipeLaunchSummary.tsx";
import { RecipesLibrary } from "./RecipesLibrary.tsx";

/** Mounted once in the Shell: the Recipe library, editor, launch sheet and result summary. */
export function RecipesHost() {
  return (
    <>
      <RecipesLibrary />
      <RecipeEditor />
      <RecipeLaunchSheet />
      <RecipeLaunchSummary />
    </>
  );
}
