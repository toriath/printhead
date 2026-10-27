import { buyFilament, overclockSlot } from '@printhead/core';
import { Workshop } from '@printhead/renderer';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { AgentsPanel } from './agents.js';
import { AssemblyBench, Awakening } from './assembly.js';
import { CasinoLayer, MusicToggle, MuteToggle, StreakPill, useCasino } from './casino.js';
import { CommissionsPanel } from './commissions.js';
import { buildControlModel } from './controls-model.js';
import { ActionBar, Controls } from './controls.js';
import { DiaryButton, DiaryDrawer } from './diary.js';
import { EndgamePanel, EndingScreen } from './endgame.js';
import { FleetPanel } from './fleet.js';
import { useFloor } from './floor.js';
import { formatGrams, formatMoney } from './format.js';
import { gateSummary, layerProgress, nextStep } from './guide.js';
import { useVisualState } from './hooks.js';
import { Hud, SpoolShelf } from './hud.js';
import { Spool } from './icons.js';
import { LayerBanner, LayerTrack, PopupLayer, WorkshopLog, useJuice } from './juice.js';
import { PrestigePanel, StudioPanel } from './meta.js';
import { startMusic } from './music.js';
import { AutomationPanel, MarketPanel, RecyclerPanel, UpgradePanel } from './panels.js';
import { useReveal } from './reveal.js';
import * as sfx from './sfx.js';
import { unlockAudio } from './sfx.js';
import { ShopFloor, ShopPanel } from './shop.js';
import { useShortcuts } from './shortcuts.js';
import { starvedSlots } from './starve.js';
import type { GameStore } from './store.js';
import { useDiary } from './story.js';
import { PanelTabs } from './tabs.js';

/**
 * The shell (spec §16). It renders `VisualState` and dispatches `Action`s —
 * that is the whole contract. Every rule it appears to know (which piece is
 * next, which buttons exist, what a phase allows) is read out of the projection
 * or the content, never decided here.
 */
export interface AppProps {
  readonly store: GameStore;
  /** Shown when a save existed but could not be read. */
  readonly loadWarning?: string | null;
}

/** The out-of-filament badge floats clear of the printer's face. */
const STALL_LIFT_PX = 44;
/** The diary's "…" bubble sits off the printer's shoulder. */
const THOUGHT_OFFSET_PX = 46;

export function App({ store, loadWarning = null }: AppProps): ReactElement {
  const visual = useVisualState(store);
  const content = store.getContent();
  const juice = useJuice(store);
  const casino = useCasino(store);
  useShortcuts();
  // Browsers only let a page make sound after a gesture: the first one unlocks it.
  useEffect(() => {
    const unlock = (): void => {
      unlockAudio();
      startMusic();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  const bays = visual.goliath ? 1 : Math.max(visual.slotCapacity, visual.slots.length);
  // One bay is in focus: the bay card, the guide and the commission board all
  // aim at it. Tapping a printer overclocks it *and* brings it into focus.
  const [slotId, setSlotId] = useState<string | null>(null);
  const state = store.getState();
  const model = buildControlModel(state, content, visual, slotId ?? undefined);
  const reveal = useReveal(state, visual, content, model);
  const diary = useDiary(state, content);
  const [reading, setReading] = useState(false);
  const closeDiary = (): void => {
    diary.markRead();
    setReading(false);
  };
  const floor = useFloor(visual.slots.map((slot) => slot.slotId));
  // Bays stopped for want of filament: the loudest thing on screen.
  const starved = starvedSlots(state, content);
  const step = nextStep(visual, model, starved);
  const starvedKey = starved.join();
  const wasStarved = useRef<readonly string[]>([]);
  useEffect(() => {
    const now = starvedKey === '' ? [] : starvedKey.split(',');
    if (now.some((id) => !wasStarved.current.includes(id))) {
      sfx.starve();
    }
    wasStarved.current = now;
  }, [starvedKey]);
  const faces = {
    ...juice.flourishes,
    ...Object.fromEntries(
      starved
        .filter((id) => juice.flourishes[id] === undefined)
        .map((id) => [id, 'worried' as const]),
    ),
  };
  const stage = useRef<HTMLDivElement | null>(null);
  /** A popup rises from the printer it is about, wherever it stands. */
  const anchorOf = (slotIndex: number): { left: number; top: number } | null => {
    const slotId = visual.slots[slotIndex]?.slotId;
    const spot = stage.current?.querySelector(`[data-slot-id="${slotId}"][data-lead]`);
    const box = stage.current?.getBoundingClientRect();
    if (spot === null || spot === undefined || box === undefined) {
      return null;
    }
    const rect = spot.getBoundingClientRect();
    return {
      left: rect.left + rect.width / 2 - box.left,
      top: rect.top + rect.height * 0.3 - box.top,
    };
  };
  const [panels, setPanels] = useState(0);
  // Printer #1 is built by hand on the bench; later runs rebuild themselves.
  const onBench = !visual.assembly.complete && !visual.assembly.selfAssembling;
  // The moment the last piece goes on, the machine wakes up and the workshop
  // is revealed around it — once, on the transition, never on a reload.
  const wasOnBench = useRef(onBench);
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (wasOnBench.current && !onBench) {
      setAwake(true);
    }
    wasOnBench.current = onBench;
  }, [onBench]);

  if (onBench) {
    // The intro is the bench and nothing else: no ledger, no panels, no word
    // of what is being built. The workshop appears when the thing wakes up.
    return (
      <div className="intro-screen">
        <span className="visually-hidden" data-testid="phase">
          {visual.phaseId}
        </span>
        {loadWarning === null ? null : (
          <output className="app__warning" data-testid="load-warning">
            {loadWarning}
          </output>
        )}
        <AssemblyBench store={store} visual={visual} content={content} />
        <div className="intro-screen__mute">
          <MusicToggle />
          <MuteToggle />
        </div>
      </div>
    );
  }

  return (
    <div
      className={[
        'shell',
        awake ? 'is-revealed' : '',
        panels === 0 ? 'no-right' : '',
        reveal.sell || reveal.filament || reveal.build ? '' : 'no-foot',
      ].join(' ')}
    >
      <header className="topbar">
        <div className="topbar__brand">
          <svg viewBox="0 0 64 64" width="30" height="30" aria-hidden="true" className="pc-char">
            <rect x="10" y="6" width="44" height="38" rx="10" className="pc-o pc-pla" />
            <rect x="17" y="13" width="30" height="16" rx="4" className="pc-o pc-screen" />
            <rect x="23" y="17" width="4" height="7" className="pc-pixel" />
            <rect x="37" y="17" width="4" height="7" className="pc-pixel" />
            <rect x="24" y="44" width="16" height="6" rx="1.5" className="pc-o pc-alu" />
            <path d="M27 50h10l-3 8h-4z" className="pc-o pc-brass" />
          </svg>
          <h1>Printhead</h1>
        </div>
        <div className="topbar__phase">
          <LayerTrack
            content={content}
            phaseId={visual.phaseId}
            progress={layerProgress(state, content)}
            gate={gateSummary(state, content)}
          />
          {visual.prestige.current === null ? null : (
            <span
              className="runchip"
              data-testid="run-modifier"
              title={visual.prestige.current.description}
            >
              {visual.prestige.current.name}
            </span>
          )}
          <p className="app__phase">
            {/* The id is the stable handle tests and tooling address; the name is
                what a player reads. Both are here; only one is visible. */}
            <span className="visually-hidden" data-testid="phase">
              {visual.phaseId}
            </span>
            <span className="app__phase-name" data-testid="phase-name">
              {visual.phaseName}
            </span>
          </p>
        </div>
        <Hud visual={visual} content={content} showFilament={false} reveal={reveal} />
        <StreakPill streak={casino.streak} />
        <DiaryButton diary={diary} onOpen={() => setReading(true)} />
        <MusicToggle />
        <MuteToggle />
      </header>

      <aside className="sidebar sidebar--left" aria-label="bays and orders">
        <Controls
          store={store}
          visual={visual}
          content={content}
          model={model}
          onSelectSlot={setSlotId}
          next={step.target}
          starved={starved.includes(model.slotId)}
        />
        <div className="reveal" hidden={!reveal.filament}>
          <SpoolShelf visual={visual} content={content} />
        </div>
        <div className="reveal" hidden={!visual.shop.open}>
          <ShopPanel store={store} visual={visual} />
        </div>
        <div className="reveal" hidden={!reveal.orders}>
          <CommissionsPanel store={store} visual={visual} slotId={model.slotId} />
        </div>
      </aside>

      <main className="center">
        {loadWarning === null ? null : (
          <output className="app__warning" data-testid="load-warning">
            {loadWarning}
          </output>
        )}
        {/* Alternating two identical animations restarts the shake on every
            failure without remounting the workshop. */}
        <div
          className={[
            'stage',
            juice.shake === 0 ? '' : juice.shake % 2 === 0 ? 'is-shake-a' : 'is-shake-b',
            starved.length > 0 ? 'is-starved' : '',
          ].join(' ')}
          data-shake={juice.shake}
          ref={stage}
          onPointerDown={floor.onPointerDown}
        >
          <Workshop
            visual={visual}
            flourishes={faces}
            layout="floor"
            positions={floor.positions}
            grabbedSlotId={floor.grabbed}
            onSlotPress={(pressed) => {
              // The click that ends a drag moved the printer; it is not a press.
              if (floor.swallowClick()) {
                return;
              }
              setSlotId(pressed);
              store.dispatch(overclockSlot(pressed));
            }}
          />
          <PopupLayer popups={juice.popups} bays={bays} anchorOf={anchorOf} />
          <ShopFloor store={store} stage={stage} />
          {diary.fresh === null || reading
            ? null
            : (() => {
                const anchor = anchorOf(0);
                return anchor === null ? null : (
                  <button
                    type="button"
                    className="thought"
                    data-testid="diary-thought"
                    aria-label="The printer wrote something in its diary"
                    style={{
                      left: anchor.left + THOUGHT_OFFSET_PX,
                      top: anchor.top - STALL_LIFT_PX,
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => setReading(true)}
                  >
                    …
                  </button>
                );
              })()}
          {starved.map((id) => {
            const index = visual.slots.findIndex((slot) => slot.slotId === id);
            const anchor = anchorOf(index);
            const slot = visual.slots[index];
            if (anchor === null || slot === undefined) {
              return null;
            }
            const restock = buildControlModel(state, content, visual, id).buyFilament;
            return (
              <button
                key={id}
                type="button"
                className="stall"
                data-testid={`stall-${id}`}
                style={{ left: anchor.left, top: anchor.top - STALL_LIFT_PX }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  setSlotId(id);
                  if (restock?.enabled === true) {
                    store.dispatch(buyFilament(restock.materialId, restock.grams));
                  }
                }}
              >
                <Spool materialId={slot.materialId ?? ''} fill={0} size={22} />
                <span className="stall__text">
                  <strong>{`Out of ${slot.materialName ?? 'filament'}`}</strong>
                  <span>
                    {restock?.enabled === true
                      ? `Click to buy ${formatGrams(restock.grams)} · ${formatMoney(restock.cost)}`
                      : 'Sell parts to afford a spool'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="center__foot reveal" hidden={!reveal.log}>
          <WorkshopLog log={juice.log} />
          <p className="center__hint">
            Click a printer to overclock it, drag it to move it. Keys:{' '}
            {visual.slots.length > 1 ? (
              <>
                <kbd>1</kbd>–<kbd>4</kbd> bays,{' '}
              </>
            ) : null}
            <kbd>L</kbd> load, <kbd>P</kbd> print
            {reveal.sell ? (
              <>
                , <kbd>S</kbd> sell
              </>
            ) : null}
            {reveal.filament ? (
              <>
                , <kbd>F</kbd> filament
              </>
            ) : null}
            {reveal.build ? (
              <>
                , <kbd>B</kbd> build
              </>
            ) : null}
            .
          </p>
        </div>
      </main>

      <aside className="sidebar sidebar--right" aria-label="workshop panels">
        {/* Each panel hides itself until its mechanic unlocks (spec §6's
            reveal order); the tab bar offers exactly the ones that show. */}
        <PanelTabs
          onAvailable={setPanels}
          tabs={[
            {
              id: 'machine',
              label: 'Machine',
              icon: 'machine',
              content: reveal.machine ? (
                <>
                  <UpgradePanel store={store} visual={visual} />
                  <RecyclerPanel store={store} visual={visual} />
                </>
              ) : null,
            },
            {
              id: 'automation',
              label: 'Automation',
              icon: 'automation',
              content: reveal.automation ? <AutomationPanel store={store} visual={visual} /> : null,
            },
            {
              id: 'agents',
              label: 'Agents',
              icon: 'agent',
              content: <AgentsPanel store={store} visual={visual} />,
            },
            {
              id: 'market',
              label: 'Market',
              icon: 'market',
              content: reveal.filament ? <MarketPanel store={store} visual={visual} /> : null,
            },
            {
              id: 'fleet',
              label: 'Fleet',
              icon: 'fleet',
              content: <FleetPanel store={store} visual={visual} />,
            },
            {
              id: 'studio',
              label: 'Studio',
              icon: 'studio',
              content: <StudioPanel store={store} visual={visual} />,
            },
            {
              id: 'meltdown',
              label: 'Melt-down',
              icon: 'meltdown',
              content: <PrestigePanel store={store} visual={visual} />,
            },
            {
              id: 'endgame',
              label: 'Endgame',
              icon: 'endgame',
              content: <EndgamePanel store={store} visual={visual} />,
            },
          ]}
        />
      </aside>

      <footer className="footer">
        <ActionBar
          store={store}
          visual={visual}
          model={model}
          next={step.target}
          reveal={reveal}
          starved={starved.length > 0}
        />
      </footer>

      <CasinoLayer casino={casino} />
      {reading ? <DiaryDrawer diary={diary} onClose={closeDiary} /> : null}
      {awake ? <Awakening onDone={() => setAwake(false)} /> : null}
      <LayerBanner banner={juice.banner} />
      {/* The ending takes the screen when it arrives (spec §6 phase 6). */}
      <EndingScreen store={store} visual={visual} />
    </div>
  );
}
