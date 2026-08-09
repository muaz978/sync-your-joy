import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createGenerator } from 'unocss'
import unoConfig from '../uno.config.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDirectory, '..')
const sourceDirectory = resolve(root, 'apps/extension/src')
const staticDirectory = resolve(root, 'apps/extension/static')
const outputDirectory = resolve(root, 'apps/extension/dist')
const roomServerUrl = process.env.SYNCYOURJOY_ROOM_SERVER_URL ?? 'ws://127.0.0.1:8787/rooms'

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

const entries = [
  ['sidepanel', resolve(sourceDirectory, 'sidepanel.ts')],
  ['service-worker', resolve(sourceDirectory, 'service-worker.ts')],
  ['content-script', resolve(sourceDirectory, 'content-script.ts')],
]

for (const [name, entry] of entries) {
  await build({
    entryPoints: [entry],
    outfile: resolve(outputDirectory, `${name}.js`),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome116',
    minify: false,
    sourcemap: true,
    define: {
      __ROOM_SERVER_URL__: JSON.stringify(roomServerUrl),
    },
  })
}

const sourceText = await Promise.all([
  ...entries.map(([, path]) => readFile(path, 'utf8')),
  readFile(resolve(staticDirectory, 'sidepanel.html'), 'utf8'),
])
const generator = await createGenerator(unoConfig)
const generated = await generator.generate(sourceText.join('\n'), { preflights: true })
const baseStyles = await readFile(resolve(sourceDirectory, 'styles.css'), 'utf8')
await writeFile(resolve(outputDirectory, 'styles.css'), `${baseStyles}\n${generated.css}\n`)

const manifest = JSON.parse(await readFile(resolve(staticDirectory, 'manifest.json'), 'utf8'))
const connectSource = new URL(roomServerUrl).origin
if (!manifest.content_security_policy.extension_pages.includes(connectSource))
  manifest.content_security_policy.extension_pages += ` ${connectSource}`
await writeFile(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await cp(resolve(staticDirectory, 'sidepanel.html'), resolve(outputDirectory, 'sidepanel.html'))

console.log(`Built Chrome extension at ${outputDirectory}`)
