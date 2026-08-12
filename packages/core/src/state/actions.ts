import type { GatedActionType } from '../content/schema.js';

/**
 * Command pattern (spec §15): every state change is an Action fed to the single
 * pure `reduce`. `TICK` is an action like any other, which is what makes
 * replay, offline catch-up and bot harnesses share one code path.
 *
 * Every action except `TICK` and `ADVANCE_PHASE` is gated by the phase FSM; the
 * per-phase allow-lists live in `content/pacing.json` (spec §11).
 */
export interface TickAction {
  readonly type: 'TICK';
  readonly simDtMs: number;
}

export interface AdvancePhaseAction {
  readonly type: 'ADVANCE_PHASE';
}

export interface AttachPieceAction {
  readonly type: 'ATTACH_PIECE';
  readonly pieceId: string;
}

export interface SetSlotConfigAction {
  readonly type: 'SET_SLOT_CONFIG';
  readonly slotId: string;
  readonly materialId: string;
  readonly objectId: string;
}

export interface StartPrintAction {
  readonly type: 'START_PRINT';
  readonly slotId: string;
}

export interface SellPartsAction {
  readonly type: 'SELL_PARTS';
  /** Clamped to the parts in stock; `null` sells everything. */
  readonly count: number | null;
}

export interface BuyFilamentAction {
  readonly type: 'BUY_FILAMENT';
  readonly materialId: string;
  readonly grams: number;
}

export interface SellFilamentAction {
  readonly type: 'SELL_FILAMENT';
  readonly materialId: string;
  readonly grams: number;
}

export interface BuyPrinterAction {
  readonly type: 'BUY_PRINTER';
  readonly printerId: string;
  readonly slotId: string;
}

export interface BuyUpgradeAction {
  readonly type: 'BUY_UPGRADE';
  readonly upgradeId: string;
}

export interface BuyAutomationAction {
  readonly type: 'BUY_AUTOMATION';
  readonly automationId: string;
}

export interface SetAutomationAction {
  readonly type: 'SET_AUTOMATION';
  readonly automationId: string;
  readonly enabled?: boolean;
  readonly threshold?: number;
}

export interface RecycleScrapAction {
  readonly type: 'RECYCLE_SCRAP';
  readonly materialId: string;
  /** Grams of Scrap to feed the recycler; `null` feeds it everything. */
  readonly grams: number | null;
}

export type Action =
  | TickAction
  | AdvancePhaseAction
  | AttachPieceAction
  | SetSlotConfigAction
  | StartPrintAction
  | SellPartsAction
  | BuyFilamentAction
  | SellFilamentAction
  | BuyPrinterAction
  | BuyUpgradeAction
  | BuyAutomationAction
  | SetAutomationAction
  | RecycleScrapAction;

export type ActionType = Action['type'];

export type GatedAction = Extract<Action, { type: GatedActionType }>;

export const tick = (simDtMs: number): TickAction => ({ type: 'TICK', simDtMs });
export const advancePhase = (): AdvancePhaseAction => ({ type: 'ADVANCE_PHASE' });
export const attachPiece = (pieceId: string): AttachPieceAction => ({
  type: 'ATTACH_PIECE',
  pieceId,
});
export const setSlotConfig = (
  slotId: string,
  materialId: string,
  objectId: string,
): SetSlotConfigAction => ({ type: 'SET_SLOT_CONFIG', slotId, materialId, objectId });
export const startPrint = (slotId: string): StartPrintAction => ({ type: 'START_PRINT', slotId });
export const sellParts = (count: number | null = null): SellPartsAction => ({
  type: 'SELL_PARTS',
  count,
});
export const buyFilament = (materialId: string, grams: number): BuyFilamentAction => ({
  type: 'BUY_FILAMENT',
  materialId,
  grams,
});
export const sellFilament = (materialId: string, grams: number): SellFilamentAction => ({
  type: 'SELL_FILAMENT',
  materialId,
  grams,
});
export const buyPrinter = (printerId: string, slotId: string): BuyPrinterAction => ({
  type: 'BUY_PRINTER',
  printerId,
  slotId,
});
export const buyUpgrade = (upgradeId: string): BuyUpgradeAction => ({
  type: 'BUY_UPGRADE',
  upgradeId,
});
export const buyAutomation = (automationId: string): BuyAutomationAction => ({
  type: 'BUY_AUTOMATION',
  automationId,
});
export const setAutomation = (
  automationId: string,
  changes: { readonly enabled?: boolean; readonly threshold?: number },
): SetAutomationAction => ({ type: 'SET_AUTOMATION', automationId, ...changes });
export const recycleScrap = (
  materialId: string,
  grams: number | null = null,
): RecycleScrapAction => ({
  type: 'RECYCLE_SCRAP',
  materialId,
  grams,
});
