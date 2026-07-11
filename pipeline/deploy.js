// Publish the prebuilt site/ to the gh-pages branch as a single orphan commit.
//
// We build the tree straight from site/ and force-push it, rather than using the
// gh-pages package: that tool deletes the old files by passing every filename to
// `git rm` as CLI args, which overflows Windows' command-line length limit on a
// bundle this size (spawn ENAMETOOLONG). Plumbing sidesteps that entirely, and a
// fresh orphan each deploy keeps the branch clean with no history growth.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const GITDIR = resolve(ROOT, '.git');
const SITE = resolve(ROOT, 'site');
const INDEX = resolve(GITDIR, 'ghp.index');

const git = (args, opts = {}) =>
  execFileSync('git', [`--git-dir=${GITDIR}`, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  }).trim();

try {
  rmSync(INDEX, { force: true });
  const env = { ...process.env, GIT_INDEX_FILE: INDEX };
  // Drop Pagefind's prebuilt-UI bundles before deploying — we use our own UI and
  // only load pagefind.js at runtime, so these ~350KB never ship. (Pagefind
  // regenerates them each build; we just don't publish them.)
  for (const f of ['pagefind-ui.js', 'pagefind-ui.css', 'pagefind-modular-ui.js', 'pagefind-modular-ui.css',
                   'pagefind-component-ui.js', 'pagefind-component-ui.css', 'pagefind-highlight.js'])
    rmSync(resolve(SITE, 'pagefind', f), { force: true });
  // Stage site/'s contents at the tree root, forcing in the git-ignored
  // pagefind/ bundle and meta.json.
  git(['--work-tree=' + SITE, 'add', '-A', '-f', '.'], { cwd: SITE, env });
  const tree = git(['write-tree'], { env });
  const commit = git(['commit-tree', tree, '-m', 'Deploy Wooble']); // no parent → orphan
  git(['push', '-f', 'origin', `${commit}:refs/heads/gh-pages`]);
  console.log(`Deployed ${commit.slice(0, 9)} to gh-pages.`);
} finally {
  rmSync(INDEX, { force: true });
}
