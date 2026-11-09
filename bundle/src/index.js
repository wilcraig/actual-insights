import { mountWidget } from './mount';
import { maybeRedirectToReports } from './redirect';
import { WIDGET_MOUNTERS } from './widget-mounters';
import { mountWidgetBuilderPanel } from './widget-builder/mount-toolbar';
import WidgetBuilderPanel from './widget-builder/WidgetBuilderPanel.svelte';
import { watchEditableWidgets } from './widget-builder/edit-hook';
import { openBuilder } from './widget-builder/controller';
import { mountSettingsSection } from './settings-panel/mount-settings';
import SettingsLinkCard from './settings-panel/SettingsLinkCard.svelte';
import { mountInsightsPage } from './insights-page/mount-page';
import { mountSidebarEntry } from './insights-page/sidebar-entry';
import { PRESETS, loadSavedScale, applyScale } from './text-scale';
import { loadSavedFreshThemeEnabled, applyFreshTheme, watchActualTheme } from './fresh-theme';
import { fixBudgetIconCrop } from './budget-icon-fix';
import { startTakeover } from './chipmunk/shell/takeover';
import { mountChipmunkShell } from './chipmunk/shell/mount-shell';

// Pure CSS, no DOM dependency beyond `document.head` -- safe to run
// unconditionally on every page load, independent of sessionStorage.
fixBudgetIconCrop(document);

// Applies the saved text size and Fresh theme on every page load
// (Budget and Schedules pages included, not just /reports*) -- both are
// controlled from the Insights page's General tab (see insights-page/),
// not a floating button, but still need to take effect everywhere, not
// just while that page is open. Referencing
// `window.localStorage` can itself throw (not just its methods) under
// strict privacy settings, so each is guarded independently.
try {
  applyScale(document, loadSavedScale(window.localStorage));
} catch {
  applyScale(document, PRESETS[0].px);
}
try {
  applyFreshTheme(document, loadSavedFreshThemeEnabled(window.localStorage));
} catch {
  applyFreshTheme(document, false);
}
// Actual sets (and later swaps) its light/dark theme after this script runs.
watchActualTheme(document, () => {
  try {
    return loadSavedFreshThemeEnabled(window.localStorage);
  } catch {
    return false;
  }
});

// Everything that belongs to Actual's own UI (the redirect to Reports, widget
// mounting, the builder, the Insights page and its sidebar entry). Runs once:
// at once on a normal load, or later if Chipmunk mode's shell covers Actual and
// the person opens Actual (or turns the mode off, or the shell fails).
let actualStarted = false;
function startActual() {
  if (actualStarted) return;
  actualStarted = true;
  try {
    maybeRedirectToReports(window.location, window.sessionStorage);
  } catch {
    // window.sessionStorage can throw a SecurityError when site storage is
    // blocked by the browser's privacy settings. That must never prevent the
    // pacing-bars widget below from mounting.
  }

  // Every widget's mount callback (and the placeholder shape it expects) lives in
  // widget-mounters.js, shared with the widget builder's live preview.
  for (const [widgetId, mount] of Object.entries(WIDGET_MOUNTERS)) {
    mountWidget(`{{INSIGHTS:${widgetId}:`, mount);
  }

  // Panel mounting has no dependency on sessionStorage, so it stays outside
  // the try/catch above.
  mountWidgetBuilderPanel(document, window, WidgetBuilderPanel);

  // A small edit button on every live widget reopens the builder on it, with its
  // current options loaded back in (read from the widget's own placeholder text).
  try {
    watchEditableWidgets(document, window, (initial) => openBuilder({ initial }));
  } catch {
    // No edit buttons; widgets themselves are unaffected.
  }

  // Actual's Settings page keeps a one-line "Actual Insights" card pointing
  // at the Insights page, where its controls moved -- see
  // settings-panel/mount-settings.js for how it's placed.
  mountSettingsSection(document, window, SettingsLinkCard);

  // The Insights page (text size, Fresh theme, savings goals, and later
  // summaries and notification channels) and its sidebar entry. Each is
  // guarded on its own: Actual has no plugin API, so both lean on its (and
  // ABT's) markup, and a surprise there must never stop anything above
  // from mounting or break Actual itself.
  try {
    mountInsightsPage(document, window);
  } catch {
    // The page simply never opens; Actual is unaffected.
  }
  try {
    mountSidebarEntry(document, window);
  } catch {
    // No sidebar entry; the Settings card above still opens the page.
  }
}

// Chipmunk mode (docs/chipmunk-mode.md) covers the whole app with its own shell.
// With the mode off (the default), or when anything about it is in doubt, this
// calls startActual() right here, synchronously, exactly as before.
try {
  startTakeover({
    win: window,
    doc: document,
    mountShell: ({ openActual }) => mountChipmunkShell(document, window, { openActual }),
    startActual,
  });
} catch (err) {
  console.error('chipmunk takeover failed to start:', err);
  startActual();
}
