/**
 * Addressing content fields for sweeps and auto-tuning (spec §12.3/§12.4).
 *
 * Plain JSON Pointer would address content arrays by index (`/curves/0/base`),
 * which silently retargets the moment someone reorders a file. Content is
 * id-keyed, so this resolver accepts ids where an array index would go:
 *
 *   curves/printer-cost-tier1/base
 *   start/assemblyPieces/frame/attachDesignSeconds
 *   start/assemblyPieces/... every piece ...
 *
 * A `*` segment fans out over every element of an array, so one knob can move a
 * whole family of values together.
 */
export type Mutable = Record<string, unknown>;

export class PointerError extends Error {
  constructor(
    public readonly pointer: string,
    message: string,
  ) {
    super(`${pointer}: ${message}`);
    this.name = 'PointerError';
  }
}

const WILDCARD = '*';

export function parsePointer(pointer: string): readonly string[] {
  const segments = pointer.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new PointerError(pointer, 'must name at least one field');
  }
  return segments;
}

function childrenOf(node: unknown, segment: string, pointer: string): unknown[] {
  if (Array.isArray(node)) {
    if (segment === WILDCARD) {
      return node;
    }
    const index = Number(segment);
    if (Number.isInteger(index) && index >= 0 && index < node.length) {
      return [node[index]];
    }
    const byId = node.filter(
      (entry) => typeof entry === 'object' && entry !== null && (entry as Mutable).id === segment,
    );
    if (byId.length === 0) {
      throw new PointerError(pointer, `no array element with id "${segment}"`);
    }
    return byId;
  }
  if (typeof node === 'object' && node !== null) {
    if (!(segment in (node as Mutable))) {
      throw new PointerError(pointer, `no field "${segment}"`);
    }
    return [(node as Mutable)[segment]];
  }
  throw new PointerError(pointer, `cannot descend into ${typeof node} at "${segment}"`);
}

/** Every numeric value the pointer selects. */
export function readPointer(root: unknown, pointer: string): number[] {
  const segments = parsePointer(pointer);
  let nodes: unknown[] = [root];
  for (const segment of segments) {
    nodes = nodes.flatMap((node) => childrenOf(node, segment, pointer));
  }
  return nodes.map((node) => {
    if (typeof node !== 'number') {
      throw new PointerError(pointer, `resolves to ${typeof node}, expected a number`);
    }
    return node;
  });
}

/**
 * Set every value the pointer selects, in place. Callers pass a deep clone of
 * the raw content: the auto-tuner must never mutate the bundled defs, only the
 * candidate it is scoring.
 */
export function writePointer(root: unknown, pointer: string, value: number): void {
  const segments = parsePointer(pointer);
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) {
    throw new PointerError(pointer, 'must name at least one field');
  }
  let parents: unknown[] = [root];
  for (const segment of segments.slice(0, -1)) {
    parents = parents.flatMap((node) => childrenOf(node, segment, pointer));
  }
  for (const parent of parents) {
    if (Array.isArray(parent)) {
      throw new PointerError(pointer, 'cannot assign to an array element without an id');
    }
    if (typeof parent !== 'object' || parent === null) {
      throw new PointerError(pointer, `cannot assign into ${typeof parent}`);
    }
    if (!(leaf in (parent as Mutable))) {
      throw new PointerError(pointer, `no field "${leaf}"`);
    }
    (parent as Mutable)[leaf] = value;
  }
}
