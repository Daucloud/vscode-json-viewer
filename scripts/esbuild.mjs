import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const shared = {
  bundle: true,
  sourcemap: watch,
  minify: !watch,
  logLevel: 'info',
  // jsonc-parser's CommonJS UMD entry uses runtime-relative requires. Prefer
  // its ESM entry so the worker and extension bundles are self-contained.
  mainFields: ['module', 'main'],
};

const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: ['src/worker/workerMain.ts'],
    outfile: 'dist/worker.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
  },
  {
    ...shared,
    entryPoints: ['src/webview/main.tsx'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    loader: { '.css': 'css' },
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching extension, worker, and webview bundles...');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
