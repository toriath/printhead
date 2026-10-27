import type { GatedActionType } from '../content/schema.js';
import type { SlotQueueEntry } from './game-state.js';

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

/** Overclock a running bay (see `failure.overclock`). */
export interface OverclockSlotAction {
  readonly type: 'OVERCLOCK_SLOT';
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

/** Buy the next config slot (spec §4). Bays are bought in content order. */
export interface BuySlotAction {
  readonly type: 'BUY_SLOT';
  readonly unlockId: string;
}

/** Move machines between bays (spec §4). `count` is clamped to the source. */
export interface AssignPrinterAction {
  readonly type: 'ASSIGN_PRINTER';
  readonly fromSlotId: string;
  readonly toSlotId: string;
  readonly count: number;
}

/** Rewrite a slot's print rota (spec §5B); an empty list clears it. */
export interface SetSlotQueueAction {
  readonly type: 'SET_SLOT_QUEUE';
  readonly slotId: string;
  readonly entries: readonly SlotQueueEntry[];
}

/** Draft a Design in the studio (spec §5D). Costs Money and the bench's time. */
export interface CreateDesignAction {
  readonly type: 'CREATE_DESIGN';
  readonly designId: string;
}

/** Point a bay at one of your Designs (spec §5D): it starts making Products. */
export interface SetSlotDesignAction {
  readonly type: 'SET_SLOT_DESIGN';
  readonly slotId: string;
  readonly designId: string;
}

export interface SellProductsAction {
  readonly type: 'SELL_PRODUCTS';
  /** Clamped to the products in stock; `null` sells everything. */
  readonly count: number | null;
}

/** Melt the workshop down for Plates (spec §5D). The run ends; Designs stay. */
export interface PrestigeAction {
  readonly type: 'PRESTIGE';
}

/** Install or upgrade a money printer (spec §5E), paid for in Plates. */
export interface BuyMoneyPrinterAction {
  readonly type: 'BUY_MONEY_PRINTER';
  readonly moneyPrinterId: string;
}

/**
 * Pre-print one section of the Universal Fabricator (spec §7.3). A Farm build
 * cannot attempt the final print, but it can print its pieces in advance and
 * carry them through the melt-down that follows.
 */
export interface PrintSectionAction {
  readonly type: 'PRINT_SECTION';
}

/**
 * Commit the whole workshop to the final print (spec §4: "a deliberate return
 * to total commitment"). Every active bay is cleared and dedicated to it.
 */
export interface StartFabricatorAction {
  readonly type: 'START_FABRICATOR';
}

/**
 * Start again, keeping what `endgame.newGamePlus` says to keep and whatever
 * optional modifiers the player took (spec §18 M6).
 */
export interface NewGamePlusAction {
  readonly type: 'NEW_GAME_PLUS';
  readonly modifierIds: readonly string[];
}

/** Set the shop's price level (see `content/shop.json`). */
export interface SetShopPriceAction {
  readonly type: 'SET_SHOP_PRICE';
  readonly priceLevelId: string;
}

/** Take on a client's proposal, or turn it down. */
export interface AnswerCommissionAction {
  readonly type: 'ANSWER_COMMISSION';
  readonly serial: number;
  readonly accept: boolean;
}

/** Commit to Farm or Goliath for this run (spec §5B). One choice, forever. */
export interface ChooseForkAction {
  readonly type: 'CHOOSE_FORK';
  readonly forkId: string;
}

export type Action =
  | TickAction
  | AdvancePhaseAction
  | AttachPieceAction
  | SetSlotConfigAction
  | StartPrintAction
  | OverclockSlotAction
  | SellPartsAction
  | BuyFilamentAction
  | SellFilamentAction
  | BuyPrinterAction
  | BuyUpgradeAction
  | BuyAutomationAction
  | SetAutomationAction
  | RecycleScrapAction
  | BuySlotAction
  | AssignPrinterAction
  | SetSlotQueueAction
  | ChooseForkAction
  | CreateDesignAction
  | SetSlotDesignAction
  | SellProductsAction
  | PrestigeAction
  | BuyMoneyPrinterAction
  | PrintSectionAction
  | StartFabricatorAction
  | NewGamePlusAction
  | SetShopPriceAction
  | AnswerCommissionAction;

export type ActionType = Action['type'];

export type GatedAction = Extract<Action, { type: GatedActionType }>;

export const tick = (simDtMs: number): TickAction => ({ type: 'TICK', simDtMs });
export const setShopPrice = (priceLevelId: string): SetShopPriceAction => ({
  type: 'SET_SHOP_PRICE',
  priceLevelId,
});
export const answerCommission = (serial: number, accept: boolean): AnswerCommissionAction => ({
  type: 'ANSWER_COMMISSION',
  serial,
  accept,
});
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
export const overclockSlot = (slotId: string): OverclockSlotAction => ({
  type: 'OVERCLOCK_SLOT',
  slotId,
});
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
export const buySlot = (unlockId: string): BuySlotAction => ({ type: 'BUY_SLOT', unlockId });
export const assignPrinter = (
  fromSlotId: string,
  toSlotId: string,
  count: number,
): AssignPrinterAction => ({ type: 'ASSIGN_PRINTER', fromSlotId, toSlotId, count });
export const setSlotQueue = (
  slotId: string,
  entries: readonly SlotQueueEntry[],
): SetSlotQueueAction => ({ type: 'SET_SLOT_QUEUE', slotId, entries });
export const chooseFork = (forkId: string): ChooseForkAction => ({ type: 'CHOOSE_FORK', forkId });
export const createDesign = (designId: string): CreateDesignAction => ({
  type: 'CREATE_DESIGN',
  designId,
});
export const setSlotDesign = (slotId: string, designId: string): SetSlotDesignAction => ({
  type: 'SET_SLOT_DESIGN',
  slotId,
  designId,
});
export const sellProducts = (count: number | null = null): SellProductsAction => ({
  type: 'SELL_PRODUCTS',
  count,
});
export const prestige = (): PrestigeAction => ({ type: 'PRESTIGE' });
export const buyMoneyPrinter = (moneyPrinterId: string): BuyMoneyPrinterAction => ({
  type: 'BUY_MONEY_PRINTER',
  moneyPrinterId,
});
export const printSection = (): PrintSectionAction => ({ type: 'PRINT_SECTION' });
export const startFabricator = (): StartFabricatorAction => ({ type: 'START_FABRICATOR' });
export const newGamePlus = (modifierIds: readonly string[] = []): NewGamePlusAction => ({
  type: 'NEW_GAME_PLUS',
  modifierIds,
});
