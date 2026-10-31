/** Deploy only actor source, never the working tree's private config or datasets. */
import { mkdtemp, copyFile, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const [projectId, ...options] = process.argv.slice(2);
if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId) || options.some(option => option !== '--check')) {
  throw new Error('Usage: npm run actors:deploy -- <existing-project-id> [--check]');
}
const check = options.includes('--check');
if (!check && !process.env.TERSE_API_KEY) throw new Error('TERSE_API_KEY_REQUIRED');
const root = resolve(import.meta.dirname, '..');
const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'src/actor.ts',
  'study/protocol.ts', 'study/state.ts', 'study/evidence.ts'];
const stage = await mkdtemp(join(tmpdir(), 'allot-actor-deploy-'));
try {
  for (const file of files) {
    const target = join(stage, file);
    await mkdir(resolve(target, '..'), { recursive: true });
    await copyFile(join(root, file), target);
  }
  await writeFile(join(stage, 'terse.config.json'), JSON.stringify({ projectId, name: 'allot' }));
  // The CLI needs installed tools for local typechecking. Its archiver excludes node_modules.
  await symlink(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir');
  console.log(JSON.stringify({ code: 'ACTOR_SOURCE_STAGED', files: [...files, 'terse.config.json'], check }));
  if (!check) {
    const status = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, [join(root, 'node_modules/terse-cli/dist/index.js'), 'deploy'],
        { cwd: stage, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', done);
    });
    if (status !== 0) throw new Error('ACTOR_DEPLOY_FAILED');
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
