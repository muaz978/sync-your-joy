import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const docxModulePath = process.env.SYNCYOURJOY_DOCX_MODULE_PATH
  ?? '/Users/muazsabbagh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/docx'
const {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} = require(docxModulePath)

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDirectory, '..')
const outputDirectory = resolve(root, 'docs', 'artifacts')
const outputPath = resolve(outputDirectory, 'SyncYourJoy-Gates-1-3-Test-Guide.docx')
await mkdir(outputDirectory, { recursive: true })

const teal = '0F766E'
const dark = '16303A'
const light = 'E8F4F2'
const muted = '52656D'

const document = new Document({
  creator: 'SyncYourJoy',
  title: 'SyncYourJoy Gates 1-3 Friend Test Guide',
  description: 'Two-device beta acceptance guide for SyncYourJoy.',
  numbering: {
    config: [
      {
        reference: 'steps',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.LEFT }],
      },
      {
        reference: 'bullets',
        levels: [{ level: 0, format: 'bullet', text: '\u2022', alignment: AlignmentType.LEFT }],
      },
    ],
  },
  sections: [{
    properties: {
      page: { margin: { top: 720, right: 850, bottom: 720, left: 850 } },
    },
    children: [
      titleBlock(),
      metadataTable(),
      paragraph('This guide closes the real-device evidence still required for Gates 1-3. It is for two or more people using separate devices and separate authorized streaming accounts.'),
      paragraph('SyncYourJoy synchronizes playback state only. It does not share a screen, video, audio, password, cookie, subscription, or DRM key.', { bold: true, color: dark }),
      heading('1. Before the session'),
      bulletList([
        'Two computers in different locations, each with a stable internet connection.',
        'Google Chrome 116 or newer for the primary test. Firefox is optional for the portability test.',
        'The same SyncYourJoy 0.1.22 release installed on every computer.',
        'A separate authorized account for the selected video service on each computer.',
        'One short, known video for the first run. Avoid live streams and pages with many unrelated videos at first.',
      ]),
      heading('2. Install the extension in Chrome'),
      numberedList([
        'Download the release ZIP from the GitHub release page.',
        'Extract it to a permanent folder. Chrome cannot load the compressed ZIP directly.',
        'Open chrome://extensions, enable Developer mode, and select Load unpacked.',
        'Choose the extracted folder containing manifest.json and pin SyncYourJoy.',
        'Open a normal HTTP or HTTPS video page.',
        'On first use, read the privacy disclosure and select I understand and continue.',
        'Refresh the video page after installing or reloading the extension.',
      ]),
      linkParagraph('Release ZIP: ', 'https://github.com/muaz978/sync-your-joy/releases/latest/download/sync-your-joy-extension.zip'),
      heading('3. Create and join a room'),
      numberedList([
        'The host opens the intended video page, pauses it near the beginning, and opens the SyncYourJoy side panel.',
        'The host selects Start a synced room.',
        'The friend opens SyncYourJoy and enters the eight-character room code. The friend does not paste a video URL.',
        'The host may enter the page URL under Video page link and select Open link for everyone.',
        'Wait for both sides to show the intended player and Video matches.',
        'Each participant selects I am ready.',
        'Confirm that both participants show Ready before testing playback.',
      ]),
      heading('4. Test A - automatic play and pause'),
      numberedList([
        'With everyone ready, the host clicks the video native play button.',
        'Verify that every participant starts without clicking Play all.',
        'Wait 30 seconds and compare the visible playback positions.',
        'The host clicks the native pause button.',
        'Verify that every participant pauses without refreshing.',
        'Repeat play and pause three times.',
      ]),
      passParagraph('Pass when every participant follows the host and the room does not advance while a participant is visibly stopped. Record perceived delay and any stopped, buffering, or autoplay-blocked state.'),
      heading('5. Test B - forward and backward seeking'),
      numberedList([
        'Start playback and drag the host progress bar forward by about 30 seconds.',
        'Wait for the side panel alignment barrier to complete.',
        'Confirm both videos resume at the same position.',
        'Repeat with a backward seek of about 30 seconds.',
        'Repeat with three rapid drags in different directions. The final drag must win.',
        'Repeat while the room is paused.',
        'Use Sync everyone once and confirm the room remains at the displayed position.',
      ]),
      passParagraph('Pass when no refresh is required, the room does not resume before the guest confirms the target, and a slow seek leaves the room safely paused.'),
      heading('6. Test C - autoplay and manual recovery'),
      numberedList([
        'Use a clean provider tab if possible and start a room with both participants ready.',
        'Have the host start playback.',
        'If Chrome blocks a guest play request, click the video once on that guest device.',
        'Select Sync me now in the side panel or Sync in the in-page pill.',
        'Confirm the guest joins the authoritative position without a refresh.',
      ]),
      passParagraph('Pass when the UI explains the user-gesture requirement and one explicit click repairs playback.'),
      heading('7. Test D - reconnect and readiness stability'),
      numberedList([
        'Start playback with both participants ready.',
        'Temporarily disable the friend network for 5 to 15 seconds, then restore it.',
        'Confirm the side panel shows reconnecting and then connected.',
        'Confirm a brief reconnect with the same video does not unnecessarily cancel readiness.',
        'Repeat by backgrounding the video tab and returning to it.',
        'Repeat after briefly putting one computer to sleep.',
        'Refresh the friend video tab and wait for player detection.',
      ]),
      passParagraph('Pass when state recovers without an unnecessary refresh and a genuine navigation or different video correctly requires readiness again.'),
      heading('8. Test E - controller handoff'),
      numberedList([
        'Start playback with both participants ready.',
        'Close the controller video tab or browser for more than ten seconds.',
        'Confirm the room pauses safely.',
        'Confirm control transfers to the remaining participant.',
        'Have the new controller play and pause once.',
      ]),
      passParagraph('Pass when the former controller cannot continue issuing controls and the new controller lease is visible.'),
      heading('9. Test F - matching and multiple players'),
      numberedList([
        'Open the same page on both devices using Open link for everyone.',
        'Confirm different regional titles or nested player URLs still match for the same content.',
        'Open a page with more than one video element.',
        'Inspect Player diagnostics and use Lock selected player.',
        'Trigger play, pause, and seek, then confirm an advertisement or background video cannot replace the selected player.',
        'Select Redetect player after a player replacement or SPA route change.',
      ]),
      passParagraph('Pass when the intended video remains bound and unrelated videos do not change readiness or room state.'),
      heading('10. Test G - network-quality and chaos'),
      numberedList([
        'If you know how to use a network tool, add about 50 ms latency and repeat Tests A and B.',
        'Add about 150 to 300 ms latency and repeat Tests A and B.',
        'Add jitter or brief packet loss.',
        'Disconnect and reconnect the network.',
        'Observe RTT, clock quality, connection quality, and reconnect state.',
        'Download a report after each failure.',
      ]),
      passParagraph('Pass when degraded or offline state is shown honestly, reconnect is bounded, and an unconfirmed seek never releases a participant into moving playback.'),
      heading('11. Download the detailed report'),
      numberedList([
        'Only the room controller can collect the room-wide report.',
        'Open the side panel while the room is connected.',
        'Find Beta diagnostics and select Download detailed report.',
        'Wait for the JSON file to download.',
        'Keep the report with the exact test step and time of the failure.',
        'Review the report before sharing. Do not attach unrelated private files.',
      ]),
      paragraph('The report is testing-only. It is designed to exclude passwords, cookies, media bytes, audio, screenshots, and URL query parameters.'),
      heading('12. Record every issue'),
      bulletList([
        'Test letter and step.',
        'Provider and exact page type.',
        'Host or guest.',
        'Browser and version.',
        'Operating system.',
        'Side-panel status and RTT.',
        'Whether readiness changed unexpectedly.',
        'Whether the room clock moved while the local video was stopped.',
        'Whether a refresh was required.',
        'Detailed-report filename.',
        'A short description without account or payment information.',
      ]),
      heading('13. Pass/fail worksheet'),
      worksheetTable(),
      heading('14. Release-blocking outcomes'),
      bulletList([
        'A guest shows a different title or episode as matched.',
        'The room timeline advances while a participant video is stopped.',
        'A forward or backward seek requires a refresh.',
        'A later seek loses to an older seek.',
        'Readiness cancels during ordinary playback or a short reconnect.',
        'A participant receives controls for an unrelated player or advertisement.',
        'A controller that lost its lease can still control the room.',
        'A report includes credentials, cookies, video, audio, or other unexpected sensitive data.',
      ]),
      paragraph('Send failed steps, the exact environment, and the sanitized JSON report to the project issue tracker. Do not include streaming credentials.', { bold: true, color: dark }),
    ].flat(),
  }],
})

const buffer = await Packer.toBuffer(document)
await writeFile(outputPath, buffer)
console.log(`Wrote ${outputPath}`)

function titleBlock() {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 180 },
    children: [
      new TextRun({ text: 'SyncYourJoy', bold: true, color: teal, size: 38 }),
      new TextRun({ text: '\nGates 1-3 Friend Test Guide', bold: true, color: dark, size: 30 }),
      new TextRun({ text: '\nTwo-city beta acceptance checklist', color: muted, size: 22 }),
    ],
  })
}

function metadataTable() {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [2400, 6600],
    rows: [
      ['Test build', 'SyncYourJoy 0.1.22 beta'],
      ['Room service', 'wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms'],
      ['Primary target', 'Chrome desktop, two separate devices'],
      ['Evidence', 'Playback, pause, seeking, readiness, reconnect, matching, browser portability'],
    ].map(([key, value]) => new TableRow({ children: [cell(key, true, 2400), cell(value, false, 6600)] })),
  })
}

function worksheetTable() {
  const rows = [
    ['A. Automatic play/pause', '', '', '', '', ''],
    ['B. Forward/backward seek', '', '', '', '', ''],
    ['C. Autoplay recovery', '', '', '', '', ''],
    ['D. Reconnect/readiness', '', '', '', '', ''],
    ['E. Controller handoff', '', '', '', '', ''],
    ['F. Matching/multiple players', '', '', '', '', ''],
    ['G. Network chaos', '', '', '', '', ''],
  ]
  const header = ['Test', 'Pass/Fail', 'Delay or drift', 'Refresh?', 'Report filename', 'Notes']
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [2400, 1000, 1300, 900, 1700, 1700],
    rows: [header, ...rows].map((row, rowIndex) => new TableRow({
      children: row.map((value, index) => cell(value, rowIndex === 0, [2400, 1000, 1300, 900, 1700, 1700][index])),
    })),
  })
}

function cell(value, header = false, width = undefined) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: { type: ShadingType.CLEAR, fill: header ? light : 'FFFFFF' },
    margins: { top: 90, bottom: 90, left: 100, right: 100 },
    borders: { top: { style: BorderStyle.SINGLE, size: 2, color: 'D8E3E1' }, bottom: { style: BorderStyle.SINGLE, size: 2, color: 'D8E3E1' }, left: { style: BorderStyle.SINGLE, size: 2, color: 'D8E3E1' }, right: { style: BorderStyle.SINGLE, size: 2, color: 'D8E3E1' } },
    children: [new Paragraph({ children: [new TextRun({ text: value || ' ', bold: header, color: header ? dark : '24353A', size: 17 })] })],
  })
}

function heading(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 180, after: 100 }, children: [new TextRun({ text, color: teal })] })
}

function paragraph(text, options = {}) {
  return new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text, size: 20, color: options.color ?? '24353A', bold: options.bold ?? false })] })
}

function passParagraph(text) {
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: 'F1F8F7' },
    spacing: { before: 80, after: 120 },
    indent: { left: 180, right: 180 },
    children: [new TextRun({ text: `Pass criteria: ${text}`, italic: true, color: dark, size: 19 })],
  })
}

function bulletList(items) {
  return items.map(item => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 45 }, children: [new TextRun({ text: item, size: 19 })] }))
}

function numberedList(items) {
  return items.map(item => new Paragraph({ numbering: { reference: 'steps', level: 0 }, spacing: { after: 45 }, children: [new TextRun({ text: item, size: 19 })] }))
}

function linkParagraph(prefix, url) {
  return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: prefix, size: 19, color: muted }), new ExternalHyperlink({ link: url, children: [new TextRun({ text: url, size: 19, color: '0563C1', underline: {} })] })] })
}
