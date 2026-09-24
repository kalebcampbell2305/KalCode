import "@kalcode/ui/fonts.css";
import "@kalcode/ui/tokens.css";
import "@kalcode/ui/base.css";
import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("KalCode: #root element missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
