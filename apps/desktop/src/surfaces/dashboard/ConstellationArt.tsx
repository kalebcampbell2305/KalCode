/** Small constellation motif from the brand: nodes joined by fine lines, one node lit. */
export function ConstellationArt() {
  return (
    <svg width="120" height="56" viewBox="0 0 120 56" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeOpacity="0.35" strokeWidth="1">
        <path d="M8 40 30 22l24 10 22-20 20 14 16-8" />
        <path d="M30 22 38 48M76 12l6 34" strokeDasharray="2 3" />
      </g>
      <g fill="currentColor">
        <circle cx="8" cy="40" r="2" fillOpacity="0.5" />
        <circle cx="30" cy="22" r="2.5" fillOpacity="0.7" />
        <circle cx="54" cy="32" r="2" fillOpacity="0.5" />
        <circle cx="76" cy="12" r="3.5" />
        <circle cx="96" cy="26" r="2" fillOpacity="0.5" />
        <circle cx="112" cy="18" r="1.5" fillOpacity="0.4" />
        <circle cx="38" cy="48" r="1.5" fillOpacity="0.35" />
        <circle cx="82" cy="46" r="1.5" fillOpacity="0.35" />
      </g>
      <circle cx="76" cy="12" r="8" fill="currentColor" fillOpacity="0.12" />
    </svg>
  );
}
