import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const expectedVersion = process.argv[2]
const [rootPackage, extensionPackage, manifest] = await Promise.all([
  readJson('package.json'),
  readJson('apps/extension/package.json'),
  readJson('apps/extension/static/manifest.json'),
])

const versions = {
  'package.json': rootPackage.version,
  'apps/extension/package.json': extensionPackage.version,
  'apps/extension/static/manifest.json': manifest.version,
}
const uniqueVersions = new Set(Object.values(versions))

if (uniqueVersions.size !== 1) {
  console.error('Release versions do not match:')
  for (const [file, version] of Object.entries(versions))
    console.error(`- ${file}: ${version}`)
  process.exit(1)
}

const [version] = uniqueVersions
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid release version: ${String(version)}`)
  process.exit(1)
}

if (expectedVersion && version !== expectedVersion) {
  console.error(`Tag version ${expectedVersion} does not match source version ${version}.`)
  process.exit(1)
}

console.log(version)

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), 'utf8'))
}
