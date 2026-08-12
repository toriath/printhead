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
export const WORKSHOP_CSS = `
.printhead-workshop {
  --ph-ink: #d7dee6;
  --ph-dim: #7b8794;
  --ph-bay: #10151b;
  --ph-bay-edge: #263141;
  --ph-accent: #4cc2ff;
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
`;
