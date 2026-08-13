import {
  type Content,
  type GameState,
  type GatedActionType,
  type MarketQuote,
  type VisualState,
  createCurveRegistry,
  filamentOf,
  getPhase,
  isPhaseReached,
  maxBuyableGrams,
  nextPrinterCost,
  quoteFor,
  resolveSlotConfig,
} from '@printhead/core';

/**
 * What the shell may offer the player right now.
 *
 * The reducer is the authority — it rejects anything the phase FSM forbids and
 * anything the ledger cannot pay for. This model exists so the *interface*
 * agrees with it: a button the reducer would refuse is disabled with a reason,
 * not offered and then silently ignored. Every rule it applies is read from
 * `content` (per-phase `allowedActions`, unlock phases, cost curves), so
 * unlocking a mechanic stays a data edit (spec §11).
 */

/** How much filament one "buy" click stocks, measured in batches it can print. */
export const RESTOCK_BATCHES = 12;

export interface ControlOption {
  readonly id: string;
  readonly name: string;
}

export interface AttachControl {
  readonly pieceId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly cooldownMs: number;
}

export interface BuyFilamentControl {
  readonly materialId: string;
  readonly materialName: string;
  readonly grams: number;
  readonly cost: number;
  readonly pricePerGram: number;
  readonly enabled: boolean;
}

export interface BuyPrinterControl {
  readonly printerId: string;
  readonly name: string;
  readonly cost: number;
  readonly resource: string;
  readonly enabled: boolean;
}

export interface ControlModel {
  readonly slotId: string;
  /** Every bay the workshop is running, so the panel can target one (spec §4). */
  readonly slots: readonly ControlOption[];
  /** The rota is the auto-changeover automation's feature (spec §5B). */
  readonly canQueue: boolean;
  readonly materials: readonly ControlOption[];
  readonly objects: readonly ControlOption[];
  readonly allows: (action: GatedActionType) => boolean;
  readonly attach: AttachControl | null;
  readonly canConfigure: boolean;
  readonly canPrint: boolean;
  readonly canSell: boolean;
  readonly buyFilament: BuyFilamentControl | null;
  readonly buyPrinter: BuyPrinterControl | null;
}

const NONE = 0;

function unlocked<T extends { id: string; name: string; unlockPhaseId: string }>(
  defs: readonly T[],
  content: Content,
  phaseId: string,
): readonly ControlOption[] {
  return defs
    .filter((def) => isPhaseReached(content.pacing.phases, phaseId, def.unlockPhaseId))
    .map((def) => ({ id: def.id, name: def.name }));
}

export function buildControlModel(
  state: GameState,
  content: Content,
  visual: VisualState,
  /** Which bay the panel is pointed at; defaults to the first. */
  targetSlotId?: string,
): ControlModel {
  const phase = getPhase(content.pacing.phases, visual.phaseId);
  const allows = (action: GatedActionType): boolean => phase.allowedActions.includes(action);
  const slot = visual.slots.find((bay) => bay.slotId === targetSlotId) ?? visual.slots[0];
  const slotId = slot?.slotId ?? '';

  const materials = unlocked(content.materials, content, visual.phaseId);
  const objects = unlocked(content.objects, content, visual.phaseId);

  const { assembly } = visual;
  const attach: AttachControl | null =
    assembly.nextPieceId === null || !allows('ATTACH_PIECE')
      ? null
      : {
          pieceId: assembly.nextPieceId,
          label: assembly.nextPieceName ?? assembly.nextPieceId,
          enabled: assembly.ready,
          cooldownMs: assembly.cooldownMs,
        };

  /*
   * What the bay is loaded with, asked of the simulation rather than looked up
   * in `objects`. Since M5 a bay may be printing one of the player's Designs
   * instead of a stock object (spec §5D), and a model that recognised only
   * objects computed "0 g per print" for a studio bay — which disabled Print
   * forever and made the whole Product economy unreachable through the UI.
   */
  const loaded = state.slots.find((bay) => bay.id === slotId);
  const config = loaded === undefined ? null : resolveSlotConfig(content, loaded);
  const currentMaterial = config?.material;
  const stock = currentMaterial === undefined ? NONE : filamentOf(state, currentMaterial.id);
  const perPrint = config?.filamentGrams ?? NONE;

  const buyMaterial = currentMaterial ?? content.materials.find((m) => m.id === materials[0]?.id);
  const fallbackGrams = content.objects.find((o) => o.id === objects[0]?.id)?.filamentGrams;
  const buyGrams = perPrint > NONE ? perPrint : fallbackGrams;
  const buyFilament: BuyFilamentControl | null =
    buyMaterial === undefined || buyGrams === undefined || !allows('BUY_FILAMENT')
      ? null
      : buildBuyFilament(state, content, buyMaterial, buyGrams, slot?.printerCount ?? NONE);

  const printer = content.printers.find((candidate) =>
    isPhaseReached(content.pacing.phases, visual.phaseId, candidate.unlockPhaseId),
  );
  const cost =
    printer === undefined || !allows('BUY_PRINTER')
      ? null
      : nextPrinterCost(state, content, createCurveRegistry(content.curves), printer.id);

  return {
    slotId,
    slots: visual.slots.map((bay) => ({
      id: bay.slotId,
      name: bay.materialName === null ? bay.slotId : `${bay.slotId} · ${bay.materialName}`,
    })),
    canQueue:
      allows('SET_SLOT_QUEUE') &&
      visual.automation.some((row) => row.behavior === 'auto-changeover' && row.installed),
    materials,
    objects,
    allows,
    attach,
    canConfigure:
      allows('SET_SLOT_CONFIG') &&
      slotId !== '' &&
      materials.length > NONE &&
      objects.length > NONE &&
      slot?.running !== true,
    canPrint:
      allows('START_PRINT') &&
      slot !== undefined &&
      slot.occupied &&
      !slot.running &&
      perPrint > NONE &&
      stock >= perPrint,
    canSell: allows('SELL_PARTS') && visual.ledger.parts > NONE,
    buyFilament,
    buyPrinter:
      printer === undefined || cost === null
        ? null
        : {
            printerId: printer.id,
            name: printer.name,
            cost: cost.amount,
            resource: cost.resource,
            // A bay holds only so many machines (spec §4). Offering the button
            // for a full bay would be offering a purchase the reducer refuses;
            // the fleet panel is where the answer to a full rack lives.
            enabled:
              cost.resource !== 'filament' &&
              state.resources[cost.resource] >= cost.amount &&
              slot !== undefined &&
              slot.printerCount < slot.printerCapacity,
          },
  };
}

function buildBuyFilament(
  state: GameState,
  content: Content,
  material: Content['materials'][number],
  gramsPerPrint: number,
  printerCount: number,
): BuyFilamentControl | null {
  // Prices come from the market (spec §7.2), so the button quotes what the
  // reducer would actually charge — including today's multiplier.
  const quote: MarketQuote | null = quoteFor(state, content, material.id);
  if (quote === null) {
    return null;
  }
  const batchGrams = gramsPerPrint * Math.max(printerCount, 1);
  const wanted = batchGrams * RESTOCK_BATCHES;
  const grams = Math.floor(
    Math.min(wanted, maxBuyableGrams(state, content, material.id, state.resources.money)),
  );
  return {
    materialId: material.id,
    materialName: material.name,
    grams,
    cost: quote.buyPerGram * grams,
    pricePerGram: quote.buyPerGram,
    enabled: grams >= gramsPerPrint,
  };
}
