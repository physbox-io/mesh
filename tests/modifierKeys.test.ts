import { describe, it, expect, afterEach } from 'vitest';
import { installModifierKeys, modifiers, subscribeModifiers, fineStep } from '../src/utils/modifierKeys';

// Node has EventTarget and Event but no KeyboardEvent, so the events are plain
// Events with the fields the tracker reads put on them.
function fire(target: EventTarget, type: string, fields: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, fields);
  target.dispatchEvent(event);
  return event;
}

describe('modifierKeys', () => {
  let remove: (() => void) | null = null;
  afterEach(() => { remove?.(); remove = null; });

  it('follows Alt down and up', () => {
    const win = new EventTarget();
    remove = installModifierKeys(win);
    fire(win, 'keydown', { key: 'Alt', altKey: true });
    expect(modifiers().alt).toBe(true);
    fire(win, 'keyup', { key: 'Alt', altKey: false });
    expect(modifiers().alt).toBe(false);
  });

  it('lets go when the window loses focus, since Alt-Tab eats the keyup', () => {
    const win = new EventTarget();
    remove = installModifierKeys(win);
    fire(win, 'keydown', { key: 'Alt', altKey: true, shiftKey: true });
    expect(modifiers()).toEqual({ alt: true, shift: true });
    fire(win, 'blur');
    expect(modifiers()).toEqual({ alt: false, shift: false });
  });

  it('lets go when the page is hidden', () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    remove = installModifierKeys(win, doc);
    fire(win, 'keydown', { key: 'Alt', altKey: true });
    doc.visibilityState = 'hidden';
    fire(doc, 'visibilitychange');
    expect(modifiers().alt).toBe(false);
  });

  it('takes the true state from a pointer event when a key event was missed', () => {
    const win = new EventTarget();
    remove = installModifierKeys(win);
    fire(win, 'pointermove', { altKey: true });
    expect(modifiers().alt).toBe(true);
    fire(win, 'pointermove', { altKey: false });
    expect(modifiers().alt).toBe(false);
  });

  it('stops a bare Alt from reaching the browser menu, and leaves other keys alone', () => {
    const win = new EventTarget();
    remove = installModifierKeys(win);
    expect(fire(win, 'keydown', { key: 'Alt', altKey: true }).defaultPrevented).toBe(true);
    expect(fire(win, 'keydown', { key: 'a', altKey: true }).defaultPrevented).toBe(false);
  });

  it('tells subscribers only about changes', () => {
    const win = new EventTarget();
    remove = installModifierKeys(win);
    let calls = 0;
    const stop = subscribeModifiers(() => { calls++; });
    fire(win, 'keydown', { key: 'Alt', altKey: true });
    fire(win, 'pointermove', { altKey: true });
    fire(win, 'keyup', { key: 'Alt', altKey: false });
    stop();
    expect(calls).toBe(2);
  });

  it('makes a slider step two decades finer', () => {
    expect(fineStep(0.01)).toBeCloseTo(0.0001);
  });
});
