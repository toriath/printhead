/**
 * PRINTHEAD import rules (spec §19).
 *
 * The load-bearing rule is `core-is-independent`: packages/core must never
 * import renderer / app / editor / platform — the simulation is portable,
 * headless and renderer-swappable (spec §10, ADR-001).
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make the reducer/projection layering unprovable.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-is-independent',
      severity: 'error',
      comment:
        'packages/core is the pure simulation: it may not depend on renderer, app, editor or platform.',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(renderer|app|editor|platform)/' },
    },
    {
      name: 'core-imports-no-workspace-ui',
      severity: 'error',
      comment: 'Same rule, via workspace package names resolved through node_modules symlinks.',
      from: { path: '^packages/core/' },
      to: { path: 'node_modules/@printhead/(renderer|app|editor|platform)/' },
    },
    {
      name: 'core-has-no-dom',
      severity: 'error',
      comment: 'packages/core must stay DOM-free and framework-free (spec §10).',
      from: { path: '^packages/core/' },
      to: { path: 'node_modules/(react|react-dom|jsdom)/' },
    },
    {
      name: 'renderer-is-presentational',
      severity: 'error',
      comment: 'The renderer is a pure function of VisualState; it may not reach into app/editor.',
      from: { path: '^packages/renderer/' },
      to: { path: '^packages/(app|editor)/' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)[.][^/]+[.](?:js|cjs|mjs|ts|cts|mts|json)$',
          '[.]d[.]ts$',
          '(^|/)tsconfig[.]json$',
          '(^|/)src/index[.]tsx?$',
          '(^|/)(?:babel|webpack|vite|vitest|playwright|stryker)[.]config[.](?:js|cjs|mjs|ts)$',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: [
        'node_modules',
        '(^|/)dist/',
        '(^|/)dist-types/',
        '\\.test\\.tsx?$',
        '\\.spec\\.tsx?$',
        '(^|/)__fixtures__/',
      ],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.json'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
