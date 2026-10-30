import { describe, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, assertEqual } from '../testing.js'

// Guards the all-in-one image's runtime contract: it runs as the base image's
// unprivileged `trailbase` user, so the depot must be handed over before the
// CMD, and CI must boot the image instead of only building it. A built image
// with a root-owned depot crash-loops with `PermissionDenied` (issue #105).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

const dockerfile = read('scripts/trailbase/Dockerfile')
const ci = read('.github/workflows/ci.yml')
const smoke = read('scripts/trailbase/smoke-image.sh')

describe('All-in-one image boots as its own user', () => {
  it('hands every depot copy to trailbase', () => {
    const copies = dockerfile
      .split('\n')
      .filter((line) => line.startsWith('COPY') && line.includes('/app/traildepot/'))
    assertEqual(copies.length, 2, 'the Dockerfile must copy the config and the migrations into the depot')
    for (const line of copies) {
      assert(
        line.includes('--chown=trailbase:trailbase'),
        `${line} must use --chown=trailbase:trailbase; a root-owned depot crash-loops`
      )
    }
  })

  it('does not switch the image back to root', () => {
    assert(!/^USER\s+root/m.test(dockerfile), 'the image must keep running as the base image user')
  })

  it('creates the data directory so a named volume inherits its owner', () => {
    assert(
      dockerfile.includes('mkdir -p /app/traildepot/data'),
      'the data dir must exist in the image (compose mounts a named volume there)'
    )
  })

  it('both image jobs boot the built image', () => {
    const invocations = ci.split('\n').filter((line) => line.includes('scripts/trailbase/smoke-image.sh'))
    assertEqual(
      invocations.length,
      2,
      'validate-image and publish-image must each run scripts/trailbase/smoke-image.sh'
    )
  })

  it('the smoke script waits for TrailBase and fails when the container dies', () => {
    assert(smoke.includes('Listening on http'), 'the smoke script must wait for the listening line')
    assert(smoke.includes('State.Running'), 'the smoke script must fail fast when the container exits')
  })
})
