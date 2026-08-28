export function shouldPublishMediaMatchChange(currentMatches: boolean | undefined, nextMatches: boolean): boolean {
  return currentMatches !== undefined && currentMatches !== nextMatches
}
