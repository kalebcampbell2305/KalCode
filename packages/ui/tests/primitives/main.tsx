import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../src/components/DropdownMenu.tsx";
import { Tooltip, TooltipProvider } from "../../src/components/Tooltip.tsx";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";

function Harness() {
  const [selectionCount, setSelectionCount] = useState(0);
  const [theme, setTheme] = useState("light");

  return (
    <main style={{ padding: 48 }}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">Editor options</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            asChild
            icon={<span>+</span>}
            description="Create a document"
            shortcut="Ctrl+N"
            onSelect={() => setSelectionCount((count) => count + 1)}
          >
            <button type="button" data-testid="new-document">
              New document
            </button>
          </DropdownMenuItem>
          <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
            <DropdownMenuRadioItem asChild value="light" description="Bright colors">
              <button type="button" data-testid="light-theme">
                Light theme
              </button>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem asChild value="dark" description="Dim colors" shortcut="Ctrl+D">
              <button type="button" data-testid="dark-theme">
                Dark theme
              </button>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <p role="status">Documents created: {selectionCount}</p>
      <p data-testid="theme-value">Theme: {theme}</p>
      <p id="save-description">Saves your current document.</p>
      <TooltipProvider>
        <Tooltip content="Save changes with Ctrl+S" side="bottom">
          <button type="button" aria-describedby="save-description">
            Save document
          </button>
        </Tooltip>
      </TooltipProvider>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing harness root");
createRoot(root).render(<Harness />);
