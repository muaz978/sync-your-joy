import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// wrangler 4.141.0 and later send a *deferred*, 300 second Durable Object code
// update on every deploy and rollback unless told otherwise. For this
// coordinator that means old code keeps serving live rooms for up to five
// minutes after a security fix or after a rollback of a bad build. These tests
// keep the pin, the commands that must read it, and wrangler's own behavior
// from drifting apart again.
const root = fileURLToPath(new URL('../', import.meta.url))
const CONFIG = 'apps/edge-service/wrangler.jsonc'

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function parseJsonc(text: string): any {
  // The file holds only whole-line comments; strip them and parse as JSON.
  return JSON.parse(text.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n'))
}

describe('coordinator deploy safety', () => {
  it('pins Durable Object code updates to immediate in the wrangler config', () => {
    const config = parseJsonc(read(CONFIG))
    expect(config.durable_objects.code_update_strategy).toEqual({ mode: 'immediate' })
  })

  it('makes every deploy and rollback command read that config', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    expect(scripts['deploy:edge']).toContain(`--config ${CONFIG}`)
    // The explicit flag makes a wrangler that no longer knows the option fail
    // loudly instead of silently falling back to a deferred rollback.
    expect(scripts['rollback:edge']).toContain('wrangler rollback')
    expect(scripts['rollback:edge']).toContain(`--config ${CONFIG}`)
    expect(scripts['rollback:edge']).toContain('--durable-objects-code-update-mode immediate')
    expect(read('.github/workflows/deploy-edge.yml')).toContain(`npx wrangler deploy --config ${CONFIG}`)
  })

  it('sends immediate in the deploy upload metadata with the installed wrangler', () => {
    const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js')
    const scratch = mkdtempSync(join(tmpdir(), 'syj-wrangler-'))
    try {
      const outfile = join(scratch, 'upload.bin')
      const run = spawnSync(process.execPath, [wrangler, 'deploy', '--dry-run', '--outfile', outfile, '--config', CONFIG], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(scratch, 'logs') },
        timeout: 90_000,
      })
      expect(run.status, run.stderr || run.stdout).toBe(0)
      const upload = readFileSync(outfile, 'latin1')
      expect(upload).toContain('"code_update_strategy":{"mode":"immediate"}')
      expect(upload).not.toContain('"mode":"deferred"')
    }
    finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 120_000)
})
