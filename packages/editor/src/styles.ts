/**
 * The panel ships its own stylesheet inline, exactly as the renderer does: a
 * dev tool that needs the host to wire up a CSS pipeline is a dev tool nobody
 * turns on. Everything is scoped under `.ph-editor`.
 */
export const EDITOR_CSS = `
.ph-editor {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 9999;
  width: min(420px, calc(100vw - 24px));
  max-height: min(70vh, 640px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid #2b3a4d;
  border-radius: 10px;
  background: #0b1118;
  color: #d7dee6;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  box-shadow: 0 12px 40px rgb(0 0 0 / 55%);
}
.ph-editor--closed { width: auto; padding: 6px; }
.ph-editor__bar { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.ph-editor__section { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ph-editor__label { color: #7b8794; margin-right: 4px; }
.ph-editor__scroll { overflow: auto; border-top: 1px solid #1d2734; padding-top: 6px; }
.ph-editor summary { cursor: pointer; color: #4cc2ff; padding: 3px 0; }
.ph-editor__fields { margin: 0 0 8px; padding: 0 0 0 10px; }
.ph-editor__field { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ph-editor__field dt { color: #7b8794; }
.ph-editor__field dd { margin: 0; }
.ph-editor input, .ph-editor select, .ph-editor button {
  font: inherit;
  color: inherit;
  background: #111a24;
  border: 1px solid #2b3a4d;
  border-radius: 4px;
  padding: 2px 6px;
}
.ph-editor input[type="number"] { width: 92px; text-align: right; }
.ph-editor button { cursor: pointer; }
.ph-editor button[aria-pressed="true"] { border-color: #4cc2ff; color: #4cc2ff; }
.ph-editor output { color: #7b8794; }
.ph-editor__literal { color: #e8c469; }
.ph-editor__tree { padding-left: 8px; }
.ph-editor__tree-leaf { display: flex; justify-content: space-between; gap: 8px; padding-left: 8px; }
.ph-editor__spark { display: flex; align-items: center; gap: 6px; color: #4cc2ff; }
.ph-editor__spark span:last-child { color: #d7dee6; margin-left: auto; }
.ph-editor__log { margin: 0; padding-left: 18px; max-height: 120px; overflow: auto; }
.ph-editor__log li { color: #7b8794; }
.ph-editor textarea {
  font: inherit;
  color: inherit;
  background: #111a24;
  border: 1px solid #2b3a4d;
  border-radius: 4px;
  width: 100%;
  min-height: 48px;
}
[data-over-budget="true"] { color: #ffb454; }
`;
