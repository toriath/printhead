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
  | PrintStartedEvent
  | PrintCompletedEvent
  | PartSoldEvent
  | FilamentPurchasedEvent
  | PrinterBuiltEvent
  | PhaseAdvancedEvent
  | ActionRejectedEvent;

export type DomainEventType = DomainEvent['type'];

export const DOMAIN_EVENT_TYPES = [
  'PIECE_ATTACHED',
  'ASSEMBLY_COMPLETED',
  'SLOT_CONFIGURED',
  'PRINT_STARTED',
  'PRINT_COMPLETED',
  'PART_SOLD',
  'FILAMENT_PURCHASED',
  'PRINTER_BUILT',
  'PHASE_ADVANCED',
  'ACTION_REJECTED',
] as const satisfies readonly DomainEventType[];

/** The sink the reducer writes to, injected through `ReduceContext`. */
export type EventSink = (event: DomainEvent) => void;
