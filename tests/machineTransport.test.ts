import { describe, it, expect, afterEach } from 'vitest';
import { webSerialUnavailableReason } from '../src/utils/machineTransport';

describe('why USB is unavailable', () => {
  /*
   * These run in plain Node, so `navigator` and `window` are stood up here
   * rather than assumed. That is also the case the function has to survive in
   * real life — it is called from a module that loads before anything has
   * checked what it is running in.
   */
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  const setUp = (opts: { serial: boolean; secure: boolean }) => {
    Object.defineProperty(globalThis, 'navigator', {
      value: opts.serial ? { serial: { requestPort: async () => ({}) } } : {},
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: { isSecureContext: opts.secure },
      configurable: true,
      writable: true,
    });
  };

  afterEach(() => {
    if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator);
    else delete (globalThis as any).navigator;
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else delete (globalThis as any).window;
  });

  it('blames the origin, not the browser, on a plain-http page', () => {
    // The failure people actually hit: physbox open on a LAN address from a
    // phone. Telling them to change browser there sends them the wrong way.
    setUp({ serial: false, secure: false });
    expect(webSerialUnavailableReason()).toMatch(/secure page/i);
    expect(webSerialUnavailableReason()).not.toMatch(/Chrome/);
  });

  it('blames the browser when the page is secure and the API still is not there', () => {
    setUp({ serial: false, secure: true });
    expect(webSerialUnavailableReason()).toMatch(/Chrome, Edge or Opera/);
  });

  it('says nothing at all when the cable is available', () => {
    setUp({ serial: true, secure: true });
    expect(webSerialUnavailableReason()).toBeNull();
  });

  it('points at WiFi either way, since that is what still works', () => {
    for (const secure of [true, false]) {
      setUp({ serial: false, secure });
      expect(webSerialUnavailableReason()).toMatch(/WiFi/);
    }
  });
});
