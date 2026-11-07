import { mountWidget } from './mount';
import { maybeRedirectToReports } from './redirect';
import PacingBars from './widgets/PacingBars.svelte';
import { parsePacingConfig } from './widgets/pacing-data';
import MonthEndNet from './widgets/MonthEndNet.svelte';
import PaycheckAlertBanner from './widgets/PaycheckAlertBanner.svelte';
import BillsTimeline from './widgets/BillsTimeline.svelte';
import AccountBalancesChart from './widgets/AccountBalancesChart.svelte';
import AccountBalanceList from './widgets/AccountBalanceList.svelte';
import UnlinkedTransfers from './widgets/UnlinkedTransfers.svelte';
import SpendingBreakdownDonut from './widgets/SpendingBreakdownDonut.svelte';
import SavingsGoalsThermometers from './widgets/SavingsGoalsThermometers.svelte';
import BurnRateChart from './widgets/BurnRateChart.svelte';
import SpendingHeatmap from './widgets/SpendingHeatmap.svelte';
import SavingsRateGauge from './widgets/SavingsRateGauge.svelte';
import SpendingSankey from './widgets/SpendingSankey.svelte';
import SpendingTreemap from './widgets/SpendingTreemap.svelte';
import SubscriptionRadar from './widgets/SubscriptionRadar.svelte';
import { parseRadarConfig } from './widgets/radar-data';
import { mountWidgetBuilderPanel } from './widget-builder/mount-toolbar';
import WidgetBuilderPanel from './widget-builder/WidgetBuilderPanel.svelte';
import { mountSettingsSection } from './settings-panel/mount-settings';
import SettingsLinkCard from './settings-panel/SettingsLinkCard.svelte';
import { mountInsightsPage } from './insights-page/mount-page';
import { mountSidebarEntry } from './insights-page/sidebar-entry';
import { PRESETS, loadSavedScale, applyScale } from './text-scale';
import { loadSavedFreshThemeEnabled, applyFreshTheme, watchActualTheme } from './fresh-theme';
import { fixBudgetIconCrop } from './budget-icon-fix';

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

try {
  maybeRedirectToReports(window.location, window.sessionStorage);
} catch {
  // window.sessionStorage can throw a SecurityError when site storage is
  // blocked by the browser's privacy settings. That must never prevent the
  // pacing-bars widget below from mounting.
}

// The body is either the legacy array of category ids / rollups, or
// {"categoryIds": [...], "allGroups": true} from the builder's "Category
// Groups" box, optionally with "groupIds" (which groups, in which order);
// see parsePacingConfig.
mountWidget('{{INSIGHTS:pacing-bars:', (host, config) => {
  const { items, allGroups, groupIds } = parsePacingConfig(config);
  new PacingBars({ target: host, props: { items, allGroups, groupIds } });
});

// MonthEndNet takes no config (mount.js still requires the placeholder's body
// to parse as JSON, so an empty or missing body like `{{INSIGHTS:month-end-net:}}`
// fails to parse and the widget never mounts). To add this widget, type the
// following literal text into an Actual Reports "Text widget":
//   {{INSIGHTS:month-end-net:null}}
mountWidget('{{INSIGHTS:month-end-net:', (host) => {
  new MonthEndNet({ target: host });
});

// PaycheckAlertBanner takes no config (mount.js still requires the
// placeholder's body to parse as JSON, so an empty or missing body like
// `{{INSIGHTS:paycheck-alerts:}}` fails to parse and the widget never
// mounts). To add this widget, type the following literal text into an
// Actual Reports "Text widget":
//   {{INSIGHTS:paycheck-alerts:null}}
mountWidget('{{INSIGHTS:paycheck-alerts:', (host) => {
  new PaycheckAlertBanner({ target: host });
});

// BillsTimeline takes no config (mount.js still requires the placeholder's
// body to parse as JSON, so an empty or missing body like
// `{{INSIGHTS:bills-timeline:}}` fails to parse and the widget never
// mounts). To add this widget, type the following literal text into an
// Actual Reports "Text widget":
//   {{INSIGHTS:bills-timeline:null}}
mountWidget('{{INSIGHTS:bills-timeline:', (host) => {
  new BillsTimeline({ target: host });
});

// AccountBalancesChart's config is EITHER a bare array of account ids
// (empty or omitted means every open account, the original convention,
// same as pacing-bars' categoryIds -- kept working for every dashboard
// that already carries this older, bare-array form) OR an object with an
// `accountIds` array and a `labelContent` ('both' | 'amount' | 'name',
// defaulting to 'both') controlling what the combined view's in-band
// label shows. To show every account with the default label, type the
// following literal text into an Actual Reports "Text widget":
//   {{INSIGHTS:account-balances:[]}}
// or to show only specific accounts:
//   {{INSIGHTS:account-balances:["accountId1","accountId2"]}}
// or, to also set labelContent:
//   {{INSIGHTS:account-balances:{"accountIds":[],"labelContent":"amount"}}}
// The object form may also carry `chart` ('stacked' | 'lines', default
// stacked) and `range` ('1M' | '3M' | '6M' | '1Y' | 'ALL', default 1M): the
// chart's initial view and range (the buttons still change them).
mountWidget('{{INSIGHTS:account-balances:', (host, config) => {
  const object = config && typeof config === 'object' && !Array.isArray(config);
  const accountIds = Array.isArray(config) ? config : (config?.accountIds ?? []);
  const labelContent = Array.isArray(config) ? 'both' : (config?.labelContent ?? 'both');
  const chart = object && config.chart === 'lines' ? 'lines' : 'stacked';
  const range = object && typeof config.range === 'string' ? config.range : '1M';
  new AccountBalancesChart({ target: host, props: { accountIds, labelContent, chart, range } });
});

// AccountBalanceList: the selected accounts' current balances as a list.
// Empty accountIds means every open account; showTotal adds a Total row.
//   {{INSIGHTS:account-balance-list:{"accountIds":[],"showTotal":true}}}
mountWidget('{{INSIGHTS:account-balance-list:', (host, config) => {
  const accountIds = Array.isArray(config) ? config : (config?.accountIds ?? []);
  const showTotal = Boolean(config && !Array.isArray(config) && config.showTotal === true);
  new AccountBalanceList({ target: host, props: { accountIds, showTotal } });
});

// UnlinkedTransfers takes no config, same convention as month-end-net and
// paycheck-alerts above. To add this widget, type the following literal
// text into an Actual Reports "Text widget":
//   {{INSIGHTS:unlinked-transfers:null}}
mountWidget('{{INSIGHTS:unlinked-transfers:', (host) => {
  new UnlinkedTransfers({ target: host });
});

// SpendingBreakdownDonut's config is an array of category-group ids to show
// (empty or omitted means every expense group), the same convention as
// account-balances' accountIds. To show every group, type the following
// literal text into an Actual Reports "Text widget":
//   {{INSIGHTS:spending-breakdown-donut:[]}}
// or to show only specific groups:
//   {{INSIGHTS:spending-breakdown-donut:["groupId1","groupId2"]}}
mountWidget('{{INSIGHTS:spending-breakdown-donut:', (host, groupIds) => {
  new SpendingBreakdownDonut({ target: host, props: { groupIds } });
});

// SavingsGoalsThermometers' config is a bare array of category ids to show
// (empty or omitted means every goal-tracked category), same convention as
// pacing-bars' categoryIds. To show every goal-tracked category, type the
// following literal text into an Actual Reports "Text widget":
//   {{INSIGHTS:savings-goals-thermometers:[]}}
// or to show only specific categories:
//   {{INSIGHTS:savings-goals-thermometers:["categoryId1","categoryId2"]}}
mountWidget('{{INSIGHTS:savings-goals-thermometers:', (host, categoryIds) => {
  new SavingsGoalsThermometers({ target: host, props: { categoryIds } });
});

// BurnRateChart takes no config (mount.js still requires the placeholder's
// body to parse as JSON, so an empty or missing body like
// `{{INSIGHTS:burn-rate:}}` fails to parse and the widget never mounts).
// Zero-config, current-month only (no month picker in v1), same posture as
// month-end-net. To add this widget, type the following literal text into
// an Actual Reports "Text widget":
//   {{INSIGHTS:burn-rate:null}}
mountWidget('{{INSIGHTS:burn-rate:', (host) => {
  new BurnRateChart({ target: host });
});

// SpendingHeatmap's config is EITHER a bare 'month'/'year' string (the form
// the widget builder emits, since this widget has exactly one field -- see
// buildPlaceholder's single-field convention) OR an object with a `range`
// key, same two-shapes pattern account-balances' accountIds/config already
// establishes. 'month' is the default (last 30 days), 'year' is the last 12
// months. To show the default 30-day view, type the following literal text
// into an Actual Reports "Text widget":
//   {{INSIGHTS:spending-heatmap:{}}}
// or to show the last 12 months (either shape):
//   {{INSIGHTS:spending-heatmap:"year"}}
//   {{INSIGHTS:spending-heatmap:{"range":"year"}}}
mountWidget('{{INSIGHTS:spending-heatmap:', (host, config) => {
  const range = typeof config === 'string' ? config : (config?.range ?? 'month');
  new SpendingHeatmap({ target: host, props: { range } });
});

// SavingsRateGauge's config is a bare array of category-group ids to count
// as savings rather than spending (empty or omitted means none), same
// convention as pacing-bars' categoryIds and savings-goals-thermometers'
// categoryIds. To show the gauge with no investment groups configured,
// type the following literal text into an Actual Reports "Text widget":
//   {{INSIGHTS:savings-rate-gauge:[]}}
// or to count specific category groups (e.g. a brokerage-transfer group)
// as savings:
//   {{INSIGHTS:savings-rate-gauge:["groupId1","groupId2"]}}
mountWidget('{{INSIGHTS:savings-rate-gauge:', (host, investmentGroupIds) => {
  new SavingsRateGauge({ target: host, props: { investmentGroupIds: investmentGroupIds ?? [] } });
});

// SpendingSankey takes no config (mount.js still requires the placeholder's
// body to parse as JSON, so an empty or missing body like
// `{{INSIGHTS:spending-sankey:}}` fails to parse and the widget never
// mounts). Zero-config, current-month only, shows the whole budget -- same
// posture as unlinked-transfers. To add this widget, type the following
// literal text into an Actual Reports "Text widget":
//   {{INSIGHTS:spending-sankey:null}}
mountWidget('{{INSIGHTS:spending-sankey:', (host) => {
  new SpendingSankey({ target: host });
});

// SpendingTreemap takes no config (mount.js still requires the placeholder's
// body to parse as JSON, so an empty or missing body like
// `{{INSIGHTS:spending-treemap:}}` fails to parse and the widget never
// mounts). Zero-config, current-month only, Group -> Category drill-down --
// same posture as spending-sankey. To add this widget, type the following
// literal text into an Actual Reports "Text widget":
//   {{INSIGHTS:spending-treemap:null}}
mountWidget('{{INSIGHTS:spending-treemap:', (host) => {
  new SpendingTreemap({ target: host });
});

// SubscriptionRadar's body is `null` (the original horizontal timeline) or
// {"layout":"vertical"|"horizontal","excludeCategoryIds":[...]} -- see
// parseRadarConfig. Type one of these into an Actual Reports "Text widget":
//   {{INSIGHTS:subscription-radar:null}}
mountWidget('{{INSIGHTS:subscription-radar:', (host, config) => {
  const { layout, excludeCategoryIds } = parseRadarConfig(config);
  new SubscriptionRadar({ target: host, props: { layout, excludeCategoryIds } });
});

// Panel mounting has no dependency on sessionStorage, so it stays outside
// the try/catch above.
mountWidgetBuilderPanel(document, window, WidgetBuilderPanel);

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
