/** The open note's summary with the updated time of a write the core reports, so History and Info follow this window's own saves. */
export function summaryAfterWrites<T extends { id: string; updatedAt: number }>(
  summary: T | undefined,
  writes: ReadonlyMap<string, number>,
): T | undefined {
  const at = summary && writes.get(summary.id)
  return summary && at !== undefined && at > summary.updatedAt
    ? { ...summary, updatedAt: at }
    : summary
}
