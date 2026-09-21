import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDirectory, '..')
const source = resolve(root, 'fixtures/sync-test-clip.mp4')
const target = resolve(root, 'fixtures/adaptive-test-clip.mp4')

execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-stream_loop',
  '5',
  '-i',
  source,
  '-map',
  '0:v:0',
  '-c',
  'copy',
  '-movflags',
  'empty_moov+default_base_moof+frag_keyframe+separate_moof',
  '-frag_duration',
  '4000000',
  '-t',
  '120',
  target,
], { cwd: root, stdio: 'inherit' })

console.log(`Generated ${target} from ${source}`)
