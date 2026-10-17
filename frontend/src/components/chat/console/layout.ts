export const SIDEBAR_LAYOUT_MIN_WIDTH = 1280

export function getIsSidebarLayout() {
  if (typeof window === 'undefined') {
    return false
  }

  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(`(min-width: ${SIDEBAR_LAYOUT_MIN_WIDTH}px)`).matches
  }

  return window.innerWidth >= SIDEBAR_LAYOUT_MIN_WIDTH
}
