/**
 * The workshop's stylesheet, shipped as a string and injected by `Workshop`
 * into an SVG `<style>` element.
 *
 * Two reasons it lives here rather than in a `.css` file: the renderer stays a
 * single self-contained function of `VisualState` that any host can drop in
 * without a CSS pipeline, and the idle animation stays *declarative*. A
 * JS-driven animation would need a clock, and a renderer with a clock is no
 * longer a pure function of the projection (spec §1, §15).
 *
 * Per-slot desynchronisation comes from `--ph-offset` (0..1, the projection's
 * `phaseOffset`) used as a negative animation delay, so two identical printers
 * side by side never move in lockstep.
 */
export const CHARACTER_CSS = `
/* ==== Characters ========================================================= */
.pc-char { display: block; overflow: visible; }
.pc-o { stroke: var(--char-outline, #1C2330); stroke-width: var(--stroke-char, 3px); stroke-linejoin: round; stroke-linecap: round; }
.pc-none { fill: none; }
.pc-ink { fill: var(--char-outline, #1C2330); }
.pc-shell { fill: var(--char-shell, #FAFAF7); }
.pc-shade { fill: var(--char-shade, #DCE0DE); }
.pc-pla { fill: var(--char-pla, #E23673); }
.pc-acrylic { fill: var(--char-acrylic, #BEE5F4); }
.pc-alu { fill: var(--char-alu, #C7CFD5); }
.pc-steel { fill: var(--char-steel, #6C7884); }
.pc-brass { fill: var(--char-brass, #E2AA3A); }
.pc-tape { fill: var(--char-tape, #58A8E6); }
.pc-heat { fill: var(--char-heat, #EF6236); }
.pc-gold { fill: var(--char-brass, #E2AA3A); }
.pc-money { fill: var(--char-money, #4FA86E); }
.pc-carbon { fill: var(--char-carbon, #30353D); }
.pc-carbon-back { fill: var(--char-carbon, #30353D); opacity: 0.45; }
.pc-masking { fill: #efe1b0; }
.pc-petg-c { fill: #1fa595; }
.pc-resin-c { fill: var(--char-amber, #F5A23A); }
.pc-blueprint-c { fill: #4c86e8; }
.pc-plate-in { fill: #2a323b; }
.pc-print-product { fill: var(--ph-gold, #e2b65a); }
.pc-resin-print { fill: #f3c98a; }
.pc-screen { fill: var(--char-screen, #142A2C); }
.pc-pixel { fill: var(--char-pixel, #7DF0C3); }
.pc-glare { fill: #ffffff; opacity: 0.08; }
.pc-shadow { fill: var(--char-shadow, rgba(28, 35, 48, 0.14)); }
.pc-amber { fill: var(--char-amber, #F5A23A); fill-opacity: 0.72; }
.pc-glass { fill: var(--char-glass, #D6F1F6); fill-opacity: 0.4; }
.pc-hot { fill: #ffd27a; }
.pc-glow { fill: #ff9a3c; opacity: 0.45; }
.pc-thin { fill: none; stroke: var(--char-outline, #1C2330); stroke-width: 2px; stroke-linecap: round; }
.pc-seam { fill: none; stroke: #ffffff; stroke-opacity: 0.55; stroke-width: 1.5px; }
.pc-layer { fill: none; stroke: var(--char-pla-deep, #A8204F); stroke-width: 1.5px; stroke-linecap: round; }
.pc-layer-petg { fill: none; stroke: #0b6a5f; stroke-width: 1.5px; stroke-linecap: round; }
.pc-layer-resin { fill: none; stroke: #c48a3a; stroke-width: 1.2px; }
.pc-winding { stroke: var(--char-pla-deep, #A8204F); stroke-width: 1.5px; stroke-dasharray: 4 3; }
.pc-winding-petg { stroke: #0b6a5f; stroke-width: 1.5px; stroke-dasharray: 4 3; }
.pc-winding-gold { stroke: #9a6c14; stroke-width: 1.5px; stroke-dasharray: 4 3; }
.pc-filament { fill: none; stroke: var(--char-pla, #E23673); stroke-width: 2.5px; stroke-linecap: round; }
.pc-filament-petg { fill: none; stroke: #1fa595; stroke-width: 2.5px; stroke-linecap: round; }
.pc-filament-gold { fill: none; stroke: var(--char-brass, #E2AA3A); stroke-width: 2.5px; stroke-linecap: round; }
.pc-groove { fill: none; stroke: #8f9aa3; stroke-width: 2px; }
.pc-shimmer { fill: none; stroke: var(--char-heat, #EF6236); stroke-width: 2.5px; stroke-linecap: round; opacity: 0.8; }
.pc-speckle { fill: none; stroke: #7d5a14; stroke-width: 2.5px; stroke-linecap: round; opacity: 0.6; }
.pc-reflect { fill: none; stroke: #ffffff; stroke-width: 3px; stroke-linecap: round; opacity: 0.55; }
.pc-liquid { fill: none; stroke: var(--char-amber, #F5A23A); stroke-width: 3px; stroke-linecap: round; }
.pc-rivet { fill: none; stroke: var(--char-outline, #1C2330); stroke-width: 4px; stroke-linecap: round; opacity: 0.5; }
.pc-arm { fill: none; stroke: var(--char-outline, #1C2330); stroke-width: 2.5px; stroke-linecap: round; }
.pc-halo { fill: none; stroke: var(--char-brass, #E2AA3A); stroke-width: 4px; opacity: 0.9; }

/* idle life: blink, sweep, spool, shimmer. Phase offset desyncs bays. */
.pc-eyes-blink { opacity: 0; }
.pc-char .pc-eyes-open { animation: pc-blink-open 5.2s steps(1) infinite; animation-delay: calc(var(--pc-offset, 0) * -5.2s); }
.pc-char .pc-eyes-blink { animation: pc-blink-shut 5.2s steps(1) infinite; animation-delay: calc(var(--pc-offset, 0) * -5.2s); }
@keyframes pc-blink-open { 0%, 95% { opacity: 1; } 96%, 99% { opacity: 0; } }
@keyframes pc-blink-shut { 0%, 95% { opacity: 0; } 96%, 99% { opacity: 1; } }
.is-printing .pc-carriage { animation: pc-sweep var(--ph-sweep, 3.4s) ease-in-out infinite alternate; animation-delay: calc(var(--pc-offset, 0) * -3.4s); }
@keyframes pc-sweep { from { transform: translateX(-16px); } to { transform: translateX(16px); } }
.is-printing .pc-spool { transform-box: fill-box; transform-origin: center; animation: pc-spin 10s linear infinite; }
@keyframes pc-spin { to { transform: rotate(360deg); } }
.is-printing .pc-shimmer { animation: pc-shimmer 1.6s ease-in-out infinite; }
@keyframes pc-shimmer { 50% { opacity: 0.25; transform: translateY(-3px); } }
.is-printing .pc-bill-fly { animation: pc-float 2.4s ease-in-out infinite; }
@keyframes pc-float { 50% { transform: translateY(-5px); } }
@media (prefers-reduced-motion: reduce) {
  .pc-char *, .pc-char { animation: none !important; }
  .pc-eyes-blink { opacity: 0; }
}


/* overclocked: the toolhead races and the bay glows */
.is-overclocked .pc-carriage { animation-duration: 0.9s; }
.is-overclocked .pc-glare { opacity: 0.2; }
`;

export const WORKSHOP_CSS = `
.printhead-workshop {
  --ph-ink: #d7dee6;
  --ph-dim: #7b8794;
  --ph-bay: #10151b;
  --ph-bay-edge: #263141;
  --ph-accent: #4cc2ff;
  --ph-gold: #e8c469;
    --ph-warn: #ffb454;
  --ph-hot: #ff8a3d;
  --ph-sweep: 3.4s;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  display: block;
  width: 100%;
  height: auto;
}

.ph-bay { fill: var(--ph-bay); stroke: var(--ph-bay-edge); stroke-width: 1.5; }
.ph-bay--empty { fill: none; stroke-dasharray: 5 5; opacity: 0.45; }

.ph-label { fill: var(--ph-ink); font-size: 11px; }
.ph-label--dim { fill: var(--ph-dim); font-style: italic; }
.ph-badge-disc { fill: var(--ph-accent); }
.ph-badge-text { fill: #05090d; font-size: 12px; font-weight: 700; }

.ph-progress-track { fill: var(--ph-bay-edge); }
.ph-progress-fill { fill: var(--ph-accent); }
.ph-progress-fill--purge { fill: var(--ph-dim); }
.ph-risk-track { fill: var(--ph-bay-edge); }
.ph-risk-fill { fill: var(--ph-warn); }
.ph-perfect-fill { fill: var(--ph-gold); }

/* --- overclock (tap a printer) ----------------------------------------- */
.ph-oc-track { fill: none; stroke: var(--ph-bay-edge); stroke-width: 3; }
.ph-oc-fill { fill: none; stroke-width: 3; stroke-linecap: round; transition: stroke-dasharray 0.2s linear; }
.ph-oc-fill--ready { stroke: var(--ph-accent); }
.ph-oc-fill--active { stroke: var(--ph-hot); }
.ph-oc-fill--cooling { stroke: var(--ph-dim); }
.ph-oc-bolt { fill: var(--ph-ink); }
.ph-slot--pressable { cursor: pointer; }
.ph-slot--pressable:hover .ph-bay { stroke: var(--ph-accent); }
.ph-slot:focus-visible { outline: none; }
.ph-slot:focus-visible .ph-bay { stroke: var(--ph-accent); stroke-width: 3; }
[data-overclocked="true"] .ph-bay { stroke: var(--ph-hot); stroke-width: 2.5; }

/* --- print rota (spec §5B) ---------------------------------------------- */
.ph-queue-pip { fill: var(--ph-bay-edge); }
.ph-queue-pip--current { fill: var(--ph-accent); }

/* --- frame tiers (spec §5A) --------------------------------------------- */
.printer--frame-acrylic   { --ph-frame: #9fd9ff; --ph-frame-fill: rgba(159, 217, 255, 0.10); }
.printer--frame-aluminium { --ph-frame: #c9d3dd; --ph-frame-fill: rgba(201, 211, 221, 0.16); }
.printer--frame-steel     { --ph-frame: #8b98a8; --ph-frame-fill: rgba(139, 152, 168, 0.28); }

.ph-frame { fill: var(--ph-frame-fill); stroke: var(--ph-frame); }
.ph-strut { fill: var(--ph-frame); }
.ph-base { fill: #1b232d; stroke: var(--ph-frame); stroke-width: 1; }
.ph-enclosure { fill: rgba(159, 217, 255, 0.06); stroke: var(--ph-frame); stroke-dasharray: 3 3; }

/* --- bed tiers ----------------------------------------------------------- */
.ph-bed { fill: #38424f; }
.printer--bed-tape .ph-bed { fill: #4a5462; }
.printer--bed-heated .ph-bed { fill: #6b3a2c; }
.printer--bed-auto-level .ph-bed { fill: #2f4a44; }
.ph-bed-probe { fill: var(--ph-accent); }
.ph-bed-heat { fill: var(--ph-hot); opacity: 0.35; }

/* --- nozzle tiers -------------------------------------------------------- */
.ph-carriage-body { fill: #2b3542; stroke: var(--ph-frame); stroke-width: 1; }
.ph-nozzle { fill: #b98b3f; }
.printer--nozzle-hardened .ph-nozzle { fill: #6f7883; }
.printer--nozzle-glowing .ph-nozzle { fill: #ffd08a; }
.ph-nozzle-glow { fill: var(--ph-hot); opacity: 0; }
.printer--nozzle-glowing .ph-nozzle-glow { opacity: 0.3; }
.printer--running .ph-nozzle-glow { opacity: 0.55; }

.ph-spool-rim { fill: none; stroke: var(--ph-accent); stroke-width: 3; }
.ph-spool-hub { fill: var(--ph-dim); }
.ph-filament { fill: none; stroke: var(--ph-accent); stroke-width: 1.2; opacity: 0.7; }
.ph-controller { fill: #1b232d; stroke: var(--ph-frame); stroke-width: 1; }
.ph-controller-screen { fill: var(--ph-accent); opacity: 0.55; }
.ph-print { fill: var(--ph-accent); opacity: 0.85; }
/* A Product is not a Part: the studio bay reads gold (spec §5D). */
.ph-print--product { fill: var(--ph-gold); opacity: 0.95; }

/* The mint (spec §5E): one bill per installed press level, gently breathing. */
.ph-bill {
  fill: var(--ph-gold);
  opacity: 0.8;
  animation: ph-mint 1.8s ease-in-out infinite;
}
@keyframes ph-mint {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 0.95; }
}
@media (prefers-reduced-motion: reduce) {
  .ph-bill { animation: none; opacity: 0.8; }
}

/* --- the printed city (spec §5E) ----------------------------------------- */
.ph-backdrop-tower { fill: var(--ph-bay-edge); opacity: 0.5; }

/* --- the Universal Fabricator (spec §6 phase 6) --------------------------- */
.ph-fabricator-bed { fill: #1b232d; stroke: var(--ph-dim); stroke-width: 1; }
.ph-fabricator-band { fill: var(--ph-accent); opacity: 0.9; }
.ph-fabricator-band--pending { fill: none; stroke: var(--ph-bay-edge); stroke-width: 1; }
.ph-fabricator-band--printing {
  fill: var(--ph-hot);
  animation: ph-pulse 1.2s ease-in-out infinite;
}
.ph-fabricator--complete .ph-fabricator-band { fill: var(--ph-gold); }

/* --- the ending (spec §6 phase 6) ---------------------------------------- */
.printhead-ending {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  display: block;
  width: 100%;
  height: auto;
  background: #05090d;
}
.ph-ending-title { fill: #e8c469; font-size: 48px; text-anchor: middle; }
.ph-ending-line { fill: #d7dee6; font-size: 11px; text-anchor: middle; }
.ph-museum-case { fill: rgba(159, 217, 255, 0.05); stroke: #7b8794; stroke-dasharray: 4 3; }

/* --- the idle print-head animation --------------------------------------- */
@keyframes ph-sweep {
  from { transform: translateX(0); }
  to   { transform: translateX(var(--ph-travel, 70px)); }
}
@keyframes ph-spin { to { transform: rotate(360deg); } }
@keyframes ph-pulse {
  0%, 100% { opacity: 0.25; }
  50%      { opacity: 0.7; }
}

.ph-carriage {
  animation: ph-sweep var(--ph-sweep) ease-in-out infinite alternate;
  animation-delay: calc(var(--ph-offset, 0) * var(--ph-sweep) * -1);
}
.printer--idle .ph-carriage { animation-duration: calc(var(--ph-sweep) * 2.5); }
.ph-spool {
  transform-box: fill-box;
  transform-origin: center;
  animation: ph-spin calc(var(--ph-sweep) * 3) linear infinite;
  animation-delay: calc(var(--ph-offset, 0) * var(--ph-sweep) * -3);
  animation-play-state: paused;
}
.printer--running .ph-spool { animation-play-state: running; }
.printer--running .ph-nozzle-glow { animation: ph-pulse var(--ph-sweep) ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
  .ph-carriage, .ph-spool, .ph-nozzle-glow { animation: none; }
}

${CHARACTER_CSS}
`;
