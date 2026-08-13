import { createPolicyBot, runHeadless } from '@printhead/balance';
import { RAW_CONTENT, loadContent, newGamePlusAvailability } from '@printhead/core';

const content = loadContent(RAW_CONTENT);
const bot = createPolicyBot({
  id: 'new-game-plus',
  checkInDesignSeconds: 5,
  capacityFirst: false,
  reserveBatches: 3,
  chaseMargin: true,
  preferFork: 'flexibility',
  useQueues: false,
  newGamePlusModifierIds: ['veteran-workshop'],
});
const log = runHeadless({ content, bot });
const s = log.finalState;
console.log(
  'final',
  log.finalPhaseId,
  'ngplus',
  s.ngPlus,
  'avail',
  newGamePlusAvailability(s, content),
);
console.log('fab', s.fabricator, 'ended events', log.eventCounts.GAME_ENDED);
console.log(
  'moves',
  JSON.stringify(bot.decide({ state: s, content, designMinutes: 0 })).slice(0, 200),
);
for (const e of log.events) {
  if (
    e.type === 'PHASE_ADVANCED' ||
    e.type === 'PRESTIGED' ||
    e.type === 'GAME_ENDED' ||
    e.type === 'NEW_GAME_PLUS_STARTED'
  ) {
    console.log((e.simTimeMs / 60000).toFixed(1), e.type, JSON.stringify(e).slice(0, 70));
  }
}
