import '@testing-library/jest-dom'

// Polyfills for Radix UI components in jsdom
// jsdom doesn't implement these DOM APIs that Radix UI uses

// Mock hasPointerCapture and releasePointerCapture
HTMLElement.prototype.hasPointerCapture = function (this: HTMLElement) {
  return false
}
HTMLElement.prototype.releasePointerCapture = function (this: HTMLElement) {}
HTMLElement.prototype.setPointerCapture = function (this: HTMLElement) {}

// Mock scrollIntoView
Element.prototype.scrollIntoView = function (this: Element) {}

// Mock getBoundingClientRect for Radix UI positioning
Element.prototype.getBoundingClientRect = function (this: Element) {
  return {
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    x: 0,
    y: 0,
    toJSON: () => {},
  } as DOMRect
}

// Mock clientWidth and clientHeight for Radix UI
Object.defineProperties(HTMLElement.prototype, {
  clientWidth: {
    get() {
      return 0
    },
  },
  clientHeight: {
    get() {
      return 0
    },
  },
})
