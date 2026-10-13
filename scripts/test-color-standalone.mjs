import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const built = spawnSync(process.execPath, [path.join(root, 'scripts/build-color-correction.mjs')], { stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const dir = await mkdtemp(path.join(tmpdir(), 'jilingti-consumer-'));
try {
  // 临时消费端只安装待测包，没有 src/lib、React、Three.js 或其他依赖。
  await cp(path.join(root, 'artifacts/color-correction'), path.join(dir, 'node_modules/jilingti-color-correction'), { recursive: true });
  await cp(path.join(root, 'examples/color-correction/baseline.json'), path.join(dir, 'baseline.json'));
  await writeFile(path.join(dir, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as c from 'jilingti-color-correction';
assert.equal(typeof globalThis.document, 'undefined');
const baseline = JSON.parse(await readFile(new URL('./baseline.json', import.meta.url)));
for (const [key, rows] of Object.entries(baseline.profiles)) {
  for (const { target, written, forward } of rows) {
    assert.deepEqual(c.solveWritten(...target, c[key]), written);
    assert.deepEqual(c.forwardOf(...target, c[key]), forward);
  }
}
const presets = ['keynote-prism', 'keynote-card', 'freeform-prism'];
for (const id of presets) {
  const { comp, conditions } = c.createCorrectionPreset(id);
  const independent = c.createCorrectionPreset(id);
  comp.matrix[0] += 0.1;
  assert.notDeepEqual(comp.matrix, independent.comp.matrix);
  const data = new Uint8ClampedArray([200,120,80,0,200,120,80,63,200,120,80,255]);
  c.applyToImageData(data, independent.comp);
  const w = c.solveWritten(200,120,80, independent.comp);
  for (let i=0; i<3; i++) assert.deepEqual([...data.slice(i*4,i*4+3)], w);
  assert.deepEqual([data[3],data[7],data[11]], [0,63,255]);
  const file = c.serializeProfile(independent.comp, conditions.target, conditions.shape);
  const parsed = c.parseProfile(JSON.stringify(file));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.target, conditions.target);
  assert.equal(parsed.shape, conditions.shape);
  assert.equal(parsed.lift, conditions.lift);
  assert.deepEqual(c.solveWritten(200,120,80,{...independent.comp,...parsed.comp}), w);
}
const disabled = {...c.DEFAULT_COMP,on:false};
const raw = new Uint8ClampedArray([10,20,30,40]);
c.applyToImageData(raw, disabled);
assert.deepEqual([...raw],[10,20,30,40]);
assert.equal(c.applyToHex('invalid', c.DEFAULT_COMP), 'invalid');
assert.throws(()=>c.createCorrectionPreset('freeform-card'));
console.log('Standalone consumer passed: original outputs, all presets, alpha, identity, profile round-trip.');
`);
  const result = spawnSync(process.execPath, [path.join(dir, 'consumer.mjs')], { cwd: dir, stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = 1;
  // 真正的 NodeNext TypeScript 消费端检查 .d.ts，避免只在 Vite 中能用。
  await writeFile(path.join(dir, 'consumer.mts'), `import { createCorrectionPreset, solveWritten, type Triple } from 'jilingti-color-correction';\nconst p = createCorrectionPreset('freeform-prism');\nconst written: Triple = solveWritten(200,120,80,p.comp);\nvoid written;\n`);
  const types = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--target', 'ES2020', path.join(dir, 'consumer.mts')], { cwd: dir, stdio: 'inherit' });
  if (types.status !== 0) process.exitCode = 1;
  const meta = JSON.parse(await readFile(path.join(dir, 'node_modules/jilingti-color-correction/build-meta.json'), 'utf8'));
  if (Object.keys(meta.inputs).some(input => !input.includes('src/color-correction/'))) {
    throw new Error('Build included files from the host app');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
