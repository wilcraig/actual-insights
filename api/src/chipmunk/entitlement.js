// The ONE place that decides whether Chipmunk mode may be used. Everything that
// offers or serves it (the toggle, the settings route, the data routes) asks
// here. A later phase replaces the body with real subscription verification;
// callers only rely on the shape { entitled, reason, lastVerifiedAt }.
async function chipmunkEntitled() {
  return { entitled: true, reason: 'unlicensed-dev', lastVerifiedAt: null };
}

module.exports = { chipmunkEntitled };
