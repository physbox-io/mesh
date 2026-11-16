/**
 * A ResizeObserver that also reports once as soon as it is asked to watch an
 * element, then goes on as the browser's own does.
 *
 * Why: the viewport's canvas (react-three-fiber, through react-use-measure)
 * is only created once its container has been measured, and browsers deliver
 * no ResizeObserver callbacks to a tab in the background. A tab reloaded
 * while unfocused (an edit to the source, under the dev server) had no
 * renderer at all until someone looked at it, and every MCP screenshot of it
 * failed with "Renderer not ready yet". Measuring reads layout, which works
 * in a background tab.
 */
export class EagerResizeObserver {
  private ro: ResizeObserver;
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    this.ro = new ResizeObserver(cb);
  }
  observe(target: Element, options?: ResizeObserverOptions) {
    this.ro.observe(target, options);
    // The callback measures the element itself; it is not handed sizes.
    queueMicrotask(() => this.cb([], this.ro));
  }
  unobserve(target: Element) { this.ro.unobserve(target); }
  disconnect() { this.ro.disconnect(); }
  static toString() { return 'function ResizeObserver() { [native code] }'; }
}
