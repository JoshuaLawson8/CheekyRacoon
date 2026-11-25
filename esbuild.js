const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const testBuild = process.argv.includes('--test');

async function buildExtension() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

async function buildTests() {
  const testDir = path.join(__dirname, 'test', 'unit');
  const entries = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => path.join(testDir, f));

  await esbuild.build({
    entryPoints: entries,
    bundle: true,
    format: 'cjs',
    sourcemap: true,
    platform: 'node',
    target: 'node18',
    outdir: 'dist-test',
    external: ['vscode'],
    logLevel: 'info',
  });
}

(testBuild ? buildTests() : buildExtension()).catch((err) => {
  console.error(err);
  process.exit(1);
});
