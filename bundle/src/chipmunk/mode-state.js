import { getMode } from './chipmunk-api';

// The Chipmunk-mode state the Insights page reads. Defaults to off, and any
// failure (API down, odd response) leaves it off, so the page is exactly what
// it was before Chipmunk mode existed.
let state = { enabled: false, entitled: false };
const listeners = new Set();

export const getChipmunkMode = () => state;

export function setChipmunkMode(next) {
  const enabled = next?.enabled === true && next?.entitled === true;
  const entitled = next?.entitled === true;
  if (enabled === state.enabled && entitled === state.entitled) return;
  state = { enabled, entitled };
  for (const fn of listeners) fn(state);
}

export function subscribeChipmunkMode(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshChipmunkMode() {
  try {
    setChipmunkMode(await getMode());
  } catch {
    setChipmunkMode({ enabled: false, entitled: false });
  }
  return state;
}
