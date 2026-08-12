import automation from '../../content/automation.json' with { type: 'json' };
import curves from '../../content/curves.json' with { type: 'json' };
import designs from '../../content/designs.json' with { type: 'json' };
import market from '../../content/market.json' with { type: 'json' };
import materials from '../../content/materials.json' with { type: 'json' };
import objects from '../../content/objects.json' with { type: 'json' };
import pacing from '../../content/pacing.json' with { type: 'json' };
import prestige from '../../content/prestige.json' with { type: 'json' };
import printers from '../../content/printers.json' with { type: 'json' };
import start from '../../content/start.json' with { type: 'json' };
import upgrades from '../../content/upgrades.json' with { type: 'json' };
import type { RawContent } from './schema.js';

/** The bundled content set, unvalidated. Always go through `loadContent`. */
export const RAW_CONTENT: RawContent = {
  pacing,
  start,
  curves,
  materials,
  objects,
  printers,
  upgrades,
  designs,
  market,
  automation,
  prestige,
};
