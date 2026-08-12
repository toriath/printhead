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
  readonly objectId: string;
  /** Changeover cost the switch incurred (spec §3); zero for a free swap. */
  readonly downtimeMs: number;
  readonly purgedGrams: number;
  /** Prints thrown away because the switch interrupted them. */
  readonly abandonedBatch: number;
}

export interface PrintStartedEvent extends EventBase {
  readonly type: 'PRINT_STARTED';
  readonly slotId: string;
  readonly objectId: string;
  readonly materialId: string;
  readonly batch: number;
  readonly durationMs: number;
}

export interface PrintCompletedEvent extends EventBase {
  readonly type: 'PRINT_COMPLETED';
  readonly slotId: string;
  readonly objectId: string;
  readonly materialId: string;
  readonly batch: number;
  readonly parts: number;
  readonly partsValue: number;
  /** How many of the batch the pity timer failed (spec §7.1). */
  readonly failed: number;
  readonly scrapGrams: number;
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
  | 'max-level'
  | 'missing-prerequisite'
  | 'no-recycler'
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
  'ACTION_REJECTED',
] as const satisfies readonly DomainEventType[];

/** The sink the reducer writes to, injected through `ReduceContext`. */
export type EventSink = (event: DomainEvent) => void;
