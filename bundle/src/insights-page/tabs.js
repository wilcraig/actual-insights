import GeneralTab from './GeneralTab.svelte';
import ChannelsTab from './ChannelsTab.svelte';
import SummariesTab from './SummariesTab.svelte';
import ForecastTab from './ForecastTab.svelte';
import MobileTab from './MobileTab.svelte';
import ReportsTab from '../chipmunk/ReportsTab.svelte';
import AccountsTab from '../chipmunk/AccountsTab.svelte';
import TransactionsTab from '../chipmunk/TransactionsTab.svelte';
import BudgetTab from '../chipmunk/BudgetTab.svelte';

// The Insights page's tabs, in tab-bar order. Ids match route.js's
// TAB_IDS (they name the tab in the URL hash).
export const TABS = [
  { id: 'general', label: 'General', component: GeneralTab },
  { id: 'summaries', label: 'Summaries', component: SummariesTab },
  { id: 'channels', label: 'Channels', component: ChannelsTab },
  { id: 'forecast', label: 'Forecast', component: ForecastTab },
  { id: 'mobile', label: 'Mobile app', component: MobileTab },
];

// Chipmunk mode: the phone's screens first, then the usual tabs (General included).
export const CHIPMUNK_TABS = [
  { id: 'reports', label: 'Reports', component: ReportsTab },
  { id: 'accounts', label: 'Accounts', component: AccountsTab },
  { id: 'transactions', label: 'Transactions', component: TransactionsTab },
  { id: 'budget', label: 'Budget', component: BudgetTab },
];

export function tabsFor(chipmunk) {
  return chipmunk ? [...CHIPMUNK_TABS, ...TABS] : TABS;
}
