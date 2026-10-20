import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// The copied audit runs a real browser and the existing scripted-LLM fixture.
// Keep its evidence as artifacts, never as strict image baselines.
for (const scenario of ['beam', 'frame2d', 'frame3d']) {
  test(`visualization controls, PNG and responsive locale/theme matrix: ${scenario}`, async ({}, info) => {
    test.setTimeout(1_800_000)
    const out = process.env.SCLAW_VIZ_ACCEPTANCE_OUT ? path.join(process.env.SCLAW_VIZ_ACCEPTANCE_OUT, scenario) : info.outputPath('audit')
    const lines: string[] = []
    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['tests/e2e/visualization-audit.mjs', scenario], {
        cwd: path.resolve(import.meta.dirname, '../../..'), windowsHide: true,
        env: { ...process.env, SCLAW_E2E_PORT: new URL(String(info.project.use.baseURL)).port,
          SCLAW_VIZ_OUT: out, SCLAW_VIZ_REPO: path.resolve(import.meta.dirname, '../../../..'), SCLAW_VIZ_SCREENSHOTS: '1' },
      })
      child.stdout.on('data', data => lines.push(String(data)))
      child.stderr.on('data', data => lines.push(String(data)))
      child.once('error', reject)
      child.once('exit', resolve)
    })
    await info.attach('control-audit-log', { body: lines.join(''), contentType: 'text/plain' })
    expect(status, lines.join('')).toBe(0)
    const evidence = JSON.parse(await readFile(path.join(out, `${scenario}-results.json`), 'utf8'))
    expect(evidence.rows.every((row: { class: string }) => row.class === 'a')).toBe(true)
    expect(evidence.screenshotPaths).toHaveLength(32)
    expect(evidence.errors).toEqual([])
    await info.attach('control-audit-results', { path: path.join(out, `${scenario}-results.json`), contentType: 'application/json' })
  })
}
