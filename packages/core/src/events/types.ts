/**
 * Domain events (Observer, spec §15). The simulation announces *what happened*
 * so achievements, sound and flourishes can react — but the renderer's state
 * still comes only from `VisualState`. Events are therefore deliberately
 * renderer-independent: plain data, no callbacks, no DOM types.
 */
export interface EventBase {
  /** Simulation clock at the moment the event was emitted. */
  readonly simTimeMs: number;
}

export interface PieceAttachedEvent extends EventBase {
  readonly type: 'PIECE_ATTACHED';
  readonly pieceId: string;
  readonly attachedCount: number;
  readonly totalPieces: number;
}

export interface AssemblyCompletedEvent extends EventBase {
  readonly type: 'ASSEMBLY_COMPLETED';
  readonly printerId: string;
}

export interface SlotConfiguredEvent extends EventBase {
  readonly type: 'SLOT_CONFIGURED';
  readonly slotId: string;
  readonly materialId: string;
  /** The object or Design now loaded (spec §5D) — whichever it is. */
  readonly recipeId: string;
  /** Changeover cost the switch incurred (spec §3); zero for a free swap. */
  readonly downtimeMs: number;
  readonly purgedGrams: number;
  /** Prints thrown away because the switch interrupted them. */
  readonly abandonedBatch: number;
}

export interface PrintStartedEvent extends EventBase {
  readonly type: 'PRINT_STARTED';
  readonly slotId: string;
  readonly recipeId: string;
  readonly materialId: string;
  readonly batch: number;
  readonly durationMs: number;
}

export interface PrintCompletedEvent extends EventBase {
  readonly type: 'PRINT_COMPLETED';
  readonly slotId: string;
  readonly recipeId: string;
  readonly materialId: string;
  readonly batch: number;
  /** Units made: Parts for a stock object, Products for a Design (spec §5D). */
  readonly produced: number;
  readonly pool: 'parts' | 'products';
  readonly value: number;
  /** How many of the batch the pity timer failed (spec §7.1). */
  readonly failed: number;
  readonly scrapGrams: number;
  /** The perfect meter filled on this batch: it yielded several times over. */
  readonly perfect: boolean;
}

export interface CommissionOfferedEvent extends EventBase {
  readonly type: 'COMMISSION_OFFERED';
  readonly serial: number;
  readonly templateId: string;
  readonly clientId: string;
}

export interface CommissionCompletedEvent extends EventBase {
  readonly type: 'COMMISSION_COMPLETED';
  readonly serial: number;
  readonly templateId: string;
  readonly clientId: string;
  /** Money paid on delivery. */
  readonly reward: number;
}

export interface CommissionExpiredEvent extends EventBase {
  readonly type: 'COMMISSION_EXPIRED';
  readonly serial: number;
  readonly templateId: string;
}

/** The player took a proposal on, or turned it down. */
export interface CommissionAnsweredEvent extends EventBase {
  readonly type: 'COMMISSION_ANSWERED';
  readonly serial: number;
  readonly clientId: string;
  readonly accepted: boolean;
}

/** A shop customer bought Parts off the shelf. */
export interface CustomerServedEvent extends EventBase {
  readonly type: 'CUSTOMER_SERVED';
  readonly customerId: string;
  readonly parts: number;
  readonly money: number;
}

/** A shop customer found the shelf empty and left. */
export interface CustomerLeftEvent extends EventBase {
  readonly type: 'CUSTOMER_LEFT';
  readonly customerId: string;
  readonly wanted: number;
}

export interface SlotOverclockedEvent extends EventBase {
  readonly type: 'SLOT_OVERCLOCKED';
  readonly slotId: string;
  readonly durationMs: number;
}

/** Emitted alongside PRINT_COMPLETED when the pity timer bit — for flourishes. */
export interface PrintFailedEvent extends EventBase {
  readonly type: 'PRINT_FAILED';
  readonly slotId: string;
  readonly materialId: string;
  readonly failed: number;
  readonly scrapGrams: number;
}

export interface ChangeoverCompletedEvent extends EventBase {
  readonly type: 'CHANGEOVER_COMPLETED';
  readonly slotId: string;
}

export interface ScrapRecycledEvent extends EventBase {
  readonly type: 'SCRAP_RECYCLED';
  readonly materialId: string;
  readonly scrapGrams: number;
  readonly filamentGrams: number;
}

export interface FilamentSoldEvent extends EventBase {
  readonly type: 'FILAMENT_SOLD';
  readonly materialId: string;
  readonly grams: number;
  readonly money: number;
  readonly pricePerGram: number;
}

export interface UpgradeInstalledEvent extends EventBase {
  readonly type: 'UPGRADE_INSTALLED';
  readonly upgradeId: string;
  readonly level: number;
  readonly paid: number;
}

export interface AutomationInstalledEvent extends EventBase {
  readonly type: 'AUTOMATION_INSTALLED';
  readonly automationId: string;
  readonly level: number;
  readonly paid: number;
}

export interface AutomationConfiguredEvent extends EventBase {
  readonly type: 'AUTOMATION_CONFIGURED';
  readonly automationId: string;
  readonly enabled: boolean;
  readonly threshold: number;
}

/** One firing of an installed automation — the machine acting on your behalf. */
export interface AutomationFiredEvent extends EventBase {
  readonly type: 'AUTOMATION_FIRED';
  readonly automationId: string;
  readonly behavior: string;
}

export interface PartSoldEvent extends EventBase {
  readonly type: 'PART_SOLD';
  readonly parts: number;
  readonly money: number;
}

/** Products sold at the value their Design's level banked (spec §5D). */
export interface ProductSoldEvent extends EventBase {
  readonly type: 'PRODUCT_SOLD';
  readonly products: number;
  readonly money: number;
}

/** The studio bench took a commission (spec §5D). */
export interface DesignStartedEvent extends EventBase {
  readonly type: 'DESIGN_STARTED';
  readonly designId: string;
  readonly designMinutes: number;
  readonly paid: number;
}

/** A draft came off the bench: the Design is owned, forever. */
export interface DesignCreatedEvent extends EventBase {
  readonly type: 'DESIGN_CREATED';
  readonly designId: string;
  readonly designsOwned: number;
}

export interface DesignLevelledEvent extends EventBase {
  readonly type: 'DESIGN_LEVELLED';
  readonly designId: string;
  readonly level: number;
}

/** The melt-down (spec §5D): the run is scrapped and engraved into Plates. */
export interface PrestigedEvent extends EventBase {
  readonly type: 'PRESTIGED';
  readonly platesAwarded: number;
  readonly platesHeld: number;
  readonly runNumber: number;
  readonly designsKept: number;
}

export interface MoneyPrinterInstalledEvent extends EventBase {
  readonly type: 'MONEY_PRINTER_INSTALLED';
  readonly moneyPrinterId: string;
  readonly level: number;
  readonly paid: number;
}

/** One section of the Universal Fabricator came off the bed (spec §7.3). */
export interface FabricatorSectionPrintedEvent extends EventBase {
  readonly type: 'FABRICATOR_SECTION_PRINTED';
  readonly sections: number;
  readonly maxSections: number;
}

/** The whole workshop was committed to the final print (spec §6 phase 6). */
export interface FabricatorStartedEvent extends EventBase {
  readonly type: 'FABRICATOR_STARTED';
  readonly durationMs: number;
  readonly sections: number;
  readonly slotsCommitted: number;
}

export interface FabricatorCompletedEvent extends EventBase {
  readonly type: 'FABRICATOR_COMPLETED';
  readonly designMinutes: number;
}

/** The credits finished printing: the arc is over (spec §6 phase 6). */
export interface GameEndedEvent extends EventBase {
  readonly type: 'GAME_ENDED';
  readonly totalDesignMinutes: number;
}

/** A new run on the far side of the ending (spec §18 M6). */
export interface NewGamePlusStartedEvent extends EventBase {
  readonly type: 'NEW_GAME_PLUS_STARTED';
  readonly run: number;
  readonly modifierIds: readonly string[];
  readonly designsKept: number;
}

export interface FilamentPurchasedEvent extends EventBase {
  readonly type: 'FILAMENT_PURCHASED';
  readonly materialId: string;
  readonly grams: number;
  readonly money: number;
}

export interface PrinterBuiltEvent extends EventBase {
  readonly type: 'PRINTER_BUILT';
  readonly printerId: string;
  readonly slotId: string;
  readonly owned: number;
  /** 0 for the hand-assembled printer #1. */
  readonly paid: number;
}

/** A new config slot came online (spec §4: 1 → 2 → 3 → 4). */
export interface SlotUnlockedEvent extends EventBase {
  readonly type: 'SLOT_UNLOCKED';
  readonly unlockId: string;
  readonly slotId: string;
  readonly slotCount: number;
  readonly paid: number;
}

/** Machines moved between bays (spec §4 fleet allocation). */
export interface PrintersAssignedEvent extends EventBase {
  readonly type: 'PRINTERS_ASSIGNED';
  readonly fromSlotId: string;
  readonly toSlotId: string;
  readonly moved: number;
}

/** A slot's print rota was rewritten (spec §5B). */
export interface SlotQueueSetEvent extends EventBase {
  readonly type: 'SLOT_QUEUE_SET';
  readonly slotId: string;
  readonly entries: number;
}

/** The irreversible Farm/Goliath commitment (spec §5B). */
export interface ForkChosenEvent extends EventBase {
  readonly type: 'FORK_CHOSEN';
  readonly forkId: string;
  readonly slotCapacity: number | null;
  readonly paid: number;
}

export interface PhaseAdvancedEvent extends EventBase {
  readonly type: 'PHASE_ADVANCED';
  readonly fromPhaseId: string;
  readonly toPhaseId: string;
}

export type ActionRejectedReason =
  | 'phase-gated'
  | 'unknown-target'
  /** The target exists but its unlock phase has not been reached yet. */
  | 'locked'
  | 'out-of-order'
  | 'not-ready'
  | 'insufficient-resources'
  | 'slot-busy'
  | 'slot-idle'
  /** The bay already holds all the machines it can (spec §4). */
  | 'slot-full'
  /** The melt-down would not be worth `prestige.minimumPlates` yet. */
  | 'not-worth-it'
  | 'max-level'
  /** The studio has already drafted this Design (spec §5D). */
  | 'already-owned'
  | 'missing-prerequisite'
  | 'no-recycler'
  /** The final print needs every active bay staffed and committed (spec §4). */
  | 'slots-not-committed'
  /** Only the fork that declares `requiredForFinalPrint` may attempt it (§7.3). */
  | 'wrong-fork'
  /** Nothing left to print: the Fabricator has already been built. */
  | 'already-built'
  | 'not-tradeable'
  | 'nothing-to-do';

export interface ActionRejectedEvent extends EventBase {
  readonly type: 'ACTION_REJECTED';
  readonly actionType: string;
  readonly reason: ActionRejectedReason;
}

export type DomainEvent =
  | PieceAttachedEvent
  | AssemblyCompletedEvent
  | SlotConfiguredEvent
  | ChangeoverCompletedEvent
  | PrintStartedEvent
  | PrintCompletedEvent
  | PrintFailedEvent
  | ScrapRecycledEvent
  | PartSoldEvent
  | ProductSoldEvent
  | DesignStartedEvent
  | DesignCreatedEvent
  | DesignLevelledEvent
  | PrestigedEvent
  | MoneyPrinterInstalledEvent
  | FabricatorSectionPrintedEvent
  | FabricatorStartedEvent
  | FabricatorCompletedEvent
  | GameEndedEvent
  | NewGamePlusStartedEvent
  | FilamentPurchasedEvent
  | FilamentSoldEvent
  | PrinterBuiltEvent
  | UpgradeInstalledEvent
  | AutomationInstalledEvent
  | AutomationConfiguredEvent
  | AutomationFiredEvent
  | SlotUnlockedEvent
  | PrintersAssignedEvent
  | SlotQueueSetEvent
  | ForkChosenEvent
  | PhaseAdvancedEvent
  | SlotOverclockedEvent
  | CommissionOfferedEvent
  | CommissionCompletedEvent
  | CommissionExpiredEvent
  | CommissionAnsweredEvent
  | CustomerServedEvent
  | CustomerLeftEvent
  | ActionRejectedEvent;

export type DomainEventType = DomainEvent['type'];

export const DOMAIN_EVENT_TYPES = [
  'PIECE_ATTACHED',
  'ASSEMBLY_COMPLETED',
  'SLOT_CONFIGURED',
  'CHANGEOVER_COMPLETED',
  'PRINT_STARTED',
  'PRINT_COMPLETED',
  'PRINT_FAILED',
  'SCRAP_RECYCLED',
  'PART_SOLD',
  'PRODUCT_SOLD',
  'DESIGN_STARTED',
  'DESIGN_CREATED',
  'DESIGN_LEVELLED',
  'PRESTIGED',
  'MONEY_PRINTER_INSTALLED',
  'FABRICATOR_SECTION_PRINTED',
  'FABRICATOR_STARTED',
  'FABRICATOR_COMPLETED',
  'GAME_ENDED',
  'NEW_GAME_PLUS_STARTED',
  'FILAMENT_PURCHASED',
  'FILAMENT_SOLD',
  'PRINTER_BUILT',
  'UPGRADE_INSTALLED',
  'AUTOMATION_INSTALLED',
  'AUTOMATION_CONFIGURED',
  'AUTOMATION_FIRED',
  'SLOT_UNLOCKED',
  'PRINTERS_ASSIGNED',
  'SLOT_QUEUE_SET',
  'FORK_CHOSEN',
  'PHASE_ADVANCED',
  'SLOT_OVERCLOCKED',
  'COMMISSION_OFFERED',
  'COMMISSION_COMPLETED',
  'COMMISSION_EXPIRED',
  'ACTION_REJECTED',
  'COMMISSION_ANSWERED',
  'CUSTOMER_SERVED',
  'CUSTOMER_LEFT',
] as const satisfies readonly DomainEventType[];

/** The sink the reducer writes to, injected through `ReduceContext`. */
export type EventSink = (event: DomainEvent) => void;
