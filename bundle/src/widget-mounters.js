// One mount callback per widget id: given the element to render into and the
// placeholder's parsed JSON body, build the widget and return its component
// instance. index.js hands each of these to mountWidget() (so a
// `{{INSIGHTS:<id>:<json>}}` placeholder in a Reports Text widget comes alive),
// and the widget builder's live preview calls the very same functions, so what
// you preview is exactly what the dashboard will render.
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

export const WIDGET_MOUNTERS = {
  // The body is either the legacy array of category ids / rollups, or
  // {"categoryIds": [...], "allGroups": true} from the builder's "Category
  // Groups" box, optionally with "groupIds" (which groups, in which order);
  // see parsePacingConfig.
  'pacing-bars': (host, config) => {
    const { items, allGroups, groupIds } = parsePacingConfig(config);
    return new PacingBars({ target: host, props: { items, allGroups, groupIds } });
  },

  // MonthEndNet takes no config (mount.js still requires the placeholder's body
  // to parse as JSON, so an empty or missing body like `{{INSIGHTS:month-end-net:}}`
  // fails to parse and the widget never mounts). To add this widget by hand, type
  // the following literal text into an Actual Reports "Text widget":
  //   {{INSIGHTS:month-end-net:null}}
  'month-end-net': (host) => new MonthEndNet({ target: host }),

  // PaycheckAlertBanner takes no config (same JSON-body rule as month-end-net):
  //   {{INSIGHTS:paycheck-alerts:null}}
  'paycheck-alerts': (host) => new PaycheckAlertBanner({ target: host }),

  // BillsTimeline takes no config (same JSON-body rule as month-end-net):
  //   {{INSIGHTS:bills-timeline:null}}
  'bills-timeline': (host) => new BillsTimeline({ target: host }),

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
  'account-balances': (host, config) => {
    const object = config && typeof config === 'object' && !Array.isArray(config);
    const accountIds = Array.isArray(config) ? config : (config?.accountIds ?? []);
    const labelContent = Array.isArray(config) ? 'both' : (config?.labelContent ?? 'both');
    const chart = object && config.chart === 'lines' ? 'lines' : 'stacked';
    const range = object && typeof config.range === 'string' ? config.range : '1M';
    return new AccountBalancesChart({ target: host, props: { accountIds, labelContent, chart, range } });
  },

  // AccountBalanceList: the selected accounts' current balances as a list.
  // Empty accountIds means every open account; showTotal adds a Total row.
  //   {{INSIGHTS:account-balance-list:{"accountIds":[],"showTotal":true}}}
  'account-balance-list': (host, config) => {
    const accountIds = Array.isArray(config) ? config : (config?.accountIds ?? []);
    const showTotal = Boolean(config && !Array.isArray(config) && config.showTotal === true);
    return new AccountBalanceList({ target: host, props: { accountIds, showTotal } });
  },

  // UnlinkedTransfers takes no config (same JSON-body rule as month-end-net):
  //   {{INSIGHTS:unlinked-transfers:null}}
  'unlinked-transfers': (host) => new UnlinkedTransfers({ target: host }),

  // SpendingBreakdownDonut's config is an array of category-group ids to show
  // (empty or omitted means every expense group), the same convention as
  // account-balances' accountIds. To show every group, type the following
  // literal text into an Actual Reports "Text widget":
  //   {{INSIGHTS:spending-breakdown-donut:[]}}
  // or to show only specific groups:
  //   {{INSIGHTS:spending-breakdown-donut:["groupId1","groupId2"]}}
  'spending-breakdown-donut': (host, groupIds) => new SpendingBreakdownDonut({ target: host, props: { groupIds } }),

  // SavingsGoalsThermometers' config is a bare array of category ids to show
  // (empty or omitted means every goal-tracked category), same convention as
  // pacing-bars' categoryIds. To show every goal-tracked category, type the
  // following literal text into an Actual Reports "Text widget":
  //   {{INSIGHTS:savings-goals-thermometers:[]}}
  // or to show only specific categories:
  //   {{INSIGHTS:savings-goals-thermometers:["categoryId1","categoryId2"]}}
  'savings-goals-thermometers': (host, categoryIds) => new SavingsGoalsThermometers({ target: host, props: { categoryIds } }),

  // BurnRateChart takes no config (same JSON-body rule as month-end-net).
  // Zero-config, current-month only (no month picker in v1):
  //   {{INSIGHTS:burn-rate:null}}
  'burn-rate': (host) => new BurnRateChart({ target: host }),

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
  'spending-heatmap': (host, config) => {
    const range = typeof config === 'string' ? config : (config?.range ?? 'month');
    return new SpendingHeatmap({ target: host, props: { range } });
  },

  // SavingsRateGauge's config is a bare array of category-group ids to count
  // as savings rather than spending (empty or omitted means none), same
  // convention as pacing-bars' categoryIds and savings-goals-thermometers'
  // categoryIds. To show the gauge with no investment groups configured,
  // type the following literal text into an Actual Reports "Text widget":
  //   {{INSIGHTS:savings-rate-gauge:[]}}
  // or to count specific category groups (e.g. a brokerage-transfer group)
  // as savings:
  //   {{INSIGHTS:savings-rate-gauge:["groupId1","groupId2"]}}
  'savings-rate-gauge': (host, investmentGroupIds) => new SavingsRateGauge({
    target: host,
    props: { investmentGroupIds: investmentGroupIds ?? [] },
  }),

  // SpendingSankey takes no config (same JSON-body rule as month-end-net).
  // Zero-config, current-month only, shows the whole budget:
  //   {{INSIGHTS:spending-sankey:null}}
  'spending-sankey': (host) => new SpendingSankey({ target: host }),

  // SpendingTreemap takes no config (same JSON-body rule as month-end-net).
  // Zero-config, current-month only, Group -> Category drill-down:
  //   {{INSIGHTS:spending-treemap:null}}
  'spending-treemap': (host) => new SpendingTreemap({ target: host }),

  // SubscriptionRadar's body is `null` (the original horizontal timeline) or
  // {"layout":"vertical"|"horizontal","excludeCategoryIds":[...]} -- see
  // parseRadarConfig. Type one of these into an Actual Reports "Text widget":
  //   {{INSIGHTS:subscription-radar:null}}
  'subscription-radar': (host, config) => {
    const { layout, excludeCategoryIds } = parseRadarConfig(config);
    return new SubscriptionRadar({ target: host, props: { layout, excludeCategoryIds } });
  },
};
