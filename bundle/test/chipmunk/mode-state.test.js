vi.mock('../../src/chipmunk/chipmunk-api', () => ({ getMode: vi.fn(), setMode: vi.fn() }));
import { getMode } from '../../src/chipmunk/chipmunk-api';
import { getChipmunkMode, setChipmunkMode, subscribeChipmunkMode, refreshChipmunkMode } from '../../src/chipmunk/mode-state';

beforeEach(() => setChipmunkMode({ enabled: false, entitled: false }));

test('defaults off and only on when enabled AND entitled', () => {
  expect(getChipmunkMode()).toEqual({ enabled: false, entitled: false });
  setChipmunkMode({ enabled: true, entitled: false });
  expect(getChipmunkMode().enabled).toBe(false);
  setChipmunkMode({ enabled: true, entitled: true });
  expect(getChipmunkMode()).toEqual({ enabled: true, entitled: true });
});

test('notifies subscribers once per change and can unsubscribe', () => {
  const fn = vi.fn();
  const off = subscribeChipmunkMode(fn);
  setChipmunkMode({ enabled: true, entitled: true });
  setChipmunkMode({ enabled: true, entitled: true });
  expect(fn).toHaveBeenCalledTimes(1);
  off();
  setChipmunkMode({ enabled: false, entitled: true });
  expect(fn).toHaveBeenCalledTimes(1);
});

test('refresh adopts the server state; a failure or junk leaves it off', async () => {
  getMode.mockResolvedValueOnce({ enabled: true, entitled: true });
  expect((await refreshChipmunkMode()).enabled).toBe(true);
  getMode.mockRejectedValueOnce(new Error('down'));
  expect((await refreshChipmunkMode()).enabled).toBe(false);
  getMode.mockResolvedValueOnce([]);
  expect((await refreshChipmunkMode()).enabled).toBe(false);
});
