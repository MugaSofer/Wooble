// Split the thread-only target contexts into batches for the Sonnet attribution
// pass. Each batch is a small JSON array of {id, label, transcript}; one agent
// handles one batch and writes a matching part file. Mirrors wog-batch.js.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const IN = 'data/wog-thread-context.json';
const BATCH_DIR = 'data/wog-thread-batches';
const PART_DIR = 'data/wog-thread-parts';
const PER = Number(process.argv[2]) || 14;

async function main() {
  const ctx = JSON.parse(await readFile(IN, 'utf8'));
  // Clear both dirs so a re-run never leaves stale parts from a prior pass.
  await rm(BATCH_DIR, { recursive: true, force: true });
  await rm(PART_DIR, { recursive: true, force: true });
  await mkdir(BATCH_DIR, { recursive: true });
  await mkdir(PART_DIR, { recursive: true });

  let n = 0;
  for (let i = 0; i < ctx.length; i += PER) {
    const batch = ctx.slice(i, i + PER).map(({ id, label, transcript }) => ({ id, label, transcript }));
    await writeFile(join(BATCH_DIR, `batch-${String(n).padStart(2, '0')}.json`), JSON.stringify(batch, null, 2));
    n++;
  }
  console.log(`Wrote ${n} batches of up to ${PER} (${ctx.length} targets) to ${BATCH_DIR}/. Parts go to ${PART_DIR}/.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
