// Writes src/icons/bundledIcons.generated.ts: a curated subset of Material Design Icons for the
// tab icon picker and the built-in widgets, so Iconify never fetches them from a public API.
// Run: node scripts/gen-icons.mjs (needs the @iconify-json/mdi dev dependency).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const set = JSON.parse(readFileSync(require.resolve('@iconify-json/mdi/icons.json'), 'utf8'));

const WANTED = `view-dashboard view-dashboard-outline view-grid view-grid-outline view-list view-agenda
  chart-line chart-bar chart-pie chart-donut chart-areaspline chart-timeline-variant chart-box-outline
  gauge speedometer table table-large table-column text-box-outline text-long note-text-outline
  clock-outline clock-time-four-outline calendar calendar-month-outline timer-outline alarm
  server server-network server-security dns lan network router-network cloud cloud-outline
  database database-outline harddisk memory cpu-64-bit chip expansion-card thermometer
  fire flash lightning-bolt battery power-plug water fan snowflake weather-sunny
  kubernetes docker console console-line code-braces code-tags bug-outline wrench hammer-wrench
  cog cog-outline tune tune-variant  toolbox-outline
  alert alert-circle-outline alert-outline bell-outline bell-ring-outline shield-check shield-alert
  security lock lock-outline key-variant account account-group account-circle-outline
  home home-outline map-marker earth web link-variant open-in-new
  folder folder-outline file-document-outline file-chart-outline clipboard-text-outline
  check-circle-outline close-circle-outline information-outline help-circle-outline heart-pulse
  star star-outline bookmark-outline flag-outline pin-outline lightbulb-outline rocket-launch-outline
  play-circle-outline pause-circle-outline stop-circle-outline refresh sync reload history update
  magnify filter-variant filter-outline sort format-list-bulleted format-list-checks
  monitor monitor-dashboard desktop-tower laptop cellphone tablet television
  package-variant package-variant-closed cube-outline cube-scan layers-outline
  rss email-outline message-outline chat-outline phone-outline send
  currency-usd cash credit-card-outline cart-outline store-outline
  trending-up trending-down arrow-up arrow-down arrow-left arrow-right chevron-up chevron-down
  plus minus close pencil pencil-outline delete-outline content-copy content-save-outline
  drag drag-variant arrow-all dots-vertical dots-horizontal menu cog-transfer
  fullscreen fullscreen-exit eye-outline eye-off-outline palette-outline format-color-fill
  image-outline video-outline music-note camera-outline
  view-split-horizontal puzzle-outline view-split-vertical page-layout-header page-layout-body page-layout-sidebar-left
  format-header-1 format-header-2 minus-thick format-text text-recognition format-align-left
  format-align-center format-align-right dock-top dock-bottom arrow-collapse-vertical
  swap-horizontal swap-vertical arrow-up-down content-cut ruler resize-bottom-right
  chart-areaspline-variant chart-bell-curve chart-histogram chart-scatter-plot chart-multiline
  poll equalizer  finance book-open-variant school robot robot-outline brain
  nas usb-flash-drive sd harddisk-plus tray-full cloud-upload-outline cloud-download-outline
  access-point wifi ethernet cable-data bluetooth qrcode barcode label-outline tag-outline

  run run-fast walk bike speedometer-slow speedometer-medium gauge-full gauge-low gauge-empty
  alert-decagram alert-decagram-outline alert-circle alert-octagon alert-octagon-outline alert-rhombus-outline
  bell bell-alert-outline bell-off-outline bell-sleep-outline bell-badge-outline
  check check-bold check-all check-circle check-decagram check-decagram-outline check-network-outline
  close-octagon-outline close-network-outline cancel progress-check progress-clock progress-alert progress-wrench
  information help-circle information-variant-circle-outline help-network-outline
  checkbox-marked-circle-outline checkbox-marked-outline checkbox-blank-circle checkbox-blank-circle-outline
  circle circle-outline circle-slice-8 circle-medium square square-outline triangle triangle-outline hexagon hexagon-outline
  thumb-up-outline thumb-down-outline emoticon-happy-outline emoticon-sad-outline emoticon-neutral-outline
  signal signal-cellular-3 signal-off sine-wave pulse heart heart-outline heart-broken-outline heart-plus-outline
  github gitlab bitbucket git source-branch source-branch-check source-merge source-pull source-commit
  source-repository source-fork  application-cog-outline application-outline
  pipe pipe-disconnected pipe-leak pipe-valve pipe-wrench cog-sync cog-play-outline cog-stop-outline cog-pause-outline
  console-network console-network-outline  powershell
  language-ruby language-markdown language-html5 language-css3 language-c language-cpp language-swift language-kotlin
  code-json code-array code-brackets code-parentheses code-equal code-not-equal code-string code-tags-check
  file-import-outline file-lock-outline file-move-outline file-upload-outline file-download-outline
  folder-cog-outline folder-zip-outline folder-star-outline folder-plus-outline
  kubernetes docker server-plus server-minus server-remove server-off server-outline server-network-off server-network-outline
  server-security dns-outline lan-connect lan-disconnect lan-pending lan-check network-outline network-off-outline
  router router-wireless router-network-wireless switch network-pos
  cloud-check-outline cloud-alert-outline cloud-off-outline cloud-sync-outline cloud-lock-outline cloud-braces cloud-cog-outline
  cloud-search-outline cloud-tags cloud-print-outline cloud-circle-outline cloud-refresh-outline
  database-check database-alert database-clock database-cog database-export database-import database-lock database-plus
  database-minus database-remove database-search database-sync database-refresh database-arrow-up database-arrow-down
  database-settings database-eye database-marker database-edit database-check-outline database-alert-outline
  database-clock-outline database-cog-outline database-lock-outline database-search-outline database-sync-outline
  harddisk-remove harddisk-plus nas usb zip-disk floppy content-save content-save-all content-save-cog-outline
  memory cpu-32-bit chip expansion-card expansion-card-variant   fan fan-alert fan-off fan-speed-1
  thermometer-alert thermometer-high thermometer-low thermometer-lines thermometer-chevron-up thermometer-chevron-down
  water-outline water-alert-outline water-percent water-pump water-boiler flash-outline flash-alert-outline flash-off
  flash-auto battery-outline battery-charging battery-alert battery-high battery-low battery-medium battery-heart-variant
  power power-off power-standby power-cycle power-sleep power-socket power-plug-outline power-plug-off-outline
  lightning-bolt-outline lightning-bolt-circle solar-power solar-panel wind-power transmission-tower
  chart-line-variant chart-line-stacked chart-areaspline chart-arc chart-bubble chart-gantt chart-sankey chart-sankey-variant
  chart-tree chart-timeline chart-box chart-donut-variant chart-bar-stacked chart-waterfall chart-ppf chart-box-plus-outline
  chart-pie-outline chart-timeline-variant-shimmer chart-scatter-plot-hexbin chart-multiple  chart-sankey
  chart-bell-curve-cumulative chart-histogram chart-multiline chart-areaspline-variant
  graph graph-outline graphql sigma sigma-lower percent percent-outline numeric numeric-1-box-outline pound pound-box-outline
  trending-neutral arrow-top-right arrow-bottom-right arrow-top-left arrow-bottom-left arrow-up-bold arrow-down-bold
  arrow-up-circle-outline arrow-down-circle-outline arrow-left-circle-outline arrow-right-circle-outline arrow-up-thick arrow-down-thick
  clock clock-alert clock-alert-outline clock-check-outline clock-fast clock-start clock-end clock-in clock-out
  clock-digital clock-time-eight-outline clock-time-twelve-outline timer timer-sand timer-sand-complete timer-off-outline
  timer-cog-outline timer-play-outline timer-pause-outline timer-stop-outline timelapse timeline timeline-clock-outline
  timeline-check-outline timeline-alert-outline timeline-text-outline timeline-plus-outline
  calendar-clock calendar-clock-outline calendar-check-outline calendar-alert calendar-range calendar-today calendar-week
  calendar-sync-outline calendar-refresh-outline calendar-star calendar-month calendar-blank-outline calendar-text-outline
  history backup-restore restore restart update sync-alert sync-circle autorenew reload-alert refresh-circle repeat
  repeat-once shuffle-variant skip-next skip-previous play pause stop record fast-forward rewind step-forward
  play-box-outline play-network-outline pause-box-outline stop-circle motion-play-outline
  account-multiple account-multiple-outline account-outline account-check account-check-outline account-alert account-alert-outline
  account-cog account-cog-outline account-key account-key-outline account-lock account-lock-outline account-clock-outline
  account-details account-details-outline account-edit-outline account-eye account-heart-outline account-hard-hat account-star
  account-supervisor account-supervisor-outline account-switch account-tie account-network account-plus account-minus account-off-outline
  account-group-outline account-box-outline account-search-outline account-wrench-outline account-question-outline
  android-studio brain creation auto-fix auto-mode magic-staff head-cog head-lightbulb-outline lightbulb lightbulb-on-outline
  lightbulb-alert-outline lightbulb-off-outline lightbulb-group-outline
  shield shield-outline shield-off-outline shield-key-outline shield-lock-outline shield-half-full shield-search shield-bug-outline
  shield-account-outline shield-star-outline shield-sync-outline shield-link-variant-outline shield-home-outline shield-plus-outline
  shield-lock shield-key shield-check-outline shield-alert-outline shield-cross-outline shield-refresh-outline
  lock-alert-outline lock-check-outline lock-clock lock-open-outline lock-open-variant-outline lock-reset lock-question lock-plus
  lock-open-check-outline lock-pattern lock-smart key key-outline key-chain key-plus key-remove key-star key-wireless key-link
  key-alert-outline key-change certificate certificate-outline passport fingerprint incognito eye eye-check-outline eye-lock-outline
  eye-circle-outline eye-refresh-outline eye-settings-outline security-network bug bug-check-outline bug-play-outline bug-stop-outline
  virus-outline virus ghost-outline skull-outline skull-crossbones-outline radioactive biohazard
   fire-alert fire-circle fire-extinguisher fire-truck fire-hydrant campfire
  bomb flare flash-triangle-outline sword-cross wall wall-fire shield-sword-outline
  tune-vertical tune-vertical-variant tune-variant   toggle-switch toggle-switch-outline toggle-switch-off-outline
  toggle-switch-variant-off cog-box cogs hammer hammer-screwdriver screwdriver wrench-outline wrench-cog-outline
  tools toolbox   briefcase-outline briefcase-check-outline
  magnify-scan magnify-plus-outline magnify-minus-outline magnify-expand file-find-outline text-search text-search-variant
  database-search layers layers-search-outline layers-triple-outline layers-plus layers-minus layers-remove layers-edit
  layers-off-outline layers-triple cube cube-send cube-unfolded cube-off-outline package package-variant-closed-check
  package-variant-closed-remove package-variant-closed-plus package-up package-down package-check  archive archive-outline
  archive-arrow-down-outline archive-arrow-up-outline archive-alert-outline archive-clock-outline archive-search-outline
  message-reply-text-outline message-cog-outline message-badge-outline message-bookmark-outline message-check-outline
  webhook api api-off cloud-braces rss-box broadcast broadcast-off antenna satellite-variant satellite-uplink radar
  wifi-off wifi-alert wifi-check wifi-strength-1 wifi-strength-4 wifi-sync lan-connect bluetooth-connect
  ethernet-cable ethernet-cable-off access-point-network access-point-network-off access-point-check
  vpn tunnel-outline tunnel earth-box earth-off earth-arrow-right web-check web-off web-remove web-sync web-clock web-box
  link link-off link-box-outline link-plus link-lock link-variant-off link-variant-plus link-variant-remove
  open-in-app launch export import share-variant-outline send-outline send-check-outline send-clock-outline
  upload download upload-network-outline download-network-outline upload-lock-outline download-lock-outline upload-outline
  download-outline cloud-upload cloud-download transfer transfer-right transfer-left transfer-up transfer-down
  swap-horizontal-bold swap-vertical-bold call-merge call-split  set-merge set-split set-center
  directions directions-fork routes   source-branch-plus source-branch-minus source-branch-remove
  source-branch-sync source-branch-refresh source-branch-check source-merge source-pull
  alpha-i-circle-outline alpha-p-circle-outline alpha-s-circle-outline numeric-0-circle-outline numeric-1-circle-outline
  numeric-2-circle-outline numeric-3-circle-outline numeric-4-circle-outline numeric-5-circle-outline
  priority-high priority-low sort-ascending sort-descending sort-alphabetical-ascending sort-numeric-ascending
  sort-calendar-ascending sort-clock-ascending-outline sort-bool-ascending sort-variant filter filter-check-outline filter-plus-outline
  filter-minus-outline filter-remove-outline filter-off-outline filter-cog-outline filter-menu-outline filter-variant-plus
  filter-variant-remove filter-multiple-outline table-filter table-search table-edit table-cog table-eye table-clock
  table-arrow-down table-arrow-up table-network table-refresh table-sync table-lock table-key table-check table-alert
  table-row table-column-plus-after table-large-plus table-split-cell table-merge-cells
  view-dashboard-edit-outline view-dashboard-variant view-dashboard-variant-outline view-dashboard-outline view-compact-outline
  view-comfy view-carousel view-column view-day view-week view-module view-sequential view-parallel view-stream view-array
  view-gallery-outline view-quilt view-headline view-list-outline view-split-horizontal
  monitor-eye monitor-dashboard monitor-cellphone monitor-multiple monitor-off monitor-screenshot monitor-star monitor-small
  monitor-shimmer monitor-lock monitor-speaker monitor-share desktop-classic desktop-tower-monitor television-classic
  television-guide cast cast-connected projector presentation presentation-play
  bookmark-plus-outline bookmark-remove-outline  flag flag-checkered flag-triangle flag-variant-outline
  flag-plus-outline flag-minus-outline pin pin-off-outline pin-outline map-marker-outline map-marker-alert-outline
  map-marker-check-outline map-marker-radius-outline map-marker-multiple-outline map map-outline map-search-outline compass-outline
  navigation-outline crosshairs crosshairs-gps target target-account home-city-outline home-group home-lock home-alert-outline
  home-analytics home-automation home-circle-outline home-thermometer-outline office-building office-building-outline
  office-building-cog-outline domain domain-off factory warehouse city city-variant-outline bank-outline store store-cog-outline
  crown-outline diamond-stone gift-outline party-popper ticket-outline ticket-confirmation-outline
  credit-card-clock-outline credit-card-off-outline invoice-text-outline calculator calculator-variant-outline scale-balance
  notebook-outline notebook-edit-outline notebook-multiple book-cog-outline library bookshelf newspaper newspaper-variant-outline
  text-box-edit-outline text-shadow text-short subtitles-outline format-title format-paragraph format-quote-open
  format-underline format-strikethrough format-size format-font format-clear format-line-spacing format-wrap-square
  clipboard clipboard-outline clipboard-check-outline clipboard-alert-outline clipboard-clock-outline clipboard-list-outline
  clipboard-pulse-outline clipboard-flow-outline clipboard-text-clock-outline clipboard-text-search-outline clipboard-arrow-down-outline
  clipboard-arrow-up-outline clipboard-account-outline clipboard-edit-outline clipboard-file-outline clipboard-plus-outline
  checkbox-multiple-marked-outline checkbox-multiple-outline format-list-checks order-bool-ascending-variant playlist-check
  playlist-plus playlist-remove playlist-edit playlist-play  trello 
  palette palette-swatch-outline format-color-text format-color-highlight image image-multiple-outline image-search-outline
  image-filter-hdr image-area image-edit-outline image-plus image-off-outline camera camera-off-outline camera-wireless-outline
  camera-iris cctv video video-off-outline video-wireless-outline video-vintage movie-outline movie-open-outline
  menu-down menu-up menu-left menu-right menu-open dock-left dock-right dock-window page-layout-footer page-layout-header-footer
  application application-brackets-outline application-braces-outline application-import application-export
  application-array-outline application-variable-outline application-parentheses-outline
  plus-circle-outline plus-box-outline plus-thick minus-circle-outline minus-box-outline close-box-outline close-thick
  close-circle close-circle-multiple-outline information-outline check-circle-outline help-box-outline
  weather-hurricane weather-sunset weather-sunny-alert weather-tornado white-balance-sunny moon-waning-crescent
  heart-pulse pulse    stethoscope
  gauge gauge-full gauge-low speedometer-slow cog-clockwise cog-counterclockwise
  help help-circle-outline help-rhombus-outline information-box-outline
  server-network server-security dns lan
  bell-cog-outline bell-check-outline bell-plus-outline bell-remove-outline bell-ring bell-circle-outline bell-badge
  notification-clear-all`
  .split(/\s+/)
  .filter(Boolean);

const found = [];
const missing = [];
for (const n of [...new Set(WANTED)].sort()) {
  const icon = set.icons[n];
  if (icon) found.push([n, icon.body]);
  else missing.push(n);
}
if (missing.length) console.warn(`Skipped (not in mdi): ${missing.join(' ')}`);

let out = `// Generated by scripts/gen-icons.mjs. Do not edit.
// Subset of @iconify-json/mdi (Apache-2.0).
export const BUNDLED_MDI: Record<string, string> = {\n`;
for (const [n, body] of found) out += `  '${n}': ${JSON.stringify(body)},\n`;
out += '};\n';
writeFileSync(new URL('../src/icons/bundledIcons.generated.ts', import.meta.url), out);
console.log(`${found.length} icons written`);
