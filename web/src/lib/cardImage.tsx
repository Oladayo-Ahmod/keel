import { ImageResponse } from "next/og";
import type { Card } from "./share";
import type { Risk } from "./risk";

export const CARD_SIZE = { width: 1200, height: 630 } as const;

// the same pale glass palette as the app, written out because an image has no stylesheet
const INK = "#172033";
const MUTED = "#566479";
const TONE: Record<Risk, { fg: string; bg: string }> = {
  safe: { fg: "#2b8765", bg: "#dcefe7" },
  caution: { fg: "#b97e0e", bg: "#f6ead0" },
  danger: { fg: "#bf4338", bg: "#f6dedb" },
  stale: { fg: "#566479", bg: "#e6ebf0" },
  none: { fg: "#566479", bg: "#e6ebf0" },
};

/** Renders one card as a 1200x630 PNG. `cache` is the Cache-Control value, since the numbers behind a card move. */
export function renderCard(card: Card, cache: string, status = 200): Response {
  const tone = card.chip ? TONE[card.chip.level] : undefined;
  const image = new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
          padding: 56, color: INK, fontSize: 28,
          background: "linear-gradient(135deg, #dbe8f4 0%, #f4f6f8 55%, #f1efe6 100%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <svg width="44" height="44" viewBox="0 0 32 32" fill="none" stroke={INK} strokeWidth="1.6">
            <path d="M3 19c3 6 8 9 13 9s10-3 13-9H3Z" strokeLinejoin="round" />
            <path d="M16 4v15M16 4c3 4 6 9 9 15M16 4c-3 4-6 9-9 15" strokeLinejoin="round" />
          </svg>
          <div style={{ fontSize: 34, fontWeight: 700 }}>Trozu</div>
        </div>

        <div
          style={{
            display: "flex", flexDirection: "column", gap: 28, padding: 40, borderRadius: 32,
            background: "rgba(255,255,255,0.78)", border: "2px solid rgba(255,255,255,0.95)", boxShadow: "0 8px 40px rgba(23,32,51,0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
            <div style={{ fontSize: 60, fontWeight: 700, letterSpacing: -1 }}>{card.title}</div>
            {card.chip && tone && (
              <div style={{ display: "flex", padding: "10px 26px", borderRadius: 999, fontSize: 30, fontWeight: 600, color: tone.fg, background: tone.bg }}>
                {card.chip.text}
              </div>
            )}
          </div>
          <div style={{ fontSize: 26, color: MUTED }}>{card.subtitle}</div>
          {card.stats.length > 0 && (
            <div style={{ display: "flex", gap: 16 }}>
              {card.stats.map((s) => (
                <div
                  key={s.label}
                  style={{ display: "flex", flexDirection: "column", gap: 6, padding: "16px 20px", borderRadius: 20, background: "rgba(255,255,255,0.7)", border: "1px solid rgba(23,32,51,0.08)", flex: "1 1 0", minWidth: 0 }}
                >
                  <div style={{ fontSize: 17, letterSpacing: 1.5, textTransform: "uppercase", color: MUTED }}>{s.label}</div>
                  <div style={{ fontSize: 30, fontWeight: 700 }}>{s.value}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", fontSize: 22, color: MUTED }}>{card.foot}</div>
      </div>
    ),
    CARD_SIZE,
  );
  // ImageResponse adds a one-year immutable Cache-Control of its own and merges ours into it, which would pin a stale card in browsers
  return new Response(image.body, { status, headers: { "Content-Type": "image/png", "Cache-Control": cache } });
}
