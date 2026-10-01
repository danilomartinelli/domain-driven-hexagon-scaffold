// https://github.com/Sairyss/domain-driven-hexagon#enforcing-architecture

const apiLayerPaths = [
  'controller',
  'dtos',
  'request',
  'response',
  'dto\\.ts$',
  'controller\\.ts$',
  'resolver\\.ts$',
];

const applicationLayerPaths = ['application', '\\.service\\.ts$'];

// Nest CQRS handlers are input adapters that delegate to plain use cases.
const cqrsHandlerPaths = [
  'query-handler\\.ts$',
  'command-handler\\.ts$',
  'service\\.ts$',
];

const infrastructureLayerPaths = [
  'infrastructure',
  'infra',
  'database',
  'repository',
];

const domainLayerPaths = [
  'domain',
  'entity\\.ts$',
  'aggregate\\.ts$',
  'domain-event\\.ts$',
  'value-object\\.ts$',
];

// A closed set prevents indirect escapes through shared barrels as well.
const corePaths = [
  '^src/packages/core/(?!tests/)',
  '^src/apps/[^/]+/(domain|application)/',
];

// Root files are entry points; every package subfolder is private.
const PACKAGES_ROOT = 'src/packages';
const PACKAGE_INTERNALS = `^${PACKAGES_ROOT}/[^/]+/[^/]+/`;

// Test code; production code must not import it.
const testPaths =
  '^(tests|src/type-tests|scripts/tests|src/packages/[^/]+/tests|src/apps/[^/]+/tests)';

/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
  forbidden: [
    {
      name: 'apps-are-independent',
      severity: 'error',
      comment:
        'An application imports its own files and shared packages, never another application.',
      from: { path: '^src/apps/([^/]+)/' },
      to: {
        path: '^(src|tests|scripts)/',
        pathNot: [
          '^src/apps/$1/',
          `^${PACKAGES_ROOT}/`,
          '^scripts/tests/(cleanup|broker-gate)\\.ts$',
        ],
      },
    },
    {
      name: 'app-runtime-excludes-tooling',
      severity: 'error',
      comment:
        'Production application code cannot depend on database or environment tooling; only its tests use the environment guard.',
      from: { path: '^src/apps/[^/]+/', pathNot: '^src/apps/[^/]+/tests/' },
      to: { path: '^(database|scripts)/' },
    },
    {
      name: 'app-implementation-is-private',
      severity: 'error',
      comment:
        'Other applications, packages, tooling and system tests cannot import application implementation.',
      from: { pathNot: '^src/apps/' },
      to: { path: '^src/apps/' },
    },
    {
      name: 'shared-is-technical',
      severity: 'error',
      from: {
        path: '^src/packages/(core|nest-support|integration-contracts)/',
      },
      to: { path: '^(src/(?!packages/)|tests/|scripts/|database/)' },
    },
    {
      name: 'integration-contract-is-independent',
      severity: 'error',
      comment:
        'Wire contracts depend only on their own schema and validation library, never on application or framework implementation.',
      from: { path: '^src/packages/integration-contracts/(?!tests/)' },
      to: {
        pathNot: [
          '^src/packages/integration-contracts/',
          '(^|/)node_modules/zod/',
          '(^|/)node_modules/\\.bun/zod@[^/]+/node_modules/zod/',
        ],
      },
    },
    {
      name: 'entrypoint-boundary-from-app',
      severity: 'error',
      comment: 'Outside code must use package root entry points.',
      from: { pathNot: `^${PACKAGES_ROOT}/` },
      to: { path: PACKAGE_INTERNALS },
    },
    {
      name: 'entrypoint-boundary-across-packages',
      severity: 'error',
      comment:
        'A package may reach other packages only through their entry points.',
      from: {
        path: `^${PACKAGES_ROOT}/([^/]+)/`,
        pathNot: `^${PACKAGES_ROOT}/[^/]+/tests/`,
      },
      to: { path: PACKAGE_INTERNALS, pathNot: `^${PACKAGES_ROOT}/$1/` },
    },
    {
      name: 'tests-through-entrypoints',
      severity: 'error',
      comment:
        'Tests may use package entry points and their own test fixtures only.',
      from: { path: `^${PACKAGES_ROOT}/([^/]+)/tests/` },
      to: { path: PACKAGE_INTERNALS, pathNot: `^${PACKAGES_ROOT}/$1/tests/` },
    },
    {
      name: 'tests-folder-is-private',
      severity: 'error',
      comment: 'Production code must not import package tests or fixtures.',
      from: { pathNot: `^${PACKAGES_ROOT}/[^/]+/tests/` },
      to: { path: `^${PACKAGES_ROOT}/[^/]+/tests/` },
    },
    {
      name: 'core-is-context-independent',
      comment:
        'Domain, commands, application use cases and shared primitives may only import the plain TypeScript core.',
      severity: 'error',
      from: { path: corePaths },
      to: {
        pathNot: [
          ...corePaths,
          // The package, wherever node_modules resolves (including linked copies).
          '(^|/)node_modules/oxide\\.ts/',
          '(^|/)node_modules/\\.bun/oxide\\.ts@[^/]+/node_modules/oxide\\.ts/',
        ],
      },
    },
    /* user defined rules */
    {
      name: 'no-domain-to-api-deps',
      comment: 'Domain layer cannot depend on api layer',
      severity: 'error',
      from: { path: domainLayerPaths },
      to: {
        path: apiLayerPaths,
      },
    },
    {
      name: 'no-domain-to-app-deps',
      comment: 'Domain layer cannot depend on application layer',
      severity: 'error',
      from: { path: domainLayerPaths },
      to: {
        path: applicationLayerPaths,
      },
    },
    {
      name: 'no-domain-to-infra-deps',
      comment: 'Domain layer cannot depend on infrastructure layer',
      severity: 'error',
      from: { path: domainLayerPaths },
      to: {
        path: infrastructureLayerPaths,
        pathNot: ['port\\.ts$'],
      },
    },
    {
      name: 'no-infra-to-api-deps',
      comment: 'Infrastructure layer cannot depend on api layer',
      severity: 'error',
      from: { path: infrastructureLayerPaths },
      to: {
        path: apiLayerPaths,
      },
    },
    {
      name: 'no-input-adapter-to-persistence-deps',
      comment:
        'Controllers, resolvers and CQRS handlers use application results, not persistence models or repositories',
      severity: 'error',
      from: {
        path: [
          ...apiLayerPaths,
          ...cqrsHandlerPaths,
          '^src/apps/[^/]+/messaging/',
        ],
      },
      to: { path: '^src/(modules|apps)/[^/]+/database/' },
    },
    {
      name: 'no-command-query-to-api-deps',
      comment: 'Commands and Queries cannot depend on api layer',
      severity: 'error',
      from: { path: [...cqrsHandlerPaths, 'command\\.ts$'] },
      to: {
        path: apiLayerPaths,
      },
    },

    /* rules from the 'recommended' preset: */
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No dependency cycles, including type-only imports.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment:
        "This is an orphan module - it's likely not used (anymore?). Either use it or " +
        "remove it. If it's logical this module is an orphan (i.e. it's a config file), " +
        'add an exception for it in your dependency-cruiser configuration. By default ' +
        'this rule does not scrutinize dot-files (e.g. .eslintrc.js), TypeScript declaration ' +
        'files (.d.ts), tsconfig.json and some of the babel and webpack configs.',
      severity: 'error',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$', // dot files
          '\\.d\\.ts$', // TypeScript declaration files
          '(^|/)tsconfig\\.json$', // TypeScript config
          '(^|/)(babel|webpack)\\.config\\.(js|cjs|mjs|ts|json)$', // other configs
        ],
      },
      to: {},
    },
    {
      name: 'no-deprecated-core',
      comment:
        'A module depends on a node core module that has been deprecated. Find an alternative - these are ' +
        "bound to exist - node doesn't deprecate lightly.",
      severity: 'error',
      from: {},
      to: {
        dependencyTypes: ['core'],
        path: [
          '^(v8/tools/codemap)$',
          '^(v8/tools/consarray)$',
          '^(v8/tools/csvparser)$',
          '^(v8/tools/logreader)$',
          '^(v8/tools/profile_view)$',
          '^(v8/tools/profile)$',
          '^(v8/tools/SourceMap)$',
          '^(v8/tools/splaytree)$',
          '^(v8/tools/tickprocessor-driver)$',
          '^(v8/tools/tickprocessor)$',
          '^(node-inspect/lib/_inspect)$',
          '^(node-inspect/lib/internal/inspect_client)$',
          '^(node-inspect/lib/internal/inspect_repl)$',
          // AsyncLocalStorage from node:async_hooks is stable and intentionally retained.
          '^(punycode)$',
          '^(domain)$',
          '^(constants)$',
          '^(sys)$',
          '^(_linklist)$',
          '^(_stream_wrap)$',
        ],
      },
    },
    {
      name: 'not-to-deprecated',
      comment:
        'This module uses a (version of an) npm module that has been deprecated. Either upgrade to a later ' +
        'version of that module, or find an alternative. Deprecated modules are a security risk.',
      severity: 'error',
      from: {},
      to: {
        dependencyTypes: ['deprecated'],
      },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      comment:
        "This module depends on an npm package that isn't in the 'dependencies' section of your package.json. " +
        "That's problematic as the package either (1) won't be available on live (2 - worse) will be " +
        'available on live with an non-guaranteed version. Fix it by adding the package to the dependencies ' +
        'in your package.json.',
      from: {},
      to: {
        dependencyTypes: ['npm-no-pkg', 'npm-unknown'],
      },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        "This module depends on a module that cannot be found ('resolved to disk'). If it's an npm " +
        'module: add it to your package.json. In all other cases you likely already know what to do.',
      severity: 'error',
      from: {},
      to: {
        couldNotResolve: true,
      },
    },
    {
      name: 'no-duplicate-dep-types',
      comment:
        "Likely this module depends on an external ('npm') package that occurs more than once " +
        'in your package.json i.e. bot as a devDependencies and in dependencies. This will cause ' +
        'maintenance problems later on.',
      severity: 'error',
      from: {},
      to: {
        moreThanOneDependencyType: true,
        // as it's pretty common to have a type import be a type only import
        // _and_ (e.g.) a devDependency - don't consider type-only dependency
        // types for this rule
        dependencyTypesNot: ['type-only'],
      },
    },

    /* rules you might want to tweak for your specific situation: */
    {
      name: 'not-to-test',
      comment:
        "This module depends on code within a folder that should only contain tests. As tests don't " +
        "implement functionality this is odd. Either you're writing a test outside the test folder " +
        "or there's something in the test folder that isn't a test.",
      severity: 'error',
      from: { pathNot: testPaths },
      to: { path: testPaths },
    },
    {
      name: 'not-to-spec',
      comment:
        'This module depends on a spec (test) file. The sole responsibility of a spec file is to test code. ' +
        "If there's something in a spec that's of use to other modules, it doesn't have that single " +
        'responsibility anymore. Factor it out into (e.g.) a separate utility/ helper or a mock.',
      severity: 'error',
      from: {},
      to: {
        path: '\\.(spec|test)\\.(js|mjs|cjs|ts|ls|coffee|litcoffee|coffee\\.md)$',
      },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        "This module depends on an npm package from the 'devDependencies' section of your " +
        'package.json. It looks like something that ships to production, though. To prevent problems ' +
        "with npm packages that aren't there on production declare it (only!) in the 'dependencies'" +
        'section of your package.json. If this module is development only - add it to the ' +
        'from.pathNot re of the not-to-dev-dep rule in the dependency-cruiser configuration',
      from: {
        path: '^(src)',
        pathNot: [
          '/tests/',
          '/type-tests/',
          '\\.(spec|test)\\.(js|mjs|cjs|ts|ls|coffee|litcoffee|coffee\\.md)$',
        ],
      },
      to: {
        dependencyTypes: ['npm-dev'],
        // Type-only adapter contracts are supplied by @types packages, not runtime imports.
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'optional-deps-used',
      severity: 'info',
      comment:
        'This module depends on an npm package that is declared as an optional dependency ' +
        "in your package.json. As this makes sense in limited situations only, it's flagged here. " +
        "If you're using an optional dependency here by design - add an exception to your" +
        'dependency-cruiser configuration.',
      from: {},
      to: {
        dependencyTypes: ['npm-optional'],
      },
    },
    {
      name: 'peer-deps-used',
      comment:
        'This module depends on an npm package that is declared as a peer dependency ' +
        'in your package.json. This makes sense if your package is e.g. a plugin, but in ' +
        'other cases - maybe not so much. If the use of a peer dependency is intentional ' +
        'add an exception to your dependency-cruiser configuration.',
      severity: 'error',
      from: {},
      to: {
        dependencyTypes: ['npm-peer'],
      },
    },
  ],
  // Reference: https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md
  options: {
    // Record third-party modules as dependencies without cruising their internals.
    doNotFollow: {
      path: 'node_modules',
    },
    // Type-only imports are real dependencies for the architecture rules.
    tsPreCompilationDeps: true,
    // Workspace packages declare their dependencies in their own manifests.
    combinedDependencies: true,
    // Resolves the root path aliases.
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    // enhanced-resolve settings; there is no webpack configuration to supply them.
    enhancedResolveOptions: {
      // Package entry points come from `exports`, including Bun's condition.
      exportsFields: ['exports'],
      conditionNames: ['bun', 'import', 'require', 'node', 'default'],
      // TypeScript, JavaScript and JSON sources the analyzed projects import.
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      // `types` resolves packages whose manifests only name TypeScript declarations.
      mainFields: ['main', 'types'],
    },
    reporterOptions: {
      // `deps:graph` renders dot output with each external package collapsed.
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
      // The high-level `archi` graph collapses each top-level folder and package.
      archi: {
        collapsePattern:
          '^(packages|src|lib|app|bin|test(s?)|spec(s?))/[^/]+|node_modules/[^/]+',
      },
      text: {
        highlightFocused: true,
      },
    },
  },
};
// Maintained for dependency-cruiser 18 and native Bun/ESM resolution.

export default config;
