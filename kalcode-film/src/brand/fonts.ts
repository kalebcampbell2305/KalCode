import { loadFont } from "@remotion/fonts";
import { continueRender, delayRender, staticFile } from "remotion";

// The desktop app's own bundled faces (OFL): Lexend Deca, Lexend Exa, JetBrains Mono.
// Rendering blocks until every face is ready, so no frame can use a fallback font.
const handle = delayRender("fonts");
Promise.all([
  loadFont({ family: "Lexend Deca", url: staticFile("fonts/lexend-deca.woff2"), weight: "100 900" }),
  loadFont({ family: "Lexend Exa", url: staticFile("fonts/lexend-exa.woff2"), weight: "100 900" }),
  loadFont({ family: "JetBrains Mono", url: staticFile("fonts/jetbrains-mono.woff2"), weight: "100 800" }),
])
  .then(() =>
    Promise.all(["Lexend Deca", "Lexend Exa", "JetBrains Mono"].map((f) => document.fonts.load(`500 20px "${f}"`))),
  )
  .then((faces) => {
    if (faces.some((f) => f.length === 0)) throw new Error("font failed to load");
    continueRender(handle);
  });
