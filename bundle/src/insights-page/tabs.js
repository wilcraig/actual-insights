import GeneralTab from './GeneralTab.svelte';
import ChannelsTab from './ChannelsTab.svelte';
import SummariesTab from './SummariesTab.svelte';
import ForecastTab from './ForecastTab.svelte';
import MobileTab from './MobileTab.svelte';

// The Insights page's tabs, in tab-bar order. Ids match route.js's
// TAB_IDS (they name the tab in the URL hash).
export const TABS = [
  { id: 'general', label: 'General', component: GeneralTab },
  { id: 'summaries', label: 'Summaries', component: SummariesTab },
  { id: 'channels', label: 'Channels', component: ChannelsTab },
  { id: 'forecast', label: 'Forecast', component: ForecastTab },
  { id: 'mobile', label: 'Mobile app', component: MobileTab },
];
