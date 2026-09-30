// "atlas" — the fictional sample product the story builds (sample project data). A light
// marketing page so the Browser pane reads instantly against the dark KalCode UI.
import type React from "react";
import { FONT } from "../brand/tokens";

const ink = "#0b1322";
const sub = "#51607a";
const acc = "#2f6bec";

export const AtlasPage: React.FC<{ variant: "old" | "new" | "live"; t?: number }> = ({ variant, t = 1 }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: "#f5f7fb",
      fontFamily: FONT.ui,
      color: ink,
      overflow: "hidden",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 22, padding: "18px 30px", fontSize: 15, color: sub }}>
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          background: ink,
          display: "grid",
          placeItems: "center",
          color: "#fff",
          fontWeight: 700,
          fontSize: 15,
        }}
      >
        a
      </div>
      <span style={{ color: ink, fontWeight: 600, fontSize: 18 }}>atlas</span>
      <div style={{ flex: 1 }} />
      <span>Product</span>
      <span>Pricing</span>
      <span>Docs</span>
      <span style={{ background: ink, color: "#fff", borderRadius: 999, padding: "7px 16px" }}>Sign in</span>
    </div>
    {variant === "old" ? (
      <div style={{ padding: "40px 30px" }}>
        <div style={{ fontSize: 34, fontWeight: 600 }}>Pricing</div>
        <div style={{ fontSize: 16, color: sub, marginTop: 8 }}>Simple plans for every team.</div>
        <div style={{ display: "flex", gap: 14, marginTop: 26 }}>
          {["Starter", "Team", "Scale"].map((p) => (
            <div
              key={p}
              style={{ flex: 1, border: "1px solid #d9dfea", borderRadius: 10, padding: 16, background: "#fff" }}
            >
              <div style={{ fontSize: 17, fontWeight: 600 }}>{p}</div>
              <div style={{ height: 8, width: "70%", background: "#e6ebf3", borderRadius: 4, marginTop: 12 }} />
              <div style={{ height: 8, width: "50%", background: "#e6ebf3", borderRadius: 4, marginTop: 8 }} />
            </div>
          ))}
        </div>
      </div>
    ) : (
      <div style={{ padding: "30px 30px", opacity: t, transform: `translateY(${(1 - t) * 24}px)` }}>
        <div style={{ fontSize: 14, letterSpacing: "0.18em", color: acc, fontWeight: 600 }}>PRICING</div>
        <div style={{ fontSize: 46, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.02, marginTop: 10 }}>
          Pick a plan. Ship today.
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 26 }}>
          {[
            ["Starter", "For side projects"],
            ["Team", "Most popular"],
            ["Scale", "For growing apps"],
          ].map(([p, d], i) => (
            <div
              key={p}
              style={{
                flex: 1,
                borderRadius: 16,
                padding: 18,
                background: i === 1 ? ink : "#fff",
                color: i === 1 ? "#fff" : ink,
                border: i === 1 ? "none" : "1px solid #d9dfea",
                boxShadow: i === 1 ? "0 20px 40px -18px rgba(47,107,236,0.6)" : "0 10px 30px -20px rgba(11,19,34,0.3)",
                transform: `translateY(${(1 - t) * (20 + i * 12)}px)`,
              }}
            >
              <div style={{ fontSize: 19, fontWeight: 600 }}>{p}</div>
              <div style={{ fontSize: 14, opacity: 0.7, marginTop: 4 }}>{d}</div>
              <div
                style={{
                  marginTop: 16,
                  borderRadius: 999,
                  padding: "8px 0",
                  textAlign: "center",
                  fontSize: 14,
                  background: i === 1 ? acc : "#eef2f8",
                  color: i === 1 ? "#fff" : ink,
                }}
              >
                Choose {p}
              </div>
            </div>
          ))}
        </div>
      </div>
    )}
  </div>
);
