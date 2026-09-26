import { Activity } from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { WidgetDefinition } from "../../src/shell/widgets/registry.tsx";
import { WidgetFrame } from "../../src/shell/widgets/WidgetFrame.tsx";
import "@kalcode/ui/tokens.css";
import "@kalcode/ui/base.css";

const widget: WidgetDefinition = {
  id: "pointer-fixture",
  title: "Activity fixture",
  anchor: "pointer-fixture",
  description: "Pointer capture regression fixture",
  icon: Activity,
  Body: () => <div style={{ height: 600 }}>Widget content</div>,
  defaultHeight: 240,
  defaultVisible: true,
};

function Harness() {
  const [moves, setMoves] = useState(0);
  const [height, setHeight] = useState(widget.defaultHeight);
  return (
    <main style={{ padding: 40, width: 440 }}>
      <WidgetFrame
        widget={widget}
        height={height}
        index={0}
        total={2}
        onMove={() => setMoves((count) => count + 1)}
        onResize={setHeight}
        onHide={() => undefined}
        indexAt={() => 1}
      />
      <output data-testid="moves">{moves}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing harness root");
createRoot(root).render(<Harness />);
