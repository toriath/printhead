import {
  type Content,
  type CurveRegistry,
  type GameState,
  type PhaseDef,
  affordableBatch,
  automationAvailability,
  computeModifiers,
  designAvailability,
  forkAvailability,
  forkCost,
  hasRecycler,
  isPieceReady,
  maxBuyableGrams,
  moneyPrinterAvailability,
  nextAutomationCost,
  nextDesignCost,
  nextMoneyPrinterCost,
  nextPiece,
  nextPrinterCost,
  nextSlotCost,
  nextSlotUnlock,
  nextUpgradeCost,
  prestigeAvailability,
  quoteFor,
  resolveSlotConfig,
  slotUnlockAvailability,
  slotWithRoom,
  upgradeAvailability,
} from '@printhead/core';

/**
 * Wait-wall detector (spec §12.2): "flags any stretch > N design-minutes where
 * the bot had no affordable meaningful action — the classic idle-game dead
 * zone". Budgeted per phase in `pacing.json`.
 *
 * The load-bearing word is **meaningful**. In an idle game the player is *meant*
 * to spend most of their time watching prints finish, so "did the bot click
 * anything?" would flag the entire genre. What makes a stretch a dead zone is
 * that there is nothing worth clicking: no piece to attach, no purchase in
 * reach, no idle machine to feed. Selling parts deliberately does not count —
 * it is a step towards a purchase, not a decision, and counting it would let
 * any wall hide behind a sell button.
 *
 * The options are derived from the same content and the same availability rules
 * the reducer enforces, so a wall the detector reports is a wall a player would
 * actually sit through.
 */
export type MeaningfulOption =
  | 'attach-piece'
  | 'buy-printer'
  | 'buy-slot'
  | 'choose-fork'
  | 'buy-upgrade'
  | 'buy-automation'
  | 'feed-idle-slot'
  | 'restock-filament'
  | 'recycle-scrap'
  | 'draft-design'
  | 'load-design'
  | 'prestige'
  | 'buy-money-printer';

function phaseOf(content: Content, phaseId: string): PhaseDef | undefined {
  return content.pacing.phases.find((phase) => phase.id === phaseId);
}

function allows(content: Content, phaseId: string, action: string): boolean {
  return phaseOf(content, phaseId)?.allowedActions.some((allowed) => allowed === action) ?? false;
}

/**
 * Everything the player could usefully do right now. An empty list means they
 * are watching paint dry.
 */
export function meaningfulOptions(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): readonly MeaningfulOption[] {
  const options: MeaningfulOption[] = [];

  if (
    allows(content, state.phaseId, 'ATTACH_PIECE') &&
    nextPiece(state.assembly, content) !== null &&
    isPieceReady(state.assembly)
  ) {
    options.push('attach-piece');
  }

  const affordable = (cost: { resource: string; amount: number } | null): boolean =>
    cost !== null &&
    cost.resource !== 'filament' &&
    state.resources[cost.resource as keyof typeof state.resources] >= cost.amount;

  // A machine you cannot house is not an option: bays hold a fixed number of
  // printers (spec §4), so a full rack makes "buy a printer" a dead button.
  if (allows(content, state.phaseId, 'BUY_PRINTER') && slotWithRoom(state, content) !== null) {
    for (const printer of content.printers) {
      if (affordable(nextPrinterCost(state, content, curves, printer.id))) {
        options.push('buy-printer');
        break;
      }
    }
  }

  const unlock = nextSlotUnlock(state, content);
  if (
    allows(content, state.phaseId, 'BUY_SLOT') &&
    unlock !== null &&
    slotUnlockAvailability(state, content, unlock.id) === null &&
    affordable(nextSlotCost(content, curves, unlock.id))
  ) {
    options.push('buy-slot');
  }

  if (allows(content, state.phaseId, 'CHOOSE_FORK')) {
    for (const fork of content.forks) {
      if (
        forkAvailability(state, content, fork.id) === null &&
        affordable(forkCost(content, curves, fork.id))
      ) {
        options.push('choose-fork');
        break;
      }
    }
  }

  if (allows(content, state.phaseId, 'BUY_UPGRADE')) {
    for (const def of content.upgrades) {
      if (
        upgradeAvailability(state, content, def.id) === null &&
        affordable(nextUpgradeCost(state, content, curves, def.id))
      ) {
        options.push('buy-upgrade');
        break;
      }
    }
  }

  if (allows(content, state.phaseId, 'BUY_AUTOMATION')) {
    for (const def of content.automation) {
      if (
        automationAvailability(state, content, def.id) === null &&
        affordable(nextAutomationCost(state, content, curves, def.id))
      ) {
        options.push('buy-automation');
        break;
      }
    }
  }

  if (
    allows(content, state.phaseId, 'RECYCLE_SCRAP') &&
    state.resources.scrap > 0 &&
    hasRecycler(state, content)
  ) {
    options.push('recycle-scrap');
  }

  for (const slot of state.slots) {
    const config = resolveSlotConfig(content, slot);
    if (config === null || slot.run !== null || slot.changeoverMs > 0) {
      continue;
    }
    const stock = state.filamentGrams[config.material.id] ?? 0;
    if (
      allows(content, state.phaseId, 'START_PRINT') &&
      affordableBatch(config, slot.printerCount, stock) > 0
    ) {
      options.push('feed-idle-slot');
      break;
    }
    // A stalled slot the player could unstall by buying filament is not a wall.
    const quote = quoteFor(state, content, config.material.id);
    if (
      allows(content, state.phaseId, 'BUY_FILAMENT') &&
      quote !== null &&
      maxBuyableGrams(state, content, config.material.id, state.resources.money) >=
        config.filamentGrams
    ) {
      options.push('restock-filament');
      break;
    }
  }

  // The meta layer (spec §5D/§5E). A studio with a free bench and the money to
  // fill it, a Design waiting for a bay, a melt-down that would pay, or a press
  // to install — each of them is a real decision the player could make.
  const modifiers = computeModifiers(state, content);
  if (allows(content, state.phaseId, 'CREATE_DESIGN')) {
    for (const def of content.designs) {
      if (
        designAvailability(state, content, modifiers, def.id) === null &&
        affordable(nextDesignCost(state, content, curves, def.id))
      ) {
        options.push('draft-design');
        break;
      }
    }
  }

  if (
    allows(content, state.phaseId, 'SET_SLOT_DESIGN') &&
    Object.keys(state.designs).length > 0 &&
    state.slots.some((slot) => slot.designId === null && slot.printerCount > 0)
  ) {
    options.push('load-design');
  }

  if (
    allows(content, state.phaseId, 'PRESTIGE') &&
    prestigeAvailability(state, content, curves) === null
  ) {
    options.push('prestige');
  }

  if (allows(content, state.phaseId, 'BUY_MONEY_PRINTER')) {
    for (const def of content.prestige.moneyPrinters) {
      if (
        moneyPrinterAvailability(state, content, def.id) === null &&
        affordable(nextMoneyPrinterCost(state, content, curves, def.id))
      ) {
        options.push('buy-money-printer');
        break;
      }
    }
  }

  return options;
}

export interface WaitWall {
  readonly phaseId: string;
  readonly startDesignMinutes: number;
  readonly endDesignMinutes: number;
  readonly durationDesignMinutes: number;
}

/**
 * Folds a stream of "was there anything to do at this moment?" samples into
 * maximal idle stretches. A stretch is attributed to the phase it started in,
 * which is where a designer would go looking for it.
 */
export class WaitWallTracker {
  private walls: WaitWall[] = [];
  private idleSince: number | null = null;
  private idlePhaseId = '';
  private lastAt = 0;

  /** Record one check-in. */
  sample(designMinutes: number, phaseId: string, hasOptions: boolean): void {
    this.lastAt = designMinutes;
    if (hasOptions) {
      this.close(designMinutes);
      return;
    }
    // A stretch that runs across a phase boundary is *two* walls, one charged
    // to each phase. Charging the whole thing to the phase it began in made a
    // 5-minute intro report a 9.6-minute wall, which is not a fact about the
    // intro — it is a fact about the bench that followed it.
    if (this.idleSince !== null && this.idlePhaseId !== phaseId) {
      this.close(designMinutes);
    }
    if (this.idleSince === null) {
      this.idleSince = designMinutes;
      this.idlePhaseId = phaseId;
    }
  }

  /** Close the open stretch, if any, at `designMinutes`. */
  private close(designMinutes: number): void {
    if (this.idleSince === null) {
      return;
    }
    this.walls.push({
      phaseId: this.idlePhaseId,
      startDesignMinutes: this.idleSince,
      endDesignMinutes: designMinutes,
      durationDesignMinutes: designMinutes - this.idleSince,
    });
    this.idleSince = null;
  }

  /** Every stretch found, including one still open when the run stopped. */
  finish(): readonly WaitWall[] {
    this.close(this.lastAt);
    return this.walls;
  }
}

export interface WaitWallViolation {
  readonly phaseId: string;
  readonly durationDesignMinutes: number;
  readonly budgetDesignMinutes: number;
  readonly startDesignMinutes: number;
}

/** Walls that overrun the budget their phase declares in `pacing.json`. */
export function checkWaitWalls(
  content: Content,
  walls: readonly WaitWall[],
): readonly WaitWallViolation[] {
  const violations: WaitWallViolation[] = [];
  for (const wall of walls) {
    const budget = phaseOf(content, wall.phaseId)?.waitWallBudgetDesignMinutes;
    if (budget === undefined || wall.durationDesignMinutes <= budget) {
      continue;
    }
    violations.push({
      phaseId: wall.phaseId,
      durationDesignMinutes: wall.durationDesignMinutes,
      budgetDesignMinutes: budget,
      startDesignMinutes: wall.startDesignMinutes,
    });
  }
  return violations;
}

/** The worst wall per phase — what a report table wants to show. */
export function longestWallByPhase(walls: readonly WaitWall[]): ReadonlyMap<string, number> {
  const worst = new Map<string, number>();
  for (const wall of walls) {
    const current = worst.get(wall.phaseId) ?? 0;
    if (wall.durationDesignMinutes > current) {
      worst.set(wall.phaseId, wall.durationDesignMinutes);
    }
  }
  return worst;
}
