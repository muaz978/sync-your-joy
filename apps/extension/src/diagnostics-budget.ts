import type { DiagnosticsReport } from '@syncyourjoy/protocol'

export const DIAGNOSTIC_MESSAGE_BUDGET_BYTES = 12_000

export function fitDiagnosticsReport(report: DiagnosticsReport): DiagnosticsReport {
  let candidate = report
  while (serializedDiagnosticsBytes(candidate) > DIAGNOSTIC_MESSAGE_BUDGET_BYTES && candidate.events.length > 0)
    candidate = { ...candidate, events: candidate.events.slice(1) }
  if (serializedDiagnosticsBytes(candidate) <= DIAGNOSTIC_MESSAGE_BUDGET_BYTES)
    return candidate
  return {
    ...candidate,
    mediaCanonicalId: candidate.mediaCanonicalId?.slice(0, 120) ?? null,
    mediaPageUrl: candidate.mediaPageUrl?.slice(0, 512) ?? null,
    userAgent: candidate.userAgent.slice(0, 160),
    events: [],
  }
}

export function serializedDiagnosticsBytes(report: DiagnosticsReport, reportId = 'report_00000000000000000000000000000000000000000000000000000000000000000000000000000000'): number {
  return new TextEncoder().encode(JSON.stringify({
    type: 'diagnostics_response',
    reportId,
    report,
  })).byteLength
}
