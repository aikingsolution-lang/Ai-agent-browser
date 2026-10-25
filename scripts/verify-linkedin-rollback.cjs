#!/usr/bin/env node
/**
 * verify-linkedin-rollback.cjs
 *
 * Verifies the LinkedIn "restore proven queue flow" rollback (revert of 969610e)
 * and the surrounding safety net. Read-only except for optional --typecheck/--test.
 *
 * Usage: node scripts/verify-linkedin-rollback.cjs [--typecheck] [--test]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'chrome-extension', 'src', 'background', 'agent', 'linkedin', 'dedicatedJobRunner.ts');
const PAGE = path.join(ROOT, 'chrome-extension', 'src', 'background', 'browser', 'page.ts');
const flags = new Set(process.argv.slice(2));

let failures = 0;
let checks = 0;

function check(name, ok, detail) {
  checks++;
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`${mark}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}
function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

console.log('=== LinkedIn rollback verification ===\n');

// ── 1. Git state ──
console.log('[1] Git state');
const branch = git('rev-parse --abbrev-ref HEAD');
check('current branch is main', branch === 'main', `actual: ${branch}`);
const backupExists = git('rev-parse --verify backup-before-cleanup');
check('safety branch backup-before-cleanup exists', Boolean(backupExists));
const backupTip = backupExists ? git('rev-parse --short backup-before-cleanup') : '';
check('backup branch points at f2f8162 (pre-revert HEAD)', backupTip === 'f2f8162', `actual: ${backupTip || 'none'}`);
const revertStaged = git(
  'diff --cached --stat -- chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts',
);
check('rollback change is staged (or committed)', Boolean(revertStaged), 'dedicatedJobRunner.ts has staged diff');
const otherStaged = git('diff --cached --name-only')
  .split('\n')
  .filter(Boolean)
  .filter(f => !f.includes('dedicatedJobRunner.ts'));
check('no unexpected staged files', otherStaged.length === 0, otherStaged.join(', '));

console.log('\n[2] dedicatedJobRunner.ts — queue flow restored');
const runner = read(RUNNER);
check('"Queued N eligible jobs" message present', runner.includes('Queued ${queue.length} eligible jobs for this run'));
check('streaming processPageCards removed', !runner.includes('processPageCards'));
check('streaming counters removed', !runner.includes('totalCandidateAttempted') && !runner.includes('quotaHalted'));
check('two-phase scan loop present (scan up to 3 pages)', runner.includes('Scan up to 3 pages per location'));
check(
  'queue carries searchPageUrl + searchRole',
  runner.includes('searchPageUrl: string;') && runner.includes('searchRole: string;'),
);
check('per-job fn applySingleLinkedInJobInSplitPane kept', /\bapplySingleLinkedInJobInSplitPane\s*\(/.test(runner));
check('queue loop calls per-job fn', runner.includes('const res = await this.applySingleLinkedInJobInSplitPane('));
check('quota/credit halt handled in queue loop', runner.includes("if (res.status === 'halt')"));
check(
  'direct-fallback search page restore present',
  runner.includes('Restoring search page ${job.searchPageUrl} for next queued job'),
);

console.log('\n[3] KEEP fixes preserved (post-969610e phases)');
check('skip-reason instrumentation (recordSkip)', runner.includes('recordSkip(stats,'));
check('negative cache in queue building', runner.includes('isJobRecentlyFailed(card.jobId)'));
check('negative cache reason recorded', runner.includes("'negative cache (failed within 24h)'"));
check('strict sequential completion between jobs', runner.includes('isEasyApplyModalOpen()'));
check('borderline arbitration kept', runner.includes('arbitrateBorderlineRelevance'));
check('stuck-step fail-fast guard kept', /stuckStreak/.test(runner) && runner.includes('Stuck-step guards'));
check('skip breakdown in final summary', runner.includes('formatSkipBreakdown(stats.skipReasons)'));
check('Naukri loop untouched', runner.includes('startNaukriJobLoop'));

console.log('\n[4] page.ts — footer fix + card-click improvement intact');
const page = read(PAGE);
const footerMarkers = (page.match(/data-view-name="footer"/g) || []).length;
check('footer structural exclusion present (10+ refs)', footerMarkers >= 10, `refs: ${footerMarkers}`);
const footerContent = (page.match(/select language/gi) || []).length;
check('footer content check present', footerContent >= 5, `refs: ${footerContent}`);
check('card-click improvement kept (findAndClickCard)', page.includes('function findAndClickCard()'));
check('Easy Apply click new-UI selectors kept', page.includes('.scaffold-layout__detail'));
check('no conflict markers anywhere', !/^<<<<<<<|^>>>>>>>/m.test(runner) && !/^<<<<<<<|^>>>>>>>/m.test(page));

console.log('\n[5] Optional gates');
if (flags.has('--typecheck')) {
  console.log('running tsc --noEmit ...');
  try {
    execSync('pnpm --filter chrome-extension exec tsc --noEmit', { cwd: ROOT, stdio: 'pipe' });
    check('typecheck', true);
  } catch (e) {
    check(
      'typecheck',
      false,
      String(e.stdout || e.message)
        .split('\n')
        .slice(0, 6)
        .join(' | '),
    );
  }
} else {
  console.log('skipped (pass --typecheck)');
}
if (flags.has('--test')) {
  console.log('running vitest ...');
  try {
    const out = execSync('pnpm --filter chrome-extension test', { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
    const m = plain.match(/Tests\s+(\d+) passed \((\d+)\)/);
    check('vitest all green', Boolean(m && m[1] === m[2]), m ? `${m[1]}/${m[2]}` : 'no summary found');
  } catch (e) {
    check(
      'vitest all green',
      false,
      String(e.stdout || '')
        .split('\n')
        .slice(-6)
        .join(' | '),
    );
  }
} else {
  console.log('skipped (pass --test)');
}

console.log(`\n=== ${checks - failures}/${checks} checks passed ===`);
process.exit(failures === 0 ? 0 : 1);
