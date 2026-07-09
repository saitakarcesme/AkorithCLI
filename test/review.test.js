import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReviewPatch } from '../src/commands.js'
import { filePatch, parseDiff } from '../src/review.js'

test('parseDiff ignores diffstat preamble and keeps per-file raw patches', () => {
  const patch = [
    ' src/a.js | 1 +',
    ' 1 file changed, 1 insertion(+)',
    '',
    'diff --git a/src/a.js b/src/a.js',
    'index 1111111..2222222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n')

  const files = parseDiff(patch)
  assert.deepEqual(files.map((file) => file.path), ['src/a.js'])
  assert.equal(files[0].adds, 1)
  assert.equal(files[0].dels, 1)
  assert.match(filePatch(files[0]), /^diff --git a\/src\/a\.js b\/src\/a\.js/)
})

test('buildReviewPatch exposes untracked files as parseable synthetic diffs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'akorith-review-'))
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd })
  writeFileSync(join(cwd, 'tracked.js'), 'const answer = 41\n')
  execFileSync('git', ['add', 'tracked.js'], { cwd })
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' })

  writeFileSync(join(cwd, 'tracked.js'), 'const answer = 42\n')
  writeFileSync(join(cwd, 'fresh.js'), 'export const fresh = true\n')

  const patch = buildReviewPatch({ cwd, uncommitted: true })
  const files = parseDiff(patch)
  const fresh = files.find((file) => file.path === 'fresh.js')

  assert.ok(files.find((file) => file.path === 'tracked.js'))
  assert.ok(fresh)
  assert.equal(fresh.summary, 'new file')
  assert.equal(fresh.adds, 1)
  assert.match(filePatch(fresh), /\+\+\+ b\/fresh\.js/)
})
