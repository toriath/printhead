import { type Content, type GameState, resolveSlotConfig } from '@printhead/core';

/**
 * Bays that are stopped because the spool ran dry: loaded, not printing, not
 * purging, and holding less filament than one print takes. Nothing in the
 * workshop moves for them, and silence is the worst feedback an idle game can
 * give, so the shell makes a lot of noise about exactly these.
 */
export function starvedSlots(state: GameState, content: Content): readonly string[] {
  return state.slots
    .filter((slot) => {
      if (slot.printerCount === 0 || slot.run !== null || slot.changeoverMs > 0) {
        return false;
      }
      const config = resolveSlotConfig(content, slot);
      if (config === null) {
        return false;
      }
      return (state.filamentGrams[config.material.id] ?? 0) < config.filamentGrams;
    })
    .map((slot) => slot.id);
}
