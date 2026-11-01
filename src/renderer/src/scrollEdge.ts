export function isScrolled(scrollTop: number): boolean {
  return Number.isFinite(scrollTop) && scrollTop > 0
}
