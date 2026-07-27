import * as esbuild from 'esbuild';

const shared = {
  bundle: true,
  sourcemap: false,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  mainFields: ['module', 'main'],
  logLevel: 'info',
};

await Promise.all([
  esbuild.build({ ...shared, entryPoints: ['test/integration/runTest.ts'], outfile: 'dist-tests/runTest.cjs', external: ['@vscode/test-electron'] }),
  esbuild.build({ ...shared, entryPoints: ['test/integration/suite/index.ts'], outfile: 'dist-tests/suite.cjs', external: ['vscode'] }),
]);
