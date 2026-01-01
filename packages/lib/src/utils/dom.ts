export type Disposable = { dispose: () => void };

export function domListener<E extends Event>(
  target: EventTarget,
  type: string,
  handler: (ev: E) => void,
  options?: AddEventListenerOptions | boolean,
): Disposable {
  target.addEventListener(type, handler as EventListener, options);
  return { dispose: () => target.removeEventListener(type, handler as EventListener, options) };
}

