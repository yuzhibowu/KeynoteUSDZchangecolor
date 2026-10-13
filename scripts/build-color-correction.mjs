import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'artifacts/color-correction');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/color-correction/index.ts')],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2020',
  outfile: path.join(out, 'index.js'), metafile: true,
}).then(async ({ metafile }) => {
  if (Object.values(metafile.outputs).some(output => output.imports.length)) {
    throw new Error('Standalone module unexpectedly has runtime dependencies');
  }
  await writeFile(path.join(out, 'build-meta.json'), JSON.stringify(metafile, null, 2));
});
const tsc = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
  '-p', path.join(root, 'src/color-correction/tsconfig.json'), '--outDir', out,
], { cwd: root, stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
// 声明里的相对模块路径加扩展名，兼容 NodeNext 消费端。
for (const name of ['index', 'core', 'profile', 'presets', 'math']) {
  const { readFile } = await import('node:fs/promises');
  const file = path.join(out, name + '.d.ts');
  await writeFile(file, (await readFile(file, 'utf8')).replace(/from '(\.\/[^']+)'/g, "from '$1.js'"));
}
await copyFile(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
await writeFile(path.join(out, 'README.md'), `# 几棱体 USDZ 色彩预补偿\n\n复用原项目实测算法的独立 ESM 包，运行时零依赖。\n\n\`\`\`js\nimport { createCorrectionPreset, applyToImageData } from 'jilingti-color-correction';\nconst { comp, conditions } = createCorrectionPreset('keynote-card');\napplyToImageData(exportPixels.data, comp);\n// 按 conditions 配置导出材质和补光；只补偿原始像素副本一次。\n\`\`\`\n\n预设：keynote-prism、keynote-card（纸张 / lift 0.5），freeform-prism（纸张 / lift 0）。不能保证任意 USDZ 或 App 版本的外观。\n\n[完整 API、色彩空间与限制](https://github.com/yuzhibowu/KeynoteUSDZchangecolor/blob/main/docs/COLOR_CORRECTION.md) · [接入步骤](https://github.com/yuzhibowu/KeynoteUSDZchangecolor/blob/main/docs/AI_INTEGRATION.md)\n\n代码与数值档按随包 MIT LICENSE 提供。本包不包含 Three.js、FFmpeg 或主应用。尚未发布 npm registry，使用本地构建目录或 npm pack。\n`);
await writeFile(path.join(out, 'package.json'), JSON.stringify({
  name: 'jilingti-color-correction', version: '0.1.0', type: 'module', license: 'MIT',
  description: 'Measured USDZ color precompensation for specific Keynote and Freeform conditions',
  exports: { '.': { types: './index.d.ts', import: './index.js' } },
  files: ['*.js', '*.d.ts', 'LICENSE', 'README.md'],
}, null, 2) + '\n');
console.log('Built artifacts/color-correction (ESM + TypeScript declarations; no runtime dependencies)');
