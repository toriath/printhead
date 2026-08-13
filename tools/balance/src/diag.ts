import { REFERENCE_BOT, findBot, runHeadless } from '@printhead/balance';
import { RAW_CONTENT, loadContent, requirementProgress } from '@printhead/core';

const content = loadContent(RAW_CONTENT);
const bot = process.argv[2] === undefined ? REFERENCE_BOT : findBot(process.argv[2]);
const log = runHeadless({ content, bot });
const s = log.finalState;
console.log(
  'bot',
  bot.id,
  'final phase',
  log.finalPhaseId,
  'minutes',
  log.designMinutes.toFixed(1),
);
for (const [id, d] of log.phaseDurations) console.log('  phase', id, d.toFixed(1));
const phase = content.pacing.phases.find((p) => p.id === s.phaseId);
console.log('waiting on:', requirementProgress(s, content, phase?.advanceWhen ?? []));
console.log('resources', s.resources);
console.log('designs', s.designs, 'studio', s.studio, 'fork', s.forkId);
console.log('upgrades', s.upgrades);
console.log(
  'slots',
  s.slots.map((x) => [x.id, x.materialId, x.objectId, x.designId, x.printerCount]),
);
console.log('moneyPrinters', s.moneyPrinters);
console.log('stats', s.stats);
console.log('actions', log.actionsByType);
console.log('walls', log.waitWalls);
