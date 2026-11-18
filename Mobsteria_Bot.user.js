// ==UserScript==
// @name         Mobsteria Bot V2 + Local CAPTCHA
// @namespace    kyle.mobsteria
// @version      2.3.21
// @description  Automates Mobsteria: rotating crimes (pickpocket, car break-ins, shoplifting, burglary), GTA, heists, gym, jobs, mob bosses, dailies/contracts/syndicate, MOB Pass, organised crime, drug trading runs, drug crafting + smuggling, jail busts and jail-time activities. Adds configurable strategy scheduling, presets, telemetry and diagnostics while preserving the local CAPTCHA solver.
// @match        https://mobsteria.com/*
// @match        https://www.mobsteria.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      ntfy.sh
// @connect      api.mobsteria.com
// @updateURL    https://raw.githubusercontent.com/jgibbon1993-design/mobsteria-bot/main/Mobsteria_Bot.meta.js
// @downloadURL  https://raw.githubusercontent.com/jgibbon1993-design/mobsteria-bot/main/Mobsteria_Bot.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================
   *  CONFIG + STORAGE
   * ========================================================= */
  const API = 'https://api.mobsteria.com/api';
  const DRUG_LIST = ['Cannabis', 'MDMA', 'LSD', 'Heroin', 'Cocaine', 'Meth'];
  const TRADING_CITIES = [{id:1,name:'Silverton'},{id:2,name:'The Docks'},{id:3,name:'Uptown'},{id:4,name:'Ironworks'},{id:5,name:'The Flats'},{id:6,name:'The Crossing'}];
  const OC_UNFUNDED_EXIT_KEY='mbx_v2313_oc_unfunded_exit';
  const OC_EXCLUDED_ROLES_KEY='mbx_v2313_oc_excluded_roles';
  const BOOT_AT = Date.now();
  const STORE_KEY = 'mbx_settings_v1'; // Preserve existing settings through migration.
  const PRESET_KEY = 'mbx_v22_strategy_presets';
  const MIGRATION_KEY = 'mbx_v22_initialized';
  const TELEMETRY_KEY = 'mbx_v22_telemetry';
  const WORKSHOP_PENDING_KEY = 'mbx_v225_workshop_pending';
  const EMPIRE_PENDING_KEY = 'mbx_v225_empire_pending';
  const MISSION_PENDING_KEY = 'mbx_v225_mission_pending';
  const API_RETRY_UNTIL_KEY = 'mbx_v226_api_retry_until';
  const GARAGE_HOLD_KEY = 'mbx_v231_garage_hold';
  const OC_ACTION_HOLD_KEY = 'mbx_v232_oc_action_hold';
  const OC_HOST_HOLD_KEY = 'mbx_v232_oc_host_hold';
  const OC_CONTRIBUTION_HOLD_KEY = 'mbx_v232_oc_contribution_hold';
  const SMUGGLING_PENDING_KEY = 'mbx_v235_smuggling_pending';
  const SMUGGLING_STATUS_KEY = 'mbx_v237_smuggling_status';
  const EMPIRE_STATUS_KEY = 'mbx_v238_empire_status';
  const CRIME_TURN_KEY = 'mbx_v233_crime_next_type';

  const DEFAULTS = {
    running: false,
    modules: {
      crimes: true,
      gta: true,
      heists: true,
      gym: true,
      jobs: true,
      dailies: true,
      missions: true,
      empire: true,
      workshop: true,
      smuggling: true,
      garage: true,
      busting: true,
      bosses: true,
      burglary: true,
      jailtime: true,
      mobpass: true,
      trading: true,
      oc: false,
    },
    // Resource use is randomized and rotated; no fixed wait-for-resource thresholds.
    crimes: { keepNerve: 0, breakins: true, mixEnabled: true },
    burglary: { maxJail: 30 },
    jail: {},
    jobs: { joinMultiplayer: true, waitForPending: true, keepDailyAttempts: 0 },
    bosses: { solo: true, world: true },
    empire: { collectVisible: true, navigateToCollect: true, checkMinutes: 15, collectAtPct: 90, collectAny: false },
    // Mission claims are free; changing active missions or starting a challenge is never automatic.
    missions: { claimVisible: true, navigateToCheck: false, checkMinutes: 5 },
    // Drug trading runs: buy where cheap, travel, sell where dear. Also sells crafted drugs at the best market.
    // Default paired route: A Silverton, B The Docks; saved custom routes remain unchanged.
    trading: { cityA:1, cityB:2, loopTravel:true, minProfitPct: 0, minNetProfit: 1, keepCash: 0, maxRisk: 20, sellCrafted: true, sellInventory: true },
    // Organised crime: join public OCs (and accept invites) in your preferred roles
    oc: { roles: [4, 2, 3, 5], acceptInvites: true, travel: false, contribute: true,
      // Join a suitable public OC first. If none exists, only prepare/host
      // a PUBLIC five-human-seat lobby using verified visible form controls.
      hostPublicFive: true, hostOperation: 'Sporting Goods Robbery',
      preferredOperations: ['Import Dock Raid', 'Sporting Goods Robbery', 'Casino Robbery'],
      startWhenReady: true },
    gta: { mode: 'mastery' },          // 'mastery' = push unlock of next job, 'best' = best success
    heists: { keepWit: 0 }, // effective OC reserve is configured in scheduler.witReserve
    gym: { stat: 'auto' }, // auto = lowest stat
    // Drugs are a fallback when no affordable item craft is ready.
    drugs: ['Heroin'],
    workshop: { useEnhancer: false, rotate: 0, itemsFirst: true,
      drugsFallback: true, navigateToItems: true, maxItemCost: 25000, keepCash: 50000 },
    smuggling: { minLoad: 20, autoTravelToComplete: false, minExpectedProfit: 1, keepCash: 50000, checkMinutes: 5, allowedDrugs: [...DRUG_LIST] },
    // Garage uses visible game controls only: no guessed garage endpoints.
    // Keep 60+ base cargo cars for smuggling. Never unlock cars automatically.
    garage: { minBaseCapacity: 60, checkMinutes: 45, maxCrushTotalFee: 100000,
      protect: true, crushLocal: true, repair: true, upgradeCapacity: true, shipAfterCrushToA: true,
      navigateToGarage: true, maxRepairCost: 25000,
      maxCapacityUpgradeCost: 25000, keepCash: 50000 },
    busting: { alwaysCrew: true, maxPerMinute: 4 },
    delays: { min: 2500, max: 6000 },
    // Pace site requests and obey server retry instructions. This does not disguise browser events.
    pacing: { requestGapMs: 450 },
    // These strategies change the ORDER in which existing action modules are checked,
    // not their game mechanics. No unverified game rewards are assumed.
    scheduler: {
      // Random resource trigger is a fresh % of its normal cap after a spend.
      resourceMinPct: 10, // legacy / energy-only trigger when batch resource mode is enabled
      resourceMaxPct: 45,
      batchMin: 1,
      batchMax: 5,
      // Batch nerve/focus when high, then continue draining towards a low level.
      // Preserve OC resources: heists do not spend the last 35 wit by default.
      batchResources: true,
      nerveStartPct: 90,
      nerveStopPct: 10,
      focusStartPct: 90,
      focusStopPct: 10,
      witStartPct: 80,
      witReserve: 35,
      alternateResources: false,
      mode: 'balanced', // balanced | xp | money | progression | custom
      singleTab: true, // Prevent duplicate action loops in the same browser profile
      emptyBackoffMs: 5000,
      idleCadenceSeconds: 1800, // 30-minute ceiling; earlier resource/module deadlines still win.
      errorBackoffMs: 30000,
      maxErrorBackoffMs: 180000,
      customOrder: [],
    },
    ntfyTopic: '',
    followPage: true,       // switch the game to the page of whatever the bot just did
    closePopups: true,      // close achievement / reward pop-ups (never challenges)
    challengeAssist: true,  // show the recognised challenge type
    autoSolveChallenges: true, // local image recognition + selection + Verify (manual fallback)
    stuckReloadMins: 10,    // refresh the page if the bot makes no progress for this long (0 = off)
    autoReloadMins: 0,      // no background refresh by default; opt-in under Advanced.
    panel: { x: 16, y: 80, min: false, tab: 'home' },
  };

  function deepMerge(base, over) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const k in over) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') {
        out[k] = deepMerge(base[k], over[k]);
      } else out[k] = over[k];
    }
    return out;
  }

  let S = deepMerge(DEFAULTS, safeParse(GM_getValue(STORE_KEY, '{}')) || {});
  function removeLegacySuccessLimits() {
    for (const key of ['crimes','burglary','jail','heists','busting']) {
      if (S[key] && typeof S[key] === 'object') { delete S[key].minSuccess; delete S[key].minChance; }
    }
  }
  function removeFixedWaitLimits() {
    delete S.crimes.minNerve;
    delete S.gta.minFocus;
    delete S.heists.minWit;
    delete S.gym.minEnergy;
  }
  removeFixedWaitLimits();
  // One-time migration for earlier installs where resource rotation was ON
  // by default. Leave manually configured Custom priority lists untouched.
  if (!GM_getValue('mbx_v2316_order_migrated', false)) {
    if (S.scheduler && S.scheduler.mode !== 'custom') S.scheduler.alternateResources = false;
    GM_setValue('mbx_v2316_order_migrated', true);
  }
  if (!S.scheduler || !['balanced', 'xp', 'money', 'progression', 'custom'].includes(S.scheduler.mode)) {
    S.scheduler = deepMerge(DEFAULTS.scheduler, S.scheduler || {});
    S.scheduler.mode = 'balanced';
  }
  // A major upgrade is first installed PAUSED to avoid overlapping with an old script.
  if (!GM_getValue(MIGRATION_KEY, false)) {
    S.running = false;
    GM_setValue(STORE_KEY, JSON.stringify(S));
    GM_setValue(MIGRATION_KEY, true);
  }
  // Clamp settings that would otherwise cause an endless tight loop.
  S.scheduler.emptyBackoffMs = Math.max(1000, Math.min(60000, Number(S.scheduler.emptyBackoffMs) || 5000));
  S.scheduler.errorBackoffMs = Math.max(5000, Math.min(300000, Number(S.scheduler.errorBackoffMs) || 30000));
  S.scheduler.maxErrorBackoffMs = Math.max(S.scheduler.errorBackoffMs, Math.min(900000, Number(S.scheduler.maxErrorBackoffMs) || 180000));
  function normaliseResourceSettings() {
    const s = S.scheduler;
    const pct = (value, def) => Number.isFinite(Number(value)) ? Number(value) : def;
    s.resourceMinPct = Math.max(0, Math.min(95, Math.round(pct(s.resourceMinPct, 10))));
    s.resourceMaxPct = Math.max(s.resourceMinPct, Math.min(100, Math.round(pct(s.resourceMaxPct, 45))));
    s.batchMin = Math.max(1, Math.min(20, Math.round(pct(s.batchMin, 1))));
    s.batchMax = Math.max(s.batchMin, Math.min(20, Math.round(pct(s.batchMax, 5))));
    s.batchResources = s.batchResources !== false;
    for (const [start, stop] of [['nerveStartPct','nerveStopPct'],['focusStartPct','focusStopPct']]) {
      s[start] = Math.max(40, Math.min(100, Math.round(pct(s[start], 80))));
      s[stop] = Math.max(0, Math.min(s[start]-5, Math.round(pct(s[stop], 15))));
    }
    s.witStartPct = Math.max(40, Math.min(100, Math.round(pct(s.witStartPct,80))));
    s.witReserve = Math.max(0, Math.min(250, Math.round(pct(s.witReserve,35))));
    s.alternateResources = s.alternateResources !== false;
  }
  normaliseResourceSettings();
  S.scheduler.idleCadenceSeconds = Math.max(20,Math.min(1800,Number(S.scheduler.idleCadenceSeconds)||1800));
  if (!GM_getValue('mbx_v230_ui_initialised',false)) { S.panel.tab='home'; S.running=false; GM_setValue(STORE_KEY,JSON.stringify(S)); GM_setValue('mbx_v230_ui_initialised',true); }
  if (!['home','modules','options','log','strategy','settings','health','advanced'].includes(S.panel.tab))S.panel.tab='home';
  function normalizeResearchOptions() {
    S.empire=deepMerge(DEFAULTS.empire,S.empire||{});
    S.jobs=deepMerge(DEFAULTS.jobs,S.jobs||{});
    S.jobs.keepDailyAttempts=Math.max(0,Math.min(12,Math.round(Number(S.jobs.keepDailyAttempts)||0)));
    S.missions=deepMerge(DEFAULTS.missions,S.missions||{});
    S.pacing=deepMerge(DEFAULTS.pacing,S.pacing||{});
    S.smuggling=deepMerge(DEFAULTS.smuggling,S.smuggling||{});
    S.trading=deepMerge(DEFAULTS.trading,S.trading||{});
    for(const k of ['cityA','cityB']){const id=Number(S.trading[k])||0;S.trading[k]=TRADING_CITIES.some(c=>c.id===id)?id:0;}
    S.trading.loopTravel=S.trading.loopTravel!==false;
    S.trading.minProfitPct=Math.max(0,Math.min(1000,Number(S.trading.minProfitPct)||0));
    S.trading.minNetProfit=Math.max(1,Number(S.trading.minNetProfit)||1);
    S.trading.keepCash=Math.max(0,Number(S.trading.keepCash)||0);
    S.trading.maxRisk=Math.max(0,Math.min(100,Number(S.trading.maxRisk)||0));
    S.trading.sellInventory=S.trading.sellInventory!==false;
    S.empire.checkMinutes=Math.max(2,Math.min(120,Number(S.empire.checkMinutes)||15));
    S.empire.collectAtPct=Math.max(50,Math.min(100,Number(S.empire.collectAtPct)||90));
    S.empire.collectAny=S.empire.collectAny===true;
    S.missions.checkMinutes=Math.max(2,Math.min(120,Number(S.missions.checkMinutes)||5));
    S.pacing.requestGapMs=Math.max(250,Math.min(3000,Number(S.pacing.requestGapMs)||450));
    S.smuggling.minExpectedProfit=Math.max(0,Number(S.smuggling.minExpectedProfit)||0);
    S.smuggling.keepCash=Math.max(0,Number(S.smuggling.keepCash)||0);
    S.smuggling.checkMinutes=Math.max(3,Math.min(60,Number(S.smuggling.checkMinutes)||5));
    if(!Array.isArray(S.smuggling.allowedDrugs)) S.smuggling.allowedDrugs=[...DRUG_LIST];
    S.smuggling.allowedDrugs=S.smuggling.allowedDrugs.filter(n=>DRUG_LIST.includes(n));
    S.workshop=deepMerge(DEFAULTS.workshop,S.workshop||{});
    S.workshop.maxItemCost=Math.max(0,Number(S.workshop.maxItemCost)||0);
    S.workshop.keepCash=Math.max(0,Number(S.workshop.keepCash)||0);
    S.crimes=deepMerge(DEFAULTS.crimes,S.crimes||{});
    S.oc=deepMerge(DEFAULTS.oc,S.oc||{});
    if(!Array.isArray(S.oc.roles))S.oc.roles=[4,2,3,5];
    // Apply the requested order to previously saved bot settings.
    S.oc.preferredOperations=['Import Dock Raid','Sporting Goods Robbery','Casino Robbery'];
    S.garage=deepMerge(DEFAULTS.garage,S.garage||{});
    S.garage.minBaseCapacity=Math.max(1,Math.min(500,Math.round(Number(S.garage.minBaseCapacity)||60)));
    S.garage.checkMinutes=Math.max(10,Math.min(240,Math.round(Number(S.garage.checkMinutes)||45)));
    S.garage.maxCrushTotalFee=Math.max(0,Number(S.garage.maxCrushTotalFee)||0);
    S.garage.maxRepairCost=Math.max(0,Number(S.garage.maxRepairCost)||0);
    S.garage.maxCapacityUpgradeCost=Math.max(0,Number(S.garage.maxCapacityUpgradeCost)||0);
    S.garage.keepCash=Math.max(0,Number(S.garage.keepCash)||0);
  }
  normalizeResearchOptions();
  // Set Silverton / The Docks as defaults for existing accounts where neither
  // side was configured. Never overwrite a user's saved custom city pair.
  if(!GM_getValue('mbx_v2318_pair_defaults_migrated',false)){
    if(!S.trading.cityA && !S.trading.cityB){
      S.trading.cityA=1; // Silverton
      S.trading.cityB=2; // The Docks
      GM_setValue(STORE_KEY,JSON.stringify(S));
    }
    GM_setValue('mbx_v2318_pair_defaults_migrated',true);
  }
  // Explicitly requested Empire collection: older installations had navigation OFF,
  // so the module never reached the Empire page. Migrate once; thereafter the
  // user can turn it off normally in Advanced settings.
  if(!GM_getValue('mbx_v238_empire_navigation_migrated',false)){
    S.empire.navigateToCollect=true;
    S.running=false;
    GM_setValue(STORE_KEY,JSON.stringify(S));
    GM_setValue('mbx_v238_empire_navigation_migrated',true);
  }
  if(!GM_getValue('mbx_v233_crime_workshop_reviewed',false)){
    S.running=false;GM_setValue(STORE_KEY,JSON.stringify(S));
    GM_setValue('mbx_v233_crime_workshop_reviewed',true);
  }
  // The dynamic Supply Lines planner can start lower-capacity vehicles now.
  // First upgrade review prevents a pre-existing running session from paying
  // for a delivery before the owner can inspect reserve/cargo preferences.
  if(!GM_getValue('mbx_v236_smuggling_reviewed',false)){
    S.running=false;GM_setValue(STORE_KEY,JSON.stringify(S));
    GM_setValue('mbx_v236_smuggling_reviewed',true);
  }
  if(!GM_getValue('mbx_v239_resource_policy_reviewed',false)){
    S.running=false;GM_setValue(STORE_KEY,JSON.stringify(S));
    GM_setValue('mbx_v239_resource_policy_reviewed',true);
  }
  if(!GM_getValue('mbx_v238_jobs_empire_reviewed',false)){
    S.running=false;GM_setValue(STORE_KEY,JSON.stringify(S));
    GM_setValue('mbx_v238_jobs_empire_reviewed',true);
  }
  // Destructive garage disposal is new in this release. Do not silently
  // continue an older running session until the owner reviews the options.
  if(!GM_getValue('mbx_v231_garage_reviewed',false)){
    S.running=false;
    GM_setValue(STORE_KEY,JSON.stringify(S));
    GM_setValue('mbx_v231_garage_reviewed',true);
  }
  // New release confirms actual, paid crusher transactions. One-time review
  // ensures an existing running installation cannot unexpectedly dispose of cars.
  if(!GM_getValue('mbx_v234_crusher_confirm_reviewed',false)){
    S.running=false;GM_setValue(STORE_KEY,JSON.stringify(S));
    GM_setValue('mbx_v234_crusher_confirm_reviewed',true);
  }
  // Travel trading is now auto and requires a manually selected pair.
  // Review OC exit policy and paid travel settings once before resuming.
  if(!GM_getValue('mbx_v2313_trade_oc_reviewed',false)){
    S.running=false;GM_setValue(STORE_KEY,JSON.stringify(S));
    GM_setValue('mbx_v2313_trade_oc_reviewed',true);
  }
  // Recheck OC options after changing public-lobby policy; only once.
  if(!GM_getValue('mbx_v232_oc_policy_reviewed',false)){
    S.running=false;
    GM_setValue(STORE_KEY,JSON.stringify(S));
    GM_setValue('mbx_v232_oc_policy_reviewed',true);
  }
  // Keep established custom settings. Migrate only the old v2.3.10 defaults
  // so upgrading an existing account actually applies the requested 90/10
  // batch policy and 30-minute idle ceiling.
  if(!GM_getValue('mbx_v2311_resource_idle_migrated',false)){
    const sch=S.scheduler;
    for(const [key,oldValue,newValue] of [
      ['nerveStartPct',80,90],['nerveStopPct',15,10],
      ['focusStartPct',80,90],['focusStopPct',15,10],
      ['idleCadenceSeconds',60,1800]]){
      if(Number(sch[key])===oldValue)sch[key]=newValue;
    }
    normaliseResourceSettings();
    sch.idleCadenceSeconds=Math.max(20,Math.min(1800,Number(sch.idleCadenceSeconds)||1800));
    S.running=false; // Review before resuming paid and destructive modules.
    GM_setValue(STORE_KEY,JSON.stringify(S));
    GM_setValue('mbx_v2311_resource_idle_migrated',true);
  }
  S.delays.min=Math.max(1000,Math.min(60000,Number(S.delays.min)||2500));
  S.delays.max=Math.max(S.delays.min,Math.min(60000,Number(S.delays.max)||6000));
  function save() { GM_setValue(STORE_KEY, JSON.stringify(S)); }
  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

  /* =========================================================
   *  STATE
   * ========================================================= */
  const st = {
    char: null,             // last /character-updates
    lastCharAt: 0,
    paused: null,           // null | { reason, since }
    challenge: false,
    challengeRecoveryReason: '',
    nextAction: 0,
    busy: false,
    lastBusts: [],
    lastWorkshopCheck: 0,
    lastWorkshopItemNav: 0,
    lastWorkshopUiStep: 0,
    lastWorkshopWarning: '',
    lastWorkshopWarningAt: 0,
    workshopPending: null,
    crimeNextType: String(GM_getValue(CRIME_TURN_KEY,'pickpocket')||'pickpocket'),
    lastSmuggleCheck: 0,
    smuggleStatus: String(GM_getValue(SMUGGLING_STATUS_KEY,'Not checked yet')),
    smuggleDiagnostics: '',
    smugglePending: safeParse(GM_getValue(SMUGGLING_PENDING_KEY, 'null')),
    lastGarageCheck: 0,
    lastGarageNav: 0,
    lastGarageMessage: '',
    lastGarageContext: '',
    garageHold: safeParse(GM_getValue(GARAGE_HOLD_KEY, 'null')),
    garageStatus: 'Not checked',
    garageProtected: {},
    lastJobsCheck: 0,
    lastDailiesCheck: 0,
    lastMissionsCheck: 0,
    lastMissionsNav: 0,
    lastMissionSummary: 'Not checked',
    missionPendingAt: 0,
    lastJailCheck: 0,
    lastBossCheck: 0,
    lastPassCheck: 0,
    lastJailActCheck: 0,
    resourceObservations: {},
    resourceRegenPerMin: {},
    lastTradeCheck: 0,
    tradeTravelReadyAt: 0,
    tradeStatus: 'Checking two-city travel cooldown and optional drug cargo',
    tradePending: null,
    ocExcluded: safeParse(GM_getValue(OC_EXCLUDED_ROLES_KEY,'{}'))||{},
    ocExitHold: safeParse(GM_getValue(OC_UNFUNDED_EXIT_KEY,'null')),
    lastOcCheck: 0,
    lastEmpireCheck: 0,
    lastEmpireNav: 0,
    empirePending: 0,
    empireStatus: String(GM_getValue(EMPIRE_STATUS_KEY,'Not checked yet')),
    empireVisitedAt: 0,
    lastSmuggleWarning: '',
    lastSmuggleWarningAt: 0,
    resourceTargets: {}, // Current thresholds / predicted regeneration recheck
    resourceCycles: {nerve:false,focus:false,wit:false}, // Hysteresis: not reset after each action
    nextResource: 'nerve',
    ocStatus: 'Not checked yet',
    ocStatusAt: 0,
    ocPending: safeParse(GM_getValue(OC_CONTRIBUTION_HOLD_KEY,'null')),
    ocSessionReview: null,
    ocPhase: 'idle',
    ocActionHold: safeParse(GM_getValue(OC_ACTION_HOLD_KEY,'null')),
    ocHostHold: safeParse(GM_getValue(OC_HOST_HOLD_KEY,'null')),
    stats: { actions: 0, cash: 0, busts: 0, bustOk: 0, crafts: 0, smuggles: 0, jailed: 0, bossHits: 0, trades: 0, tradeProfit: 0, ocs: 0 },
    log: [],
    moduleHealth: {},
    lastActionModule: '',
    lastActionAt: 0,
    lastHealthyAt: Date.now(),
    lastTickCompleteAt: Date.now(),
    lastNoActionAt: 0,
    watchdogNoticeAt: 0,
    activeModule: '',
    otherTab: false,
  };

  // Persist unsettled requests so a reload does not immediately repeat an
  // enqueue or a collection. Expiry is conservative and never implies success.
  st.workshopPending = safeParse(GM_getValue(WORKSHOP_PENDING_KEY,'null'));
  st.empirePending = Number(GM_getValue(EMPIRE_PENDING_KEY, 0)) || 0;
  st.missionPendingAt = Number(GM_getValue(MISSION_PENDING_KEY, 0)) || 0;

  /* =========================================================
   *  HELPERS
   * ========================================================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
  const num = (v) => Number(v) || 0;
  const now = () => Date.now();
  // Per-browser-profile lease: shared between tabs of the same origin, not
  // separate Firefox profiles or containers. Other tabs stand by.
  const LEASE_KEY = 'mbx_v22_active_lease';
  const TAB_ID = (() => {
    try {
      const previous = sessionStorage.getItem('mbx_v22_tab_id');
      if (previous) return previous;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem('mbx_v22_tab_id', id);
      return id;
    } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  })();
  function ownLease() {
    if (!S.scheduler.singleTab) return true;
    try {
      const lock = safeParse(localStorage.getItem(LEASE_KEY));
      return lock?.id === TAB_ID && Number(lock?.expires || 0) > now();
    } catch { return true; }
  }
  function canRunTab() {
    if (!S.scheduler.singleTab) return true;
    try {
      const lock = safeParse(localStorage.getItem(LEASE_KEY));
      if (lock && lock.id !== TAB_ID && Number(lock.expires || 0) > now()) return false;
      localStorage.setItem(LEASE_KEY, JSON.stringify({id:TAB_ID, expires:now()+12000}));
      return ownLease();
    } catch { return true; } // Browser storage unavailable: preserve legacy behaviour.
  }
  function releaseLease() {
    if (!S.scheduler.singleTab) return;
    try { if (ownLease()) localStorage.removeItem(LEASE_KEY); } catch {/* no storage */}
  }
  setInterval(() => { if (S.running && ownLease()) canRunTab(); }, 4000);
  window.addEventListener('pagehide', releaseLease);

  function storedTelemetry() {
    const data = safeParse(GM_getValue(TELEMETRY_KEY, '{}')) || {};
    return data && typeof data === 'object' ? data : {};
  }
  const history = storedTelemetry();
  if (history.stats && typeof history.stats === 'object') {
    for (const k of Object.keys(st.stats)) {
      const v = Number(history.stats[k]);
      if (Number.isFinite(v) && v >= 0) st.stats[k] = v;
    }
  }
  const savedModuleHealth = history.modules || {};
  const metric = (key) => {
    if (!st.moduleHealth[key]) {
      const prev = savedModuleHealth[key] || {};
      st.moduleHealth[key] = {
        checks: Number(prev.checks) || 0,
        actions: Number(prev.actions) || 0,
        errors: Number(prev.errors) || 0,
        lastSuccess: Number(prev.lastSuccess) || 0,
        lastError: String(prev.lastError || '').slice(0, 180),
        lastErrorAt: Number(prev.lastErrorAt) || 0,
        totalMs: Number(prev.totalMs) || 0,
        nextAllowed: 0, consecutiveErrors: 0,
        lastCheckAt: 0, // Runtime fairness: an uninspected activity cannot be starved.
      };
    }
    return st.moduleHealth[key];
  };
  let telemetryDirty = false;
  function persistTelemetry() {
    if (!telemetryDirty) return;
    const modules = {};
    for (const [key, m] of Object.entries(st.moduleHealth)) {
      modules[key] = {
        checks: m.checks, actions: m.actions, errors: m.errors,
        lastSuccess: m.lastSuccess, lastError: m.lastError,
        lastErrorAt: m.lastErrorAt, totalMs: m.totalMs,
      };
    }
    GM_setValue(TELEMETRY_KEY, JSON.stringify({ stats: st.stats, modules, savedAt: now() }));
    telemetryDirty = false;
  }
  setInterval(persistTelemetry, 30000);
  window.addEventListener('pagehide', persistTelemetry);
  // A module without an available action should not repeatedly query its page.
  // Checks for passive systems are deliberately infrequent; a successful action
  // still permits the next eligible module to run immediately.
  const PASSIVE_MIN_CHECK_MS = {
    dailies: 180000, missions: 180000, empire: 180000, mobpass: 300000,
    bosses: 180000, oc: 90000, smuggling: 180000, garage: 180000, trading: 120000,
    workshop: 180000, jobs: 180000, busting: 120000, jailtime: 30000,
  };
  function resourceRecheckMs(key) {
    const resource=MODULE_RESOURCE[key];
    if (!resource || !st.char) return 60000;
    const observed=st.char.resources?.[resource]||{};
    const current=Number(observed.current), cap=Number(observed.max);
    const cycle=st.resourceCycles?.[resource];
    const stop=resourceFloor(resource);
    const target=S.scheduler.batchResources && ['nerve','focus','wit'].includes(resource)
      ? (Number.isFinite(cap) && cap>0 ? Math.ceil(cap*resourceStartPct(resource)/100) : current)
      : st.resourceTargets[resource]?.target;
    if (!Number.isFinite(current) || !Number.isFinite(cap) || cap<=0 || !Number.isFinite(target)) return 60000;
    if ((cycle && current>stop) || current>=target || ((!S.scheduler.batchResources || !['nerve','focus','wit'].includes(resource)) && current>=cap*.85)) return 30000;
    const rate=st.resourceRegenPerMin[resource] || resourceReportedRegen(observed) || 1;
    const remaining=Math.max(0,target-current);
    // Sleep close to the predicted high-water time, not an arbitrary three
    // minutes. Capped at 30 minutes so rate changes are eventually rechecked.
    return Math.max(30000,Math.min(1800000,remaining/Math.max(.1,rate)*60000*.90));
  }
  function idleModuleDelay(key) {
    // Three-minute OC actions need quick, *state-aware* checks. Ordinary
    // public lobby waiting still backs off, and no tight polling is done.
    if(key==='oc' && st.ocPhase==='active') return 5000;
    if(key==='oc' && st.ocPhase==='planning') return 45000;
    if(key==='empire')return Math.max(120000,Number(S.empire.checkMinutes||15)*60000);
    if(key==='trading'){
      if(tradePlan()||tradePending()||tradeTravelPending())return 25000;
      if(tradingPair() && S.trading.loopTravel){
        const remaining=st.tradeTravelReadyAt-now();
        return remaining>0?Math.max(10000,Math.min(180000,remaining+1000)):25000;
      }
    }
    if (MODULE_RESOURCE[key]) return resourceRecheckMs(key);
    return PASSIVE_MIN_CHECK_MS[key]||120000;
  }
  function observeModule(key, event, elapsedMs, error) {
    const m = metric(key);
    m.lastCheckAt = now();
    m.checks += 1;
    m.totalMs += Math.max(0, Math.round(elapsedMs || 0));
    if (event === 'action') {
      m.actions += 1;
      m.lastSuccess = now();
      m.consecutiveErrors = 0;
      m.nextAllowed = 0;
      st.lastActionModule = key;
      st.lastActionAt = now();
      st.lastProgress = now();
    } else if (event === 'error') {
      m.errors += 1;
      m.consecutiveErrors += 1;
      m.lastErrorAt = now();
      m.lastError = String(error?.message || error || 'Unknown').slice(0, 180);
      const base = Number(S.scheduler.errorBackoffMs) || 30000;
      const cap = Number(S.scheduler.maxErrorBackoffMs) || 180000;
      m.nextAllowed = now() + Math.min(cap, base * Math.pow(2, Math.min(m.consecutiveErrors - 1, 6)));
    } else {
      m.consecutiveErrors = 0;
      m.nextAllowed = now() + Math.max(Number(S.scheduler.emptyBackoffMs)||5000, idleModuleDelay(key));
    }
    telemetryDirty = true;
  }

  function token() {
    const raw = safeParse(localStorage.getItem('auth-storage'));
    return raw?.state?.token || null;
  }

  // Honest action metadata: the same shape the game sends, but with no fake click position.
  function meta() {
    return { t: Date.now(), c: null, d: { w: window.innerWidth, h: window.innerHeight } };
  }

  class ChallengeError extends Error {}
  class AuthError extends Error {}
  class RateLimitError extends Error {}

  // Request pacing prevents overlapping modules, a background character refresh,
  // and a navigation pass from submitting bursts of API requests. Browser-origin
  // mouse/pointer events remain synthetic; no cursor spoofing or anti-bot bypass.
  let apiSlot = Promise.resolve();
  let lastApiStart = 0;
  let apiHoldUntil = Number(GM_getValue(API_RETRY_UNTIL_KEY,0)) || 0;
  async function paceRequest() {
    if (now() < apiHoldUntil) {
      st.nextAction = Math.max(st.nextAction, apiHoldUntil);
      throw new RateLimitError('Server retry window still active');
    }
    const prior=apiSlot;
    let release;
    apiSlot = new Promise(resolve=>{release=resolve;});
    await prior;
    try {
      const gap = Math.max(250,Math.min(3000,num(S.pacing?.requestGapMs)||450));
      const wait = Math.max(0,lastApiStart+gap-now());
      if (wait) await sleep(wait);
      if (now() < apiHoldUntil) {
        st.nextAction = Math.max(st.nextAction, apiHoldUntil);
        throw new RateLimitError('Server retry window still active');
      }
      lastApiStart=now();
    } finally { release(); }
  }
  function retryDelayMs(header) {
    if (!header) return 60000;
    const text=String(header).trim();
    const sec=/^\d+(?:\.\d+)?$/.test(text)?Number(text):NaN;
    const fromHeader=Number.isFinite(sec)?sec*1000:Date.parse(text)-now();
    return Math.max(60000,Math.min(900000,Number.isFinite(fromHeader)?fromHeader:60000));
  }

  async function api(method, path, body) {
    const tk = token();
    if (!tk) throw new AuthError('Not logged in');
    await paceRequest();
    // Give up on any request that hangs, so the bot can never freeze waiting for one
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + tk,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? `Request timed out (${path})` : `Network error (${path})`);
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (data && data.needsChallenge === true) throw new ChallengeError('Challenge required');
    if (res.status === 401) throw new AuthError('Session expired');
    if (res.status === 429) {
      const delay=retryDelayMs(res.headers?.get?.('Retry-After'));
      apiHoldUntil=now()+delay;
      GM_setValue(API_RETRY_UNTIL_KEY,apiHoldUntil);
      st.nextAction = Math.max(st.nextAction, apiHoldUntil);
      log(`Rate limited: pausing requests for ${Math.ceil(delay/1000)}s`, 'warn');
      throw new RateLimitError('rate limited');
    }
    if (!res.ok) {
      const msg = data?.error || data?.message || 'HTTP ' + res.status;
      const e = new Error(msg);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }
  const GET = (p) => api('GET', p);
  const POST = (p, b) => api('POST', p, b);

  function log(msg, type = 'info') {
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    st.log.unshift({ t, msg, type });
    if (st.log.length > 120) st.log.length = 120;
    renderLog();
  }

  function notify(title, message) {
    if (!S.ntfyTopic) return;
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://ntfy.sh/' + encodeURIComponent(S.ntfyTopic),
      headers: { Title: title, Priority: 'high', Tags: 'rotating_light' },
      data: message,
    });
  }

  function cashFrom(r) {
    if (!r || typeof r !== 'object') return 0;
    const c = r.cash ?? r.money ?? r.cash_reward ?? r.money_reward ?? r.totalMoney ?? r.reward ?? r.cash_earned ?? r.earned ?? r.result?.cash_reward ?? r.result?.cash ?? r.result?.money;
    return typeof c === 'number' ? c : 0;
  }

  /* =========================================================
   *  CHARACTER / STATUS
   * ========================================================= */
  function resourceReportedRegen(resource) {
    // Exposed resource regeneration varies by game version and active buffs.
    // Unknown fields are ignored; positive observed balances are sampled below.
    for (const field of ['regen_per_minute','regenPerMinute','regeneration_per_minute','regenerationPerMinute','regen_rate_per_minute']) {
      const r=Number(resource?.[field]);if(Number.isFinite(r)&&r>0&&r<50)return r;
    }
    return 0;
  }
  function learnResourceRegen(character) {
    const sampleAt=now();
    for (const k of ['nerve','focus','wit','energy']) {
      const item=character?.resources?.[k]||{};
      const current=Number(item.current);
      if(!Number.isFinite(current)) continue;
      const previous=st.resourceObservations[k];
      const elapsed=previous ? (sampleAt-previous.at)/60000 : 0;
      // Only measure *passive* gain between clean observations, not action
      // rewards or refills. Ignore implausible swings and cap overflow.
      if(previous && elapsed>=.35 && elapsed<=12 && previous.actionAt===st.lastActionAt &&
          current>=previous.current && current-previous.current<=elapsed*5 &&
          current<Number(item.max||Infinity)) {
        const seen=(current-previous.current)/elapsed;
        if(seen>.12 && seen<5) {
          st.resourceRegenPerMin[k] = st.resourceRegenPerMin[k] ?
            st.resourceRegenPerMin[k]*.65 + seen*.35 : seen;
        }
      }
      const fromApi=resourceReportedRegen(item);
      if(fromApi)st.resourceRegenPerMin[k]=fromApi;
      st.resourceObservations[k]={current,at:sampleAt,actionAt:st.lastActionAt};
    }
  }
  async function refreshChar(force) {
    if (!force && now() - st.lastCharAt < 45000 && st.char) return st.char;
    const latest = await GET('/character-updates');
    learnResourceRegen(latest);
    st.char = latest;
    // Refreshing live balances also closes a burst when a bar reaches its floor.
    // This must happen even if no action is affordable and the module returns early.
    if (S.scheduler.batchResources) for (const k of ['nerve','focus','wit']) {
      if (num(latest?.resources?.[k]?.current) <= resourceFloor(k)) st.resourceCycles[k]=false;
    }
    st.lastCharAt = now();
    st.lastHealthyAt = now();
    renderStatus();
    return st.char;
  }
  const res = (k) => st.char?.resources?.[k] || {};
  const cur = (k) => num(res(k).current);
  /* V2.3.9: High-water / low-water resource cycles.
   * Nerve and focus wait to regenerate high, then spend down near a low floor.
   * Wit waits high but never spends OC reserve on heists. Energy keeps its
   * original rotating randomized trigger. Reward overflow is never clamped.
   * Cycle state survives module turns but is deliberately reset on reload.
   */
  const RESOURCE_ORDER = ['nerve', 'focus', 'wit', 'energy'];
  const MODULE_RESOURCE = {crimes:'nerve', burglary:'nerve', gta:'focus', heists:'wit', gym:'energy'};
  function resourceStartPct(k) {
    if(k==='nerve')return S.scheduler.nerveStartPct;
    if(k==='focus')return S.scheduler.focusStartPct;
    if(k==='wit')return S.scheduler.witStartPct;
    return S.scheduler.resourceMinPct;
  }
  function resourceFloor(k) {
    if(!S.scheduler.batchResources)return k==='wit' ? Math.max(0,num(S.heists.keepWit)) : 0;
    if(k==='wit')return Math.max(num(S.heists.keepWit),num(S.scheduler.witReserve));
    const cap=num(res(k).max);
    if(k==='nerve')return cap>0 ? Math.floor(cap*S.scheduler.nerveStopPct/100) : num(S.crimes.keepNerve);
    if(k==='focus')return cap>0 ? Math.floor(cap*S.scheduler.focusStopPct/100) : 0;
    return 0;
  }
  function resourceTrigger(k,cost=1) {
    const balance=cur(k),cap=num(res(k).max);
    if(balance<cost)return false;
    if(S.scheduler.batchResources && ['nerve','focus','wit'].includes(k)){
      const floor=Math.max(k==='nerve'?num(S.crimes.keepNerve):0,resourceFloor(k));
      if(balance-floor<cost){ st.resourceCycles[k]=false;return false; }
      if(cap<=0)return true; // Don't freeze on a game response that omits the cap.
      const threshold=Math.ceil(cap*resourceStartPct(k)/100);
      st.resourceTargets[k]={cap,target:threshold,pct:resourceStartPct(k)};
      if(!st.resourceCycles[k]){
        if(balance<threshold)return false;
        st.resourceCycles[k]=true;
        log(`${k.toUpperCase()} burst ready: ${Math.floor(balance)}/${Math.floor(cap)}; stop near ${Math.floor(floor)}`,'info');
      }
      return true;
    }
    if(cap<=0)return true;
    const old=st.resourceTargets[k];
    if(!old || old.cap!==cap){
      const pct=S.scheduler.resourceMinPct+Math.random()*(S.scheduler.resourceMaxPct-S.scheduler.resourceMinPct);
      st.resourceTargets[k]={cap,pct,target:Math.max(cost,Math.ceil(cap*pct/100))};
    }
    return balance>=st.resourceTargets[k].target || balance>=cap*.85;
  }
  function nextResourceTarget(k) {delete st.resourceTargets[k];}
  function randomBatchCount(affordable,balance,cap,cost,resource='') {
    if(affordable<1)return 0;
    if(S.scheduler.batchResources && ['focus','wit','nerve'].includes(resource)){
      // Use the maximum available batch, but never exceed the server's 20 limit.
      // Caller has already subtracted the configured low-water / OC floor.
      return Math.min(20,affordable);
    }
    const s=S.scheduler;
    const sampled=s.batchMin+Math.floor(Math.random()*(s.batchMax-s.batchMin+1));
    const highWater=cap>0&&balance>cap*.85?Math.ceil((balance-cap*.85)/cost):0;
    const limit=Math.min(20,Math.max(s.batchMax,8));
    return Math.max(1,Math.min(affordable,limit,Math.max(sampled,Math.min(8,highWater))));
  }
  function resourceTurnComplete(module) {
    const key=MODULE_RESOURCE[module];
    if(!key)return;
    // Do not reroll a high-water threshold after each action in the same burst.
    if(!(S.scheduler.batchResources && ['nerve','focus','wit'].includes(key)))nextResourceTarget(key);
    const pos=RESOURCE_ORDER.indexOf(key);
    st.nextResource=RESOURCE_ORDER[(pos+1)%RESOURCE_ORDER.length];
  }
  const isJailed = () => !!st.char?.jail?.isInJail;
  const jailLeft = () => num(st.char?.jail?.timeLeft);
  const isHospital = () => num(st.char?.health) <= 0 || st.char?.status === 'hospital';

  /* =========================================================
   *  MODULES
   *  Each returns true if it performed an action this tick.
   * ========================================================= */

  // ---- Daily operations: claim finished objectives and bonuses
  async function doDailies() {
    if (now() - st.lastDailiesCheck < 5 * 60000) return false;
    st.lastDailiesCheck = now();
    const ops = await GET('/operations');
    for (const tierKey of Object.keys(ops || {})) {
      const tier = ops[tierKey];
      if (!tier || !Array.isArray(tier.objectives)) continue;
      for (const o of tier.objectives) {
        if (o.claimable && !o.claimed) {
          await POST(`/operations/objectives/${o.id}/claim`);
          log(`Claimed daily: ${o.name}`, 'good');
          st.lastDailiesCheck=0;
          return true;
        }
      }
      if (tier.bonus && tier.bonus.claimable && !tier.bonus.claimed) {
        await POST(`/operations/${tier.tier || tierKey}/claim-bonus`);
        log(`Claimed ${tierKey} completion bonus`, 'good');
        st.lastDailiesCheck=0;
        return true;
      }
    }
    return false;
  }

  /* V2.2.5: Mission observer + free reward claims. The game has story and
   * challenge states under /game/missions. We deliberately do NOT start,
   * cancel, switch missions, bust NPCs or click Go: requirements, risk and
   * the correct target must be established from live page data first.
   */
  async function doMissions() {
    if (!S.missions?.claimVisible || now()-st.lastMissionsCheck<30000) return false;
    st.lastMissionsCheck=now();
    const cadence=Math.max(2,Math.min(120,num(S.missions.checkMinutes)||5))*60000;
    if (!/^\/game\/missions(?:\/|$)/.test(location.pathname)) {
      if (!S.missions.navigateToCheck || now()-st.lastMissionsNav<cadence) return false;
      const links=[...document.querySelectorAll('nav a,nav button,aside a,aside button,.shell-cols-nav a,.shell-cols-nav button')];
      const link=links.find(x=>!x.closest('#mbx') && /^missions$/i.test((x.textContent||'').trim()) && !x.disabled);
      if (!link) return false;
      st.lastMissionsNav=now();st.lastMissionsCheck=0;link.click();
      log('Missions: navigated to inspect claimable rewards','info');return true;
    }
    const page=document.querySelector('main')||document.querySelector('[data-tour="page-content"]')||document.body;
    const full=(page.textContent||'').replace(/\s+/g,' ');
    const status=/\bactive mission\b/i.test(full)?'Active mission visible'
      :/\bmission complete\b|\bcompleted mission\b/i.test(full)?'Completed mission visible'
      :/\bavailable\b/i.test(full)?'Available missions visible':'Mission page loaded';
    if(status!==st.lastMissionSummary){st.lastMissionSummary=status;log(`Missions: ${status}`,'info');}
    if(st.missionPendingAt && now()-st.missionPendingAt<90000) return false;
    // Only explicit free Claim controls on the *Missions* page. Ignore generic
    // Continue, Go, Start, Cancel, Retry and any premium/points action.
    const button=[...page.querySelectorAll('button,[role="button"]')].find(x=>
      !x.closest('#mbx') && /^claim(?:\s+(?:mission|reward|rewards))?$/i.test((x.textContent||'').trim()) &&
      !x.disabled && x.getAttribute('aria-disabled')!=='true' && x.getBoundingClientRect().width>0);
    if(!button) return false;
    st.missionPendingAt=now();GM_setValue(MISSION_PENDING_KEY,st.missionPendingAt);button.click();await sleep(850);
    const stillPresent=button.isConnected && !button.disabled && button.getAttribute('aria-disabled')!=='true';
    log(stillPresent?'Missions: claim clicked, awaiting confirmation (no immediate retry)'
      :'Missions: claim control cleared after click; reward must be reconciled',stillPresent?'warn':'good');
    st.lastMissionsCheck=now()+cadence-30000;
    return true;
  }

  /* V2.3.9: direct Empire collection is verified by the latest manual HAR:
   * GET /empire + /empire/businesses, then POST /empire/collect-all.
   * Require positive waiting cash before sending the POST. Trust returned
   * collected {cash,xp,cars,items,resources,sources}; don't infer loot from
   * a cash delta while other modules may be spending/earning simultaneously.
   */
  function empireNote(message,type='info') {
    st.empireStatus=String(message).slice(0,240);
    GM_setValue(EMPIRE_STATUS_KEY,st.empireStatus);
    if(type!=='silent')log('Empire: '+st.empireStatus,type);
    renderStatus();
  }
  async function doEmpire() {
    const cadence=Math.max(2,Math.min(120,num(S.empire.checkMinutes)||15))*60000;
    if(!S.empire.collectVisible || now()-st.lastEmpireCheck<cadence)return false;
    if(st.empirePending && now()-st.empirePending<120000){
      empireNote('Previous collection awaiting reconciliation; no duplicate POST','silent');return false;
    }
    st.lastEmpireCheck=now();
    let empire,businesses;
    try {
      [empire,businesses]=await Promise.all([GET('/empire'),GET('/empire/businesses')]);
    } catch(e) {
      empireNote('Empire data unavailable: '+String(e.message||e).slice(0,90),'warn');return false;
    }
    if(!Array.isArray(empire?.operations) || !Array.isArray(businesses?.businesses)){
      empireNote('Empire response incomplete; no collection sent','warn');return false;
    }
    const opWaiting=empire.operations.reduce((n,o)=>n+Math.max(0,num(o.cash_waiting)),0);
    const tills=businesses.businesses.reduce((n,b)=>n+Math.max(0,num(b.till)),0);
    const pending=opWaiting+tills;
    const threshold=S.empire.collectAtPct;
    // Operations and businesses have separate cap clocks. Premium operations
    // can report a 12h window, while others can fill in 8h; business tills
    // expose a per-business cap and typically fill in 12h. Use the GAME'S
    // current progress, not elapsed wall-clock time since our last POST.
    const operationState=empire.operations.map(o=>({
      percent:o.full===true?100:
        Number.isFinite(Number(o.progress))?Math.max(0,Math.min(100,Number(o.progress))):
        (num(o.window_hours)>0?Math.min(100,100*num(o.charge_hours)/num(o.window_hours)):0),
      active:o.active===true,
      waiting:Math.max(0,num(o.cash_waiting)),
      full:o.full===true,
    }));
    const businessState=businesses.businesses.filter(b=>b.owned===true).map(b=>({
      percent:num(b.till_cap)>0?Math.max(0,Math.min(100,100*num(b.till)/num(b.till_cap))):0,
      waiting:Math.max(0,num(b.till)),
    }));
    const maxOpPct=Math.max(0,...operationState.map(o=>o.percent));
    const maxBusinessPct=Math.max(0,...businessState.map(b=>b.percent));
    const oldOperationToCollect=operationState.some(o=>!o.active&&o.waiting>0);
    const nearCap=operationState.some(o=>o.full || (o.active&&o.percent>=threshold)) ||
      businessState.some(b=>b.waiting>0&&b.percent>=threshold);
    if(!nearCap && !oldOperationToCollect && !(S.empire.collectAny && pending>0)){
      empireNote(`Holding ${money(pending)}; operations ${Math.floor(maxOpPct)}%, tills ${Math.floor(maxBusinessPct)}% full. Auto-collect at ${threshold}%`,'silent');
      return false;
    }
    if(pending<1 && !operationState.some(o=>o.full || (o.active&&o.percent>=threshold))){
      empireNote('No earnings or mature operation rewards reported','silent');return false;
    }
    st.empirePending=now(); GM_setValue(EMPIRE_PENDING_KEY,st.empirePending);
    let result;
    try{result=await POST('/empire/collect-all');}
    catch(e){
      empireNote('Collection request uncertain; waiting before any retry: '+String(e.message||e).slice(0,90),'warn');
      return false;
    }
    const got=result?.collected;
    const cash=Number(got?.cash),xp=Number(got?.xp);
    if(!got || !Number.isFinite(cash) || cash<0 || !Number.isFinite(xp) || xp<0){
      empireNote('Collection reply unconfirmed; not assuming rewards or resubmitting','warn');return false;
    }
    st.empirePending=0;GM_setValue(EMPIRE_PENDING_KEY,0);
    st.lastEmpireCheck=now();
    st.stats.cash+=cash;
    const cars=Array.isArray(got.cars)?got.cars.length:0;
    const items=Array.isArray(got.items)?got.items.length:0;
    const resources=Array.isArray(got.resources)?got.resources.length:0;
    const sources=Array.isArray(got.sources)?got.sources.length:0;
    empireNote(`Confirmed ${money(cash)} + ${xp} XP, ${cars} car rewards, ${items} item entries, ${resources} resource entries across ${sources} sources`,'good');
    st.lastCharAt=0;
    return true;
  }

  /* =========================================================
   *  V2.2.1: Reward-aware selection (no arbitrary success cutoffs)
   *  XP fields are NOT available on every endpoint. Missing XP uses
   *  a conservative success-per-resource heuristic, labelled proxy.
   *  Observed explicit reward XP can improve the choices over time.
   * ========================================================= */
  const REWARD_OBSERVATIONS_KEY = 'mbx_v221_reward_observations';
  let rewardObservations = safeParse(GM_getValue(REWARD_OBSERVATIONS_KEY, '{}')) || {};
  if (typeof rewardObservations !== 'object' || Array.isArray(rewardObservations)) rewardObservations = {};
  function firstNumber(obj, paths) {
    if (!obj || typeof obj !== 'object') return null;
    for (const path of paths) {
      let cur = obj;
      for (const p of path.split('.')) cur = cur && typeof cur === 'object' ? cur[p] : undefined;
      if (cur == null || cur === '' || typeof cur === 'boolean') continue;
      const n = Number(cur);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }
  const XP_FIELDS = [
    'base_exp','base_xp','xp_reward','exp_reward','experience_reward','reward_xp',
    'earned_xp','earned_exp','experience_gained','xp_gained','exp_gained','totalExp',
    'xp_earned','exp_earned','rewards.xp','rewards.exp','rewards.experience',
    'result.xp','result.exp','result.experience','result.rewards.xp',
    'xp','exp','experience'
  ];
  const CASH_FIELDS = [
    'cash','cash_earned','cash_reward','money','money_earned','money_reward',
    'cash_reward_amount','reward_cash','reward_money','rewards.cash','rewards.money',
    'result.cash','result.money','result.cash_reward','result.rewards.cash',
  ];
  function explicitXp(obj) { return firstNumber(obj, XP_FIELDS); }
  function rewardCash(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const bounds = [
      ['cash_min','cash_max'],['min_reward','max_reward'],
      ['reward_min','reward_max'],['min_cash','max_cash'],
      ['cash_reward.0','cash_reward.1']
    ];
    for (const [lo,hi] of bounds) {
      const a = firstNumber(obj,[lo]), b=firstNumber(obj,[hi]);
      if (a != null && b != null) return (a+b)/2;
    }
    return firstNumber(obj,CASH_FIELDS);
  }
  function successProbability(obj) {
    // No fabricated success-percent floor; unknown chance is treated as uncertain.
    const v = firstNumber(obj,['success_rate','success_chance','bust_chance','chance']);
    return v == null ? 0.5 : Math.max(0,Math.min(1,v/100));
  }
  function shopliftingProbability(store) {
    if (firstNumber(store,['success_rate','success_chance'])!=null) return store;
    const heat=firstNumber(store,['heat','current_heat','store_heat']);
    if (heat==null) return store;
    const knots=[[0,80],[20,63],[40,46],[60,29],[80,12],[94,0]];
    const h=Math.max(0,Math.min(100,heat));let estimate=0;
    for(let i=1;i<knots.length;i++)if(h<=knots[i][0]){
      const [x0,y0]=knots[i-1],[x1,y1]=knots[i];
      estimate=y0+(y1-y0)*(h-x0)/(x1-x0);break;
    }
    return {...store,success_rate:estimate,estimated_heat_odds:true};
  }
  function objective() {
    if (S.scheduler.mode === 'money') return 'money';
    if (S.scheduler.mode === 'xp' || S.scheduler.mode === 'progression') return 'xp';
    return S.scheduler.customObjective === 'money' ? 'money' : S.scheduler.customObjective === 'xp' ? 'xp' : 'balanced';
  }
  function observedXp(id) {
    const o = rewardObservations[id];
    return o && o.xpCount > 0 ? o.totalXp/o.xpCount : null;
  }
  function learnReward(id, response, reps=1) {
    // Only use explicit numeric XP from the response, not guessed rank changes.
    // The stored average already includes successes/failures, so no second chance multiplier.
    const xp = explicitXp(response);
    if (!Number.isFinite(xp) || xp < 0) return;
    // A bulk request may abort on arrest or challenge. Requested reps are NOT
    // completed reps, so only learn an average if the server supplies an actual
    // completed/attempted count or a final single-action result.
    let n=1;
    if (reps > 1) {
      const actual=firstNumber(response,['heistsExecuted','crimesExecuted','attempts_completed','completed_attempts','runs_completed','totalHeists','totalGTAs','total_attempts','attempts','runs','result.attempts_completed','result.total_attempts']);
      const final=Boolean(response?.completed===true || response?.finished===true || response?.is_final===true || response?.status==='completed' || response?.result?.is_final===true ||
        response?.heistsExecuted!=null || response?.crimesExecuted!=null);
      if (!final || actual == null || actual < 1 || actual > reps) return;
      n=actual;
    }
    const o=rewardObservations[id] || {totalXp:0,xpCount:0};
    o.totalXp+=xp; o.xpCount+=n; rewardObservations[id]=o;
    // Bound local storage and cap noise from long-running bots.
    if (Object.keys(rewardObservations).length>120) {
      for (const key of Object.keys(rewardObservations).slice(0,30)) delete rewardObservations[key];
    }
    GM_setValue(REWARD_OBSERVATIONS_KEY,JSON.stringify(rewardObservations));
  }
  function choiceRating(entry) {
    const {data,id,cost=1} = entry;
    const chance=successProbability(data);
    const c=Math.max(1,num(cost));
    const offeredXp=explicitXp(data);
    const learnedXp=observedXp(id);
    const xp=offeredXp ?? learnedXp;
    const cash=rewardCash(data);
    const jailRisk=firstNumber(data,['jail_chance','jail_risk']) ?? 0;
    const riskFactor=Math.max(0,1-Math.min(100,Math.max(0,jailRisk))/100);
    const xpPer=xp == null ? null : (offeredXp != null ? chance*offeredXp : learnedXp)*riskFactor/c;
    const cashPer=cash == null ? null : chance*cash*riskFactor/c;
    const fallback=chance*riskFactor/c;
    const aim=objective();
    // On XP: prefer a known XP yield, then measured outcomes, then a disclosed proxy.
    // On Money: prefer known expected cash yield. Risk is limited separately in handlers.
    // Balanced mixes normalized in-module rankings (not dollars and XP as if equal units).
    return {aim,chance,xpPer,cashPer,fallback,knownXp:xp!=null,knownCash:cash!=null};
  }
  function rankChoices(choices) {
    if (!choices.length) return [];
    const rated=choices.map(c=>({...c,rating:choiceRating(c)}));
    const maxXp=Math.max(0,...rated.map(c=>c.rating.xpPer ?? 0));
    const maxCash=Math.max(0,...rated.map(c=>c.rating.cashPer ?? 0));
    const maxProxy=Math.max(.001,...rated.map(c=>c.rating.fallback));
    for (const c of rated) {
      const r=c.rating;
      const xpScore=r.xpPer!=null && maxXp>0 ? r.xpPer/maxXp : r.fallback/maxProxy*0.4;
      const cashScore=r.cashPer!=null && maxCash>0 ? r.cashPer/maxCash : r.fallback/maxProxy*0.35;
      r.score=r.aim==='xp' ? xpScore : r.aim==='money' ? cashScore : 0.6*xpScore+0.4*cashScore;
      // An unspecified success chance is not treated as certain.
      if (r.chance<=0 && (r.xpPer??0)<=0) r.score=-Infinity;
    }
    return rated.sort((a,b)=>b.rating.score-a.rating.score);
  }
  function describeChoice(entry) {
    const r=entry.rating;
    const mode=r.aim;
    if (mode==='money' && r.cashPer!=null) return `expected $${Math.round(r.cashPer)}/resource`;
    if (mode==='xp' && r.xpPer!=null) return `expected ${r.xpPer.toFixed(2)} XP/resource`;
    return 'XP/cash estimate (reward metadata incomplete)';
  }

  // Four-way fair rotation over real crime attempts. No fixed success-percent
  // threshold, and XP / cash scoring still chooses the best target WITHIN a type.
  const CRIME_CYCLE=['pickpocket','car','shoplifting','burglary'];
  function crimeCycle(){
    if(!S.crimes.mixEnabled)return [];
    return CRIME_CYCLE.filter(k=>k==='burglary'?S.modules.burglary:
      S.modules.crimes && (k!=='car'||S.crimes.breakins));
  }
  function preferredCrimeType(){
    const kinds=crimeCycle();
    return kinds.includes(st.crimeNextType)?st.crimeNextType:kinds[0]||'pickpocket';
  }
  function recordCrimeTurn(kind){
    const kinds=crimeCycle();
    if(!kinds.length||!kinds.includes(kind))return;
    st.crimeNextType=kinds[(kinds.indexOf(kind)+1)%kinds.length];
    GM_setValue(CRIME_TURN_KEY,st.crimeNextType);
  }
  function mixedCrimeChoice(ranked){
    if(!S.crimes.mixEnabled)return ranked[0]||null;
    const kinds=crimeCycle(),wanted=preferredCrimeType();
    const start=Math.max(0,kinds.indexOf(wanted));
    for(let i=0;i<kinds.length;i++){
      const kind=kinds[(start+i)%kinds.length];
      if(kind==='burglary')continue;
      const choice=ranked.find(c=>c.kind===kind);
      if(choice)return choice;
    }
    return ranked[0]||null;
  }

  // ---- Crimes (nerve): compare ALL available pickpocket / car / shoplifting choices.
  async function doCrimes() {
    const nerve = cur('nerve');
    const available = nerve - Math.max(num(S.crimes.keepNerve),resourceFloor('nerve'));
    if (available < 1 || !resourceTrigger('nerve', 1)) return false;

    const choices=[];
    // Parallel reads reduce latency without overlapping action POST requests.
    const [pp,bi,sl]=await Promise.all([
      GET('/crimes2/pickpocketing'),
      S.crimes.breakins ? GET('/crimes2/car-breakins') : Promise.resolve(null),
      GET('/crimes2/shoplifting')
    ]);
    for (const t of pp.targets || []) {
      if (num(t.nerve_cost)>available || num(t.time_remaining)<=4 || !t.target_hash) continue;
      choices.push({kind:'pickpocket',id:'pickpocket:'+(t.name||t.target_hash),name:t.name,
        data:t,cost:num(t.nerve_cost),url:`/crimes2/pickpocketing/attempt/${t.target_hash}`});
    }
    let needsCarSearch=false, carSearchCost=0;
    if (S.crimes.breakins && bi) {
      const fresh=!!bi.session && (!bi.session.expires_at || new Date(bi.session.expires_at).getTime()>now()+5000);
      for (const c of (fresh ? bi.session.cars||[] : [])) {
        if (c.broken || num(c.nerve_cost)>available || c.id==null) continue;
        choices.push({kind:'car',id:'car:'+(c.name||c.id),name:c.name||'car',data:c,cost:num(c.nerve_cost),
          url:`/crimes2/car-breakins/attempt/${c.id}`});
      }
      carSearchCost=num(bi.config?.nerve_cost_search)||2;
      needsCarSearch=!(fresh && (bi.session.cars||[]).some(c=>!c.broken)) && available>=carSearchCost+2;
    }
    for (const s of sl.stores||[]) {
      if (s.is_locked || num(s.nerve_cost)>available || s.id==null) continue;
      choices.push({kind:'shoplifting',id:'shoplifting:'+s.id,name:s.name,data:shopliftingProbability(s),cost:num(s.nerve_cost),
        url:`/crimes2/shoplifting/attempt/${s.id}`});
    }

    const ranked=rankChoices(choices);
    // On the car turn, search once if the street needs refreshing.
    if (S.crimes.mixEnabled && preferredCrimeType()==='car' && needsCarSearch && carSearchCost>0) {
      await POST('/crimes2/car-breakins/search');
      recordCrimeTurn('car');
      log('Crime rotation: searched a street for car break-ins','info');
      return true;
    }
    if (ranked.length && Number.isFinite(ranked[0].rating.score)) {
      const c=mixedCrimeChoice(ranked);
      const r=await POST(c.url);
      const result=r?.result||r;
      learnReward(c.id,result);
      st.stats.cash+=cashFrom(result);
      recordCrimeTurn(c.kind);
      log(`Crime ${c.kind}: ${c.name} (${describeChoice(c)}): ${result?.jailed?'jailed':result?.success===false?'failed':'done'}`,
        result?.success===false||result?.jailed?'warn':'good');
      return true;
    }
    if (needsCarSearch && carSearchCost>0) {
      await POST('/crimes2/car-breakins/search');
      recordCrimeTurn('car');
      log('Searched a street for parked cars','info');
      return true;
    }
    return false;
  }

  // ---- GTA (focus): XP/money score, optionally mastery-first in Progression mode.
  async function doGta() {
    const focus = cur('focus');
    if (focus < 1 || !resourceTrigger('focus', 1)) return false;
    const data = await GET('/gtas');
    const list=(data.gtas||[]).filter(g=>g.is_unlocked && num(g.cost)>0 && num(g.cost)<=focus-resourceFloor('focus'));
    if (!list.length) return false;
    const choices=list.map(g=>({kind:'gta',id:'gta:'+g.id,data:g,cost:num(g.cost),name:g.name,url:`/gtas/${g.id}`}));
    const ranked=rankChoices(choices);
    let chosen=ranked[0];
    if (S.scheduler.mode==='progression' && S.gta.mode==='mastery') {
      const unfinished=ranked.filter(c=>!c.data.progress?.is_completed).sort((a,b)=>num(b.data.id)-num(a.data.id));
      if (unfinished.length) chosen=unfinished[0];
    }
    if (!chosen || !Number.isFinite(chosen.rating.score)) return false;
    const pick=chosen.data;
    const reps=randomBatchCount(Math.floor((focus-resourceFloor('focus'))/num(pick.cost)),focus,num(res('focus').max),num(pick.cost),'focus');
    let r;
    if (reps>1) {
      r=await POST(`/gtas/${pick.id}/commit-max`,{reps,_meta:meta()});
      log(`GTA ${pick.name}: ${firstNumber(r,['crimesExecuted','totalGTAs'])??'unknown'} of ${reps} attempts reported${r?.jailed||r?.isJailed?' (jailed early)':''}; ${describeChoice(chosen)}`,'good');
    } else {
      r=await POST(`/gtas/${pick.id}/commit`,{_meta:meta()});
      log(`GTA ${pick.name} (${describeChoice(chosen)}): ${r?.result?.success===false?'failed':'done'}`,'good');
    }
    learnReward(chosen.id,r?.result||r,reps);
    st.stats.cash+=Math.max(0,cashFrom(r));
    return true;
  }

  // ---- Heists (wit): expected XP or cash per wit, with no min-success cutoff.
  async function doHeists() {
    const wit=cur('wit'),keepWit=resourceFloor('wit');
    if (wit-keepWit<1 || !resourceTrigger('wit', 1)) return false;
    const data=await GET('/heists');
    const choices=(data.heists||[])
      .filter(h=>h.is_unlocked && num(h.wit_cost)>0 && num(h.wit_cost)<=wit-keepWit)
      .map(h=>({kind:'heist',id:'heist:'+h.id,data:h,cost:num(h.wit_cost),name:h.name,url:`/heists/${h.id}`}));
    const ranked=rankChoices(choices);
    if (!ranked.length || !Number.isFinite(ranked[0].rating.score)) return false;
    const c=ranked[0], h=c.data;
    const reps=randomBatchCount(Math.floor((wit-keepWit)/num(h.wit_cost)),wit,num(res('wit').max),num(h.wit_cost),'wit');
    let r;
    if (reps>1) {
      r=await POST(`/heists/${h.id}/commit-max`,{reps,_meta:meta()});
      log(`Heist ${h.name}: ${firstNumber(r,['heistsExecuted','totalHeists'])??'unknown'} of ${reps} attempts reported${r?.jailed||r?.isJailed?' (jailed early)':''}; ${describeChoice(c)}`,'good');
    } else {
      r=await POST(`/heists/${h.id}/start`,{_meta:meta()});
      log(`Heist ${h.name} (${describeChoice(c)}): ${r?.result?.success===false?'failed':'done'}`,'good');
    }
    learnReward(c.id,r?.result||r,reps);
    st.stats.cash+=Math.max(0,cashFrom(r));
    return true;
  }

  // ---- Gym (energy)
  async function doGym() {
    const energy = cur('energy');
    if (energy < 1 || !resourceTrigger('energy', 1)) return false;
    const fc = await GET('/fight-club/stats');
    if (fc.gymLockedByJail || fc.hospital?.isInHospital) return false;
    const cost = num(fc.energyCost) || 10;
    const maxAffordable = Math.min(num(fc.maxTrainReps) || 50, Math.floor(Math.min(energy,num(fc.fightStats?.energy ?? energy)) / cost));
    const reps = randomBatchCount(maxAffordable,energy,num(res('energy').max),cost);
    if (reps < 1) return false;
    let stat = S.gym.stat;
    if (stat === 'auto') {
      const fs = fc.fightStats || {};
      const keys = ['strength', 'defence', 'speed', 'endurance', 'stamina', 'health'];
      stat = keys.sort((a, b) => num(fs[a + '_level']) - num(fs[b + '_level']))[0];
    }
    await POST('/fight-club/train', { stat, reps });
    log(`Gym: trained ${stat} x${reps}`, 'good');
    return true;
  }

  // ---- Criminal jobs: the game returns can_perform as an OBJECT, not a bool.
  // Honour the actual missing-items and daily-limit fields. A multiplayer job
  // remains pending until others join; joining does not itself pay its reward.
  function jobEligible(j) {
    const c=j?.can_perform;
    if(!c || typeof c!=='object' || c.can_perform!==true ||
       c.daily_limit_reached===true ||
       (Array.isArray(c.missing_items)&&c.missing_items.length) ||
       (Array.isArray(c.missing_cars)&&c.missing_cars.length))return false;
    if(j.is_multiplayer===true && !S.jobs.joinMultiplayer)return false;
    return j.id!=null && !j.waiting_instance;
  }
  async function doJobs() {
    if(now()-st.lastJobsCheck<3*60000)return false;
    st.lastJobsCheck=now();
    const data=await GET('/jobs');
    const used=Number(data.daily_attempts),max=Number(data.daily_limit);
    if(Number.isFinite(used)&&Number.isFinite(max)&&used>=max-Math.max(0,num(S.jobs.keepDailyAttempts)))return false;
    if(S.jobs.waitForPending && Array.isArray(data.waiting_jobs) && data.waiting_jobs.some(w=>
      w && w.status!=='completed' && w.status!=='cancelled' && w.status!=='expired')){
      return false;
    }
    const list=(data.jobs||[]).filter(jobEligible);
    if(!list.length)return false;
    // Prefer same-day cash/XP reward information when exposed. No invented
    // item sell value, and only one job submitted per pass.
    const score=j=>{
      const rewards=Array.isArray(j.rewards)?j.rewards:[];
      const cash=rewards.filter(r=>/cash|money/i.test(String(r.type||r.name||'')))
        .reduce((n,r)=>n+Math.max(0,num(r.amount??r.quantity??r.value)),0);
      const rank=rewards.filter(r=>/xp|exp|rank/i.test(String(r.type||r.name||'')))
        .reduce((n,r)=>n+Math.max(0,num(r.amount??r.quantity??r.value)),0);
      return (objective()==='money'?cash:rank)*100 + (j.is_multiplayer?0:1);
    };
    list.sort((a,b)=>score(b)-score(a));
    const job=list[0];
    const reply=await POST(`/jobs/${job.id}/attempt`);
    if(reply?.success===false || reply?.result?.success===false){
      log(`Job ${job.name}: server declined attempt`,'warn');return false;
    }
    const kind=String(reply?.result?.type||'');
    log(`Job ${job.name}: ${/waiting|multi/i.test(kind)?'joined; waiting for other player(s), reward not yet earned':'submitted; verify actual reward'}`,'good');
    st.lastJobsCheck=0;
    return true;
  }

  // ---- Workshop: Items first using the verified /lab/craft endpoint;
  // /lab's craftable_items is a keyed object with material requirements.
  // Drug crafting is the fallback if no affordable item fits the queue.
  function workshopItemEligible(item, lab) {
    if (!item || item.locked || item.id==null || !String(item.name||'').trim()) return false;
    const req=item.crafting_requirements;
    if (!Array.isArray(req) || (item.has_requirements && !req.length)) return false;
    if (!req.every(x=>Number.isFinite(Number(x.quantity)) && Number.isFinite(Number(x.have_quantity)) &&
            Number(x.have_quantity)>=Number(x.quantity))) return false;
    const price=Number(item.crafting_cost);
    if (!Number.isFinite(price)||price<0||price>num(S.workshop.maxItemCost)) return false;
    const cash=firstNumber(st.char,['money','character.money']);
    if(cash==null || cash-price<num(S.workshop.keepCash))return false;
    const q=lab.queue||{};
    const remaining=Number(q.max_queue_duration)-Number(q.queue_wait_seconds);
    const duration=Number(item.craft_time);
    return Number.isFinite(remaining)&&Number.isFinite(duration)&&duration>0&&duration<=remaining;
  }
  function workshopItemScore(item) {
    const time=Math.max(1,num(item.craft_time));
    const success=Math.max(0,Math.min(1,num(item.success_chance)/100));
    const exp=Number(item.exp_gained);
    const price=Math.max(0,num(item.crafting_cost));
    const effects=Array.isArray(item.effects)?item.effects:[];
    const cashReward=effects.filter(e=>e.type==='add_cash').reduce((n,e)=>n+num(e.value),0);
    if(objective()==='money' && cashReward>0) return success*(cashReward-price)/time;
    // If no verified sellable value exists, prefer low-cost, faster high-odds
    // crafts rather than inventing an item resale value.
    if(objective()==='money')return success/(time*(1+price/10000));
    return success*(Number.isFinite(exp)?Math.max(0,exp)+0.02:0.02)/time/(1+price/50000);
  }
  function workshopQueueIds(lab) {
    return (lab?.queue?.items||[]).map(x=>String(x.id??'')).filter(Boolean);
  }
  function workshopWarn(message) {
    if(message!==st.lastWorkshopWarning || now()-st.lastWorkshopWarningAt>300000){
      log(`Workshop: ${message}`,'info');st.lastWorkshopWarning=message;st.lastWorkshopWarningAt=now();
    }
  }
  function workshopVisible(el){return !!el?.getClientRects?.().length && !el.closest('#mbx') && !el.disabled && el.getAttribute?.('aria-disabled')!=='true';}
  function workshopTxt(el){return String(el?.innerText||el?.textContent||'').replace(/\s+/g,' ').trim();}
  async function tryWorkshopItemUi(item, beforeLab) {
    if(now()-st.lastWorkshopUiStep<3000)return false;
    if(!/^\/game\/workshop(?:\/|$)/.test(location.pathname)) {
      if(!S.workshop.navigateToItems || now()-st.lastWorkshopItemNav<180000)return false;
      st.lastWorkshopItemNav=now();st.lastWorkshopUiStep=now();
      location.assign('/game/workshop');
      log('Workshop: opening Items to craft affordable items before drugs','info');
      return true;
    }
    const page=document.querySelector('main')||document.querySelector('[data-tour="page-content"]')||document.body;
    if(!page)return false;
    // Only use explicit Items tab; never confuse it with an unrelated
    // Items button in inventory, modal or the bot panel.
    const tabs=[...page.querySelectorAll('button,[role="tab"]')].filter(workshopVisible);
    const itemsTab=tabs.find(x=>/^items(?:\s*\d+)?$/i.test(workshopTxt(x)));
    if(!itemsTab){workshopWarn('Items tab not identified; item crafting held, no drug fallback');return false;}
    const tabActive=itemsTab.getAttribute('aria-selected')==='true' ||
      /(?:^|\s)(active|selected|is-active)(?:\s|$)/i.test(String(itemsTab.className||''));
    const rootDialogs=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],.modal,[class*="modal-content"]')]
      .filter(workshopVisible);
    const modal=rootDialogs.find(x=>workshopTxt(x).includes(item.name));
    if(modal){
      const send=[...modal.querySelectorAll('button,[role="button"]')].filter(workshopVisible)
        .find(b=>/^(?:add(?:\s+to)?\s+queue|craft(?:\s+now)?|make)(?:\s+x?1)?$/i.test(workshopTxt(b)));
      if(!send){workshopWarn(`Item ${item.name}: detail shown but no verified Craft/Add to Queue control`);return false;}
      // Protect against slow or ambiguous responses. Persist the before-queue
      // IDs *before* using the real game's submit control.
      st.workshopPending={at:now(),kind:'item',name:item.name,queuedBefore:workshopQueueIds(beforeLab)};
      GM_setValue(WORKSHOP_PENDING_KEY,JSON.stringify(st.workshopPending));
      st.lastWorkshopUiStep=now();send.click();await sleep(1100);
      try{
        const after=await GET('/lab');
        if(workshopItemEnqueued(st.workshopPending,after)){
          st.stats.crafts++;st.workshopPending=null;GM_setValue(WORKSHOP_PENDING_KEY,'null');
          log(`Workshop: item queued — ${item.name} (output pending history verification)`,'good');
        }else workshopWarn(`Item ${item.name}: queue request unconfirmed; no automatic retry`);
      }catch{workshopWarn(`Item ${item.name}: queue check failed; no automatic retry`);}
      st.lastWorkshopCheck=0;
      return true;
    }
    if(!tabActive){
      st.lastWorkshopUiStep=now();itemsTab.click();st.lastWorkshopCheck=0;
      log('Workshop: switched to Items tab','info');return true;
    }
    // Match a visible item label EXACTLY. Do not choose a generic Craft
    // button, where several item cards share that text.
    const labels=[...page.querySelectorAll('h2,h3,h4,h5,strong,span,p,button,[role="button"]')]
      .filter(workshopVisible).filter(el=>workshopTxt(el)===item.name);
    const label=labels.find(el=>el.closest('article,[role="button"],button,[class*="cursor-pointer"], [class*="card"]'))||labels[0];
    if(!label){workshopWarn(`Item ${item.name}: no exact visible card; skipping until UI is known`);return false;}
    const control=label.closest('button,[role="button"],[class*="cursor-pointer"],article,[class*="card"]')||label;
    if(!workshopVisible(control)){workshopWarn(`Item ${item.name}: card not clickable`);return false;}
    st.lastWorkshopUiStep=now();control.click();st.lastWorkshopCheck=0;
    log(`Workshop: inspecting ${item.name} before queuing`,'info');return true;
  }
  function workshopItemEnqueued(pending, lab){
    if(!pending || pending.kind!=='item')return false;
    const old=new Set((pending.queuedBefore||[]).map(String));
    return (lab?.queue?.items||[]).some(x=>String(x.name||'')===pending.name && x.id!=null && !old.has(String(x.id)));
  }
  async function doWorkshop() {
    if(now()-st.lastWorkshopCheck<20000)return false;
    st.lastWorkshopCheck=now();
    const lab=await GET('/lab');
    const queue=lab.queue||{};
    const pending=st.workshopPending;
    if(pending){
      if(pending.kind==='item' && workshopItemEnqueued(pending,lab)){
        st.stats.crafts++;log(`Workshop: queued item ${pending.name} confirmed after reload`,'good');
        st.workshopPending=null;GM_setValue(WORKSHOP_PENDING_KEY,'null');
      }else{
        const age=now()-num(pending.at);
        // An item queue may finish before the next check. Do not repeat an
        // ambiguous paid craft on a short timeout.
        const hold=pending.kind==='item'?900000:90000;
        if(age>=0 && age<hold)return false;
        st.workshopPending=null;GM_setValue(WORKSHOP_PENDING_KEY,'null');
        workshopWarn(`previous ${pending.kind==='item'?'item':'drug'} enqueue hold expired; outcome unknown`);
      }
    }
    if(S.workshop.itemsFirst){
      const list=Object.values(lab.craftable_items||{}).filter(x=>workshopItemEligible(x,lab))
        .sort((a,b)=>workshopItemScore(b)-workshopItemScore(a));
      if(list.length){
        const item=list[0];
        const before=workshopQueueIds(lab);
        const pending={at:now(),kind:'item',name:item.name,itemId:item.id,queuedBefore:before};
        // The 14 Nov manual HAR verifies POST /lab/craft {item_id,modifiers:[]}.
        // Persist the pending state *before* the purchase-like submission.
        st.workshopPending=pending;
        GM_setValue(WORKSHOP_PENDING_KEY,JSON.stringify(pending));
        let reply;
        try{reply=await POST('/lab/craft',{item_id:item.id,modifiers:[]});}
        catch(e){
          // A timeout can conceal a successful enqueue. Hold and reconcile;
          // never immediately submit a duplicate craft.
          workshopWarn(`${item.name}: item request uncertain; verifying queue before retry`);
          throw e;
        }
        if(reply?.success===false){
          st.workshopPending=null;GM_setValue(WORKSHOP_PENDING_KEY,'null');
          workshopWarn(`${item.name}: game declined the item craft`);return false;
        }
        const newItem=reply?.queue_item;
        const queueAfter=reply?.queue;
        const accepted=reply?.success===true && (
          (newItem && newItem.id!=null && String(newItem.name||item.name)===String(item.name)) ||
          workshopItemEnqueued(pending,{queue:queueAfter})
        );
        if(accepted){
          st.stats.crafts++;
          st.workshopPending=null;GM_setValue(WORKSHOP_PENDING_KEY,'null');
          log(`Workshop: ${item.name} added to queue (finished result pending)`,'good');
        }else workshopWarn(`${item.name}: submission response unverified; no duplicate craft`);
        st.lastWorkshopCheck=0;
        return true;
      }
    }
    if(!S.workshop.drugsFallback || !S.drugs.length)return false;
    const options=(lab.craftable_drugs||[]).filter(d=>S.drugs.includes(d.name)&&!d.locked);
    if(!options.length)return false;
    const drug=options[num(S.workshop.rotate)%options.length];
    S.workshop.rotate=(num(S.workshop.rotate)+1)%1000;save();
    const room=num(queue.max_queue_duration)-num(queue.queue_wait_seconds);
    if(room<num(drug.craft_time))return false;
    if(num(drug.crafting_cost)>num(st.char?.money))return false;
    let enhancer=null;
    if(S.workshop.useEnhancer&&drug.enhancer_tiers?.[0]){
      const e=drug.enhancer_tiers[0];
      const tier=[...(e.tiers||[])].reverse().find(t=>t.can_afford);
      if(tier)enhancer={item_id:e.item_id,quantity:tier.quantity_required};
    }
    st.workshopPending={at:now(),kind:'drug',name:String(drug.name||'craft').slice(0,80)};
    GM_setValue(WORKSHOP_PENDING_KEY,JSON.stringify(st.workshopPending));
    let response;
    try {response=await POST('/lab/craft-drug',{item_id:drug.id,enhancer});}
    catch(e) {
      if(e?.status && e.status>=400 && e.status<500 && e.status!==429){
        st.workshopPending=null;GM_setValue(WORKSHOP_PENDING_KEY,'null');
      }
      throw e;
    }
    if(response?.success===false){
      st.workshopPending=null;GM_setValue(WORKSHOP_PENDING_KEY,'null');
      log(`Workshop: ${drug.name} enqueue rejected; no craft counted`,'warn');return false;
    }
    st.stats.crafts++;
    log(`Workshop: queued fallback drug ${drug.name}${enhancer?' (enhanced)':''}; finished result unconfirmed`,'good');
    st.lastWorkshopCheck=0;
    return true;
  }

  // ---- Garage: conservative, low-frequency local vehicle management.
  // DO NOT invent garage/crusher/repair/upgrade HTTP endpoints. The captured
  // game materials expose the visible Lock button but no verified API payloads.
  // Bulk crushing requires every locally eligible car to be accounted for.
  function garageText(el) { return String(el?.innerText||el?.textContent||'').replace(/\s+/g,' ').trim(); }
  function garageVisible(el) { return !!el?.getClientRects?.().length && !el.closest('#mbx') && !el.disabled; }
  function garageCapacity(raw) {
    const t=String(raw||'');
    const patterns=[/(?:base|original)\s+(?:cargo\s+)?capacity\s*[:\-]?\s*(\d{1,4})\b/i,
      /(?:cargo|drug)\s+capacity\s*[:\-]?\s*(\d{1,4})\b/i,
      /\bcapacity\s*[:\-]?\s*(\d{1,4})\b/i,
      /\b(?:cargo|load)\s*[:\-]?\s*(\d{1,4})\b/i,
      /\b(?:cargo|load)\s*[:\-]?\s*(\d{1,4})\s*(?:units|slots)\b/i,
      /\b(\d{1,4})\s*(?:cargo\s*capacity|cargo\s*slots)\b/i];
    for(const re of patterns){const m=t.match(re);if(m)return Number(m[1]);}
    return null;
  }
  function garageCurrentDistrict() {
    const obj=st.char?.location ?? st.char?.district ?? st.char?.current_location;
    return String((typeof obj==='object'?obj?.name:obj)||'').trim().toLowerCase()
      .replace(/^the\s+/, '');
  }
  function garageLocation(t) {
    const m=String(t||'').match(/\b(The Docks|Docks|Silverton|Uptown|Ironworks)\b/i);
    return m?m[1].toLowerCase().replace(/^the\s+/,''):null;
  }
  function garageParentOfLock(b) {
    // Only accept a compact row with exactly one car's lock control. This
    // avoids interpreting the garage-wide total (e.g. 16/60) as car cargo.
    for(let p=b.parentElement,depth=0;p&&depth<9;p=p.parentElement,depth++){
      const buttons=p.querySelectorAll('button[aria-label="Lock this car"],button[aria-label="Unlock this car"]');
      if(buttons.length!==1)continue;
      const t=garageText(p);
      if(t.length>1100)break;
      if(garageCapacity(t)!=null)return p;
    }
    return null;
  }
  function garageRows() {
    return [...document.querySelectorAll('button[aria-label="Lock this car"],button[aria-label="Unlock this car"]')]
      .filter(garageVisible).map(button=>{
        const row=garageParentOfLock(button);
        if(!row)return {button,known:false};
        const text=garageText(row);
        const base=garageCapacity(text);
        const pressed=button.getAttribute('aria-pressed');
        const locked=pressed==='true'||/^Unlock this car$/i.test(button.getAttribute('aria-label')||'');
        return {button,row,text,base,locked,known:base!=null,city:garageLocation(text),
          busy:/\b(?:in transit|in use|assigned|reserved|in an? oc|smuggling active)\b/i.test(text),
          upgraded:/\b(?:upgraded|upgrades?\s*[1-9]|level\s*[1-9]\s*\/?\s*5)\b/i.test(text)};
      });
  }
  function garageWarn(message) {
    if(st.lastGarageMessage!==message){st.lastGarageMessage=message;log('Garage: '+message,'info');}
    st.garageStatus=message;
  }
  function garageHold(kind,tag,extra={}) {
    const val={kind,tag:String(tag||'').slice(0,120),at:now(),...extra};
    st.garageHold=val;GM_setValue(GARAGE_HOLD_KEY,JSON.stringify(val));
  }
  function garageHoldActive(){
    const hold=st.garageHold;
    if(!hold)return false;
    // A bulk crush or paid repair/upgrade must not be repeated blindly after
    // refresh or a network delay. Let the user inspect ambiguous results.
    const ms=['crush','repair','upgrade','ship'].includes(hold.kind)?10*60000:60000;
    if(now()-num(hold.at)<ms)return true;
    st.garageHold=null;GM_setValue(GARAGE_HOLD_KEY,'null');return false;
  }
  // The garage's "Crush All" button ONLY opens a confirmation dialog.
  // Validate the real modal before completing the irreversible paid action.
  function garageBulkCrushModal() {
    for(const button of [...document.querySelectorAll('button')].filter(garageVisible)) {
      const match=garageText(button).match(/^crush\s+(\d+)\s+cars?$/i);
      if(!match)continue;
      let dialog=button.closest('[role="dialog"],[aria-modal="true"]');
      if(!dialog) {
        // The game may use a plain div modal rather than role=dialog.
        for(let p=button.parentElement;p&&p!==document.body;p=p.parentElement){
          const txt=garageText(p);
          if(txt.length>1400)break;
          if(/crush every car here\?/i.test(txt) &&
             [...p.querySelectorAll('button')].some(b=>/^keep them$/i.test(garageText(b)))){
            dialog=p;break;
          }
        }
      }
      if(!dialog || !/crush every car here\?/i.test(garageText(dialog)))continue;
      const t=garageText(dialog);
      const city=t.match(/queues? every unlocked car at\s+(The Docks|Docks|Silverton|Uptown|Ironworks)\b/i);
      const summary=t.match(/\bCARS\s*(\d+)\b/i);
      const fee=t.match(/\bCRUSHER\s+FEE\b[^$]{0,70}\$\s*([\d,]+)\b/i);
      const cancel=[...dialog.querySelectorAll('button')].find(b=>/^keep them$/i.test(garageText(b)));
      // Require both the warning and an explicit decline control. Do not
      // guess values if the game's confirmation screen has changed.
      if(!city||!summary||!fee||!cancel||!/locked cars are never touched/i.test(t))continue;
      return {button,dialog,city:city[1].toLowerCase().replace(/^the\s+/,''),
        buttonCount:Number(match[1]),summaryCount:Number(summary[1]),
        fee:Number(fee[1].replace(/,/g,'')),cancel};
    }
    return null;
  }
  function garageBulkPageSafe(expectedCity,expectedCount,threshold) {
    const rows=garageRows();
    if(!rows.length||rows.some(x=>!x.known)||garageCurrentDistrict()!==expectedCity)return false;
    const local=rows.filter(x=>x.city===expectedCity);
    if(local.length===0)return false;
    const eligible=local.filter(x=>!x.locked&&!x.busy&&!x.upgraded&&x.base<threshold);
    if(eligible.length!==expectedCount || !local.every(x=>x.locked||eligible.includes(x)))return false;
    const page=(garageText(document.body).match(/\bpage\s+\d+\s*(?:of|\/)\s*(\d+)\b/i)||[])[1];
    if(Number(page)>1)return false;
    // Critical: the confirmation applies to ALL unlocked cars in this city,
    // including ones hidden by a search or filter.
    if([...document.querySelectorAll('input,select')]
      .filter(el=>!el.closest('#mbx')&&!el.disabled)
      .some(el=>{
        const label=String([el.getAttribute('placeholder'),el.getAttribute('aria-label'),
          el.getAttribute('name'),el.id].join(' ')).toLowerCase();
        if(!/(?:search|filter|model|car name|vehicle name)/.test(label))return false;
        return el.tagName==='SELECT'
          ? (!!el.value&&!/^(?:all|any|none)$/i.test(el.value))
          : String(el.value||'').trim().length>0;
      }))return false;
    return true;
  }
  function garageConfirmBulkCrush() {
    const hold=st.garageHold;
    if(hold?.kind!=='crush'||hold.phase!=='confirm'||hold.type!=='bulk')return 'not-pending';
    const modal=garageBulkCrushModal();
    if(!modal)return 'not-visible';
    const fresh=now()-num(hold.at)<=120000;
    const verified=fresh&&S.running&&S.modules.garage&&S.garage.crushLocal&&
      Number.isInteger(hold.count)&&hold.count>0&&
      hold.threshold===S.garage.minBaseCapacity&&
      hold.district===modal.city&&hold.district===garageCurrentDistrict()&&
      modal.buttonCount===hold.count&&modal.summaryCount===hold.count&&
      Number.isFinite(modal.fee)&&modal.fee>=0&&
      garageCashAllows(modal.fee,S.garage.maxCrushTotalFee)&&
      garageBulkPageSafe(hold.district,hold.count,hold.threshold);
    if(!verified){
      // The wrong count, city, fee or visibility is not safe to confirm.
      // Cancel only THIS known crush dialog, never an unrelated window.
      modal.cancel.click();
      garageHold('crush',hold.tag,{...hold,phase:'blocked',reason:'modal safety mismatch',at:now()});
      garageWarn('Cancelled crush confirmation: city, count, garage rows, or fee failed safety checks');
      return 'blocked';
    }
    // Record BEFORE submission so a reload or uncertain server response can
    // never cause an immediate duplicate paid crush.
    garageHold('crush',hold.tag,{...hold,phase:'submitted',fee:modal.fee,at:now()});
    modal.button.click();
    garageWarn('Confirmed crushing '+hold.count+' local low-capacity cars for $'+modal.fee.toLocaleString()+'; waiting for crusher queue/result');
    return 'submitted';
  }
  async function garageFinishBulkDialog() {
    // React may paint the modal just after the first click. This is a SHORT,
    // in-memory DOM wait, not recurring network polling.
    for(let i=0;i<20;i++){
      const result=garageConfirmBulkCrush();
      if(result==='submitted'||result==='blocked')return result;
      await sleep(120);
    }
    garageWarn('Crush confirmation not found yet; leave pending for recheck, do not repeat opening click');
    return 'not-visible';
  }
  function garageCashAllows(price,limit) {
    const cash=Number(st.char?.money);
    return Number.isFinite(cash)&&Number.isFinite(price)&&price>=0&&price<=limit&&
      cash-price>=num(S.garage.keepCash);
  }
  function garageMoneyNear(t,word){
    // Do not turn $1.2m into $1 or $25k into $25: prices must be
    // converted completely before any paid click is permitted.
    const pattern='((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)([kKmM]?)';
    const quoted=String(t||'').match(new RegExp('(?:'+word+')\\s*[:\\-]?\\s*\\$\\s*'+pattern+'(?![a-zA-Z0-9])','i')) ||
      String(t||'').match(new RegExp('\\$\\s*'+pattern+'\\s*(?:for\\s*)?(?:'+word+')(?![a-zA-Z])','i'));
    if(!quoted)return null;
    const n=Number(quoted[1].replace(/,/g,'')),unit=String(quoted[2]||'').toLowerCase();
    return Number.isFinite(n)?n*({k:1000,m:1000000}[unit]||1):null;
  }
  function garageUpgradePage() {
    // Smuggling Upgrades tab renders its own cards on the same /game/smuggling
    // route as the market and deliveries; inspect visible content, not URL alone.
    const active=/^\/game\/smuggling\/?$/.test(location.pathname);
    if(!active||!S.garage.upgradeCapacity)return false;
    const me=garageCurrentDistrict();
    if(!me){garageWarn('Smuggling upgrades: current district not confirmed');return false;}
    const visible=[...document.querySelectorAll('button')].filter(garageVisible);
    const candidates=visible.filter(b=>/^upgrade(?:\s+now)?$/i.test(garageText(b)));
    for(const button of candidates){
      let branch=null,car=null;
      // Find the capacity branch, not other vehicle upgrades such as stealth,
      // damage, or speed. Never select a different car with the same model.
      for(let el=button.parentElement,d=0;el&&d<7;el=el.parentElement,d++){
        const txt=garageText(el);
        if(txt.length>1000)break;
        if(/\b(?:door panels|drug capacity)\b/i.test(txt) &&
           (el.querySelectorAll('button').length<=2)) {branch=el;break;}
      }
      if(!branch)continue;
      for(let el=branch.parentElement,d=0;el&&d<7;el=el.parentElement,d++){
        const txt=garageText(el);
        if(txt.length>1800)break;
        const cap=garageCapacity(txt);
        const city=garageLocation(txt);
        // Price and capacity must be supported by the chosen car's own card.
        if(cap!=null&&city===me){car={base:cap,text:txt};break;}
      }
      if(!car||car.base<S.garage.minBaseCapacity)continue;
      const bt=garageText(button),xt=garageText(branch);
      // Prefer an explicit Door Panels/Upgrade price, otherwise require the
      // *branch* to show exactly one dollar amount (not the car's value).
      let price=garageMoneyNear(bt+' '+xt,'(?:door panels|upgrade)');
      if(price==null){
        const prices=[...xt.matchAll(/\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)([kKmM]?)(?![a-zA-Z0-9])/g)];
        if(prices.length===1){
          const amount=Number(prices[0][1].replace(/,/g,''));
          price=amount*({k:1000,m:1000000}[prices[0][2].toLowerCase()]||1);
        }
      }
      if(!garageCashAllows(price,S.garage.maxCapacityUpgradeCost))continue;
      if(/(?:level\s*5\s*\/\s*5|\bmax(?:ed)?\b)/i.test(xt))continue;
      garageHold('upgrade',car.text.slice(0,80));button.click();
      garageWarn('Requested Drug capacity / Door Panels upgrade for protected cargo car ($'+price+'); verify upgrade level');
      st.lastGarageCheck=0;return true;
    }
    return false;
  }

// V2.3.12: The HAR verifies GET /garage?page=N and POST /garage/crusher
// with {carIds:[...]}. Never issue /garage/crusher/all: it has no ID scope
// and there may be valuable cars on other pages or behind filters.
function garageFlag(value) {return value===true||value===1||String(value).toLowerCase()==='true';}
function garageId(value) {
  const n=Number(value);
  return Number.isSafeInteger(n)&&n>0?n:null;
}
function garageApiLocation(value) {
  return String(value||'').trim().toLowerCase().replace(/^the\s+/, '');
}
function garageApiHasUpgrades(vehicle) {
  const levels=vehicle?.upgrade_levels||{};
  return Object.values(levels).some(v=>Number(v)>0)||
    (Array.isArray(vehicle?.smuggling_upgrades)&&vehicle.smuggling_upgrades.length>0);
}
async function garageApiInventory() {
  const first=await GET('/garage?page=1');
  const page=first?.pagination||{};
  const pages=Number(page.last_page);
  const total=Number(page.total);
  if(!Array.isArray(first?.cars)||!Number.isInteger(pages)||pages<1||pages>25||
     !Number.isInteger(total)||total<0||total>375||Number(page.current_page)!==1)
    throw new Error('Garage pagination unknown; no cars crushed');
  const rows=[...first.cars];
  for(let p=2;p<=pages;p++) {
    const data=await GET('/garage?page='+p);
    if(!Array.isArray(data?.cars)||Number(data?.pagination?.current_page)!==p||
       Number(data?.pagination?.last_page)!==pages||Number(data?.pagination?.total)!==total||
       garageApiLocation(data.location)!==garageApiLocation(first.location))
      throw new Error('Garage pages changed during scan; no cars crushed');
    rows.push(...data.cars);
  }
  const ids=rows.map(c=>garageId(c?.id));
  if(rows.length!==total||ids.some(x=>!x)||new Set(ids).size!==total)
    throw new Error('Garage list incomplete or duplicated; no cars crushed');
  return {rows,first,pages,total};
}
async function garageApiSweep() {
  const home=garageCurrentDistrict();
  if(!home){garageWarn('Current district unknown; no automated crushing');return false;}
  const snapshot=await garageApiInventory();
  const {rows,first,pages,total}=snapshot;
  const origin=garageApiLocation(first.location);
  if(origin!==home){garageWarn('Garage district differs from character location; skipping');return false;}
  const smuggle=S.modules.smuggling?await GET('/drug-smuggling'):null;
  // If the game changed the smuggling schema, avoid disposing of a working vehicle.
  if(S.modules.smuggling && (!Array.isArray(smuggle?.vehicles)||!Array.isArray(smuggle?.active_operations))) {
    garageWarn('Smuggling vehicle state unavailable; no cars crushed');return false;
  }
  const vehicles=new Map((smuggle?.vehicles||[])
    .filter(v=>garageId(v.id)).map(v=>[garageId(v.id),v]));
  const busy=new Set((smuggle?.active_operations||[])
    .map(op=>garageId(op?.vehicle?.id??op?.vehicle_id)).filter(Boolean));
  const min=Number(S.garage.minBaseCapacity);
  const cars=[];
  for(const raw of rows){
    const id=garageId(raw.id),cap=Number(raw.drug_capacity),city=garageApiLocation(raw.location);
    if(!id||!Number.isFinite(cap)||cap<0||!city){garageWarn('Incomplete car fields; no cars crushed');return false;}
    const ship=raw.shipping_status;
    const moving=!!raw.shipping_end_time||!!(ship&&typeof ship==='object'&&(garageFlag(ship.required)||garageFlag(ship.expired)));
    const listing=vehicles.get(id);
    const upgraded=listing&&garageApiHasUpgrades(listing);
    // The game's GTA garage uses damage_percentage > 0 and repair_cost
    // (verified in its captured JavaScript). Do not guess a missing value.
    const damage=raw.damage_percentage==null?NaN:Number(raw.damage_percentage);
    const repairCost=raw.repair_cost==null?NaN:Number(raw.repair_cost);
    cars.push({id,cap,city,locked:garageFlag(raw.locked),moving,upgraded:!!upgraded,
      busy:busy.has(id),listing,damage,repairCost});
  }
  // Protect every high-capacity car, including those located on a hidden page.
  const lockTarget=S.garage.protect && cars.find(c=>!c.locked && (c.cap>=min||c.upgraded));
  if(lockTarget){
    garageHold('lock',String(lockTarget.id),{phase:'api-pending',at:now()});
    const reply=await POST('/garage/lock/'+lockTarget.id);
    if(!/success|updated/i.test(String(reply?.message||''))) {
      garageWarn('Lock result unconfirmed for car '+lockTarget.id);return false;
    }
    st.garageHold=null;GM_setValue(GARAGE_HOLD_KEY,'null');
    st.lastGarageCheck=0;
    garageWarn('Protected capacity '+lockTarget.cap+' car (ID '+lockTarget.id+') across '+pages+' garage pages');
    return true;
  }
  const local=cars.filter(c=>c.city===home);
  // Reserve a working car for smuggling if no already-locked eligible local car exists.
  if(S.modules.smuggling && S.garage.protect){
    const hasProtected=local.some(c=>c.locked&&!c.busy&&!c.moving&&c.listing?.is_available===true);
    if(!hasProtected){
      const reserve=local.filter(c=>!c.locked&&!c.busy&&!c.moving&&
        c.cap>=num(S.smuggling.minLoad)&&c.listing?.is_available===true)
        .sort((a,b)=>b.cap-a.cap)[0];
      if(reserve){
        garageHold('lock',String(reserve.id),{phase:'api-pending',at:now()});
        const reply=await POST('/garage/lock/'+reserve.id);
        if(!/success|updated/i.test(String(reply?.message||''))){garageWarn('Smuggling reserve lock unconfirmed');return false;}
        st.garageHold=null;GM_setValue(GARAGE_HOLD_KEY,'null');
        st.lastGarageCheck=0;
        garageWarn('Kept car '+reserve.id+' (capacity '+reserve.cap+') for smuggling');return true;
      }
    }
  }
  // V2.3.17: Repair EVERY damaged garage car before crushing ANY car.
  // The captured GTA2 game bundle verifies POST /garage/repair with
  // {carIds:[...]} and provides damage_percentage and repair_cost. Check
  // all garage pages, including protected/high-capacity and remote cars.
  // A pending/unaffordable/unknown repair BLOCKS crushing, rather than
  // destroying a damaged vehicle or silently skipping it.
  if(cars.some(c=>!Number.isFinite(c.damage)||c.damage<0||c.damage>100)){
    garageWarn('Repair-first blocked: garage damage data incomplete; no cars crushed');return false;
  }
  const damaged=cars.filter(c=>c.damage>0);
  if(damaged.length){
    if(!S.garage.repair){
      garageWarn(damaged.length+' damaged cars remain; enable Garage repairs before crushing');return false;
    }
    if(damaged.some(c=>!Number.isFinite(c.repairCost)||c.repairCost<0)){
      garageWarn('Repair-first blocked: a damaged car has no verified repair price');return false;
    }
    // Never submit repair requests for vehicles still moving/in a mission.
    // Even if other cars are repairable, the crusher waits until ALL are done.
    const available=damaged.filter(c=>!c.moving&&!c.busy);
    const maxPerCar=Number(S.garage.maxRepairCost);
    const limit=Number(st.char?.money)-num(S.garage.keepCash);
    if(!Number.isFinite(maxPerCar)||maxPerCar<0||!Number.isFinite(limit)){
      garageWarn('Repair-first blocked: repair budget or available cash unknown');return false;
    }
    // Local crusher candidates first; then all other damaged cars including
    // protected and remote vehicles. Repairs are ID-selective, never repair-all.
    available.sort((a,b)=>Number(b.city===home)-Number(a.city===home)||a.id-b.id);
    const batch=[];
    let batchCost=0;
    for(const c of available){
      if(batch.length>=8)break;
      if(c.repairCost>maxPerCar)continue;
      if(batchCost+c.repairCost>limit)continue;
      batch.push(c);batchCost+=c.repairCost;
    }
    if(!batch.length){
      const busyCount=damaged.length-available.length;
      const overCap=available.filter(c=>c.repairCost>maxPerCar).length;
      garageWarn('Repair-first blocked: '+damaged.length+' damaged cars ('+busyCount+
        ' busy/in transit, '+overCap+' over $'+maxPerCar.toLocaleString()+
        ' repair limit); cash reserve/repair availability must be satisfied');
      return false;
    }
    const repairIds=batch.map(c=>c.id);
    garageHold('repair',repairIds.join(','),{phase:'api-pending',type:'selected',
      ids:repairIds,count:repairIds.length,cost:batchCost,at:now()});
    // Store the hold BEFORE the paid call, and do not repeat it if uncertain.
    await POST('/garage/repair',{carIds:repairIds});
    const after=await garageApiInventory();
    const afterById=new Map(after.rows.map(c=>[garageId(c?.id),Number(c?.damage_percentage)]));
    if(!repairIds.every(id=>afterById.has(id)&&afterById.get(id)===0)){
      garageWarn('Repair response unconfirmed for '+repairIds.length+
        ' cars; no crushing or blind repair retry');return false;
    }
    st.garageHold=null;GM_setValue(GARAGE_HOLD_KEY,'null');
    st.lastGarageCheck=0;
    garageWarn('Verified repair of '+repairIds.length+' cars ($'+batchCost.toLocaleString()+
      '); '+(damaged.length-repairIds.length)+' damaged remain, crusher waits for all');
    return true;
  }
  if(!local.length){garageWarn('Scanned '+pages+' garage pages: none in '+home);return false;}
  if(!S.garage.crushLocal){garageWarn('Scanned '+pages+' garage pages; crushing disabled');return false;}
  if(S.modules.oc && ['active','planning'].includes(st.ocPhase)){
    garageWarn('OC underway; preserving possible driver cars until finished');return false;
  }
  // A below-threshold car with unknown upgrades or an unavailable/busy
  // smuggling state is not safe to destroy merely to free capacity.
  const selected=local.filter(c=>!c.locked&&!c.moving&&!c.busy&&!c.upgraded&&
    c.cap<min && (!c.listing || c.listing.is_available===true));
  // HAR 2026-11-18 verifies POST /garage/bulk-ship with
  // {carIds:[...],destinationId:<game_locations.id>}, returning shipped_cars.
  // Ship only after no eligible local cars remain to crush. Never ship busy
  // cars, cars in transit, or cars already at the configured Trading City A.
  if(selected.length===0 && S.garage.shipAfterCrushToA){
    const target=TRADING_CITIES.find(c=>c.id===Number(S.trading.cityA));
    const listed=(first.game_locations||[]).find(c=>
      Number(c?.id)===Number(target?.id)&&
      garageApiLocation(c?.name)===garageApiLocation(target?.name));
    if(!target||!listed){
      garageWarn('Location A not verified against game locations; shipping skipped');
      return false;
    }
    const destination=garageApiLocation(target.name);
    const processing=rows.some(raw=>/crush|queue|processing/i.test(
      String(raw.status||raw.crusher_status||'')));
    if(processing){
      garageWarn('Crusher still processing cars; shipping deferred');
      return false;
    }
    const remaining=cars.filter(c=>!c.moving&&!c.busy&&c.city!==destination);
    if(remaining.length){
      const ids=remaining.slice(0,10).map(c=>c.id);
      garageHold('ship',ids.join(','),{phase:'api-pending',ids,
        destinationId:target.id,destination,at:now()});
      const reply=await POST('/garage/bulk-ship',{carIds:ids,destinationId:target.id});
      const shipped=Array.isArray(reply?.shipped_cars)?
        reply.shipped_cars.map(c=>garageId(c?.id)):[];
      if(ids.some(id=>!shipped.includes(id))){
        garageWarn('Shipping response incomplete; no blind retry for '+ids.length+' cars');
        return false;
      }
      const after=await garageApiInventory();
      const byId=new Map(after.rows.map(c=>[garageId(c?.id),c]));
      if(!ids.every(id=>byId.has(id)&&
          garageApiLocation(byId.get(id).location)===destination)){
        garageWarn('Shipping submitted but destination not verified; waiting for recheck');
        return false;
      }
      st.garageHold=null;GM_setValue(GARAGE_HOLD_KEY,'null');
      st.lastGarageCheck=0;
      garageWarn('Verified shipping '+ids.length+' remaining cars to City A ('+
        target.name+'); '+Math.max(0,remaining.length-ids.length)+' more eligible cars');
      return true;
    }
  }
  const fee=Number(first?.crusher?.price_per_car);
  if(first?.crusher?.available!==true||!Number.isFinite(fee)||fee<=0){
    garageWarn('Crusher unavailable or fee unverified');return false;
  }
  const money=Number(st.char?.money);
  const afford=Math.floor((money-num(S.garage.keepCash))/fee);
  const budget=Math.floor(num(S.garage.maxCrushTotalFee)/fee);
  const n=Math.min(selected.length,8,afford,budget);
  if(!Number.isInteger(n)||n<=0){
    garageWarn('Scanned '+pages+' pages ('+total+' cars); no safe, affordable local cars to crush');return false;
  }
  const ids=selected.slice(0,n).map(c=>c.id);
  // The HAR proves the ID-selective endpoint and its queued_cars result.
  // Store the hold BEFORE submitting: no blind retry on network errors.
  garageHold('crush',ids.join(','),{phase:'api-pending',type:'selected',district:home,count:n,at:now()});
  const reply=await POST('/garage/crusher',{carIds:ids});
  if(!Array.isArray(reply?.queued_cars)||reply.queued_cars.length!==n ||
     !/added to crusher queue/i.test(String(reply.message||''))){
    garageWarn('Crusher response unconfirmed; review before repeating');return false;
  }
  st.garageHold=null;GM_setValue(GARAGE_HOLD_KEY,'null');
  // Crusher processes at a finite rate. Revisit after a short cooldown,
  // rather than repeating a whole batch immediately and filling the queue.
  st.lastGarageCheck=now()-Number(S.garage.checkMinutes)*60000+5*60000;
  garageWarn('Queued '+n+' selected local cars across '+pages+' pages; '+
    (total-n)+'+ cars may remain. Next garage batch in about 5 min');
  log('Garage: server confirmed '+n+' car IDs queued; no bulk Crush All used','good');
  return true;
}

  async function doGarage() {
    // Shipping has a persistent request hold. After any error or reload,
    // verify the IDs' locations before resuming, never resubmit blindly.
    if(st.garageHold?.kind==='ship'&&st.garageHold?.phase==='api-pending'){
      const hold=st.garageHold;
      if(now()-num(st.lastShipRecheckAt)<120000)return false;
      st.lastShipRecheckAt=now();
      try {
        const after=await garageApiInventory();
        const byId=new Map(after.rows.map(c=>[garageId(c?.id),c]));
        if(Array.isArray(hold.ids)&&hold.ids.length&&hold.ids.every(id=>
          byId.has(id)&&garageApiLocation(byId.get(id).location)===hold.destination)){
          st.garageHold=null;GM_setValue(GARAGE_HOLD_KEY,'null');
          st.lastGarageCheck=0;
          garageWarn('Verified previously pending shipment to '+hold.destination);
          return true;
        }
        garageWarn('Shipping result unresolved; will not repeat shipment blindly');
      }catch(err){garageWarn('Shipping verification failed: '+String(err?.message||err));}
      return false;
    }
    // An uncertain paid repair is never submitted twice, even after the
    // usual 10-minute garage hold expires. Re-check the authoritative Garage
    // inventory for the same IDs and resume only after every one reads 0%.
    if(st.garageHold?.kind==='repair'&&st.garageHold?.phase==='api-pending'){
      const hold=st.garageHold;
      if(now()-num(st.lastRepairRecheckAt)<120000)return false;
      st.lastRepairRecheckAt=now();
      try{
        const snapshot=await garageApiInventory();
        const damaged=new Map(snapshot.rows.map(c=>[garageId(c?.id),
          c?.damage_percentage==null?NaN:Number(c.damage_percentage)]));
        const ids=Array.isArray(hold.ids)?hold.ids:[];
        if(ids.length&&ids.every(id=>damaged.has(id)&&damaged.get(id)===0)){
          st.garageHold=null;GM_setValue(GARAGE_HOLD_KEY,'null');
          st.lastGarageCheck=0;
          garageWarn('Verified previously pending repairs for '+ids.length+' cars; resuming garage');
          return true;
        }
        garageWarn('Repair is unconfirmed for '+ids.length+
          ' cars; no repeated paid repairs or crushing until they are verified');
      }catch(err){
        garageWarn('Repair verification unavailable; no repeat repair or crushing: '+String(err?.message||err));
      }
      return false;
    }
    // Pending confirmation takes precedence over the ordinary 45-minute
    // cadence. Never ignore a paid confirmation behind the hold guard.
    if(st.garageHold?.kind==='crush'&&st.garageHold?.phase==='confirm'){
      const outcome=garageConfirmBulkCrush();
      if(outcome==='submitted'||outcome==='blocked')return true;
      if(now()-num(st.garageHold.at)>120000){
        garageHold('crush',st.garageHold.tag,{...st.garageHold,phase:'blocked',reason:'confirmation timeout',at:now()});
        garageWarn('Crush confirmation timed out; previous request requires review');
      }
      return false;
    }
    const p=location.pathname;
    const garageTab=/^\/game\/gta\/?$/.test(p)&&garageRows().length>0;
    const upgradeTab=/^\/game\/smuggling\/?$/.test(p)&&
      /\b(?:door panels|drug capacity)\b/i.test(garageText(document.body))&&
      [...document.querySelectorAll('button')].some(b=>garageVisible(b)&&/^upgrade(?:\s+now)?$/i.test(garageText(b)));
    const context=garageTab?'garage-visible':upgradeTab?'upgrade-visible':p;
    if(context!==st.lastGarageContext){
      const enteringUpgrade=upgradeTab&&st.lastGarageContext!=='upgrade-visible';
      st.lastGarageContext=context;
      // Page navigation must not bypass the five-minute crusher queue pacing.
      if(enteringUpgrade)st.lastGarageCheck=0;
    }
    // The cross-page API scan works even when automatic page navigation is OFF.
    if(!garageTab&&!upgradeTab&&!S.garage.navigateToGarage&&
       !S.garage.protect&&!S.garage.crushLocal)return false;
    if(now()-st.lastGarageCheck<S.garage.checkMinutes*60000) return false;
    st.lastGarageCheck=now();
    if(garageHoldActive()){
      st.lastGarageCheck=0;
      garageWarn('Previous garage change awaiting verification; no repeat');return false;
    }
    // Authoritative server data covers ALL pages, not just the visible 15.
    // Run one cross-page scan; never fall through to the old bulk DOM logic.
    if(S.garage.protect||S.garage.crushLocal){
      const changed=await garageApiSweep();
      if(changed)return true;
      // No need to navigate to the GTA page after a complete API scan.
      if(!garageTab&&!upgradeTab)return false;
    }
    const inGta=/^\/game\/gta\/?$/.test(location.pathname);
    if(/^\/game\/smuggling\/?$/.test(location.pathname) && upgradeTab) {
      if(garageUpgradePage())return true;
      garageWarn('Smuggling upgrades: waiting for a verified local capacity upgrade card');
      return false;
    }
    // Never auto-travel to another city merely to crush vehicles. This module
    // only works with the loaded on-screen garage and smuggling upgrade tabs.
    if(inGta){
      const rows=garageRows();
      if(rows.length){
        // Protect valuable cars FIRST, before any disposal. User locks are
        // never reversed. A threshold of 60 protects 60 as well as 61+.
        for(const car of rows){
          if(!car.known)continue;
          if(car.base>=S.garage.minBaseCapacity && !car.locked && S.garage.protect){
            garageHold('lock',garageText(car.row).slice(0,80));
            car.button.click();st.lastGarageCheck=0;
            garageWarn('Requested protection lock for '+car.base+'-capacity car; confirm on next scan');
            return true;
          }
        }
        const me=garageCurrentDistrict();
        if(!me){garageWarn('Current district unavailable: crushing deferred');return false;}
        if(rows.some(x=>!x.known)) {garageWarn('Unrecognised garage row: crushing deferred');return false;}
        // Only the current district is crushable. No selling, shipping,
        // unlocked high-cap disposal, or other-city travel is attempted.
        const local=rows.filter(x=>x.city===me);
        if(!local.length){garageWarn('No confirmed local cars on current garage page');return false;}
        const unsafe=local.filter(x=>x.base>=S.garage.minBaseCapacity&&!x.locked);
        if(unsafe.length){garageWarn('High-capacity local car is not locked: no crushing');return false;}
        // Preserve at least one currently usable smuggling vehicle in this
        // district. The 60+ rule is a permanent-protection threshold, NOT an
        // eligibility minimum for Supply Lines. Otherwise auto-crushing every
        // 25/30-capacity car would leave the player unable to smuggle at all.
        if(S.modules.smuggling && S.garage.protect){
          const usable=local.filter(x=>x.known&&!x.busy&&x.base>=num(S.smuggling.minLoad));
          if(usable.length&&!usable.some(x=>x.locked)){
            const reserve=usable.sort((a,b)=>b.base-a.base)[0];
            garageHold('lock',garageText(reserve.row).slice(0,80));
            reserve.button.click();st.lastGarageCheck=0;
            garageWarn('Protected a '+reserve.base+'-capacity car as a temporary smuggling reserve; other low-capacity cars may still be crushed');
            return true;
          }
        }
        // All repairs are performed and verified across Garage API pages
        // before this point; do not duplicate a paid DOM repair click.
        // The legacy Crush All path is deliberately unused; it cannot prove
        // what hidden pages contain. The ID-selective API is authoritative.
        return false;
      }
      if(S.garage.navigateToGarage && now()-st.lastGarageNav>15*60000){
        const button=[...document.querySelectorAll('button')].find(b=>garageVisible(b)&&garageText(b)==='Garage');
        if(button){st.lastGarageNav=now();button.click();garageWarn('Opening GTA Garage for capacity check');return true;}
      }
    }
    else if(S.garage.navigateToGarage&&now()-st.lastGarageNav>30*60000){
      st.lastGarageNav=now();location.assign('/game/gta');return true;
    }
    garageWarn('Garage checks wait until the Garage tab is visible; no remote-district actions');
    return false;
  }

  // ---- Supply Lines: read CURRENT origin, destination-specific prices, then
  // obtain a server preview. Never hardcode a destination, cargo, or price.
  // Based on a 13 Nov 2026 HAR containing an actual successful launch.
  function smugglingQuote(response){
    const nodes=[response?.preview?.review,response?.preview,response?.quote,
      response?.result?.preview,response?.result?.quote,response?.result,
      response?.data?.preview,response?.data,response].filter(x=>x&&typeof x==='object');
    for(const q of nodes){
      const cost=firstNumber(q,['total_cost','totalCost','cargo_cost','purchase_cost','cost','total_purchase_cost']);
      const payout=firstNumber(q,['estimated_value','estimatedValue','total_payout','totalPayout',
        'expected_payout','expectedPayout','payout','total_value','sale_value']);
      const profitField=firstNumber(q,['estimated_profit','estimatedProfit','expected_profit','expectedProfit',
        'net_profit','netProfit','profit']);
      if(cost==null||cost<0)continue;
      const profit=profitField??(payout!=null?payout-cost:null);
      if(profit==null||!Number.isFinite(profit))continue;
      // 'risk_score' is NOT a success rate. Only the explicit success_chance
      // field is interpreted as a probability.
      const chance=firstNumber(q,['success_chance','successChance','success_rate','successRate']);
      const p=chance==null?null:Math.max(0,Math.min(1,chance>1?chance/100:chance));
      const expected=p!=null&&payout!=null?p*payout-cost:null;
      return {cost,payout,profit,expected,knownSuccess:p!=null,probability:p,
        affordable:q.can_afford!==false,overCapacity:q.capacity_exceeded===true};
    }
    return null;
  }
  function smuggleWarn(message){
    st.smuggleStatus=message;
    GM_setValue(SMUGGLING_STATUS_KEY,String(message).slice(0,280));
    if(st.lastSmuggleWarning!==message||now()-st.lastSmuggleWarningAt>900000){
      st.lastSmuggleWarning=message;st.lastSmuggleWarningAt=now();
      log('Smuggling: '+message,'warn');
    }
    renderStatus();
  }
  function smuggleNote(message){
    st.smuggleStatus=message;
    GM_setValue(SMUGGLING_STATUS_KEY,String(message).slice(0,280));
    renderStatus();
  }
  function smugglingVehicleUsable(v){
    if(!v||v.id==null||v.is_available===false||v.can_use===false||v.can_smuggle===false||
        v.is_local===false||v.is_at_current_location===false||v.in_use===true||
        v.is_damaged===true||v.is_impounded===true||v.is_in_transit===true||
        /^(?:in transit|in use|impounded|damaged|repairing|crushing|sold)$/i.test(String(v.status||'')))return false;
    // Live endpoint exposes 'drug_capacity' (not cargo_capacity), and may
    // expose a higher upgraded 'modified_capacity'. Locked is NOT unavailable.
    const damage=firstNumber(v,['damage_percentage','damagePercentage']);
    if(damage!=null && damage>0)return false;
    const effective=firstNumber(v,['modified_capacity','modifiedCapacity',
      'effective_capacity','effectiveCapacity','drug_capacity','drugCapacity','cargo_capacity','cargoCapacity','capacity']);
    return effective!=null&&effective>=Math.max(1,num(S.smuggling.minLoad));
  }
  function smugglingPriceRows(p,knownDrugs=[]){
    const rows=Array.isArray(p?.drugs)?p.drugs:
      Array.isArray(p?.prices)?p.prices:
      Array.isArray(p?.data?.drugs)?p.data.drugs:[];
    return rows.map(x=>{
      const id=x?.drug_id??x?.drug?.id??x?.id;
      const known=knownDrugs.find(d=>String(d.id??d.drug_id)===String(id));
      const name=String(x?.name??x?.drug_name??x?.drug?.name??known?.name??known?.drug_name??'');
      const sell=firstNumber(x,['destination_price','destinationPrice','sell_price','payout_price','sale_price']);
      const buy=firstNumber(x,['origin_price','originPrice','buy_price','source_price','purchase_price','cost_price']);
      const margin=firstNumber(x,['profit_per_unit','profitPerUnit'])??(buy!=null&&sell!=null?sell-buy:null);
      const avail=firstNumber(x,['available_quantity','available_stock','stock_available','max_quantity','stock']);
      return {id,name,sell,buy,margin,available:avail==null?Infinity:Math.max(0,avail)};
    }).filter(x=>x.id!=null&&x.buy!=null&&x.buy>=0&&x.sell!=null&&x.sell>0&&x.margin>0&&
      S.smuggling.allowedDrugs.some(d=>d.toLowerCase()===x.name.toLowerCase())&&x.available>0);
  }
  async function doSmuggling({force=false}={}){
    if(!force&&now()-st.lastSmuggleCheck<90000)return false;
    st.lastSmuggleCheck=now();
    if(!S.smuggling.allowedDrugs.length){smuggleWarn('All cargo types disabled in settings');return false;}
    smuggleNote('Reading Supply Lines slots and local vehicles…');
    const sm=await GET('/drug-smuggling');
    const active=sm.active_operations||sm.activeOperations||[];
    for(const op of active){
      if(op.status==='arrived'&&op.can_complete&&op.id!=null){
        const r=await POST(`/drug-smuggling/complete/${op.id}`);
        st.stats.smuggles++;
        log(`Smuggling completion submitted: ${r?.result?.outcome??r?.outcome??'unconfirmed'} (reconcile History)`,'info');
        st.lastSmuggleCheck=0;smuggleNote('Delivery completion submitted');return true;
      }
      if(op.status==='arrived'&&!op.can_complete&&!op.is_at_destination&&S.smuggling.autoTravelToComplete&&op.to_location?.id!=null){
        const tr=await GET('/transit');
        if(!tr.cooldown?.is_on_cooldown){
          await POST(`/transit/${op.to_location.id}`);
          log(`Travel to ${op.to_location.name||'destination'} for smuggling`,'good');return true;
        }
      }
    }
    const pending=st.smugglePending;
    if(pending){
      const found=active.some(op=>String(op.vehicle_id??op.vehicle?.id)===String(pending.vehicleId)&&
        String(op.destination_id??op.to_location?.id)===String(pending.destinationId)) ||
        (Number.isFinite(Number(pending.activeBefore)) && active.length>Number(pending.activeBefore));
      if(found){
        st.smugglePending=null;GM_setValue(SMUGGLING_PENDING_KEY,'null');
        smuggleNote('Started; active delivery confirmed');
      }else if(now()-num(pending.at)<15*60000){
        smuggleWarn('Awaiting confirmation of previous launch (no duplicate submission)');return false;
      }else{
        st.smugglePending=null;GM_setValue(SMUGGLING_PENDING_KEY,'null');
        smuggleWarn('Previous launch unconfirmed after 15 minutes; rechecking availability');
      }
    }
    const slots=firstNumber(sm,['progression.operations_limit','progression.max_operations','max_active_operations',
      'operations_limit','slot_limit','slots.total','slots_total'])??1;
    const free=firstNumber(sm,['available_slots','slots_available','slots.free']);
    if((free!=null&&free<=0)||active.length>=Math.max(1,slots)){
      smuggleNote(`All ${Math.max(1,slots)} delivery slot(s) busy`);return false;
    }
    const originId=sm?.character?.location?.id;
    const originName=String(sm?.character?.location?.name||'current district');
    if(originId==null){smuggleWarn('Current district not verified in smuggling response');return false;}
    const listed=Array.isArray(sm.vehicles)?sm.vehicles:Array.isArray(sm.available_vehicles)?sm.available_vehicles:[];
    // A signed-in account may have cars in other districts or damaged/assigned.
    // Always report exactly what the endpoint offered, not garage inventory count.
    const capacities=listed.map(v=>firstNumber(v,['modified_capacity','drug_capacity','cargo_capacity','capacity'])).filter(x=>x!=null);
    const cars=listed.filter(v=>smugglingVehicleUsable(v)&&!active.some(op=>
      String(op.vehicle_id??op.vehicle?.id)===String(v.id)))
      .sort((a,b)=>(firstNumber(b,['modified_capacity','drug_capacity','cargo_capacity','capacity'])||0)-
                   (firstNumber(a,['modified_capacity','drug_capacity','cargo_capacity','capacity'])||0));
    if(!cars.length){
      const available=listed.filter(v=>v.is_available===true).length;
      const maxCap=capacities.length?Math.max(...capacities):'unknown';
      smuggleWarn(`No eligible smuggling vehicle: ${listed.length} listed, ${available} marked available, max capacity ${maxCap}, configured minimum load ${S.smuggling.minLoad}; check damage, district and active use`);
      return false;
    }
    const destinations=Array.isArray(sm.destinations)?sm.destinations:Array.isArray(sm.available_destinations)?sm.available_destinations:[];
    if(!destinations.length){smuggleWarn('No destination data in smuggling response');return false;}
    // Always prefer the live smuggling account balance; another module's
    // cached character balance may be stale after a recent purchase.
    const cash=firstNumber(sm,['character.money','money','cash'])??firstNumber(st.char,['money']);
    if(cash==null){smuggleWarn('Cash balance unavailable; cannot verify purchase');return false;}
    if(cash<=num(S.smuggling.keepCash)){
      smuggleWarn(`Cash below reserved ${money(S.smuggling.keepCash)}; no purchase`);return false;
    }
    smuggleNote(`Origin ${originName}; ${cars.length} usable car(s), ${destinations.length} destination(s), ${Math.max(0,slots-active.length)} open slot(s). Comparing prices…`);
    const candidates=[];let pricedRoutes=0;let belowReserve=0,belowMinLoad=0,notProfitable=0,priceErrors=0;
    for(const dest of destinations.slice(0,8)){
      if(dest.id==null||String(dest.id)===String(originId)||
          dest.is_locked===true||dest.can_smuggle===false||dest.is_available===false)continue;
      let prices;
      try{prices=await GET(`/drug-smuggling/destination/${dest.id}/prices`);}
      catch(e){
        if(e instanceof AuthError||e instanceof ChallengeError||e instanceof RateLimitError)throw e;
        priceErrors++;
        smuggleWarn(`Price request failed for ${dest.name||dest.id}: ${String(e.message).slice(0,80)}`);continue;
      }
      // The endpoint calculates origin/destination prices for the player's
      // CURRENT city. If the target location differs, skip a stale response.
      if(prices?.location?.id!=null&&String(prices.location.id)!==String(dest.id))continue;
      pricedRoutes++;
      const rows=smugglingPriceRows(prices,sm.drugs||sm.available_drugs||[])
        .sort((a,b)=>b.margin-a.margin);
      if(!rows.length)notProfitable++;
      for(const car of cars.slice(0,3)){
        const capacity=firstNumber(car,['modified_capacity','modifiedCapacity','effective_capacity',
          'drug_capacity','drugCapacity','cargo_capacity','capacity'])||0;
        // Evaluate each drug individually, rather than filling the van with
        // the first listed drug or the workshop's preferred drug.
        for(const drug of rows){
          // Fill as much as available cash allows, instead of rejecting an
          // otherwise profitable run merely because a FULL load exceeds budget.
          const spending=Math.max(0,cash-num(S.smuggling.keepCash));
          const affordableUnits=drug.buy>0?Math.floor(spending/drug.buy):capacity;
          const quantity=Math.floor(Math.min(capacity,drug.available,affordableUnits));
          if(quantity<Math.max(1,num(S.smuggling.minLoad))){
            if(affordableUnits<Math.max(1,num(S.smuggling.minLoad)))belowReserve++;else belowMinLoad++;
            continue;
          }
          const cost=quantity*drug.buy;
          if(cost>spending){belowReserve++;continue;}
          const approxMargin=quantity*drug.margin;
          const distance=Number(dest.distance)||0;
          // Preliminary ranking only. Final choice uses preview's verified
          // probability, cost, payout and trip duration, not this estimate.
          const heuristic=approxMargin/(1+distance/400);
          candidates.push({dest,car,drug,quantity,heuristic});
        }
      }
      // Pricing all routes once per check is sufficient; avoid continuous polling.
      await sleep(rand(150,350));
    }
    if(!candidates.length){
      smuggleWarn(pricedRoutes?`No eligible shipment: ${pricedRoutes} destination quotes; ${notProfitable} with no positive-margin allowed drug; ${belowReserve} loads blocked by cash reserve; ${belowMinLoad} below min load (${S.smuggling.minLoad})`:
        `No usable destination price response (${priceErrors} failed requests)`);return false;
    }
    candidates.sort((a,b)=>b.heuristic-a.heuristic);
    const eligible=[];let unverified=0,rejected=0;
    // A bounded number of authoritative server previews, no brute-force API loop.
    smuggleNote(`Found ${candidates.length} price-positive route/cargo combinations; checking game preview…`);
    let previewErrors=0, badQuote=0, moneyBlocked=0;
    for(const c of candidates.slice(0,10)){
      const payload={vehicle_id:c.car.id,destination_id:c.dest.id,
        drugs:[{drug_id:c.drug.id,quantity:c.quantity}]};
      let preview;
      try{preview=await POST('/drug-smuggling/preview',payload);}
      catch(e){
        if(e instanceof AuthError||e instanceof ChallengeError||e instanceof RateLimitError)throw e;
        unverified++;previewErrors++;continue;
      }
      const quote=smugglingQuote(preview),net=quote?.expected??quote?.profit;
      if(!quote){unverified++;badQuote++;continue;}
      if(quote.overCapacity||!quote.affordable||quote.cost>cash-num(S.smuggling.keepCash)||
          quote.profit<=0||net<num(S.smuggling.minExpectedProfit)){
        rejected++;
        if(quote.cost>cash-num(S.smuggling.keepCash)||!quote.affordable)moneyBlocked++;
        continue;
      }
      const details=preview?.preview||preview?.quote||preview?.result||preview;
      const duration=firstNumber(details,['travel_time_seconds','travelTimeSeconds','duration_seconds',
        'travel_seconds','estimated_duration_seconds']) ||
        (firstNumber(details,['duration_minutes','travel_minutes'])||0)*60;
      const xp=firstNumber(details,['smuggling_xp','expected_xp','xp_reward']);
      // XP is not exposed in this HAR's preview. Do not fabricate an XP
      // reward: use expected $/hour as a documented fallback.
      const reward=(objective()==='xp'&&xp!=null)?xp:net;
      const score=reward/(duration>0?duration/3600:1);
      eligible.push({c,payload,quote,score,duration,xp});
    }
    if(!eligible.length){
      smuggleWarn(`No viable preview: ${unverified} unverified (${badQuote} missing amounts, ${previewErrors} request errors); ${rejected} rejected (${moneyBlocked} cash/reserve), minimum expected profit $${S.smuggling.minExpectedProfit}. No purchase made`);
      return false;
    }
    eligible.sort((a,b)=>b.score-a.score);
    const {c,payload,quote}=eligible[0];
    smuggleNote(`Selected ${c.quantity} ${c.drug.name} to ${c.dest.name||c.dest.id}; verifying car, slot and cash before launch…`);
    // Re-check live city/vehicle/slot before any PAID start. Route prices
    // and availability can change during multiple preview requests.
    const fresh=await GET('/drug-smuggling');
    if(String(fresh?.character?.location?.id)!==String(originId) ||
        !(fresh.vehicles||fresh.available_vehicles||[]).some(v=>String(v.id)===String(c.car.id)&&smugglingVehicleUsable(v))||
        (fresh.active_operations||[]).length>=Math.max(1,firstNumber(fresh,['progression.operations_limit'])??slots)){
      const freshCars=fresh.vehicles||fresh.available_vehicles||[];
      smuggleWarn(`Recheck blocked: origin ${fresh?.character?.location?.id??'unknown'} vs ${originId}, car ${freshCars.some(v=>String(v.id)===String(c.car.id))?'listed':'missing'}, active ${(fresh.active_operations||[]).length}/${firstNumber(fresh,['progression.operations_limit'])??slots}. No purchase made`);
      return false;
    }
    const freshCash=firstNumber(fresh,['character.money']);
    if(freshCash==null||freshCash-quote.cost<num(S.smuggling.keepCash)){
      smuggleWarn('Cash changed since preview; no cargo purchased');return false;
    }
    const hold={at:now(),vehicleId:c.car.id,destinationId:c.dest.id,activeBefore:(fresh.active_operations||[]).length};
    st.smugglePending=hold;GM_setValue(SMUGGLING_PENDING_KEY,JSON.stringify(hold));
    let reply;
    try{reply=await POST('/drug-smuggling/start',payload);}
    catch(e){
      smuggleWarn(`Launch outcome uncertain: ${String(e.message).slice(0,90)}; awaiting reconciliation`);
      throw e;
    }
    if(reply?.success===false||reply?.error){
      st.smugglePending=null;GM_setValue(SMUGGLING_PENDING_KEY,'null');
      smuggleWarn('Launch rejected by game; no successful delivery claimed');return false;
    }
    const statement=quote.expected!=null?`estimated risk-adjusted net ${money(quote.expected)}`:
      `estimated profit if successful ${money(quote.profit)} (unknown success odds)`;
    const expectedAtStart=firstNumber(reply,['estimated_profit','smuggling.estimated_profit']);
    log(`Supply Lines: ${originName} → ${c.dest.name||c.dest.id}, ${c.quantity} ${c.drug.name}, `+
      `capacity ${firstNumber(c.car,['modified_capacity','drug_capacity','capacity'])}, purchase ${money(quote.cost)}, `+
      `${statement}${expectedAtStart!=null?'; launch estimate '+money(expectedAtStart):''}; delivery pending`,'good');
    smuggleNote(`Started ${c.quantity} ${c.drug.name}: ${originName} → ${c.dest.name||c.dest.id}; waiting for active status`);
    st.lastSmuggleCheck=0;return true;
  }

  // ---- Jail busting: maximise expected XP or available rewards, with optional crew tie-break.
  async function doBusting() {
    if (now()-st.lastJailCheck<15000) return false;
    st.lastJailCheck=now();
    st.lastBusts=st.lastBusts.filter(t=>now()-t<60000);
    if (st.lastBusts.length>=S.busting.maxPerMinute) return false;
    const data=await GET('/jail-records');
    if (data.userIsJailed) return false;
    const choices=(data.jailRecords||[])
      .filter(r=>!r.is_current_user && num(r.attempts_left)>0 && num(r.time_left_seconds)>5 && r.id!=null)
      .map(r=>({kind:'bust',id:'bust:'+r.id,cost:1,data:r,name:r.character?.name||'player'}));
    const ranked=rankChoices(choices).sort((a,b)=>
      (b.rating.score+(S.busting.alwaysCrew && b.data.is_crew_member ? .02:0))-
      (a.rating.score+(S.busting.alwaysCrew && a.data.is_crew_member ? .02:0)));
    if (!ranked.length || !Number.isFinite(ranked[0].rating.score)) return false;
    const c=ranked[0],r=c.data;
    st.lastBusts.push(now()); st.stats.busts++;
    const out=await POST(`/jail-records/${r.id}/break-out`);
    learnReward(c.id,out?.result||out);
    const ok=out?.success??out?.result?.success;
    if (ok) st.stats.bustOk++;
    log(`Bust ${c.name} (${r.bust_chance}%): ${ok?'freed':ok===false?'failed':'attempted'}`,ok?'good':'warn');
    return true;
  }

  // ---- Burglary: choose highest expected return inside the jail-risk limit.
  async function doBurglary() {
    const nerve=cur('nerve')-Math.max(num(S.crimes.keepNerve),resourceFloor('nerve'));
    if (nerve<1 || !resourceTrigger('nerve', 1)) return false;
    const b=await GET('/crimes2/burglary');
    const cfg=b.config||{};
    const targets=b.session?.scouted_targets||[];
    const open=targets.filter(t=>!t.locked_until || new Date(t.locked_until).getTime()<now());
    const safe=t=>num(t.jail_chance)<=num(S.burglary.maxJail);
    const choices=open
      .filter(t=>safe(t) && num(t.nerve_cost)<=nerve && t.unique_id!=null)
      .map(t=>({kind:'burglary',id:'burglary:'+(t.name||t.unique_id),data:t,cost:num(t.nerve_cost),name:t.name}));
    const ranked=rankChoices(choices);
    if (ranked.length && Number.isFinite(ranked[0].rating.score)) {
      const c=ranked[0], t=c.data;
      const r=await POST(`/crimes2/burglary/attempt/${t.unique_id}`);
      const result=r?.result||r;
      learnReward(c.id,result);
      st.stats.cash+=num(result?.cash_reward);
      recordCrimeTurn('burglary');
      log(`Burgled ${t.name} (${describeChoice(c)}): ${result?.jailed?'jailed':result?.success?'success':'failed'}`,
        result?.success?'good':'warn');
      return true;
    }
    // Improve a promising target when it's not yet eligible or worthwhile.
    const caseable=open.filter(t=>num(t.confidence)<num(t.max_confidence) && num(t.nerve_cost)<=nerve && t.unique_id!=null)
      .sort((a,b2)=>num(b2.max_confidence)-num(b2.confidence)-(num(a.max_confidence)-num(a.confidence)));
    if (caseable.length) {
      const t=caseable[0];
      await POST(`/crimes2/burglary/scout/${t.unique_id}`);
      recordCrimeTurn('burglary');
      log(`Cased ${t.name} (${Math.round(num(t.confidence))}% confidence)`,'info');
      return true;
    }
    // Abandon jobs that are fully cased and still exceed the explicit jail-risk cap.
    const dead=open.find(t=>num(t.confidence)>=num(t.max_confidence) && !safe(t) && t.unique_id!=null);
    if (dead) {
      await POST(`/crimes2/burglary/abandon/${dead.unique_id}`);
      recordCrimeTurn('burglary');
      log(`Dropped ${dead.name}: jail risk ${Math.round(num(dead.jail_chance))}% exceeds limit`,'info');
      return true;
    }
    if (targets.length<num(cfg.max_scouted_targets||3) && nerve>=num(cfg.nerve_cost_search||5)) {
      await POST('/crimes2/burglary/search');
      recordCrimeTurn('burglary');
      log('Looked for a new burglary job','info');
      return true;
    }
    return false;
  }

  // ---- Bosses: evaluate all unique 3-attack assignments.
  const BOSS_ATTACK_TYPES={
    'devastating blow':{main:'strength',second:'health',beats:'endurance',loses:'speed'},
    'lightning strike':{main:'speed',second:'stamina',beats:'strength',loses:'defence'},
    'enduring assault':{main:'endurance',second:'health',beats:'stamina',loses:'strength'},
    'defensive counter':{main:'defence',second:'speed',beats:'health',loses:'endurance'},
    'relentless barrage':{main:'stamina',second:'strength',beats:'defence',loses:'health'},
    'vital strike':{main:'health',second:'defence',beats:'speed',loses:'stamina'},
  };
  function bossRoundValue(a,tell,fallback,stats={}) {
    const type=BOSS_ATTACK_TYPES[String(a.name||'').trim().toLowerCase()]||{};
    const main=String(a.main_stat??a.primary_stat??type.main??'').toLowerCase();
    const second=String(a.secondary_stat??type.second??'').toLowerCase();
    const stat=k=>firstNumber(stats,[k,k+'_level','fightStats.'+k,'fightStats.'+k+'_level'])??0;
    const derived=main&&second&&stat(main)>0?3*stat(main)+1.5*stat(second):null;
    const base=firstNumber(a,['average_damage','expected_damage','base_damage','damage'])??derived??100;
    const beats=String(a.counters??type.beats??'').toLowerCase();
    const loses=String(a.countered_by??type.loses??'').toLowerCase();
    const outcomes=Array.isArray(tell)&&tell.length?tell:[{stat:fallback,chance:100}];
    const denominator=outcomes.reduce((n,t)=>n+Math.max(0,num(t.chance)),0)||100;
    return outcomes.reduce((sum,t)=>{
      const target=String(t.stat??'').toLowerCase(),w=Math.max(0,num(t.chance))/denominator;
      const byStat=firstNumber(a.damage_by_stat,[target]);
      const factor=target===beats?1.5:target===loses?0.5:1;
      return sum+w*(byStat??base*factor);
    },0);
  }
  function pickAttacks(attacks,rounds,affinity,stats={}) {
    const a=(Array.isArray(attacks)?attacks:[])
      .filter(x=>x&&x.id!=null&&x.is_available!==false&&x.can_use!==false)
      .filter((x,i,all)=>all.findIndex(y=>String(y.id)===String(x.id))===i);
    if(a.length<3)return [];
    const scores=[0,1,2].map(r=>a.map(x=>bossRoundValue(x,rounds?.[r],affinity,stats)));
    let best=[],top=-Infinity;
    for(let i=0;i<a.length;i++)for(let j=0;j<a.length;j++)for(let k=0;k<a.length;k++){
      if(i===j||i===k||j===k)continue;
      const v=scores[0][i]+scores[1][j]+scores[2][k];
      if(v>top){top=v;best=[a[i].id,a[j].id,a[k].id];}
    }
    return best;
  }
  async function doBosses() {
    if (now() - st.lastBossCheck < 2 * 60000) return false;
    st.lastBossCheck = now();
    if (S.bosses.solo) {
      const solo = await GET('/solo-mob-boss');
      const cs = solo.character_stats || {};
      const boss = solo.boss_status?.boss;
      if (boss && cs.can_attack && num(cs.attacks_remaining) > 0) {
        const ids = pickAttacks(solo.available_attacks, boss.tell, boss.stat_affinity, cs);
        if (ids.length === 3) {
          const r = await POST('/solo-mob-boss/attack', { attack_ids: ids });
          st.stats.bossHits++;
          st.lastBossCheck = 0; // keep going while charges last
          const res = r?.result || {};
          log(`Hit ${boss.name.replace(/"[^"]*"\s*/, '')}${(res.total_damage??res.damage_dealt)!=null ? ' for ' + (res.total_damage??res.damage_dealt) : ''}${res.boss_defeated ? ' - defeated!' : ''}`, 'good');
          return true;
        }
      }
    }
    if (S.bosses.world) {
      const w = await GET('/mob-bosses');
      const boss = w.boss_status?.active_boss;
      const cs = w.character_stats || {};
      if (boss && cs.can_attack && num(cs.attacks_remaining) > 0) {
        const ids = pickAttacks(w.available_attacks, boss.tell, boss.stat_affinity, cs);
        if (ids.length === 3) {
          await POST('/mob-bosses/attack', { attack_ids: ids });
          st.stats.bossHits++;
          st.lastBossCheck = 0;
          log(`Hit the world boss ${boss.name}`, 'good');
          return true;
        }
      }
    }
    return false;
  }

  // ---- MOB Pass: claim finished levels
  async function doMobPass() {
    if (now() - st.lastPassCheck < 30 * 60000) return false;
    st.lastPassCheck = now();
    const mp = await GET('/mob-pass');
    for (const [label, id] of [['MOB Pass', mp?.run?.id], ['last MOB Pass', mp?.leftover?.run?.id ?? mp?.leftover?.id]]) {
      if (!id) continue;
      try {
        const r = await POST('/mob-pass/claim-all', { event_id: id });
        if (r && r.success !== false) { log(`Claimed ${label} rewards`, 'good'); return true; }
      } catch (e) { /* nothing to claim */ }
    }
    return false;
  }

  // ---- Jail-time actions: use explicit reward fields or a success/resource proxy.
  async function doJailTime() {
    if (now()-st.lastJailActCheck<15000) return false;
    st.lastJailActCheck=now();
    const j=await GET('/jail-records');
    if (!j.userIsJailed) return false;
    const choices=(j.jailActivities||[])
      .filter(a=>a.key && a.is_open && a.can_afford!==false && num(a.nerve_cost)<=cur('nerve'))
      .map(a=>({kind:'jail',id:'jail:'+a.key,data:a,cost:num(a.nerve_cost),name:a.name}));
    const ranked=rankChoices(choices);
    if (ranked.length && Number.isFinite(ranked[0].rating.score)) {
      const c=ranked[0],a=c.data;
      const r=await POST(`/jail/crimes/${a.key}/attempt`);
      learnReward(c.id,r?.result||r);
      log(`Jail: ${a.name} ${r?.success?'worked'+(r.items?.length?' (+'+r.items.length+' item)':''):'failed'}`,
        r?.success?'good':'warn');
      return true;
    }
    const y=j.jailYard;
    if (y && y.is_open && y.can_afford && num(y.fight_stats?.energy)>=num(y.energy_cost)) {
      const fs=y.fight_stats||{};
      const stat=S.gym.stat!=='auto' && (y.stats||[]).includes(S.gym.stat) ? S.gym.stat
        :[...(y.stats||['strength'])].sort((a,b)=>num(fs[a+'_level'])-num(fs[b+'_level']))[0];
      await POST('/jail/yard/train',{stat,reps:1});
      log(`Jail yard: trained ${stat}`,'good');
      return true;
    }
    return false;
  }
  // Drug Market trades and Supply Lines smuggling are DIFFERENT game systems.
  // Store trading plans by character so separate logged-in accounts cannot
  // accidentally use another account's destination, cargo or pending order.
  function tradeStorageKey(kind) {
    const id=Number(st.char?.id);
    return id>0 ? `mbx_v2313_${kind}_${id}` : null;
  }
  function tradePlan() {
    const key=tradeStorageKey('trade_plan');
    return key ? safeParse(GM_getValue(key,'null')) : null;
  }
  function setTradePlan(p) {
    const key=tradeStorageKey('trade_plan');
    if(key)GM_setValue(key,JSON.stringify(p));
  }
  function tradePending() {
    const key=tradeStorageKey('trade_pending');
    return key ? safeParse(GM_getValue(key,'null')) : null;
  }
  // Per-character travel hold prevents duplicate fares on successful, delayed,
  // or ambiguous network responses. Never transfer plans between accounts.
  function tradeTravelPending() {
    const key=tradeStorageKey('travel_pending');
    return key ? safeParse(GM_getValue(key,'null')) : null;
  }
  function setTradeTravelPending(p) {
    const key=tradeStorageKey('travel_pending');
    if(key)GM_setValue(key,JSON.stringify(p));
  }
  function setTradePending(p) {
    const key=tradeStorageKey('trade_pending');
    if(key)GM_setValue(key,JSON.stringify(p));
    st.tradePending=p;
  }
  function tradeNote(message, level='info') {
    const v=String(message||'Waiting').slice(0,180);
    if(st.tradeStatus!==v){st.tradeStatus=v;log('Drug market: '+v,level);}
    renderStatus();
  }
  function tradingPair() {
    const a=Number(S.trading.cityA), b=Number(S.trading.cityB);
    return a>0 && b>0 && a!==b && TRADING_CITIES.some(c=>c.id===a) && TRADING_CITIES.some(c=>c.id===b) ? [a,b] : null;
  }
  function tradingCityName(id) { return TRADING_CITIES.find(c=>c.id===Number(id))?.name||'unknown district'; }
  function currentTradeInventory(t) { return Array.isArray(t?.inventory)?t.inventory:[]; }
  function tradeInventoryQty(t,drugId) {return currentTradeInventory(t).filter(i=>Number(i.drug_id)===Number(drugId)).reduce((n,i)=>n+Number(i.quantity||0),0);}
  function tradePrice(t,drugId) {return (t.drugs||[]).find(d=>Number(d.id)===Number(drugId));}
  // Submitted BUY/SELL may take time to be reflected. Do not blindly replay
  // a paid transaction after a transport timeout / unclear server response.
  function reconcileTradeRequest(t) {
    const hold=tradePending();
    if(!hold)return true;
    const observed=tradeInventoryQty(t,hold.drugId);
    const changed=hold.kind==='buy'?observed>hold.before:observed<hold.before;
    if(changed){
      setTradePending(null);
      tradeNote(`${hold.kind==='buy'?'Bought':'Sold'} ${Math.abs(observed-hold.before)} ${hold.name||'drugs'} confirmed by market inventory.`,'good');
      return true;
    }
    tradeNote(`Waiting for ${hold.kind} inventory confirmation — won't duplicate transaction`,'warn');
    return false;
  }
  async function tradeRequest(kind,drug,quantity,t) {
    const before=tradeInventoryQty(t,drug.id);
    const hold={at:now(),kind,drugId:Number(drug.id),name:String(drug.name||drug.drug_name||''),quantity,before};
    setTradePending(hold);
    let reply;
    try{reply=await POST(`/drug-trade/${kind}`,{drug_id:drug.id,quantity});}
    catch(e){tradeNote(`${kind} request outcome uncertain: ${e.message}; waiting for inventory confirmation`,'warn');return false;}
    if(reply?.success===false || reply?.error){setTradePending(null);tradeNote(`${kind} rejected: ${reply.error||reply.message||'server declined'}`,'warn');return false;}
    // One accepted request per action. Re-read inventory before sending next.
    st.stats.trades++;
    st.lastTradeCheck=0;
    st.lastCharAt=0;
    tradeNote(`${kind==='buy'?'Bought':'Selling'} ${quantity} ${hold.name}; checking market inventory`,'good');
    return true;
  }
  async function doTrade() {
    // Travel is the purpose of this paired-city loop. Profitable drugs are a
    // bonus, never a prerequisite for travelling between the chosen cities.
    if(now()-st.lastTradeCheck<25000)return false;
    st.lastTradeCheck=now();
    const t=await GET('/drug-trade');
    const here=Number(t?.location?.id);
    if(!here){tradeNote('Current market district is not verified');return false;}
    const pair=tradingPair();
    if(!pair){tradeNote('Choose two different trading cities in Options → Drug trading');return false;}
    if(!pair.includes(here)){
      tradeNote(`In ${t.location?.name||'another district'}, outside ${tradingCityName(pair[0])} ↔ ${tradingCityName(pair[1])}; no third-city travel`);
      return false;
    }
    const dest=pair.find(id=>id!==here);
    let travelHold=tradeTravelPending();
    if(travelHold && Number(travelHold.to)===here){
      setTradeTravelPending(null);
      travelHold=null;
      st.tradeTravelReadyAt=0;
      tradeNote(`Arrived in ${tradingCityName(here)}; next leg ${tradingCityName(dest)}`,'good');
    }
    // A successful or uncertain POST may leave the old location visible briefly.
    // Never send a second fare request while the first leg could still be in flight.
    if(travelHold && now()-Number(travelHold.at||0)<120000){
      tradeNote(`Checking arrival from ${tradingCityName(travelHold.from)} to ${tradingCityName(travelHold.to)}; no duplicate travel`);
      return false;
    }
    const inventorySettled=reconcileTradeRequest(t);
    const items=currentTradeInventory(t).filter(i=>Number(i.quantity)>0);
    const maxTx=Math.max(1,Number(t.trade_limits?.max_per_transaction)||500);
    const canTrade=Number(t.trade_limits?.seconds_until_trade||0)<=0 &&
      !t.jail_status?.is_jailed && !t.hospital?.isInHospital;
    const tr=await GET('/transit');
    const city=(tr.districts||[]).find(d=>Number(d.id)===dest);
    if(!city || city.is_locked){tradeNote(`Selected ${tradingCityName(dest)} is unavailable/locked`);return false;}
    if(tr.jail?.isInJail || tr.hospital?.isInHospital){tradeNote('Travel blocked by jail or hospital');return false;}
    const secondsLeft=Math.max(0,Number(tr.cooldown?.remaining_seconds)||0);
    const cooling=tr.cooldown?.is_on_cooldown===true || secondsLeft>0;
    st.tradeTravelReadyAt=cooling?now()+Math.max(15,secondsLeft)*1000:0;
    if(travelHold){
      if(cooling){tradeNote('Previous travel still under cooldown; not resubmitting fare');return false;}
      // Two minutes have passed, origin is still confirmed, and the server
      // now reports no travel cooldown. Only then can a new leg be attempted.
      setTradeTravelPending(null);
    }
    const plan=tradePlan();
    const inspectionRisk=Math.max(0,Number(tr.contraband?.inspection_risk)||0);
    const acceptableRisk=inspectionRisk<=Number(S.trading.maxRisk||0);
    const validPlan=plan && acceptableRisk && Number(plan.sell_location_id)===dest &&
      items.some(i=>Number(i.drug_id)===Number(plan.drug_id));
    // Inventory can be sold while travel cools down. A newly bought, planned
    // load for the opposite city is held, not sold back where it was bought.
    const shouldSell=items.length>0 && S.trading.sellInventory && !validPlan && inventorySettled;
    if(shouldSell && canTrade){
      const sale=items.map(inv=>({inv,drug:tradePrice(t,inv.drug_id)}))
        .filter(x=>x.drug && Number(x.drug.sell_price)>0)
        .sort((a,b)=>Number(b.drug.sell_price)*Number(b.inv.quantity)-Number(a.drug.sell_price)*Number(a.inv.quantity))[0];
      if(sale){
        if(plan && Number(plan.drug_id)===Number(sale.inv.drug_id))setTradePlan(null);
        return tradeRequest('sell',sale.drug,Math.min(maxTx,Math.floor(Number(sale.inv.quantity))),t);
      }
    }
    if(cooling){
      tradeNote(`Waiting ${Math.ceil(secondsLeft/60)}m for travel: ${tradingCityName(here)} → ${tradingCityName(dest)}`);
      return false;
    }
    const fare=Number(city.travel_cost);
    if(!Number.isFinite(fare)||fare<0){tradeNote('Destination fare not verified; not spending blindly','warn');return false;}
    const reserve=Number(S.trading.keepCash)||0;
    const moneyAvailable=Number(t.money);
    if(!Number.isFinite(moneyAvailable) || moneyAvailable<fare+reserve){
      tradeNote(`Travel to ${tradingCityName(dest)} needs ${money(fare)} fare plus ${money(reserve)} reserve`,'warn');
      return false;
    }
    // Only buy on a travel-ready tick, with space/cash after reserving fare.
    // As travel happens anyway, the incremental cargo profit need not pay
    // the fare a second time. Never buy on uncertain inventory data.
    if(!items.length && inventorySettled && canTrade && acceptableRisk){
      const freeCash=Math.max(0,moneyAvailable-reserve-fare);
      const room=Math.max(0,Number(t.carry_capacity||0)-Number(t.inventory_weight||0));
      const candidates=(Array.isArray(t.trade_routes)?t.trade_routes:[])
        .filter(r=>r.type==='buy_here' && Number(r.buy_location_id)===here &&
          Number(r.sell_location_id)===dest && r.buy_stock_indicator!=='empty' &&
          Number(r.buy_price)>0 && Number(r.sell_price)>0)
        .map(r=>{
          const qty=Math.min(Math.floor(room),maxTx,Math.floor(freeCash/Number(r.buy_price)));
          const gross=qty*(Number(r.sell_price)-Number(r.buy_price));
          const net=S.trading.loopTravel?gross:gross-fare;
          const pct=100*(Number(r.sell_price)-Number(r.buy_price))/Number(r.buy_price);
          return {...r,qty,net,pct};
        })
        .filter(r=>r.qty>0 && r.net>=Number(S.trading.minNetProfit||1) &&
          r.pct>=Number(S.trading.minProfitPct||0))
        .sort((a,b)=>b.net-a.net);
      if(candidates.length){
        const best=candidates[0];
        setTradePlan({drug_id:Number(best.drug_id),sell_location_id:dest,
          buy_price:Number(best.buy_price),quantity:best.qty,net:best.net,at:now()});
        const bought=await tradeRequest('buy',{id:best.drug_id,name:best.drug_name},best.qty,t);
        if(bought){tradeNote(`Bought ${best.qty} ${best.drug_name} for ${tradingCityName(dest)}; cargo gain ${money(best.net)}`,'good');return true;}
        setTradePlan(null);
        // An uncertain purchase cannot be repeated, but it must not stop
        // the user-requested city loop either.
      }else if(!S.trading.loopTravel){
        tradeNote(`No profitable cargo for ${tradingCityName(dest)}; waiting for prices`);
        return false;
      }
    }else if(!S.trading.loopTravel && !validPlan){
      tradeNote('Trading-only mode: waiting for cargo before travelling');return false;
    }
    // No viable drugs, trading cooldown, insufficient stock, or uncertain
    // market request: still travel when the selected city is reachable.
    const hold={from:here,to:dest,at:now()};
    setTradeTravelPending(hold);
    let reply;
    try{reply=await POST(`/transit/${dest}`);}
    catch(e){tradeNote(`Travel response uncertain; checking destination before retry: ${String(e.message||e).slice(0,90)}`,'warn');return false;}
    if(reply?.success===false || reply?.error){
      setTradeTravelPending(null);
      tradeNote(`Travel rejected: ${reply.error||reply.message||'server declined'}`,'warn');return false;
    }
    st.lastCharAt=0;
    st.lastTradeCheck=0;
    st.tradeTravelReadyAt=now()+30000;
    tradeNote(`Travelling ${tradingCityName(here)} → ${tradingCityName(dest)}${validPlan?' with a drug load':' (no load needed)'}`,'good');
    return true;
  }

  // ---- Organised crime: join public OCs / accept invites in your preferred roles, contribute, ready up,
  //      then play your lockbox attempts and spend action points on the shared loot actions.
  const OC_ROLES = { 4: 'Driver', 2: 'Weapons Expert', 3: 'Explosives Expert', 5: 'Hacker', 1: 'Leader' };
  const OC_ROLE_REQUIREMENTS = {
    1:{type:'items'},4:{type:'cars'},2:{type:'equipment'},
    3:{type:'resources',resource:'focus'},5:{type:'resources',resource:'wit'}
  };
  function ocNote(message,level='info') {
    const v=String(message||'Unknown').slice(0,170);
    if (st.ocStatus!==v || now()-st.ocStatusAt>120000) {
      st.ocStatus=v; st.ocStatusAt=now();
      log('OC: '+v, level);
    }
  }
  function ocId(s) { return String(s?.id ?? s?.session_id ?? s?.uuid ?? 'unknown'); }
  function ocMe(s,o) {
    const participants=Array.isArray(s.participants)?s.participants:[];
    const charId=o?.character?.id ?? st.char?.character?.id ?? st.char?.id;
    return participants.find(p=>p.is_current_user === true || p.isCurrentUser === true || p.is_self === true ||
      (charId!=null && String(p.character_id ?? p.character?.id ?? p.user_id)===String(charId))) || null;
  }
  function ocContributionCount(me) {
    const observed=[me.contribution_count,me.contributions_count,me.contributionCount];
    for (const v of observed) if (v!=null && Number.isFinite(Number(v))) return Number(v);
    if (Array.isArray(me.contributions)) return me.contributions.length;
    return 0;
  }
  function ocHasContribution(me) {
    return ocContributionCount(me)>0 || me.has_contributed===true || me.hasContributed===true ||
      me.contribution_complete===true || me.is_contributed===true ||
      ['ready','contributed'].includes(String(me.status||'').toLowerCase());
  }
  function ocRoleInfo(me) {
    const role=typeof me.role==='object' && me.role?me.role:{};
    const rawId=role.id ?? me.role_id ?? me.roleId ?? me.seat?.id;
    const id=Number(rawId);
    const fromName=Object.entries(OC_ROLES).find(([,name])=>name.toLowerCase()===(String(me.role_name || role.name || me.role || '').toLowerCase()))?.[0];
    const actualId=Number.isFinite(id) && id>0 ? id : Number(fromName)||0;
    const known=OC_ROLE_REQUIREMENTS[actualId] || {};
    let type=String(role.contribution_type ?? me.contribution_type ?? known.type ?? '').toLowerCase();
    if (['car','vehicle','vehicles'].includes(type)) type='cars';
    if (['weapon','weapons','equipment'].includes(type)) type='equipment';
    if (['resource','resources'].includes(type)) type='resources';
    if (['item','items'].includes(type)) type='items';
    return {id:actualId,type,resource:String(role.resource_type ?? me.resource_type ?? known.resource ?? '').toLowerCase(),role};
  }
  function ocCandidates(obj,word) {
    // Contribution availability may be wrapped in arrays under e.g. 'cars',
    // 'available_cars', or 'options'. Only use actual, returned candidate objects.
    const out=[];
    const walk=(node,depth,key='')=>{
      if(depth>4 || !node || typeof node!=='object') return;
      if(Array.isArray(node)) {
        if(word.test(key) || key==='options' || key==='available') {
          for(const entry of node) if(entry && typeof entry==='object' && !Array.isArray(entry)) out.push(entry);
        } else for(const entry of node) walk(entry,depth+1,key);
      } else {
        for(const [k,v] of Object.entries(node)) if(v && typeof v==='object') walk(v,depth+1,k);
      }
    };
    walk(obj,0);
    return out;
  }
  function ocAllowed(c,allowLocked=false) {
    return c.is_usable!==false && c.can_use!==false && c.can_contribute!==false &&
      c.is_within_mastery!==false && (allowLocked || (!c.locked && !c.is_locked)) && !c.is_damaged &&
      c.damaged!==true && c.is_owned!==false && c.available!==false;
  }
  async function ocContribute(me) {
    const info=ocRoleInfo(me);
    if(!info.type) { ocNote('Joined, but no recognised contribution type for this role — check diagnostics.','warn'); return false; }
    let payload=null,desc='';
    if(info.type==='resources') {
      if(!['nerve','focus','wit','energy'].includes(info.resource)) {
        ocNote('Joined '+(OC_ROLES[info.id]||'OC')+', but required resource is unknown.','warn');return false;
      }
      // A mastery lookup is informative, but failure must not prevent trying a
      // valid resource contribution from an otherwise usable session.
      let mastery={};
      try { mastery=await GET('/oc2/mastery'); }
      catch (e) { ocNote('OC mastery unavailable; using role limit if known.','warn'); }
      const current=(mastery.roles||[]).find(r=>num(r.id)===info.id)?.currentLevel||{};
      const limit=num(current['max_'+info.resource])||num(info.role['max_'+info.resource])||num(info.role.max_contribution)||50;
      const qty=Math.min(limit,Math.floor(cur(info.resource)));
      if(qty<1) {ocNote('Waiting for '+info.resource+' to contribute (requires '+(limit||1)+ ' max).');return false;}
      payload={type:'resource',resource_type:info.resource,quantity:qty};
      desc=`${qty} ${info.resource}`;
    } else {
      const opts=await GET('/oc2/contributions');
      if(info.type==='cars') {
        const cars=ocCandidates(opts,/car|vehicle|garage/i)
          .filter(c=>ocAllowed(c,true) && (c.character_garage_id!=null || c.garage_id!=null || c.id!=null))
          .sort((a,b)=>num(a.value ?? a.price ?? a.sell_value)-num(b.value ?? b.price ?? b.sell_value));
        const c=cars[0];
        if(!c) {ocNote('Joined as Driver, but no eligible car was offered for contribution.','warn');return false;}
        payload={type:'car',character_garage_id:c.character_garage_id ?? c.garage_id ?? c.id};
        desc=c.name||'car';
      } else if(info.type==='equipment') {
        const gear=ocCandidates(opts,/weapon|equipment|gear/i)
          .filter(c=>ocAllowed(c) && !c.is_equipped && (c.character_equipment_id!=null || c.id!=null))
          .sort((a,b)=>num(a.value ?? a.price ?? a.power)-num(b.value ?? b.price ?? b.power));
        const c=gear[0];
        if(!c) {ocNote('Joined as Weapons Expert, but no eligible equipment was offered.','warn');return false;}
        payload={type:'equipment',character_equipment_id:c.character_equipment_id ?? c.id};
        desc=c.name||'equipment';
      } else if(info.type==='items') {
        const items=ocCandidates(opts,/item|inventory|consumable/i)
          .filter(c=>ocAllowed(c) && c.id!=null && c.is_premium!==true && c.requires_points!==true &&
            !/points|premium/i.test(String(c.currency||c.payment_currency||'')) &&
            num(c.points_cost||c.cost_points)===0 &&
            num(c.quantity ?? c.owned_quantity ?? 1)>=num(c.quantity_required ?? 1))
          .sort((a,b)=>num(a.price ?? a.value)-num(b.price ?? b.value));
        const c=items[0];
        if(!c) {ocNote('Joined, but no eligible leader item was offered.','warn');return false;}
        payload={type:'item',item_id:c.id,quantity:num(c.quantity_required)||1};
        desc=c.name||'item';
      }
    }
    if(!payload) {ocNote('Contribution options not recognised for '+(OC_ROLES[info.id]||'OC role'),'warn');return false;}
    // Submit ONE request and require the next session read to confirm it before
    // proceeding to Ready. No blind double-spend retry if the server lags.
    const reply=await POST('/oc2/contributions',payload);
    if(reply?.success===false || reply?.error) {
      ocNote('Contribution declined: '+String(reply.error||reply.message||'server rejected').slice(0,80),'warn');
      return false;
    }
    ocNote('Submitted '+desc+' contribution; checking session before readying.','good');
    return true;
  }
  // Public OC discovery must compare location IDs/names, not object identity.
  function ocLocationKey(v) {
    if(v==null) return '';
    if(typeof v==='object')return String(v.id ?? v.location_id ?? v.name ?? v.location_name ?? '').toLowerCase().trim().replace(/^the\s+/, '');
    return String(v).toLowerCase().trim().replace(/^the\s+/, '');
  }
  function ocSameLocation(session,origin) {
    const a=ocLocationKey(session.location_id ?? session.location ?? session.district);
    const b=ocLocationKey(origin.yourLocationId ?? origin.yourLocation ?? origin.current_location_id ?? origin.character?.location);
    return !!a && !!b && a===b;
  }
  function ocPublic(session) {
    return session.is_public===true || session.isPublic===true ||
      String(session.visibility || session.access || '').toLowerCase()==='public';
  }
  function ocRealPlayers(session) {
    const people=Array.isArray(session.participants)?session.participants:[];
    if(people.length!==5)return false;
    return people.every(p=>p && p.is_npc!==true && p.isNpc!==true && p.is_underboss!==true &&
      p.isUnderboss!==true && !/underboss|associate/i.test(String(p.name||p.display_name||'')));
  }
  function ocEveryoneReady(session) {
    const people=Array.isArray(session.participants)?session.participants:[];
    return ocRealPlayers(session) && people.every(p=>
      p.is_ready===true || p.isReady===true || String(p.status||'').toLowerCase()==='ready');
  }
  function ocReadyForContribution(role) {
    const ready=role?.readiness;
    if(!ready || ready.can_contribute!==true)return false;
    if(ready.usable_items_count!=null && Number(ready.usable_items_count)<=0)return false;
    const type=String(role.contribution_type||'').toLowerCase();
    if(type==='resources'){
      const options=Array.isArray(ready.items_preview)?ready.items_preview:[];
      const effective=Number(options[0]?.effective_contribution??options[0]?.available??0);
      return Number.isFinite(effective)&&effective>0;
    }
    if(['cars','equipment','items'].includes(type)){
      return Array.isArray(ready.items_preview) && ready.items_preview.some(v=>v?.is_usable===true);
    }
    return false;
  }
  function ocExclude(sessionId,roleId) {
    if(!sessionId || !Number(roleId))return;
    const key=String(sessionId);const rows=st.ocExcluded[key]||[];
    st.ocExcluded[key]=[...new Set([...rows,Number(roleId)])];
    GM_setValue(OC_EXCLUDED_ROLES_KEY,JSON.stringify(st.ocExcluded));
  }
  function ocSetExitHold(v){st.ocExitHold=v;GM_setValue(OC_UNFUNDED_EXIT_KEY,JSON.stringify(v));}
  function ocLeaveUnfunded(session,me,why) {
    // Never abandon a started OC, a submitted contribution, or anyone's
    // confirmed resources. No unverified API endpoint is invented here.
    if(!session || !me || ocHasContribution(me) || String(session.status||'').toLowerCase()!=='planning')return false;
    const id=ocId(session);
    if(st.ocPending?.id===id){ocNote('Contribution may have been submitted; do not leave until confirmed','warn');return false;}
    const hold=st.ocExitHold;
    if(hold?.id===id && hold.stage==='confirmed'){
      ocNote('Leave confirmation submitted; waiting for session to close');
      return false;
    }
    if(hold?.id===id && now()-Number(hold.at||0)>120000){
      ocNote('OC leave outcome unknown after two minutes; manual review required','warn');
      return false;
    }
    if(!/^\/game\/organised-crime\/?$/.test(location.pathname)){
      if(now()-num(st.lastOcHostNav)<15000)return false;
      st.lastOcHostNav=now();location.assign('/game/organised-crime');
      ocNote('Cannot contribute; opening OC page to leave safely','warn');return true;
    }
    const dialogs=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(ocVisible);
    if(hold?.id===id && !dialogs.length){
      ocNote('Leave clicked; awaiting confirmation or session update');
      return false;
    }
    const scope=dialogs.length===1?dialogs[0]:(document.querySelector('main')||document.body);
    const candidates=[...scope.querySelectorAll('button,[role="button"]')].filter(ocVisible)
      .filter(b=>/^(?:leave(?:\s+(?:oc|operation|session))?|confirm\s+leave|yes,?\s+leave)$/i.test(ocElementText(b)));
    if(candidates.length!==1){ocNote('Unable to verify Leave OC control; manual exit needed to avoid holding players','warn');return false;}
    ocExclude(id,ocRoleInfo(me).id);
    ocSetExitHold({id,at:now(),role:ocRoleInfo(me).id,stage:dialogs.length===1?'confirmed':'clicked'});
    candidates[0].click();
    ocNote('Unfunded OC seat: requested Leave; will choose another ready role after exit is confirmed','warn');
    return true;
  }
  function ocSetContributionHold(hold) {
    st.ocPending=hold;GM_setValue(OC_CONTRIBUTION_HOLD_KEY,JSON.stringify(hold));
  }
  function ocSetActionHold(hold) {
    st.ocActionHold=hold;
    GM_setValue(OC_ACTION_HOLD_KEY,JSON.stringify(hold));
  }
  function ocActionStillPending(id,me,session) {
    const h=st.ocActionHold;
    if(!h || h.sessionId!==id) {
      if(h)ocSetActionHold(null);
      return false;
    }
    const ap=Number(me.action_points ?? me.actionPoints);
    const boxes=Number(me.remaining_lockboxes ?? me.personal_boxes_remaining ?? me.lockbox?.remaining_actions ??
      session.lockbox?.remaining_actions);
    const acted=(Array.isArray(session.actions)?session.actions:[]).find(a=>String(a.id)===h.actionId);
    if(h.kind==='lockbox-confirmed')return false;
    const confirmed = (h.kind==='action' && Number.isFinite(ap) && ap < h.beforeAp) ||
      (h.kind==='action' && !!acted && (acted.is_completed===true || acted.is_emptied===true)) ||
      (h.kind==='lockbox' && Number.isFinite(boxes) && boxes < h.beforeBoxes);
    if(confirmed){ocSetActionHold(null);return false;}
    if(now()-h.at>=12000){
      ocNote('Action submission not yet confirmed by AP/box counters; no automatic replay.','warn');
    } else ocNote('Waiting for OC action result before choosing another.');
    // Failure/timeout results are not evidence that a paid action never ran.
    // Require a confirmed state change (or a new session) to avoid replay.
    return true;
  }
  function ocVisible(el) {
    return !!el && !el.disabled && el.getAttribute('aria-disabled')!=='true' &&
      !el.closest('#mbx') && !!el.getClientRects?.().length;
  }
  function ocElementText(el) {return String(el?.innerText||el?.textContent||'').replace(/\s+/g,' ').trim();}
  function ocCreatePanel() {
    const page=document.querySelector('main')||document.body;
    const txt=ocElementText(page);
    if(!/create\s+(?:an?\s+)?(?:organised|organized|oc)|choose\s+(?:an?\s+)?operation|select\s+(?:an?\s+)?operation/i.test(txt))return null;
    return page;
  }
  // Hosting uses ONLY observed UI controls. It never invents an /oc2/create
  // endpoint or submits a private/two-player OC when form state is uncertain.
  const OC_PRIORITY=['Import Dock Raid','Sporting Goods Robbery','Casino Robbery'];
  function ocOperationRank(label) {
    const s=String(label||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    const variants=[/import\s+dock\s+raid|dock\s+raid/,/sporting\s+goods/,/casino\s+(?:heist|robbery)|casino/];
    const i=variants.findIndex(re=>re.test(s));
    return i<0?OC_PRIORITY.length:i;
  }
  function ocSessionOperation(session) {
    return session?.operation?.name ?? session?.operation_name ?? session?.operationName ??
      session?.crime_type?.name ?? session?.crime_type ?? session?.type?.name ??
      session?.operation ?? session?.type ?? '';
  }
  function ocHostPublicFive() {
    if(!S.oc.hostPublicFive)return false;
    if(!/^\/game\/organised-crime\/?$/.test(location.pathname)) {
      if(now()-num(st.lastOcHostNav||0)<15*60000)return false;
      st.lastOcHostNav=now();
      location.assign('/game/organised-crime');
      ocNote('Opening OC page to prepare a public five-player lobby.');
      return true;
    }
    const page=ocCreatePanel();
    if(!page){ocNote('OC Create form is not visible; public five-player host remains pending.');return false;}
    const buttons=[...page.querySelectorAll('button,[role="button"]')].filter(ocVisible);
    // Start by opening the Create OC form, not clicking any Start OC button.
    const open=buttons.find(b=>/^create\s+(?:an?\s+)?(?:oc|organised crime|organized crime)$/i.test(ocElementText(b)));
    const formText=ocElementText(page);
    const hasFive=/\b(?:5\s+(?:players|seats|members)|(?:players|seats|members)\s*[:\-]?\s*5)\b/i.test(formText);
    const hasPublic=/\bpublic\b/i.test(formText);
    if(open && !(hasFive&&hasPublic)){
      if(now()-num(st.lastOcFormOpen||0)<5*60000)return false;
      st.lastOcFormOpen=now();open.click();ocNote('Opened Create OC; checking Public / five seats before submission.');return true;
    }
    // Form values must be *verifiably selected*. Merely displaying an option
    // labelled Public or 5 is not confirmation of its selected state.
    const fields=[...page.querySelectorAll('input,select,button,[role="switch"],[role="radio"]')]
      .filter(el=>!el.closest('#mbx'));
    const publicControl=fields.find(el=>/public/i.test(String([el.getAttribute('aria-label'),el.getAttribute('name'),el.id,el.getAttribute('title'),ocElementText(el)].join(' '))) &&
      (/^(INPUT|SELECT)$/.test(el.tagName) || /^(switch|radio)$/.test(el.getAttribute('role')||'')));
    const publicSelected=!!publicControl && (publicControl.checked===true || publicControl.getAttribute('aria-checked')==='true' ||
      (publicControl.tagName==='SELECT' && String(publicControl.value||'').toLowerCase()==='public'));
    const sizeControl=fields.find(el=>/(?:players|members|seats|crew size|team size)/i.test(String([el.getAttribute('aria-label'),el.getAttribute('name'),el.id].join(' '))));
    const fiveSelected=!!sizeControl && (
      (sizeControl.tagName==='SELECT' && String(sizeControl.value)==='5') ||
      (sizeControl.tagName==='INPUT' && String(sizeControl.value)==='5') ||
      (sizeControl.getAttribute('aria-pressed')==='true' && /\b5\b/.test(ocElementText(sizeControl))));
    // Select highest-priority operation that is actually visible and enabled.
    const opControl=fields.find(el=>/operation|type/i.test(String([el.getAttribute('aria-label'),el.getAttribute('name'),el.id].join(' '))));
    const availableOps=opControl?.tagName==='SELECT' ? [...opControl.options]
      .map(opt=>({label:ocElementText(opt),value:opt.value,rank:ocOperationRank(ocElementText(opt))}))
      .filter(opt=>opt.rank<OC_PRIORITY.length && !opt.disabled)
      .sort((a,b)=>a.rank-b.rank) : [];
    const preferredOption=availableOps[0]||null;
    const operation=preferredOption?.label||OC_PRIORITY[0];
    const operationSelected=!!opControl && (
      (preferredOption!=null && String(opControl.value||'')===String(preferredOption.value)) ||
      (opControl.tagName==='SELECT' && [...opControl.selectedOptions].some(opt=>
        ocElementText(opt).toLowerCase().includes(operation.toLowerCase()))) ||
      (opControl.getAttribute('aria-pressed')==='true' && ocElementText(opControl).toLowerCase().includes(operation.toLowerCase())));
    if(!publicSelected){
      // Only an unambiguous native control may be changed automatically.
      if(publicControl?.tagName==='INPUT' && ['checkbox','radio'].includes(publicControl.type) && !publicControl.checked){
        publicControl.click();ocNote('Selected Public; verifying the updated form.');return true;
      }
      if(publicControl?.tagName==='SELECT'){
        const option=[...publicControl.options].find(opt=>/public/i.test(ocElementText(opt)));
        if(option){publicControl.value=option.value;publicControl.dispatchEvent(new Event('change',{bubbles:true}));
          ocNote('Selected Public; verifying the updated form.');return true;}
      }
    }
    if(publicSelected && !fiveSelected && sizeControl){
      if(sizeControl.tagName==='SELECT'){
        const option=[...sizeControl.options].find(opt=>String(opt.value)==='5' || /^5(?:\s+players)?$/i.test(ocElementText(opt)));
        if(option){sizeControl.value=option.value;sizeControl.dispatchEvent(new Event('change',{bubbles:true}));
          ocNote('Selected five seats; verifying the updated form.');return true;}
      }
      if(sizeControl.tagName==='INPUT' && sizeControl.type==='number' && num(sizeControl.max)>=5 && num(sizeControl.min)<=5){
        sizeControl.value='5';sizeControl.dispatchEvent(new Event('input',{bubbles:true}));sizeControl.dispatchEvent(new Event('change',{bubbles:true}));
        ocNote('Selected five seats; verifying the updated form.');return true;
      }
    }
    if(publicSelected && fiveSelected && !operationSelected && opControl?.tagName==='SELECT'){
      const option=[...opControl.options].find(opt=>opt.value===preferredOption?.value);
      if(option){opControl.value=option.value;opControl.dispatchEvent(new Event('change',{bubbles:true}));
        ocNote('Selected '+operation+'; verifying the updated form.');return true;}
    }
    if(!publicSelected || !fiveSelected || !operationSelected){
      ocNote('Host form must explicitly confirm Public, five human seats and '+operation+'; leaving unverified fields for review.','warn');
      return false;
    }
    if(st.ocHostHold){
      ocNote('Public OC creation result unresolved; no duplicate submission.');return false;
    }
    const start=buttons.filter(b=>/^(?:start|create)\s+(?:oc|organised crime|organized crime)$/i.test(ocElementText(b)));
    if(start.length!==1){ocNote('Public five-seat form verified but start control is ambiguous; leaving it untouched.','warn');return false;}
    st.ocHostHold={at:now(),kind:'public-five'};
    GM_setValue(OC_HOST_HOLD_KEY,JSON.stringify(st.ocHostHold));
    start[0].click();ocNote('Submitted public five-player OC; waiting for planning lobby.','good');return true;
  }
  function ocStartReadyFive(session,me) {
    if(!S.oc.startWhenReady || !ocPublic(session) || !ocEveryoneReady(session))return false;
    const role=ocRoleInfo(me);
    if(role.id!==1)return false;
    if(!/^\/game\/organised-crime\/?$/.test(location.pathname)){
      if(now()-num(st.lastOcHostNav||0)<15000)return false;
      st.lastOcHostNav=now();location.assign('/game/organised-crime');return true;
    }
    const candidates=[...document.querySelectorAll('main button,main [role="button"]')]
      .filter(ocVisible).filter(b=>/^start\s+oc$/i.test(ocElementText(b)));
    if(candidates.length!==1){ocNote('Five real players Ready, but Start OC control is ambiguous; manual check needed.','warn');return false;}
    if(st.ocHostHold && st.ocHostHold.kind==='start-five')return false;
    st.ocHostHold={at:now(),kind:'start-five'};GM_setValue(OC_HOST_HOLD_KEY,JSON.stringify(st.ocHostHold));
    candidates[0].click();ocNote('Starting fully Ready five-player public OC; awaiting live phase.','good');return true;
  }
  async function doOc() {
    // Active three-minute OC needs 5s checks; idle discovery checks rarely.
    if(now()-st.lastOcCheck<(st.ocPhase==='active'?3500:10000)) return false;
    st.lastOcCheck=now();
    const o=await GET('/oc2');
    const s=o.activeSession ?? o.active_session ?? null;
    st.ocPhase='idle';
    if(!s && st.ocExitHold){ocSetExitHold(null);st.lastOcCheck=0;}
    if(s && s.status!=='completed' && s.status!=='cancelled') {
      if(st.ocHostHold){st.ocHostHold=null;GM_setValue(OC_HOST_HOLD_KEY,'null');}
      const id=ocId(s);
      const me=ocMe(s,o);
      if(!me) {ocNote('Active session found, but could not identify our participant. Manual check needed.','warn');return false;}
      const status=String(s.status||'').toLowerCase();
      const live=['active','running','underway','in_progress','in-progress'].includes(status) ||
        s.is_underway===true || s.is_running===true || s.phase==='action';
      st.ocPhase=live?'active':'planning';
      if(['time_up','timeup','expired','finishing','finalising','finalizing'].includes(status)){
        ocNote('OC action timer ended; waiting for server to finalise rewards.');return false;
      }
      if(!live) {
        const contributed=ocHasContribution(me);
        if(ocStartReadyFive(s,me))return true;
        if(st.ocPending && st.ocPending.id!==id)ocSetContributionHold(null);
        if(contributed) {
          ocSetContributionHold(null); st.ocSessionReview=null;
          if(['joined','contributed','pending'].includes(String(me.status||'joined').toLowerCase()) && me.can_ready!==false) {
            await POST('/oc2/ready');
            ocNote('Contribution confirmed; sent Ready.','good');
            st.lastOcCheck=0;
            return true;
          }
          ocNote('Contribution confirmed; waiting for OC to start.');
          return false;
        }
        if(!S.oc.contribute) {ocNote('Joined, but auto-contribute is disabled in Options.','warn');return false;}
        const max=me.max_contributions ?? me.maxContributions;
        if(max!=null && Number.isFinite(Number(max)) && Number(max)<=0 && me.can_contribute===false) {
          ocNote('Server says this participant cannot contribute. Leaving unfunded seat.','warn');
          return ocLeaveUnfunded(s,me,'server denied contribution');
        }
        if(st.ocPending?.id===id) {
          if(now()-st.ocPending.at<15000) {ocNote('Waiting for contribution confirmation.');return false;}
          st.ocSessionReview=id;
          ocNote('Contribution still unconfirmed; not retrying automatically (avoid double spending).','warn');return false;
        }
        if(st.ocSessionReview===id) return false;
        if(await ocContribute(me)) {
          ocSetContributionHold({id,at:now()});
          st.lastOcCheck=0;
          return true;
        }
        return ocLeaveUnfunded(s,me,'no eligible contribution');
      }
      ocSetContributionHold(null);st.ocSessionReview=null;
      if(s.is_working===true || s.action_in_progress===true || me.is_working===true){
        ocNote('OC action in progress; waiting for result.');return false;
      }
      if(ocActionStillPending(id,me,s))return false;
      const lockLeft=num(me.remaining_lockboxes ?? me.personal_boxes_remaining ?? me.lockbox?.remaining_actions ??
        s.lockbox?.remaining_actions ?? me.remaining_actions);
      const lockboxDone=st.ocActionHold?.sessionId===id && st.ocActionHold?.kind==='lockbox-confirmed';
      if(lockLeft>0 && !lockboxDone && !s.is_expired) {
        ocSetActionHold({sessionId:id,kind:'lockbox',beforeBoxes:lockLeft,at:now()});
        const r=await POST('/oc2/minigames/lockbox');
        const amt=num(r?.rewards?.amount);
        if(r?.success===true && (r?.rewards || r?.result?.rewards))
          ocSetActionHold({sessionId:id,kind:'lockbox-confirmed',at:now()});
        st.stats.cash+=amt;
        ocNote(`Lockbox action submitted${amt?' ('+money(amt)+')':''}`,'good');
        st.lastOcCheck=0;
        return true;
      }
      const ap=num(me.action_points);
      const act=(s.actions||[])
        .filter(a=>a?.id!=null && num(a.action_point_cost)<=ap && a.can_afford!==false &&
          !a.is_completed && !a.is_emptied && a.available!==false && a.is_working!==true)
        .sort((a,b)=>{
          // A free, code-unlocked vault must be opened before the timer ends.
          const av=/vault|safe/i.test(String(a.name||'')) && num(a.action_point_cost)===0;
          const bv=/vault|safe/i.test(String(b.name||'')) && num(b.action_point_cost)===0;
          if(av!==bv)return av?-1:1;
          // Prefer known remaining value per AP instead of blindly picking
          // the most expensive action. Missing data uses original cost order.
          const va=firstNumber(a,['remaining_cash','expected_cash','cash_reward']);
          const vb=firstNumber(b,['remaining_cash','expected_cash','cash_reward']);
          const sa=va!=null?va/Math.max(1,num(a.action_point_cost)):-1;
          const sb=vb!=null?vb/Math.max(1,num(b.action_point_cost)):-1;
          return sa!==sb?sb-sa:num(b.action_point_cost)-num(a.action_point_cost);
        })[0];
      if(act && !s.is_expired) {
        ocSetActionHold({sessionId:id,kind:'action',beforeAp:ap,actionId:String(act.id),at:now()});
        const reply=await POST(`/oc2/minigames/actions/${act.id}/attempt`);
        // An explicit *post-action* AP counter is independent confirmation.
        // A simple HTTP 200 / success flag is not proof of an applied debit.
        const afterAp=firstNumber(reply,['remaining_action_points','action_points_remaining',
          'remaining_ap','participant.action_points','me.action_points']);
        if(afterAp!=null && afterAp<ap)ocSetActionHold(null);
        ocNote('Action submitted: '+(act.name||act.id),'good');
        st.lastOcCheck=0;
        return true;
      }
      ocNote('OC active; no lockbox or affordable action available.');
      return false;
    }
    if(o.ocCharges?.can_perform_oc===false) {ocNote('No OC charge/permission available.');return false;}
    const pref=(S.oc.roles||[]).map(Number);
    // Research preference: public first, then eligible invitations, then host.
    const publicSource=o.publicSessions||o.public_sessions||[];
    const publicLobbies=(Array.isArray(publicSource)?publicSource:Object.values(publicSource))
      .filter(Boolean).map((ses,index)=>({ses,index,rank:ocOperationRank(ocSessionOperation(ses))}))
      .sort((a,b)=>a.rank-b.rank||a.index-b.index).map(x=>x.ses);
    for(const ses of publicLobbies) {
      if(ses.can_join===false || !ocSameLocation(ses,o)) continue;
      const ar=await GET(`/oc2/session/${ses.id}/available-roles`);
      let roles=ar.availableRoles||[];
      if(!Array.isArray(roles)) roles=Object.values(roles);
      const excluded=st.ocExcluded[String(ses.id)]||[];
      const role=pref.map(id=>roles.find(r=>num(r.id)===id && r.can_join!==false &&
        !excluded.includes(id) && ocReadyForContribution(r))).find(Boolean);
      if(!role) continue;
      await POST('/oc2/join-public',{session_id:ses.id,role_id:role.id});
      ocNote('Joined '+(typeof ses.leader==='string'?ses.leader:'public')+' OC as '+(role.name||OC_ROLES[role.id]||'crew')+'; readiness verified, contributing next.','good');
      st.ocPhase='planning';
      st.stats.ocs++;st.lastOcCheck=0;
      return true;
    }
    if(S.oc.acceptInvites) {
      const inv=await GET('/oc2/invitations');
      const list=inv.invitations||inv.data||[];
      const take=Array.isArray(list)?list.find(i=>pref.includes(num(i.role_id ?? i.role?.id))):null;
      if(take && take.readiness?.can_contribute===true && ocReadyForContribution(take.role||take)) {
        await POST('/oc2/invitations/accept',{invitation_id:take.id});
        ocNote('Accepted invite as '+(OC_ROLES[num(take.role_id ?? take.role?.id)]||'crew')+'; checking contribution.','good');
        st.stats.ocs++; st.lastOcCheck=0;
        return true;
      }
    }
    // Hosting without confirmed leader items would strand up to four players.
    // Only host when game explicitly exposes a usable leader contribution.
    const leaderReady=o.leaderRole?.readiness??o.leaderReadiness??null;
    if(S.oc.hostPublicFive && leaderReady && ocReadyForContribution({...o.leaderRole,readiness:leaderReady}) && ocHostPublicFive())return true;
    ocNote('No ready OC seats; hosting held until a usable leader item is verified.');
    return false;
  }

  // Burglary is now part of the single Crimes slot (not a separate module).
  async function doCrimeGroup() {
    if (S.crimes.mixEnabled && S.modules.burglary && preferredCrimeType()==='burglary') {
      if (await doBurglary()) return true;
    }
    return doCrimes();
  }

  const MODULE_ORDER = [
    ['dailies', doDailies],
    ['missions', doMissions],
    ['empire', doEmpire],
    ['mobpass', doMobPass],
    ['bosses', doBosses],
    ['oc', doOc],
    ['garage', doGarage],
    ['smuggling', doSmuggling],
    ['trading', doTrade],
    ['workshop', doWorkshop],
    ['jobs', doJobs],
    ['heists', doHeists],
    ['gta', doGta],
    ['crimes', doCrimeGroup],
    ['gym', doGym],
    ['busting', doBusting],
  ];

  // TMN-style module control: one compatible scheduler, no duplicate action loops.
  const MODULE_NAMES = {
    dailies:'Daily rewards', missions:'Mission claims', empire:'Empire collection', mobpass:'MOB Pass', bosses:'Bosses', oc:'Organised crime',
    smuggling:'Smuggling', garage:'Garage', trading:'Drug trading', workshop:'Workshop', jobs:'Jobs',
    heists:'Heists', gta:'GTA', burglary:'Burglary', crimes:'Crimes', gym:'Gym', busting:'Jail busting'
  };
  const BASE_ORDER = MODULE_ORDER.map(([key]) => key);
  // User-defined normal priority for all built-in modes. The selected mode
  // still controls the XP/money objective, but not the preferred activity order.
  // Deadlines and readiness guards can temporarily promote time-sensitive work.
  const USER_PRIORITY_ORDER = ['crimes','gta','heists','jobs','oc','workshop','gym','busting','smuggling','trading','garage','bosses','empire','mobpass','missions','dailies'];
  const STRATEGY_ORDER = {
    balanced: USER_PRIORITY_ORDER, xp: USER_PRIORITY_ORDER,
    money: USER_PRIORITY_ORDER, progression: USER_PRIORITY_ORDER,
  };
  const availableModule = Object.fromEntries(MODULE_ORDER);
  function moduleKeys() {
    const mode = S.scheduler.mode || 'balanced';
    const order = mode === 'custom' ? S.scheduler.customOrder : STRATEGY_ORDER[mode];
    const proposed = Array.isArray(order) ? order.filter(k => availableModule[k]) : [];
    return [...new Set([...proposed, ...BASE_ORDER])];
  }
  function preferredCrimeModuleFirst(pairs){
    if(!S.crimes.mixEnabled || !S.modules.crimes || !S.modules.burglary)return pairs;
    const c=pairs.findIndex(p=>p[0]==='crimes'),b=pairs.findIndex(p=>p[0]==='burglary');
    if(c<0||b<0)return pairs;
    const burglaryFirst=preferredCrimeType()==='burglary';
    if((burglaryFirst&&b>c)||(!burglaryFirst&&c>b)){
      [pairs[b],pairs[c]]=[pairs[c],pairs[b]];
    }
    return pairs;
  }
  function prioritizedModules() {
    const keys=moduleKeys();
    if (!S.scheduler.alternateResources) return preferredCrimeModuleFirst(keys.map(k=>[k,availableModule[k]]));
    // Preserve the strategy's non-resource module slots/priorities, but rotate
    // nerve, focus, wit and energy modules through resource slots. Burglary and
    // Crimes share nerve, so their targets stay consistent.
    const resourceKeys=keys.filter(k=>MODULE_RESOURCE[k]);
    const start=Math.max(0,RESOURCE_ORDER.indexOf(st.nextResource));
    const rotated=[...RESOURCE_ORDER.slice(start),...RESOURCE_ORDER.slice(0,start)];
    const sorted=rotated.flatMap(r=>resourceKeys.filter(k=>MODULE_RESOURCE[k]===r));
    let i=0;
    return preferredCrimeModuleFirst(keys.map(k=>[MODULE_RESOURCE[k] ? sorted[i++] : k,
      availableModule[MODULE_RESOURCE[k] ? sorted[i-1] : k]]));
  }
  // V2.3.14: due Drug Market trading needs a fair turn even before it has
  // bought stock. Previously it was promoted only *after* a trade plan existed,
  // so busy crimes/GTA/workshop loops could starve its initial buy forever.
  // A cooldown/backoff is still authoritative; never force an early API poll.
  function prioritizeTimeSensitiveModules(runOrder, at=now()) {
    const raise=(key)=>{
      const index=runOrder.findIndex(([k])=>k===key);
      if(index>0)runOrder.unshift(...runOrder.splice(index,1));
    };
    // Prevent indefinite starvation: any enabled, currently eligible module
    // which has not had a check for 2 minutes earns a fair turn. Respect
    // individual nextAllowed backoffs, resource refill and server rate limits.
    const overdue=runOrder
      .filter(([key])=>S.modules[key] && at>=metric(key).nextAllowed &&
        at-Number(metric(key).lastCheckAt||0)>=120000)
      .sort(([a],[b])=>Number(metric(a).lastCheckAt||0)-Number(metric(b).lastCheckAt||0))[0];
    if(overdue)raise(overdue[0]);
    const tradingDue=S.modules.trading && at>=metric('trading').nextAllowed &&
      (tradePlan() || tradePending() || tradeTravelPending() ||
       (S.trading.loopTravel && tradingPair() &&
        (!st.tradeTravelReadyAt || st.tradeTravelReadyAt<=at)) ||
       at-Number(st.lastTradeCheck||0)>=120000);
    if(tradingDue)raise('trading');
    if(S.modules.smuggling && at-Number(st.lastSmuggleCheck||0)>=Number(S.smuggling.checkMinutes||5)*60000 &&
       at>=metric('smuggling').nextAllowed)raise('smuggling');
    // Never make a crew wait behind routine work when an OC is active or
    // preparing a contribution. An actual OC cooldown still wins.
    if(S.modules.oc && (st.ocPhase==='active' || st.ocPhase==='planning') &&
       at>=metric('oc').nextAllowed)raise('oc');
    return runOrder;
  }
  function setStrategy(mode) {
    if (!['balanced','xp','money','progression','custom'].includes(mode)) return;
    if (mode === 'custom' && (!Array.isArray(S.scheduler.customOrder) || !S.scheduler.customOrder.length)) {
      S.scheduler.customOrder = moduleKeys();
    }
    S.scheduler.mode = mode;
    st.nextAction = 0;
    save();
    log(`Strategy: ${mode} (module priorities + reward-aware targeting)`, 'info');
  }
  function moveModule(key, direction) {
    const order = [...moduleKeys()];
    const pos = order.indexOf(key);
    const dest = pos + direction;
    if (pos < 0 || dest < 0 || dest >= order.length) return;
    [order[pos], order[dest]] = [order[dest], order[pos]];
    S.scheduler.customOrder = order;
    S.scheduler.mode = 'custom';
    save();
    renderBody();
  }

  function safeConfigSnapshot() {
    const snapshot = JSON.parse(JSON.stringify(S));
    delete snapshot.running; delete snapshot.panel; delete snapshot.ntfyTopic;
    return snapshot;
  }
  function presets() {
    const p = safeParse(GM_getValue(PRESET_KEY, '[]'));
    return Array.isArray(p) ? p.filter(x => x && typeof x.name === 'string' && x.config) : [];
  }
  function storePresets(p) { GM_setValue(PRESET_KEY, JSON.stringify(p.slice(0, 15))); }
  function savePreset() {
    const raw = window.prompt('Name this configuration preset (max 32 characters):');
    if (raw === null) return;
    const name = raw.trim().slice(0,32);
    if (!name) return;
    const p = presets().filter(x => x.name !== name);
    p.unshift({name, createdAt: now(), config: safeConfigSnapshot()});
    storePresets(p);
    log(`Saved preset: ${name}`, 'good');
    renderBody();
  }
  function applyPreset(name) {
    const found = presets().find(x => x.name === name);
    if (!found) return;
    // Apply settings without unexpectedly starting/stopping or changing notification destination.
    const running = S.running, panel = S.panel, ntfyTopic = S.ntfyTopic;
    S = deepMerge(DEFAULTS, found.config);
    S.running = running; S.panel = panel; S.ntfyTopic = ntfyTopic;
    removeLegacySuccessLimits();
    removeFixedWaitLimits();
    normaliseResourceSettings();
    normalizeResearchOptions();
    st.resourceTargets = {}; st.resourceCycles={nerve:false,focus:false,wit:false};
    save(); st.nextAction = 0;
    log(`Applied preset: ${name}`, 'good');
    renderBody();
  }
  function deletePreset(name) {
    if (!window.confirm(`Delete preset "${name}"?`)) return;
    storePresets(presets().filter(x => x.name !== name));
    renderBody();
  }
  function downloadLocalFile(name, payload, mime='application/json') {
    const blob = new Blob([payload], {type: mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  function exportDiagnostics() {
    const modules = {};
    for (const key of BASE_ORDER) {
      const m = metric(key);
      modules[key] = {enabled: Boolean(S.modules[key]), checks:m.checks, actions:m.actions,
        errors:m.errors, lastSuccess:m.lastSuccess, lastError:m.lastError,
        lastErrorAt:m.lastErrorAt, avgMs:m.checks ? Math.round(m.totalMs/m.checks) : 0,
        backoffMs:Math.max(0,m.nextAllowed-now())};
    }
    const snapshot = {
      schema:'mobsteria-v2.3.8-diagnostics', time:new Date().toISOString(), version:'2.3.8',
      // No bearer tokens, cookies, or NTFY destination. Action logs may mention game character names.
      strategy:S.scheduler.mode, objective:objective(), priority:moduleKeys(),
      rewardLearning:Object.fromEntries(Object.entries(rewardObservations).map(([id,v])=>[id,{samples:v.xpCount,averageXp:v.xpCount?v.totalXp/v.xpCount:null}])) ,
      state:{running:S.running, challenge:st.challenge, otherTab:st.otherTab, paused:st.paused?.reason || null,
        ocStatus:st.ocStatus,ocPhase:st.ocPhase,ocActionHold:st.ocActionHold?{kind:st.ocActionHold.kind,ageMs:now()-st.ocActionHold.at}:null,
        ocPending:st.ocPending ? {sessionId:st.ocPending.id,ageMs:now()-st.ocPending.at} : null,
        missions:st.lastMissionSummary,empireStatus:st.empireStatus,smugglingStatus:st.smuggleStatus,smugglingLastCheckAt:st.lastSmuggleCheck,smugglingPending:st.smugglePending?{ageMs:now()-num(st.smugglePending.at)}:null,crimeNextType:preferredCrimeType(),resourceRegen:st.resourceRegenPerMin,nextCheckAt:st.nextAction,workshopPending:st.workshopPending?{name:st.workshopPending.name,ageMs:now()-num(st.workshopPending.at)}:null,
        lastModule:st.lastActionModule, lastActionAt:st.lastActionAt, lastHealthyAt:st.lastHealthyAt},
      settings:safeConfigSnapshot(), totals:{...st.stats}, modules,
      log:st.log.slice(0,100).map(x => ({t:x.t, type:x.type, msg:String(x.msg).replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/\b\d{1,12}\|[A-Za-z0-9]{16,}\b/g,'[REDACTED-TOKEN]').slice(0,280)}))
    };
    const filename=`mobsteria-diagnostics-${new Date().toISOString().slice(0,10)}.json`;
    downloadLocalFile(filename, JSON.stringify(snapshot,null,2));
    log('Downloaded local diagnostic report (no auth token)', 'good');
  }
  function resetTelemetry() {
    if (!window.confirm('Clear the local module counters and statistics? Settings will be kept.')) return;
    for (const k of Object.keys(st.stats)) st.stats[k] = 0;
    st.moduleHealth = {};
    for (const k of BASE_ORDER) {
      st.moduleHealth[k] = {checks:0, actions:0,errors:0,lastSuccess:0,lastError:'',lastErrorAt:0,totalMs:0,nextAllowed:0,consecutiveErrors:0};
    }
    telemetryDirty = true;
    persistTelemetry();
    renderBody();
    log('Statistics reset', 'info');
  }


  /* =========================================================
   *  LOCAL CHALLENGE RECOGNITION (no external AI service)
   *  Reads the challenge PNG, finds flat-colour objects, and
   *  uses their geometry, colour and proximity to answer.
   *  Unknown/ambiguous challenges remain manual.
   * ========================================================= */
  const CHALLENGE_TYPES = [
    [/\b(?:click|select)\s+the\s+group\s+(?:with|showing|containing|that\s+has)\s+(?:exactly\s+)?\d+\s+(?:items|shapes|objects)\b/i, 'Group counting'],
    [/\b(?:click|select)\s+(?:all\s+)?(?:the\s+)?(?:red|yellow|green|blue|purple|orange|pink)\b/i, 'Colour selection'],
    [/\b(?:click|select)\s+all\s+(?:the\s+)?(?:triangles?|circles?|squares?|stars?|hexagons?|diamonds?)\b/i, 'Shape selection'],
    [/\b(?:click|select)\s+the\s+(?:largest|smallest)\s+shape\b/i, 'Shape size'],
    [/\b(?:click|select)\s+the\s+word\b/i, 'Word recognition'],
  ];
  let lastChallengeInfo = '';
  let activeSolveKey = '';
  const attemptedSolves = new Set();
  let challengeSolving = false;

  function challengeDom() {
    const img = [...document.images].find(i =>
      /\/storage\/temp\/challenge_|\/canvas\.png/i.test(i.src) || i.alt === 'Challenge');
    if (!img || !img.getClientRects().length) return null;
    const visible = e => !!e.getClientRects().length && !e.closest('#mbx');
    const nodes = [...document.querySelectorAll('p.text-text-light.bold-text, p, h2, h3, h4')]
      .filter(visible);
    const instruction = nodes.map(e => (e.textContent || '').trim().replace(/\s+/g, ' '))
      .find(t => /^(?:click|select)\s+/i.test(t)) || '';
    const box = img.closest('.game-container') || img.parentElement?.parentElement?.parentElement || document;
    const button = [...box.querySelectorAll('button')]
      .find(b => /verify\s+selections?\s*\(/i.test(b.textContent || ''));
    return { img, instruction, button };
  }

  function challengeRule(text) {
    let m = text.match(/\b(?:click|select)\s+the\s+group\s+(?:with|showing|containing|that\s+has)\s+(?:exactly\s+)?(\d+)\s+(?:items|shapes|objects)\b/i);
    if (m) return { mode: 'group', count: Number(m[1]) };
    m = text.match(/\b(?:click|select)\s+the\s+(largest|smallest)\s+shape\b/i);
    if (m) return { mode: 'size', size: m[1].toLowerCase() };
    m = text.match(/\b(?:click|select)\s+the\s+word\s*:?\s*([a-z]{3,20})\b/i);
    if (m) return { mode: 'word', word: m[1].toUpperCase() };
    if (!/\b(?:click|select)\s+all\b/i.test(text)) return null;
    const cm = text.match(/\b(red|yellow|green|blue|purple|orange|pink)\b/i);
    const sm = text.match(/\b(triangles?|circles?|squares?|stars?|hexagons?|diamonds?)\b/i);
    const shape = sm && ({ triangles:'triangle', triangle:'triangle', circles:'circle', circle:'circle',
      squares:'square', square:'square', stars:'star', star:'star', hexagons:'hexagon',
      hexagon:'hexagon', diamonds:'diamond', diamond:'diamond' })[sm[1].toLowerCase()];
    return cm || shape ? { mode: 'all', colour: cm?.[1]?.toLowerCase() || null, shape: shape || null } : null;
  }

  function readChallengeImage(img) {
    // GM_xmlhttpRequest works even if the game's cross-origin IMG taints a canvas.
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: img.currentSrc || img.src, responseType: 'arraybuffer', timeout: 12000,
        onload: r => {
          if (r.status < 200 || r.status >= 300 || !r.response) return reject(new Error('Challenge PNG unavailable'));
          const blob = new Blob([r.response], { type: 'image/png' });
          const url = URL.createObjectURL(blob);
          const picture = new Image();
          picture.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement('canvas');
            canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            try { ctx.drawImage(picture, 0, 0); resolve(ctx.getImageData(0, 0, canvas.width, canvas.height)); }
            catch (e) { reject(e); }
          };
          picture.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Cannot decode challenge PNG')); };
          picture.src = url;
        },
        onerror: () => reject(new Error('Challenge PNG request failed')),
        ontimeout: () => reject(new Error('Challenge PNG request timed out')),
      });
    });
  }

  function cross(a, b, c) { return (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x); }
  function convexHull(points) {
    const ps = points.sort((a,b) => a.x-b.x || a.y-b.y);
    const lo = [], hi = [];
    for (const p of ps) { while (lo.length >= 2 && cross(lo[lo.length-2], lo[lo.length-1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i=ps.length-1;i>=0;i--) { const p=ps[i]; while (hi.length >= 2 && cross(hi[hi.length-2],hi[hi.length-1],p) <= 0) hi.pop(); hi.push(p); }
    lo.pop(); hi.pop(); return lo.concat(hi);
  }
  function polygonArea(poly) {
    let area=0; for (let i=0;i<poly.length;i++) { const p=poly[i],q=poly[(i+1)%poly.length]; area+=p.x*q.y-q.x*p.y; }
    return Math.abs(area)/2;
  }
  function hullVertices(hull) {
    if (hull.length < 3) return hull;
    let perimeter=0;
    for (let i=0;i<hull.length;i++) {
      const p=hull[i],q=hull[(i+1)%hull.length]; perimeter+=Math.hypot(p.x-q.x,p.y-q.y);
    }
    const eps=0.035*perimeter, poly=hull.slice();
    // Approximate the contour without OpenCV or another external library.
    while (poly.length>3) {
      let least=Infinity, index=-1;
      for (let i=0;i<poly.length;i++) {
        const a=poly[(i-1+poly.length)%poly.length], p=poly[i], b=poly[(i+1)%poly.length];
        const dx=b.x-a.x,dy=b.y-a.y, den=dx*dx+dy*dy || 1;
        const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/den));
        const d=Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
        if (d<least) { least=d; index=i; }
      }
      if (least>eps) break;
      poly.splice(index,1);
    }
    return poly;
  }
  function objectShape(o) {
    const n=o.vertices.length, solidity=o.area/Math.max(1,o.hullArea);
    if (solidity < 0.73 && n>=4 && n<=7) return 'star';
    const fullness=o.area/(o.w*o.h);
    // Circles may simplify to seven hull vertices in browser screenshots.
    // Their bounding-box fill is higher than a regular six-sided hexagon.
    if (n>=6 && fullness>0.765 && Math.min(o.w,o.h)/Math.max(o.w,o.h)>0.86) return 'circle';
    if (n===3) return 'triangle';
    if (n===4) {
      const p=o.vertices[0], q=o.vertices[1];
      const angle=((Math.atan2(q.y-p.y,q.x-p.x)*180/Math.PI)%90+90)%90;
      return angle>29 && angle<61 ? 'diamond' : 'square';
    }
    if (n>=5 && n<=7 && solidity>0.82) return 'hexagon';
    if (n>=8 && solidity>0.88) return 'circle';
    return 'unknown';
  }
  function objectColour(o) {
    const r=o.r/o.area, g=o.g/o.area, b=o.b/o.area;
    const max=Math.max(r,g,b), min=Math.min(r,g,b), dif=max-min;
    if (dif<25) return 'unknown';
    let hue=0;
    if (max===r) hue=60*((g-b)/dif%6);
    else if (max===g) hue=60*((b-r)/dif+2);
    else hue=60*((r-g)/dif+4);
    hue=(hue+360)%360;
    if (hue<15 || hue>=345) return 'red';
    // Mobsteria uses golden-yellow RGB(234,179,8), hue ~45.4 degrees.
    // Earlier orange<46 incorrectly classed these yellow shapes as orange.
    // Keep actual orange RGB(255,165,0), hue ~38.8 degrees, as orange.
    if (hue<42) return 'orange';
    if (hue<76) return 'yellow';
    if (hue<170) return 'green';
    if (hue<205) return 'blue';
    if (hue<260) return 'blue';
    if (hue<325) return 'purple';
    return 'pink';
  }

  function extractChallengeObjects(image) {
    const { width:w,height:h,data }=image;
    if (w<180 || h<130 || w>1200 || h>900) throw new Error('Unexpected image dimensions');
    const len=w*h, mask=new Uint8Array(len), seen=new Uint8Array(len), queue=new Int32Array(len);
    for (let i=0;i<len;i++) {
      const k=i*4, r=data[k],g=data[k+1],b=data[k+2];
      const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
      if (mx>=105 && mx-mn>=85 && data[k+3]>=200) mask[i]=1;
    }
    const objects=[];
    for (let i=0;i<len;i++) {
      if (!mask[i] || seen[i]) continue;
      let head=0,tail=1, minx=w,miny=h,maxx=0,maxy=0,sx=0,sy=0,r=0,g=0,b=0;
      let boundaries=[]; queue[0]=i; seen[i]=1;
      while(head<tail) {
        const v=queue[head++],x=v%w,y=(v/w)|0, k=v*4;
        minx=Math.min(minx,x);miny=Math.min(miny,y);maxx=Math.max(maxx,x);maxy=Math.max(maxy,y);
        sx+=x;sy+=y;r+=data[k];g+=data[k+1];b+=data[k+2];
        let edge=false;
        for(const q of [x>0?v-1:-1,x+1<w?v+1:-1,y>0?v-w:-1,y+1<h?v+w:-1]) {
          if(q<0 || !mask[q]) { edge=true;continue; }
          if(!seen[q]) {seen[q]=1;queue[tail++]=q;}
        }
        if(edge) boundaries.push({x,y});
      }
      const area=tail,bw=maxx-minx+1,bh=maxy-miny+1;
      if (area<80 || bw<10 || bh<10 || area>w*h*0.15) continue;
      const hull=convexHull(boundaries), vertices=hullVertices(hull);
      const o={x:sx/area,y:sy/area,area,r,g,b,w:bw,h:bh,hullArea:polygonArea(hull),vertices};
      o.shape=objectShape(o);o.colour=objectColour(o);
      objects.push(o);
    }
    objects.sort((a,b)=>a.y-b.y||a.x-b.x);
    if (objects.length<2 || objects.length>30) throw new Error(`Uncertain object count (${objects.length})`);
    return objects;
  }

  function solveGroupFromPixels(image, expectedCount) {
    // The previous connected-component method counted *blobs* rather than shapes.
    // Overlapping stars/circles merge into one blob, causing bogus '3 matches'.
    // Instead locate shape centres as peaks in an on-device distance transform.
    // These puzzles arrange three or four independent groups in the image quadrants.
    // A quadrant may legitimately be empty; don't reject a correct 3-group puzzle.
    const { width: w, height: h, data } = image;
    if (w < 180 || h < 130 || w > 1200 || h > 900)
      throw new Error('Unexpected group challenge image dimensions');
    const len = w * h, distance = new Uint16Array(len);
    for (let i = 0; i < len; i++) {
      const k = i * 4, r = data[k], g = data[k+1], b = data[k+2];
      const high = Math.max(r, g, b), low = Math.min(r, g, b);
      distance[i] = high >= 105 && high-low >= 85 && data[k+3] >= 200 ? 30000 : 0;
    }
    // A two-pass chamfer transform approximates the distance to the shape edge.
    // Each shape's thick centre becomes a peak, even when shapes touch.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y*w+x;
      if (!distance[i]) continue;
      let d = distance[i];
      if (x > 0) d = Math.min(d, distance[i-1] + 3);
      if (y > 0) {
        d = Math.min(d, distance[i-w] + 3);
        if (x > 0) d = Math.min(d, distance[i-w-1] + 4);
        if (x+1 < w) d = Math.min(d, distance[i-w+1] + 4);
      }
      distance[i] = d;
    }
    for (let y = h-1; y >= 0; y--) for (let x = w-1; x >= 0; x--) {
      const i = y*w+x;
      if (!distance[i]) continue;
      let d = distance[i];
      if (x+1 < w) d = Math.min(d, distance[i+1] + 3);
      if (y+1 < h) {
        d = Math.min(d, distance[i+w] + 3);
        if (x > 0) d = Math.min(d, distance[i+w-1] + 4);
        if (x+1 < w) d = Math.min(d, distance[i+w+1] + 4);
      }
      distance[i] = d;
    }
    const localRadius = Math.max(2, Math.round(w/100));
    const minDepth = Math.max(9, Math.round(w/400*12));
    const candidates = [];
    for (let y = localRadius; y < h-localRadius; y++) for (let x = localRadius; x < w-localRadius; x++) {
      const i = y*w+x, d = distance[i];
      if (d < minDepth) continue;
      let higher = false;
      for (let dy = -localRadius; dy <= localRadius && !higher; dy++) {
        for (let dx = -localRadius; dx <= localRadius; dx++) {
          if (distance[i+dy*w+dx] > d) { higher = true; break; }
        }
      }
      if (!higher) candidates.push({x, y, d});
    }
    candidates.sort((a,b) => b.d-a.d);
    // Collapse multiple maxima within one shape, retaining maxima for touching neighbours.
    const separation = Math.max(11, Math.round(w*0.035));
    const peaks = [];
    for (const p of candidates) {
      if (!peaks.some(q => (p.x-q.x)**2+(p.y-q.y)**2 < separation**2))
        peaks.push(p);
    }
    const groups = [[], [], [], []]; // top-left, top-right, bottom-left, bottom-right
    for (const p of peaks) groups[(p.y >= h/2 ? 2 : 0) + (p.x >= w/2 ? 1 : 0)].push(p);
    const occupiedGroups = groups.filter(g => g.length > 0);
    // Group puzzles may have 3 rather than 4 clusters (as in the Nov 13 challenge).
    // Still bail out on ambiguous/fragmented detection instead of guessing.
    const counts = groups.map(g => g.length);
    log(`Local solver: shape counts TL=${counts[0]}, TR=${counts[1]}, BL=${counts[2]}, BR=${counts[3]}`, 'info');
    if (occupiedGroups.length < 3 || occupiedGroups.length > 4 || occupiedGroups.some(g => g.length > 12))
      throw new Error(`Expected 3–4 recognizable groups, found ${occupiedGroups.length} (${counts.join('/')})`);
    const matches = occupiedGroups.filter(g => g.length === expectedCount);
    if (matches.length !== 1)
      throw new Error(`Group count not unique (${matches.length} matches: ${counts.join('/')})`);
    const group = matches[0];
    const mx = group.reduce((s,p)=>s+p.x,0)/group.length;
    const my = group.reduce((s,p)=>s+p.y,0)/group.length;
    // Click a visible shape near the centre of the selected group.
    const best = [...group].sort((a,b) => Math.hypot(a.x-mx,a.y-my)-Math.hypot(b.x-mx,b.y-my))[0];
    return [{ x: best.x, y: best.y }];
  }

  function answerChallenge(rule, objects, image) {
    if(rule.mode==='all') {
      if (objects.some(o => o.shape==='unknown' && rule.shape && (!rule.colour || o.colour===rule.colour)))
        throw new Error('Unrecognised shapes present');
      const matches=objects.filter(o=>(!rule.colour||o.colour===rule.colour)&&(!rule.shape||o.shape===rule.shape));
      if (!matches.length) {
        const counts = objects.reduce((a, o) => (a[o.colour]=(a[o.colour]||0)+1,a), {});
        log(`Local solver: detected colour counts ${Object.entries(counts).map(([k,v])=>`${k}=${v}`).join(', ')}`, 'info');
        throw new Error('No confident matches');
      }
      return matches;
    }
    if(rule.mode==='size') {
      const ordered=[...objects].sort((a,b)=>a.area-b.area);
      const a=rule.size==='largest'?ordered[ordered.length-1]:ordered[0];
      const b=rule.size==='largest'?ordered[ordered.length-2]:ordered[1];
      if (Math.max(a.area,b.area)/Math.min(a.area,b.area)<1.18)
        throw new Error('Size difference too small to be confident');
      return [a];
    }
    if(rule.mode==='group') {
      if(rule.count<1||rule.count>12) throw new Error('Unsupported group size');
      return solveGroupFromPixels(image, rule.count);
    }
    throw new Error('Unsupported instruction');
  }

  // Word CAPTCHA: match the requested word against local, colour-isolated
  // text silhouettes.  Does not use a network-based OCR/AI service.
  function captchaWordCandidates(image) {
    const {width:w,height:h,data}=image, n=w*h, labels=new Uint8Array(n), visited=new Uint8Array(n);
    function hueBucket(r,g,b) {
      const hi=Math.max(r,g,b),lo=Math.min(r,g,b),diff=hi-lo;
      if(hi<100||diff<80) return 0;
      let hue=0;
      if(hi===r) hue=60*((g-b)/diff%6);
      else if(hi===g) hue=60*((b-r)/diff+2);
      else hue=60*((r-g)/diff+4);
      hue=(hue+360)%360;
      return hue<18||hue>=342?1:hue<40?2:hue<76?3:hue<164?4:hue<210?5:hue<280?6:hue<334?7:8;
    }
    for(let i=0;i<n;i++){
      const p=i*4;
      if(data[p+3]>190) labels[i]=hueBucket(data[p],data[p+1],data[p+2]);
    }
    const q=new Int32Array(n),components=[];
    for(let i=0;i<n;i++) {
      if(!labels[i]||visited[i]) continue;
      const type=labels[i];let head=0,tail=1,minx=w,miny=h,maxx=0,maxy=0;
      visited[i]=1;q[0]=i;const pix=[];
      while(head<tail) {
        const p=q[head++],x=p%w,y=(p/w)|0;
        pix.push(p);minx=Math.min(minx,x);maxx=Math.max(maxx,x);miny=Math.min(miny,y);maxy=Math.max(maxy,y);
        const adj=[x>0?p-1:-1,x+1<w?p+1:-1,y>0?p-w:-1,y+1<h?p+w:-1];
        for(const j of adj)if(j>=0&&!visited[j]&&labels[j]===type){visited[j]=1;q[tail++]=j;}
      }
      if(tail>=12 && maxx-minx>=1 && maxy-miny>=4)
        components.push({type,minx,maxx,miny,maxy,pix});
    }
    if(components.length>220) throw new Error('Word image has too many coloured regions');
    const parent=components.map((_,i)=>i);
    const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    for(let i=0;i<components.length;i++)for(let j=i+1;j<components.length;j++){
      const a=components[i],b=components[j];
      if(a.type!==b.type)continue;
      const gx=Math.max(0,a.minx-b.maxx,b.minx-a.maxx);
      const gy=Math.max(0,a.miny-b.maxy,b.miny-a.maxy);
      // Close letters belong to the same word; unrelated words stay separate.
      if(gx<=Math.max(11,Math.round(w*0.0275))&&gy<=Math.max(10,Math.round(h*0.034)))parent[root(i)]=root(j);
    }
    const groups=new Map();
    for(let i=0;i<components.length;i++){
      const id=root(i);if(!groups.has(id))groups.set(id,{pix:[],type:components[i].type});
      groups.get(id).pix.push(...components[i].pix);
    }
    const candidates=[];
    for(const g of groups.values()) {
      if(g.pix.length<100)continue;
      let sx=0,sy=0,minx=w,miny=h,maxx=0,maxy=0;
      for(const p of g.pix){const x=p%w,y=(p/w)|0;sx+=x;sy+=y;minx=Math.min(x,minx);maxx=Math.max(x,maxx);miny=Math.min(y,miny);maxy=Math.max(y,maxy);}
      if(maxx-minx<24||maxy-miny<8)continue;
      const cx=sx/g.pix.length,cy=sy/g.pix.length;
      let xx=0,xy=0,yy=0;
      for(const p of g.pix){const x=p%w-cx,y=(p/w|0)-cy;xx+=x*x;xy+=x*y;yy+=y*y;}
      const angle=.5*Math.atan2(2*xy,xx-yy);
      if(Math.abs(angle)>.55)continue;
      candidates.push({x:cx,y:cy,angle,pix:g.pix,w,h,box:{minx,miny,maxx,maxy}});
    }
    return candidates;
  }

  function wordPatternFromPoints(points) {
    // Geometrically de-rotate and normalise the word's silhouette.
    const W=160,H=40, out=new Uint8Array(W*H);
    let minu=Infinity,maxu=-Infinity,minv=Infinity,maxv=-Infinity;
    for(const [u,v] of points){minu=Math.min(minu,u);maxu=Math.max(maxu,u);minv=Math.min(minv,v);maxv=Math.max(maxv,v);}
    const sw=maxu-minu,sh=maxv-minv;
    if(sw<10||sh<4)return null;
    for(const [u,v] of points){
      const x=Math.round((u-minu)*159/sw), y=Math.round((v-minv)*39/sh);
      for(let dy=0;dy<=1;dy++)for(let dx=0;dx<=1;dx++){
        const a=Math.min(159,x+dx),b=Math.min(39,y+dy);out[b*W+a]=1;
      }
    }
    return {mask:out,ratio:sw/sh};
  }

  function wordPatternCandidate(c) {
    const cos=Math.cos(c.angle),sin=Math.sin(c.angle);
    const points=c.pix.map(p=>{const x=p%c.w-c.x,y=(p/c.w|0)-c.y;return [x*cos+y*sin,-x*sin+y*cos];});
    return wordPatternFromPoints(points);
  }

  function wordPatternTemplate(word,font='Arial') {
    const cv=document.createElement('canvas');cv.width=640;cv.height=96;
    const ctx=cv.getContext('2d',{willReadFrequently:true});
    ctx.font=`bold 34px ${font}`;ctx.fillStyle='#fff';ctx.textBaseline='top';ctx.fillText(word,8,14);
    const img=ctx.getImageData(0,0,cv.width,cv.height),pts=[];
    for(let y=0;y<cv.height;y++)for(let x=0;x<cv.width;x++)if(img.data[(y*cv.width+x)*4+3]>120)pts.push([x,y]);
    return wordPatternFromPoints(pts);
  }

  function wordPatternScore(a,b) {
    if(!a||!b)return 0;
    const ratio=a.ratio/b.ratio;
    if(ratio<.69||ratio>1.45)return 0;
    function covered(m1,m2){
      let hits=0,total=0;
      for(let y=0;y<40;y++)for(let x=0;x<160;x++){
        if(!m1[y*160+x])continue;
        total++;
        let found=false;
        for(let dy=-1;dy<=1&&!found;dy++)for(let dx=-1;dx<=1;dx++){
          const xx=x+dx,yy=y+dy;
          if(xx>=0&&xx<160&&yy>=0&&yy<40&&m2[yy*160+xx]){found=true;break;}
        }
        if(found)hits++;
      }
      return hits/Math.max(1,total);
    }
    return (covered(a.mask,b.mask)+covered(b.mask,a.mask))/2*Math.exp(-.65*Math.abs(Math.log(ratio)));
  }

  function solveWordChallenge(image, word) {
    if(!/^[a-z]{3,20}$/i.test(word))throw new Error('Unsupported word instruction');
    word=word.toUpperCase();
    const candidates=captchaWordCandidates(image);
    if(!candidates.length)throw new Error('No separate coloured words detected');
    // Compare against nearby-looking words as well as the target. Direct
    // target-only matching can mistake MONEY for HEIST, for example.
    const dictionary=[...new Set([
      word,'HEIST','CASH','MAFIA','MOBSTER','CRIME','CREW','MONEY',
      'TERRITORY','GANG','JAIL','POLICE','BANK','BOSS','DRUGS','THEFT',
      'ROBBERY','POWER','STREET','GTA','WEAPON','PRISON','ESCAPE',
      'MOBSTERIA','HEALTH','POINTS','CAR','SAFE','DEAL','WAR','KING',
    ])];
    const patterns=new Map(dictionary.map(w=>[w,
      ['Arial','Helvetica'].map(font=>wordPatternTemplate(w,font))]));
    const results=[];
    for(const c of candidates) {
      if(c.box.minx<=1||c.box.maxx>=image.width-2||
         c.box.miny<=1||c.box.maxy>=image.height-2)continue;
      const pattern=wordPatternCandidate(c);
      const ranked=dictionary.map(w=>({word:w,score:Math.max(...patterns.get(w).map(t=>wordPatternScore(pattern,t)))}))
        .sort((a,b)=>b.score-a.score);
      results.push({c,ranked,score:ranked.find(r=>r.word===word).score});
    }
    results.sort((a,b)=>b.score-a.score);
    if(!results.length)throw new Error('No complete word candidates detected');
    const best=results[0];
    const runner=best.ranked[1]?.score||0;
    log(`Local solver: word ${word}: candidate=${best.score.toFixed(2)}, runner-up word ${best.ranked[1]?.word||'?'}=${runner.toFixed(2)}`, 'info');
    if(best.ranked[0].word!==word||best.score<.74||best.score-runner<.07||
       (results[1]&&best.score-results[1].score<.035))
      throw new Error('Word match not confident');
    return [{x:best.c.x,y:best.c.y}];
  }

  function selectionCount(dom = challengeDom()) {
    // The game's button changes from 'Verify Selections (0)' to 'Verify Selection (1)'
    // after the first click. Support both so the polling loop doesn't mistake an
    // accepted first click for a failure and stop before submitting the answer.
    // The game's own button is a useful acknowledgement that React accepted a click.
    const label = dom?.button?.textContent || '';
    const m = label.match(/verify\s+selections?\s*\(\s*(\d+)\s*\)/i);
    return m ? Number(m[1]) : null;
  }

  function clickChallengeAt(img, x, y, width, height) {
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('Challenge image is not visible');
    const scale = Math.min(rect.width / width, rect.height / height);
    const left = rect.left + (rect.width - width * scale) / 2;
    const top = rect.top + (rect.height - height * scale) / 2;
    const px = left + x * scale, py = top + y * scale;
    // On the saved Mobsteria page the game binds its interaction to the
    // cursor-crosshair wrapper around the image. Target the wrapper itself,
    // rather than relying on a synthetic event to bubble from the <img>.
    const wrapper = img.closest('.cursor-crosshair') || img.parentElement || img;
    const opts = { bubbles: true, cancelable: true, composed: true,
      // Tampermonkey's Firefox sandbox can expose a cross-compartment `window`
      // proxy. Passing it to UIEventInit.view throws a TypeError before any
      // click is dispatched. Omit `view` (it is optional) so both PointerEvent
      // and MouseEvent constructors work in Firefox's isolated world.
      clientX: px, clientY: py, button: 0, buttons: 1 };
    // Dispatch a single complete pointer/mouse sequence. These events remain
    // untrusted synthetic events; a site that requires trusted clicks may reject them.
    if (typeof PointerEvent === 'function') {
      wrapper.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    }
    wrapper.dispatchEvent(new MouseEvent('mousedown', opts));
    if (typeof PointerEvent === 'function') {
      wrapper.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    }
    wrapper.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    wrapper.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
    return { px: Math.round(px), py: Math.round(py), target: wrapper.tagName.toLowerCase() };
  }

  async function waitForSelectionCount(expected, imageUrl, timeoutMs = 1200) {
    const started = now();
    while (now() - started < timeoutMs) {
      const d = challengeDom();
      if (!d || (d.img.currentSrc || d.img.src) !== imageUrl) return false;
      if (selectionCount(d) === expected) return true;
      await sleep(80);
    }
    return false;
  }

  let lastSolverStatus = '';
  function solverStatusOnce(message, type = 'warn') {
    if (lastSolverStatus !== message) {
      lastSolverStatus = message;
      log('Local solver: ' + message, type);
    }
  }

  async function tryAutoSolveChallenge(dom, key) {
    if (!S.running) { solverStatusOnce('Bot is stopped — detection only.'); return; }
    if (S.scheduler.singleTab && !canRunTab()) return;
    if (!S.autoSolveChallenges) { solverStatusOnce('Auto-solve is OFF in Settings — detection only.'); return; }
    if (challengeSolving || attemptedSolves.has(key)) return;
    const rule = challengeRule(dom.instruction);
    if (!rule) {
      solverStatusOnce(`Question not supported: ${dom.instruction || '(missing instruction)'}`);
      st.challengeRecoveryReason='Unsupported puzzle pattern';
      renderStatus();
      return;
    }
    challengeSolving = true;
    attemptedSolves.add(key); // No repeated automatic attempts at the same challenge
    solverStatusOnce(`Attempting ${rule.mode} puzzle: ${dom.instruction}`, 'info');
    try {
      if (!dom.button) throw new Error('Verify Selections button was not found');
      const initialCount = selectionCount(dom);
      if (initialCount === null) throw new Error('Could not read page selection count');
      if (initialCount !== 0) throw new Error(`Page already has ${initialCount} selection(s); leaving manual selections untouched`);
      const pixels = await readChallengeImage(dom.img);
      const objects = rule.mode === 'word' ? [] : extractChallengeObjects(pixels);
      const clicks = rule.mode === 'word' ? solveWordChallenge(pixels, rule.word) : answerChallenge(rule, objects, pixels);
      if (!clicks.length || clicks.length > 10) throw new Error(`Unexpected number of proposed selections (${clicks.length})`);
      const expectedUrl = dom.img.currentSrc || dom.img.src;
      if ((challengeDom()?.img?.currentSrc || challengeDom()?.img?.src) !== expectedUrl)
        throw new Error('Challenge image changed during recognition');
      log(rule.mode === 'word' ? `Local solver matched word ${rule.word} and expects 1 selection` : `Local solver recognised ${objects.length} objects and expects ${clicks.length} selection(s)`, 'info');
      for (let i = 0; i < clicks.length; i++) {
        const o = clicks[i];
        const pos = clickChallengeAt(dom.img, o.x, o.y, pixels.width, pixels.height);
        if (!await waitForSelectionCount(i + 1, expectedUrl)) {
          throw new Error(`Click ${i + 1}/${clicks.length} at (${pos.px}, ${pos.py}) on ${pos.target} did not register. The game may ignore synthetic mouse events.`);
        }
        log(`Local solver: click ${i + 1}/${clicks.length} registered`, 'good');
      }
      const button = challengeDom()?.button;
      if (!button || button.disabled || selectionCount(challengeDom()) !== clicks.length)
        throw new Error('Selection count changed or Verify button is still disabled');
      log(`Local solver: submitting ${clicks.length} registered selection(s)`, 'good');
      button.click();
      // The existing challenge polling loop confirms whether the server actually cleared it.
    } catch (e) {
      log(`Local solver stopped: ${e.message}. Complete this challenge manually or press New CAPTCHA.`, 'warn');
      st.challengeRecoveryReason=String(e.message).slice(0,130);
      renderStatus();
      notify('Mobsteria: manual challenge', `Local solver stopped: ${e.message}`);
    } finally {
      challengeSolving = false;
    }
  }

  function inspectChallenge() {
    const dom = challengeDom();
    if (!dom) {
      lastChallengeInfo = '';
      activeSolveKey = '';
      st.challengeRecoveryReason='';
      const retry=root?.querySelector('#mbx-captcha-refresh');if(retry)retry.hidden=true;
      return;
    }
    if (S.running && (!S.scheduler.singleTab || canRunTab()) && !st.challenge) onChallenge();
    const kind = CHALLENGE_TYPES.find(([re]) => re.test(dom.instruction))?.[1] || 'Unknown challenge';
    const info = `${kind}: ${dom.instruction || 'Instruction not found'}`;
    if (S.challengeAssist && info !== lastChallengeInfo) {
      lastChallengeInfo = info;
      log(`Challenge detected (${info})`, 'warn');
      renderStatus();
    }
    const key = (dom.img.currentSrc || dom.img.src) + '|' + dom.instruction;
    if (key !== activeSolveKey) {
      activeSolveKey = key;
      lastSolverStatus = '';
      st.challengeRecoveryReason='';
    }
    void tryAutoSolveChallenge(dom, key);
  }
  setInterval(inspectChallenge, 1500);

  async function onChallenge() {
    if (st.challenge) return;
    st.challenge=true;
    log('Challenge detected - paused until verified.', 'bad');
    notify('Mobsteria: challenge', 'Trying local recognition; manual verification may be needed.');
    renderStatus();
    // An API request can discover the challenge before the game's UI actually
    // displays it. The saved Mobsteria page confirms /game/gta hosts this view.
    if (S.autoSolveChallenges && !challengeDom()) {
      await sleep(2500); // Give the SPA a chance to render the challenge itself
      if (!challengeDom()) {
        const revealKey = 'mbx_challenge_reveal_once';
        const lastReveal = Number(sessionStorage.getItem(revealKey) || 0);
        if (now() - lastReveal > 5 * 60000) {
          sessionStorage.setItem(revealKey, String(now()));
          log('Challenge required but not visible; opening GTA page to reveal the puzzle (once).', 'warn');
          location.assign('/game/gta');
          return;
        }
        log('Challenge still has no visible PNG after page navigation. Automatic solving requires the game to display the puzzle.', 'warn');
      }
    }
    while(st.challenge) {
      await sleep(5000);
      try {
        const ov=await fetch(API+'/crimes2/overview',{headers:{Accept:'application/json',Authorization:'Bearer '+token()}}).then(r=>r.json());
        if(ov&&ov.needsChallenge===false) {
          st.challenge=false;
          log('Challenge cleared - resuming', 'good');
          notify('Mobsteria: resumed', 'Challenge cleared, bot is running again.');
        }
      }catch {/* Keep waiting */}
    }
    renderStatus();
  }

  /* =========================================================
   *  MAIN LOOP
   * ========================================================= */
  /* ---- Page following: open the matching game page while the bot works ---- */
  const PAGE_LABELS = { crimes: 'Crime', burglary: 'Crime', gta: 'GTA', heists: 'Heist', gym: 'Gym', jobs: 'Jobs', workshop: 'WS', smuggling: 'Drugs', bosses: 'Boss' };
  let lastPage = null;
  function goPage(key) {
    if (!S.followPage) return;
    const label = PAGE_LABELS[key];
    if (!label || lastPage === key) return;
    if (key==='workshop' && /^\/game\/workshop(?:\/|$)/.test(location.pathname)) { lastPage=key; return; }
    const match = [...document.querySelectorAll('a,button,[role="button"],div,span')]
      .filter((e) => e.textContent.trim() === label && !e.closest('#mbx') && e.offsetParent !== null)
      .sort((a, b) => a.children.length - b.children.length)[0];
    if (!match) return;
    (match.closest('a,button,[role="button"]') || match).click();
    lastPage = key;
  }

  async function tick() {
    if (!S.running || st.busy || st.challenge || now() < st.nextAction) return;
    if (!canRunTab()) { st.otherTab = true; renderStatus(); return; }
    st.otherTab = false;
    st.busy = true;
    st.tickStart = now();
    let didAction = false;
    let completedCycle = false;
    try {
      await refreshChar(false);

      if (isJailed()) {
        if (st.paused?.reason !== 'jail') {
          st.paused = { reason: 'jail', since: now() };
          st.stats.jailed++;
          telemetryDirty = true;
          log(`In jail for ${fmt(jailLeft())} - waiting`, 'warn');
        }
        if (S.modules.jailtime) {
          const began = now();
          try {
            st.activeModule = 'jailtime';
            if (await doJailTime()) {
              observeModule('jailtime','action',now()-began);
              st.stats.actions++;
              telemetryDirty = true;
              st.nextAction = now() + rand(S.delays.min, S.delays.max);
              st.lastCharAt = 0;
              didAction = true;
              return;
            }
            observeModule('jailtime','empty',now()-began);
          } catch (e) {
            if (e instanceof ChallengeError || e instanceof AuthError || e instanceof RateLimitError) throw e;
            observeModule('jailtime','error',now()-began,e);
            log(`Jail activities: ${e.message}`, 'warn');
          } finally { st.activeModule = ''; }
        }
        st.nextAction = now() + Math.max(5000, Math.min(30000, jailLeft() * 1000 + 1500));
        st.lastCharAt = 0;
        return;
      }
      if (isHospital()) {
        if (st.paused?.reason !== 'hospital') {
          st.paused = { reason: 'hospital', since: now() };
          log('In hospital - waiting', 'warn');
        }
        st.nextAction = now() + 30000;
        st.lastCharAt = 0;
        return;
      }
      if (st.paused) { log(`Back out (${st.paused.reason}) - resuming`, 'good'); st.paused = null; }

      const runOrder=prioritizedModules();
      prioritizeTimeSensitiveModules(runOrder);
      for (const [key, fn] of runOrder) {
        if (!S.modules[key]) continue;
        const m = metric(key);
        if (now() < m.nextAllowed) continue;
        const began = now();
        let acted = false;
        try {
          st.activeModule = key;
          acted = await fn();
          observeModule(key,acted ? 'action' : 'empty',now()-began);
        } catch (e) {
          if (e instanceof ChallengeError || e instanceof AuthError || e instanceof RateLimitError) throw e;
          observeModule(key,'error',now()-began,e);
          // Preserve the first error and avoid flooding the log each second.
          log(`${key}: ${e.message} (backing off)`, 'warn');
        } finally { st.activeModule = ''; }
        if (acted) {
          resourceTurnComplete(key);
          st.stats.actions++;
          telemetryDirty = true;
          didAction = true;
          st.lastCharAt = 0;
          try { goPage(key); } catch { /* cosmetic */ }
          break;
        }
        // One scheduler owns the requests. Do not sleep just to check the next idle module.

      }
      completedCycle = true;
      if(didAction){
        // V2.3.10: A successful action MUST NOT inherit the idle 20-60s
        // cadence. Continue the resource burst/next eligible module promptly.
        // Keep the server's Retry-After hold authoritative if one exists.
        const actionGap=Math.max(250,rand(Number(S.delays.min)||2500,Number(S.delays.max)||6000));
        st.nextAction=Math.max(apiHoldUntil,now()+actionGap);
      }else{
        // All modules were empty or waiting for a real resource/cooldown.
        // Avoid repeatedly polling the server when no work is available.
        const eligibleTimes=moduleKeys().filter(k=>S.modules[k]).map(k=>metric(k).nextAllowed).filter(t=>t>now());
        const soonest=eligibleTimes.length ? Math.min(...eligibleTimes)-now() : Infinity;
        const cadence=(Number(S.scheduler.idleCadenceSeconds)||60)*1000;
        st.nextAction=now()+Math.max(20000,Math.min(cadence,soonest))+rand(0,3000);
      }

    } catch (e) {
      if (e instanceof ChallengeError) { void onChallenge(); }
      else if (e instanceof AuthError) {
        S.running = false; save();
        log('Logged out - bot stopped', 'bad');
        notify('Mobsteria: logged out', 'The bot stopped because the session ended.');
      } else if (e instanceof RateLimitError) {
        st.nextAction = Math.max(st.nextAction, now() + 60000, apiHoldUntil);
        log(`Server rate limit: next eligible check ${new Date(st.nextAction).toLocaleTimeString('en-GB')}`, 'warn');
      } else {
        log(e.message || String(e), 'warn');
        st.nextAction = Math.max(st.nextAction, now() + 15000);
      }
    } finally {
      st.busy = false;
      st.activeModule = '';
      st.lastTickCompleteAt = now();
      // Real progress is updated ONLY by observeModule(...,'action').
      // A healthy idle cycle isn't confused with successful work.
      if (completedCycle && !didAction) st.lastNoActionAt = now();
      renderStatus();
      renderStats();
    }
  }

  /* ---- Close achievement / reward pop-ups so they don't cover the game.
   *      Only dialogs whose text says it's an achievement or reward are touched,
   *      and only their Close button is pressed. Challenges are never touched. ---- */
  setInterval(() => {
    if (!S.closePopups) return;
    const realClick = (btn) => {
      // Full press-and-release, like a real click (a bare .click() is ignored by these pop-ups)
      const r = btn.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        btn.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(type, at));
      }
    };
    const isCheck = (el) => /challenge|verify|captcha|security|robot|human/i.test(el.textContent || '');
    const closeBtn = (box) => {
      const btns = [...box.querySelectorAll('button')];
      return btns.find((b) => /^\s*(collect|claim)/i.test(b.textContent))
        || box.querySelector('.v4-award-close')
        || btns.find((b) => /^\s*(close|ok|continue|done)\s*$/i.test(b.textContent))
        || box.querySelector('[aria-label*="close" i]')
        || btns.find((b) => /^\s*[×✕x]\s*$/i.test(b.textContent));
    };

    // Achievements
    for (const card of document.querySelectorAll('.v4-award')) {
      if (card.closest('#mbx') || card.dataset.mbxClosed) continue;
      const box = card.parentElement || card;
      if (isCheck(box)) continue;
      const btn = closeBtn(box);
      if (!btn) continue;
      card.dataset.mbxClosed = '1';
      const name = card.querySelector('.v4-award-name')?.textContent?.trim();
      realClick(btn);
      log(name ? `Achievement unlocked: ${name}` : 'Closed an achievement pop-up', 'good');
    }

    // Level up: pick a key from the safe, then close once the prize is shown
    for (const box of document.querySelectorAll('div.fixed')) {
      if (box.closest('#mbx') || box.parentElement?.closest('div.fixed')) continue;
      const t = box.textContent || '';
      if (!/level\s*up/i.test(t) || isCheck(box)) continue;
      const keys = [...box.querySelectorAll('button')].filter((b) => /^\s*[1-9]\s*$/.test(b.textContent) && !b.disabled);
      if (!box.dataset.mbxPicked && /pick a key/i.test(t) && keys.length) {
        const k = keys[Math.floor(Math.random() * keys.length)];
        box.dataset.mbxPicked = String(Date.now());
        const lvl = t.match(/level\s*up\s*(\d+)/i)?.[1];
        realClick(k);
        log(`Level up${lvl ? ' to ' + lvl : ''}! Picked key ${k.textContent.trim()}`, 'good');
        continue;
      }
      // Give the prize a few seconds to show before closing
      if (box.dataset.mbxPicked && Date.now() - Number(box.dataset.mbxPicked) < 4000) continue;
      if (keys.length && !box.dataset.mbxPicked) continue;
      const btn = closeBtn(box);
      if (btn) { realClick(btn); box.dataset.mbxPicked = String(Date.now() + 60000); log('Closed the level-up pop-up', 'good'); }
    }
  }, 3000);

  setInterval(tick, 5000); // Cheap in-memory wakeup, not an API poll.
  // When stopped, one initial character read and a manual refresh suffice.

  /* ---- Watchdog: only reload for lost healthy polling, not normal resource idling. ---- */
  st.lastProgress = now();
  setInterval(() => {
    if (!S.running) return;
    if (st.busy && now() - st.tickStart > 120000) {
      if (now() - st.watchdogNoticeAt > 60000) {
        log('A module is taking unusually long. Waiting for its request to settle; not starting a concurrent action.', 'warn');
        st.watchdogNoticeAt = now();
      }
      return;
    }
    if (st.challenge || st.paused) return;
    if(st.nextAction>now() && !st.busy) return; // Deliberate scheduled idle, not a hang.
    const stuckMins = num(S.stuckReloadMins);
    if (stuckMins <= 0 || st.busy) return;
    if (now() - st.lastHealthyAt > stuckMins * 60000 && now() - st.lastTickCompleteAt > stuckMins * 60000) {
      const stamp = Number(sessionStorage.getItem('mbx_v22_watchdog_reload') || 0);
      if (now() - stamp > 10 * 60000) {
        sessionStorage.setItem('mbx_v22_watchdog_reload', String(now()));
        log(`No healthy poll or completed cycle for ${stuckMins} min - reloading`, 'warn');
        persistTelemetry();
        setTimeout(() => location.reload(), 1500);
      }
    }
  }, 15000);

  // Scheduled page refresh keeps the game's own session and memory fresh
  setInterval(() => {
    const mins = num(S.autoReloadMins);
    if (S.running && mins > 0 && !st.busy && !st.challenge && now() - BOOT_AT > mins * 60000) {
      persistTelemetry();
      location.reload();
    }
  }, 30000);

  /* =========================================================
   *  UI  (uses the game's own --v4-* theme variables)
   * ========================================================= */
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
  };
  const money = (n) => '$' + Math.round(num(n)).toLocaleString('en-GB');

  const css = `
  #mbx{position:fixed;z-index:99999;width:320px;font-family:var(--v4-font-ui,"IBM Plex Sans",sans-serif);color:var(--v4-t1,#f2f3f5);
    background:linear-gradient(180deg,#26282d 0%,#1e2023 38%,#17191c 100%);border:1px solid var(--v4-line-2,#ffffff1c);
    border-radius:var(--v4-r-lg,12px);box-shadow:inset 0 1px 0 #ffffff17,var(--v4-shadow,0 18px 44px -18px #000000d9);font-size:12px;user-select:none;
    display:flex;flex-direction:column;max-width:calc(100vw - 12px);max-height:calc(100dvh - 16px);overflow:hidden}
  #mbx *{box-sizing:border-box}
  #mbx .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;border-bottom:1px solid var(--v4-line,#ffffff12);flex:0 0 auto}
  #mbx .ttl{font-family:var(--v4-font-title);font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:13px;flex:1}
  #mbx .ttl b{color:var(--v4-accent,#f0574d)}
  #mbx .dot{width:8px;height:8px;border-radius:50%;background:var(--v4-t4,#6a7078);box-shadow:0 0 0 2px #00000060}
  #mbx .dot.on{background:var(--v4-pos,#4ec27f)} #mbx .dot.wait{background:var(--v4-warn,#ea8b3c)} #mbx .dot.bad{background:var(--v4-neg,#f2685f)}
  #mbx .ib{background:none;border:0;color:var(--v4-t3,#949aa3);cursor:pointer;font-size:14px;padding:2px 4px}
  #mbx .ib:hover{color:var(--v4-t1)}
  #mbx .bd{padding:10px 12px 12px}
  #mbx.min .bd,#mbx.min .tabs{display:none}
  #mbx:not(.min) #mbx-quick-run{display:none}
  #mbx.min #mbx-quick-run{display:inline-flex;flex-shrink:0;align-items:center;padding:5px 9px;font-size:11px;min-width:46px;justify-content:center}
  #mbx.min .hd{gap:6px}
  #mbx.min .ttl{font-size:12px;white-space:nowrap}
  #mbx .tabs{display:flex;gap:4px;padding:8px 12px 0;flex:0 0 auto}
  #mbx .tab{flex:1;text-align:center;padding:6px 0;border-radius:var(--v4-r-sm,4px);cursor:pointer;color:var(--v4-t3);
    font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;background:var(--v4-s1,#1e2023);border:1px solid var(--v4-line)}
  #mbx .tab.act{color:var(--v4-t1);background:var(--v4-accent-soft,#f0574d24);border-color:var(--v4-accent-line,#f0574d73)}
  #mbx .btn{width:100%;padding:9px 0;border-radius:var(--v4-r-btn,6px);border:1px solid #0000008c;color:var(--v4-t1);cursor:pointer;
    font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;
    background:linear-gradient(#f0574d42,#f0574d1a),linear-gradient(#3e424a,#33363c 46%,#2a2d32);
    box-shadow:inset 0 0 0 1px var(--v4-accent-line,#f0574d73),inset 0 1px 0 #ffffff2e,inset 0 -1px 0 #00000066,0 2px 3px #00000066}
  #mbx .btn.stop{background:linear-gradient(#ffffff0d,#ffffff05),linear-gradient(#3e424a,#33363c 46%,#2a2d32);box-shadow:inset 0 0 0 1px var(--v4-line-3),inset 0 1px 0 #ffffff2e,0 2px 3px #00000066}
  #mbx .state{margin:10px 0 8px;padding:8px 10px;border-radius:var(--v4-r-md,8px);background:var(--v4-s0,#17181b);border:1px solid var(--v4-line);font-size:11.5px;color:var(--v4-t2)}
  #mbx .state.bad{border-color:#f2685f66;color:var(--v4-neg-t,#f9b3ad)} #mbx .state.wait{border-color:#ea8b3c66;color:#f3c08f}
  #mbx .res{display:grid;grid-template-columns:52px 1fr 54px;align-items:center;gap:8px;margin:5px 0}
  #mbx .res span{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--v4-t3)}
  #mbx .res em{font-style:normal;font-family:var(--v4-font-data,monospace);font-size:11px;text-align:right;color:var(--v4-t2)}
  #mbx .bar{height:6px;border-radius:3px;background:var(--v4-s3,#2e3135);overflow:hidden;box-shadow:inset 0 1px 1px #00000080}
  #mbx .bar i{display:block;height:100%;border-radius:3px}
  #mbx .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
  #mbx .cell{background:var(--v4-s0);border:1px solid var(--v4-line);border-radius:var(--v4-r-sm);padding:6px 8px}
  #mbx .cell small{display:block;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--v4-t4)}
  #mbx .cell b{font-family:var(--v4-font-data);font-size:12px;font-weight:600}
  #mbx .tog{display:flex;align-items:center;justify-content:space-between;padding:7px 2px;border-bottom:1px solid var(--v4-line)}
  #mbx .tog:last-child{border-bottom:0}
  #mbx .sw{position:relative;width:32px;height:18px;border-radius:9px;background:var(--v4-s4,#3a3d42);cursor:pointer;transition:background var(--v4-t,.13s)}
  #mbx .sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#d8dbe0;transition:left var(--v4-t,.13s)}
  #mbx .sw.on{background:var(--v4-accent,#f0574d)} #mbx .sw.on::after{left:16px}
  #mbx label.f{display:block;margin:8px 0 3px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--v4-t3)}
  #mbx input,#mbx select{width:100%;padding:6px 8px;background:var(--v4-s0);color:var(--v4-t1);border:1px solid var(--v4-line-2);border-radius:var(--v4-r-sm);font-family:var(--v4-font-data);font-size:11.5px}
  #mbx .row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  #mbx .chips{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:6px}
  #mbx .chip{text-align:center;padding:6px 0;border-radius:var(--v4-r-sm,4px);cursor:pointer;font-size:10.5px;letter-spacing:.04em;
    text-transform:uppercase;color:var(--v4-t3);background:var(--v4-s0);border:1px solid var(--v4-line-2)}
  #mbx .chip.on{color:var(--v4-t1);background:var(--v4-accent-soft,#f0574d24);border-color:var(--v4-accent-line,#f0574d73)}
  #mbx .bd{min-height:0;max-height:none;flex:1 1 auto;overflow-x:hidden;overflow-y:auto;
    overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#8b929e #292c32}
  #mbx .bd::-webkit-scrollbar{width:9px}
  #mbx .bd::-webkit-scrollbar-track{background:#292c32}
  #mbx .bd::-webkit-scrollbar-thumb{background:#8b929e;border:2px solid #292c32;border-radius:8px}
  #mbx.min{height:auto!important;max-height:none!important}
  #mbx details.sec{margin:0 0 6px;border:1px solid var(--v4-line);border-radius:var(--v4-r-md,8px);background:var(--v4-s0,#17181b);overflow:hidden}
  #mbx details.sec>summary{list-style:none;cursor:pointer;padding:9px 10px;display:flex;align-items:center;justify-content:space-between;
    font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--v4-t2);user-select:none}
  #mbx details.sec>summary::-webkit-details-marker{display:none}
  #mbx details.sec>summary::after{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);transition:transform var(--v4-t,.13s);margin-right:3px}
  #mbx details.sec[open]>summary{color:var(--v4-t1);background:var(--v4-accent-soft,#f0574d24);border-bottom:1px solid var(--v4-accent-line,#f0574d73)}
  #mbx details.sec[open]>summary::after{transform:rotate(-135deg)}
  #mbx details.sec>summary:hover{color:var(--v4-t1)}
  #mbx .sec-bd{padding:2px 10px 10px}
  #mbx .log{max-height:none;overflow:visible;font-family:var(--v4-font-data);font-size:10.5px;line-height:1.5;user-select:text}
  #mbx .log div{padding:2px 0;border-bottom:1px solid #ffffff08;color:var(--v4-t2)}
  #mbx .log .t{color:var(--v4-t4);margin-right:6px}
  #mbx .log .good{color:var(--v4-money-t,#a6e0bf)} #mbx .log .warn{color:#f3c08f} #mbx .log .bad{color:var(--v4-neg-t,#f9b3ad)}
  #mbx .tabs .tab{font-size:9px;padding:7px 1px;min-width:0}
  #mbx .mini-note{font-size:10.5px;color:var(--v4-t3,#949aa3);line-height:1.4;margin:7px 0}
  #mbx .mbx-row{display:flex;align-items:center;gap:6px;margin:6px 0}
  #mbx .mbx-row>*{flex:1;min-width:0}
  #mbx .mbx-row button,#mbx .mini-btn{padding:6px 8px;cursor:pointer;background:#28303b;color:#f0f4fa;border:1px solid #495463;border-radius:6px;font-size:10px}
  #mbx .mbx-row button:hover,#mbx .mini-btn:hover{background:#384353}
  #mbx .mbx-row button:disabled{opacity:.35;cursor:default}
  #mbx .prio-row{display:grid;grid-template-columns:20px minmax(0,1fr) 38px 26px 26px;gap:5px;align-items:center;padding:5px 0;border-bottom:1px solid #ffffff15;font-size:10.5px}
  #mbx .prio-row .prio-num{font-family:monospace;color:#b6bfca}
  #mbx .prio-row .prio-stat{color:#a4adb9;text-align:right}
  #mbx .prio-row button{height:24px;padding:0;background:#29313c;color:#fff;border:1px solid #495463;border-radius:5px;cursor:pointer}
  #mbx .health-row{font-size:10px;padding:7px 2px;border-bottom:1px solid #ffffff13}
  #mbx .health-row strong{display:block;font-size:11px;margin-bottom:3px}
  #mbx .health-row small{font-size:9.5px;color:#b4bdc7;display:block;overflow-wrap:anywhere}
  #mbx .error{color:#f6a59c}
  #mbx .preset{display:grid;grid-template-columns:minmax(0,1fr) 50px 24px;gap:5px;align-items:center;padding:4px 0;border-bottom:1px solid #ffffff14}
  #mbx .preset span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* V2.3: simplified command centre. Complex tuning is behind Advanced. */
  #mbx{width:350px;font:12px system-ui,-apple-system,sans-serif;background:#14191f;color:#e9edf4;border:1px solid #34404c;border-radius:14px;box-shadow:0 18px 42px #0009}
  #mbx .hd{padding:12px 14px;background:#1c242d;border-bottom:1px solid #34404c}
  #mbx .ttl{font:700 14px system-ui,sans-serif;letter-spacing:.01em;text-transform:none}
  #mbx .ttl b{color:#82bdff}
  #mbx .tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding:9px 10px 0}
  #mbx .tab{font-size:11px;text-transform:none;letter-spacing:0;padding:9px 2px;background:#222b34;border-color:#354450;color:#b3bdc9;border-radius:8px}
  #mbx .tab.act{background:#30465d;border-color:#5d8fb9;color:#f0f7ff}
  #mbx .bd{padding:13px 14px 16px}
  #mbx .simple-title{font-weight:700;font-size:13px;margin:5px 0 4px}
  #mbx .hint{font-size:11px;line-height:1.55;color:#aebccc;margin:4px 0 10px}
  #mbx .action-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
  #mbx .big-btn{width:100%;padding:12px 10px;font-weight:750;font-size:13px;background:#376da2;color:#fff;border:1px solid #5593cf;border-radius:9px;cursor:pointer}
  #mbx .big-btn.stopped{background:#a85543;border-color:#ce7764}
  #mbx .soft-btn{padding:10px 6px;background:#263544;border:1px solid #425468;color:#e5f0fb;border-radius:9px;cursor:pointer}
  #mbx .summary-card{background:#1c2630;border:1px solid #364858;border-radius:10px;padding:11px;margin-bottom:10px}
  #mbx .summary-line{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:6px 0;color:#dce6f0}
  #mbx .summary-line small{color:#9daebd;font-size:11px}
  #mbx .summary-line b{font-size:12px;text-align:right}
  #mbx .state{margin:6px 0 10px;border-radius:8px;background:#18222d;border-color:#37516a;color:#dce8f4}
  #mbx .res{grid-template-columns:52px 1fr 66px}
  #mbx .res span{color:#b9c8d7}
  #mbx .res em{color:#dbe4ed}
  #mbx .guide{background:#1b252e;border:1px solid #334454;border-radius:9px;margin:12px 0;padding:9px 11px;color:#c1d1df}
  #mbx .guide summary{font-size:11px;font-weight:700;cursor:pointer}
  #mbx .guide p{font-size:11px;line-height:1.5;margin:8px 0 3px}
  #mbx .section-head{font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#91b6db;margin:12px 0 5px}
  #mbx .simple-mod{display:flex;align-items:center;gap:8px;padding:10px 2px;border-bottom:1px solid #2c3946}
  #mbx .simple-mod span{flex:1;font-size:12px}
  #mbx .simple-mod button{flex:none;border:1px solid #566272;background:#344250;color:#e3ebf2;border-radius:20px;padding:5px 9px;font-size:11px;cursor:pointer}
  #mbx .simple-mod button.enabled{background:#1e5e4d;border-color:#3f9d81;color:#d8fff1}
  #mbx .simple-mod small{display:block;font-size:10px;color:#aab8c6;margin-top:2px}
  #mbx .nav-back{display:block;width:100%;margin:0 0 10px;padding:8px;background:#293949;color:#e8f1fa;border:1px solid #445c72;border-radius:8px;cursor:pointer}
  #mbx .simple-settings select{font:12px system-ui,sans-serif;padding:9px;background:#202c38;border:1px solid #405263;border-radius:8px;margin:4px 0 10px}
  #mbx .mbx-easy-trade{margin:10px 0 16px;padding:12px;border:1px solid #51677e;border-radius:10px;background:#182432}
  #mbx .mbx-easy-trade .simple-title{margin:0 0 8px}
  #mbx .mbx-trade-city-row select{width:100%;min-width:0}
  #mbx #mbx-easy-trade-route{font-weight:600;margin:3px 0 8px;color:#c6ddf1}
  #mbx .simple-settings .settings-toggle{display:flex;align-items:center;justify-content:space-between;padding:10px 2px;border-bottom:1px solid #2c3946}
  #mbx .simple-settings .settings-toggle input{width:auto;accent-color:#6aa9e4;margin:0}
  #mbx .log{font-size:10.5px;overflow-wrap:anywhere}
  `;

  function el(tag, attrs = {}, html = '') {
    const e = document.createElement(tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (html) e.innerHTML = html;
    return e;
  }

  let root;
  // Available panel space depends on its draggable position, not browser zoom.
  function fitPanelToViewport() {
    if (!root) return;
    const maxX = Math.max(0, window.innerWidth - Math.min(root.offsetWidth || 320, window.innerWidth) - 8);
    const maxY = Math.max(0, window.innerHeight - (S.panel.min ? 55 : 145));
    S.panel.x = Math.max(0, Math.min(maxX, Number(S.panel.x) || 0));
    S.panel.y = Math.max(0, Math.min(maxY, Number(S.panel.y) || 0));
    root.style.left = S.panel.x + 'px';
    root.style.top = S.panel.y + 'px';
    root.style.maxHeight = S.panel.min ? 'none' : Math.max(90, window.innerHeight - S.panel.y - 10) + 'px';
  }
  function buildUI() {
    document.head.appendChild(el('style', {}, css));
    root = el('div', { id: 'mbx' });
    root.innerHTML = `
      <div class="hd"><span class="dot" id="mbx-dot"></span><div class="ttl">Mob<b>steria</b> <span style="color:#91a4b8;font-weight:500">Control</span></div>
        <button class="soft-btn" id="mbx-quick-run" type="button" title="Pause or resume the bot">${S.running?'Stop':'Start'}</button>
        <button class="soft-btn" id="mbx-captcha-refresh" title="Reload page for a different puzzle (manual)" hidden>New CAPTCHA</button>
        <button class="ib" id="mbx-min" title="Minimise">&#8211;</button></div>
      <div class="tabs">
        <div class="tab" data-tab="home">Home</div><div class="tab" data-tab="modules">Activities</div>
        <div class="tab" data-tab="options">Options</div><div class="tab" data-tab="log">Activity</div></div>
      <div class="bd" id="mbx-bd"></div>`;
    document.body.appendChild(root);
    if (S.panel.min) root.classList.add('min');
    fitPanelToViewport();
    window.addEventListener('resize', () => { fitPanelToViewport(); save(); });

    root.querySelector('#mbx-captcha-refresh').onclick=()=>{
      if(challengeSolving){log('CAPTCHA is still being analysed; refresh not started','warn');return;}
      if(!challengeDom()){log('CAPTCHA is no longer visible; no refresh needed','info');return;}
      log('Manual CAPTCHA refresh requested. The page will reload once to show a new question.','info');
      persistTelemetry();
      location.reload();
    };
    root.querySelector('#mbx-quick-run').onclick = toggleBotRunning;
    root.querySelector('#mbx-min').onclick = () => {
      S.panel.min = !S.panel.min;
      root.classList.toggle('min', S.panel.min);
      fitPanelToViewport(); save();
    };
    root.querySelectorAll('.tab').forEach((t) => (t.onclick = () => { S.panel.tab = t.dataset.tab; save(); renderBody(); }));

    // drag
    const hd = root.querySelector('.hd');
    hd.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const sx = e.clientX - root.offsetLeft, sy = e.clientY - root.offsetTop;
      const mv = (ev) => {
        S.panel.x = ev.clientX - sx;
        S.panel.y = ev.clientY - sy;
        fitPanelToViewport();
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); save(); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    renderBody();
  }

  function toggleBotRunning() {
    S.running=!S.running;
    if(!S.running)releaseLease();
    save();
    log(S.running?'Bot started':'Bot paused',S.running?'good':'info');
    st.nextAction=0;
    const quick=root?.querySelector('#mbx-quick-run');
    if(quick){quick.textContent=S.running?'Stop':'Start';quick.setAttribute('aria-label',S.running?'Stop bot':'Start bot');}
    if(S.panel.tab==='home'||S.panel.tab==='status')renderBody();
    else renderStatus();
  }

  function renderBody() {
    if (!root) return;
    root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('act',t.dataset.tab===(['strategy','settings','health','advanced'].includes(S.panel.tab)?'options':S.panel.tab)));
    const bd = root.querySelector('#mbx-bd');
    const tab = S.panel.tab;
    if (tab === 'home' || tab === 'status') {
      bd.innerHTML = `
        <div class="simple-title">Your automation</div>
        <div class="hint">Choose a goal, press Start, and the bot uses its resources when useful. It doesn't need to click every few seconds.</div>
        <div class="action-row"><button class="big-btn ${S.running?'stopped':''}" id="mbx-run">${S.running?'Pause bot':'Start bot'}</button><button class="soft-btn" id="mbx-refresh">Refresh status</button></div>
        <div id="mbx-state" class="state"></div>
        <div class="summary-card">
          <div class="summary-line"><small>Current action</small><b id="mbx-current-action">—</b></div>
          <div class="summary-line"><small>Next scheduled check</small><b id="mbx-next-module">—</b></div>
          <div class="summary-line"><small>Due in</small><b id="mbx-next-state">—</b></div>
          <div class="summary-line"><small>Waiting for</small><b id="mbx-waiting-for">—</b></div>
        </div>
        <details class="guide"><summary>Resources and module details</summary>
          <div class="summary-card">
            <div class="summary-line"><small>Goal</small><b id="mbx-strategy-state"></b></div>
            <div class="summary-line"><small>Last completed</small><b id="mbx-last-state"></b></div>
            <div class="summary-line"><small>Empire</small><b id="mbx-empire-state">Not checked</b></div>
            <div class="summary-line"><small>Garage</small><b id="mbx-garage-state">Waiting for check</b></div>
            <div class="summary-line"><small>Smuggling</small><b id="mbx-smuggling-state">Not checked</b></div>
            <div class="summary-line"><small>Drug trading</small><b id="mbx-trading-state">Not checked</b></div>
            <div class="summary-line"><small>OC</small><b id="mbx-oc-short-state">Not checked</b></div>
            <div id="mbx-res"></div>
            <div class="summary-line"><small>Cash</small><b id="mbx-cash-state">—</b></div>
          </div>
        </details>
        <details class="guide"><summary>How to use the bot</summary>
        <p><b>1.</b> Select XP or Money in Options.<br><b>2.</b> Turn game activities on or off under Activities.<br><b>3.</b> Press Start. The bot checks resources at sensible intervals, and waits through jail or CAPTCHA interruptions. Use Activity to see actions and errors.</p></details>`;
      bd.querySelector('#mbx-run').onclick=toggleBotRunning;
      bd.querySelector('#mbx-refresh').onclick=async()=>{
        if(st.busy)return;
        try{await refreshChar(true);renderStatus();}catch(e){log('Status refresh: '+(e?.message||e),'warn');}
      };
      renderStatus();renderStats();
    } else if (tab === 'modules') {
      const groups=[
        ['Core activities', [['crimes','Crimes (including burglary)','Rotate through pickpocketing, car break-ins, shoplifting and burglary'],['gta','GTA','Steal cars using focus'],['heists','Heists','Spend wit on heists'],['gym','Gym','Train when energy is available'],['jailtime','Jail activities','Train and work while in jail']]],
        ['Money and items', [['jobs','Jobs','Eligible criminal jobs'],['empire','Empire','Collect earnings'],['workshop','Workshop','Items first, selected drugs if nothing craftable'],['smuggling','Smuggling','Run profitable deliveries'],['garage','Garage','Protect cargo cars and crush local low-capacity cars'],['trading','Drug trading','Travel A ↔ B and trade profitable cargo']]],
        ['Rewards and special', [['dailies','Daily objectives','Claim finished rewards'],['missions','Missions','Claim completed missions'],['mobpass','MOB Pass','Claim earned pass rewards'],['bosses','Bosses','Fight eligible Mob bosses'],['oc','Organised crime','Join and contribute to OCs'],['busting','Jail busting','Help prisoners escape']]],
      ];
      bd.innerHTML=`<div class="simple-title">What should run?</div><div class="hint">Green means enabled. Activities wait for their own resources, cooldowns and eligibility.</div>`+
        groups.map(([label,entries])=>`<div class="section-head">${label}</div>`+entries.map(([id,name,detail])=>
          `<div class="simple-mod"><span><b>${name}</b><small>${detail}</small></span><button type="button" data-m="${id}" class="${S.modules[id]?'enabled':''}" aria-pressed="${!!S.modules[id]}">${S.modules[id]?'On':'Off'}</button></div>`).join('')).join('');
      bd.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>{
        const id=b.dataset.m;S.modules[id]=!S.modules[id];save();
        b.textContent=S.modules[id]?'On':'Off';b.classList.toggle('enabled',S.modules[id]);b.setAttribute('aria-pressed',String(!!S.modules[id]));
        if(S.modules[id])metric(id).nextAllowed=0;st.nextAction=0;
      });
    } else if (tab === 'options') {
      bd.innerHTML=`<div class="simple-settings"><div class="simple-title">Simple options</div>
        <div class="hint">Set your trading cities here. Advanced controls are available below.</div>
        <div class="mbx-easy-trade">
          <div class="simple-title">Drug trading — your two cities</div>
          <label class="settings-toggle"><span>Automatic drug trading between selected cities</span><input type="checkbox" id="mbx-easy-trade-enabled" ${S.modules.trading?'checked':''}></label>
          <div class="row2 mbx-trade-city-row">
            <div><label class="f" for="mbx-easy-city-a">First city</label><select id="mbx-easy-city-a"><option value="0">Choose city...</option>${TRADING_CITIES.map(c=>`<option value="${c.id}" ${S.trading.cityA===c.id?'selected':''}>${c.name}</option>`).join('')}</select></div>
            <div><label class="f" for="mbx-easy-city-b">Second city</label><select id="mbx-easy-city-b"><option value="0">Choose city...</option>${TRADING_CITIES.map(c=>`<option value="${c.id}" ${S.trading.cityB===c.id?'selected':''}>${c.name}</option>`).join('')}</select></div>
          </div>
          <div class="hint" id="mbx-easy-trade-route" role="status" aria-live="polite"></div>
          <div class="hint">Saved automatically. Continuous travel alternates between these two cities even without profitable cargo, paying each fare if affordable. Turn it off in Advanced for profit-gated trips. This is Drug Market trading, not Supply Lines smuggling.</div>
        </div>
        <label class="f" for="mbx-easy-mode">Main objective</label>
        <select id="mbx-easy-mode"><option value="xp">Earn XP and rank up</option><option value="money">Make money</option><option value="balanced">Balance XP and money</option><option value="progression">Unlock new activities</option><option value="custom">My saved priority order</option></select>
        <label class="f" for="mbx-easy-check">How often to re-check while idle</label>
        <select id="mbx-easy-check"><option value="30">30 seconds</option><option value="60">1 minute</option><option value="120">2 minutes</option><option value="300">5 minutes</option><option value="1800">30 minutes (default)</option></select>
        <div class="hint">30 minutes is the idle ceiling, not a forced sleep: resource readiness, OC phases, smuggling, Workshop, Empire and other active deadlines can wake the bot earlier.</div>
        <label class="settings-toggle"><span>Automatic CAPTCHA assistance</span><input type="checkbox" data-easy="autoSolveChallenges"></label>
        <label class="settings-toggle"><span>Only one bot tab at once</span><input type="checkbox" data-easy="scheduler.singleTab"></label>
        <label class="settings-toggle"><span>Follow the activity being performed</span><input type="checkbox" data-easy="followPage"></label>
        <label class="settings-toggle"><span>Regenerate high, then spend nerve/focus in batches (keep OC wit)</span><input type="checkbox" data-easy="scheduler.batchResources"></label>
        <label class="settings-toggle"><span>Rotate through all crime types</span><input type="checkbox" data-easy="crimes.mixEnabled"></label>
        <label class="settings-toggle"><span>Workshop: craft items before drugs</span><input type="checkbox" data-easy="workshop.itemsFirst"></label>
        <label class="settings-toggle"><span>Protect cars with 60+ cargo capacity</span><input type="checkbox" data-easy="garage.protect"></label>
        <label class="settings-toggle"><span>Crush low-capacity cars in current district</span><input type="checkbox" data-easy="garage.crushLocal"></label>
        <div class="action-row"><button class="soft-btn" id="mbx-advanced">Advanced controls</button><button class="soft-btn" id="mbx-export-easy">Export diagnostics</button></div>
        <details class="guide"><summary>How does idle waiting work?</summary><p>When nothing is ready, the bot can sleep up to 30 minutes. It still checks earlier for game-specific cooldowns, near-full Empire income, OC actions and predicted resource readiness. A successful action continues after the normal short action gap; server rate limits remain authoritative.</p></details>
      </div>`;
      const cityA=bd.querySelector('#mbx-easy-city-a'),cityB=bd.querySelector('#mbx-easy-city-b');
      const routeStatus=bd.querySelector('#mbx-easy-trade-route');
      function updateTradingRouteStatus(warning='') {
        const a=Number(S.trading.cityA),b=Number(S.trading.cityB);
        const pair=a && b && a!==b;
        routeStatus.textContent=warning || (pair
          ? `${tradingCityName(a)} ↔ ${tradingCityName(b)} · ${S.modules.trading?(S.trading.loopTravel?'Continuous travel enabled':'Profit-gated trading enabled'):'Trading switched off'}`
          : 'Choose two different cities to enable the trading loop.');
      }
      [cityA,cityB].forEach((select,index)=>{select.onchange=()=>{
        const next=Number(select.value)||0;
        const other=index===0?Number(S.trading.cityB):Number(S.trading.cityA);
        if(next && next===other) {
          select.value=String(index===0?S.trading.cityA:S.trading.cityB);
          updateTradingRouteStatus('Choose two different cities — current selection kept.');
          return;
        }
        if(index===0) S.trading.cityA=next; else S.trading.cityB=next;
        normalizeResearchOptions();save();
        metric('trading').nextAllowed=0;st.lastTradeCheck=0;st.nextAction=0;
        updateTradingRouteStatus();renderStatus();
      };});
      bd.querySelector('#mbx-easy-trade-enabled').onchange=e=>{
        S.modules.trading=!!e.target.checked;save();
        if(S.modules.trading) metric('trading').nextAllowed=0;
        st.lastTradeCheck=0;st.nextAction=0;updateTradingRouteStatus();renderStatus();
      };
      updateTradingRouteStatus();
      const mode=bd.querySelector('#mbx-easy-mode');mode.value=S.scheduler.mode;mode.onchange=e=>{setStrategy(e.target.value);renderBody();};
      const idle=bd.querySelector('#mbx-easy-check');idle.value=String(S.scheduler.idleCadenceSeconds);
      if(!idle.value || idle.selectedIndex<0)idle.value='1800';
      idle.onchange=e=>{S.scheduler.idleCadenceSeconds=Number(e.target.value);save();st.nextAction=0;};
      bd.querySelectorAll('[data-easy]').forEach(x=>{
        const path=x.dataset.easy;const keys=path.split('.');const last=keys.pop();const parent=keys.reduce((o,k)=>o[k],S);
        x.checked=!!parent[last];x.onchange=()=>{parent[last]=x.checked;st.resourceCycles={nerve:false,focus:false,wit:false};st.resourceTargets={};save();};
      });
      bd.querySelector('#mbx-advanced').onclick=()=>{S.panel.tab='advanced';save();renderBody();};
      bd.querySelector('#mbx-export-easy').onclick=exportDiagnostics;
    } else if (tab === 'advanced') {
      bd.innerHTML=`<div class="simple-title">Advanced controls</div><div class="hint">Optional settings for experienced users. You can leave these at their defaults.</div>
      <div class="action-row"><button class="soft-btn" data-go="strategy">Detailed strategy</button><button class="soft-btn" data-go="settings">Module settings</button></div>
      <div class="action-row"><button class="soft-btn" data-go="health">Health and diagnostics</button><button class="soft-btn" data-go="options">Back to simple options</button></div>`;
      bd.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{S.panel.tab=b.dataset.go;save();renderBody();});
    } else if (tab === 'strategy') {
      const options = [['balanced','Balanced (your priority order)'],['xp','XP focus'],['money','Money focus'],
        ['progression','Progression'],['custom','Custom priority']];
      const selected = S.scheduler.mode || 'balanced';
      bd.innerHTML = `
        <label class="f">Play style / module priority</label>
        <select id="mbx-strategy">${options.map(([k,v]) => `<option value="${k}" ${selected===k?'selected':''}>${v}</option>`).join('')}</select>
        <div class="mini-note">XP and Money now also optimise individual crimes, GTA, heists, burglaries, jail busts and jail activities. Missing XP rewards use a labelled estimate until actual XP values are exposed.</div>
        <div class="mini-note">With batch mode ON: wait until nerve/focus/wit are high, then keep spending nerve and focus to their low floors while heists preserve wit for OCs. Energy still uses random triggers; disabling batch mode restores the old behaviour.</div>
        <div class="tog"><span>Regenerate high, then spend in batches</span><div class="sw ${S.scheduler.batchResources ? 'on' : ''}" id="mbx-resource-burst"></div></div>
        <div class="row2"><div><label class="f">Nerve: start at %</label><input id="mbx-nerve-start" type="number" min="40" max="100" value="${S.scheduler.nerveStartPct}"></div>
        <div><label class="f">Nerve: stop at %</label><input id="mbx-nerve-stop" type="number" min="0" max="95" value="${S.scheduler.nerveStopPct}"></div></div>
        <div class="row2"><div><label class="f">Focus: start at %</label><input id="mbx-focus-start" type="number" min="40" max="100" value="${S.scheduler.focusStartPct}"></div>
        <div><label class="f">Focus: stop at %</label><input id="mbx-focus-stop" type="number" min="0" max="95" value="${S.scheduler.focusStopPct}"></div></div>
        <div class="row2"><div><label class="f">Wit: start heists at %</label><input id="mbx-wit-start" type="number" min="40" max="100" value="${S.scheduler.witStartPct}"></div>
        <div><label class="f">Keep wit for OC (points)</label><input id="mbx-wit-reserve" type="number" min="0" max="250" value="${S.scheduler.witReserve}"></div></div>
        <div class="mini-note">The OC reserve is a floor, not a guarantee that every Hacker contribution is affordable; its actual requirement may exceed 35 wit.</div>
        <div class="row2"><div><label class="f">Energy / legacy: min %</label><input id="mbx-resource-min" type="number" min="0" max="95" value="${S.scheduler.resourceMinPct}"></div>
        <div><label class="f">Energy / legacy: max %</label><input id="mbx-resource-max" type="number" min="0" max="100" value="${S.scheduler.resourceMaxPct}"></div></div>
        <div class="row2"><div><label class="f">Batch size: min attempts</label><input id="mbx-batch-min" type="number" min="1" max="20" value="${S.scheduler.batchMin}"></div>
        <div><label class="f">Batch size: max attempts</label><input id="mbx-batch-max" type="number" min="1" max="20" value="${S.scheduler.batchMax}"></div></div>
        <div class="tog"><span>Alternate nerve, focus, wit and energy</span><div class="sw ${S.scheduler.alternateResources ? 'on' : ''}" id="mbx-resource-alternate"></div></div>
        <label class="f">Balanced / custom action target</label>
        <select id="mbx-objective"><option value="balanced">Mix XP and money</option><option value="xp">Prioritise XP</option><option value="money">Prioritise money</option></select>
        <div id="mbx-priority">${moduleKeys().map((key,i) => { const m=metric(key); return `
          <div class="prio-row"><span class="prio-num">${i+1}</span><span>${MODULE_NAMES[key] || key}${S.modules[key]?'':' (off)'}</span>
          <span class="prio-stat">${m.actions} acts</span>
          <button data-up="${key}" ${i===0?'disabled':''} title="Higher priority">↑</button>
          <button data-down="${key}" ${i===BASE_ORDER.length-1?'disabled':''} title="Lower priority">↓</button></div>`; }).join('')}</div>
        <label class="f">No-action backoff (seconds)</label><input type="number" id="mbx-empty-ms" min="1" max="60" value="${Math.round(S.scheduler.emptyBackoffMs/1000)}">
        <label class="f">Initial error backoff (seconds)</label><input type="number" id="mbx-error-ms" min="5" max="300" value="${Math.round(S.scheduler.errorBackoffMs/1000)}">
        <div class="mini-note">Modules with no available action get a short rest. Repeated errors back off exponentially up to ${Math.round(S.scheduler.maxErrorBackoffMs/1000)} seconds.</div>
        <label class="f">Saved configurations</label>
        <div class="mbx-row"><button id="mbx-preset-save">+ Save preset</button><button id="mbx-diagnostics">Export diagnostics</button></div>
        <div id="mbx-presets">${presets().length ? presets().map(p => `<div class="preset"><span title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span><button data-apply="${escapeHtml(p.name)}">Apply</button><button data-delete="${escapeHtml(p.name)}" title="Delete">×</button></div>`).join('') : '<div class="mini-note">No saved presets yet.</div>'}</div>`;
      bd.querySelector('#mbx-strategy').onchange = (e) => {setStrategy(e.target.value); renderBody();};
      const changeResource = (field, value) => {
        S.scheduler[field] = Number(value);
        normaliseResourceSettings();
        st.resourceTargets={};st.resourceCycles={nerve:false,focus:false,wit:false};
        save(); renderBody();
      };
      for (const [id,key] of [['mbx-resource-min','resourceMinPct'],['mbx-resource-max','resourceMaxPct'],['mbx-batch-min','batchMin'],['mbx-batch-max','batchMax'],['mbx-nerve-start','nerveStartPct'],['mbx-nerve-stop','nerveStopPct'],['mbx-focus-start','focusStartPct'],['mbx-focus-stop','focusStopPct'],['mbx-wit-start','witStartPct'],['mbx-wit-reserve','witReserve']]) {
        bd.querySelector('#'+id).onchange = (e) => changeResource(key,e.target.value);
      }
      bd.querySelector('#mbx-resource-burst').onclick = () => {
        S.scheduler.batchResources=!S.scheduler.batchResources;
        st.resourceCycles={nerve:false,focus:false,wit:false};st.resourceTargets={};
        save();renderBody();
      };
      bd.querySelector('#mbx-resource-alternate').onclick = () => {
        S.scheduler.alternateResources=!S.scheduler.alternateResources;save();renderBody();
      };
      bd.querySelector('#mbx-objective').value=S.scheduler.customObjective||'balanced';
      bd.querySelector('#mbx-objective').onchange=e=>{S.scheduler.customObjective=e.target.value;save();renderBody();};
      bd.querySelectorAll('[data-up]').forEach(b => b.onclick=()=>moveModule(b.dataset.up,-1));
      bd.querySelectorAll('[data-down]').forEach(b => b.onclick=()=>moveModule(b.dataset.down,1));
      bd.querySelector('#mbx-empty-ms').onchange = (e) => {S.scheduler.emptyBackoffMs=Math.max(1000,Math.min(60000,num(e.target.value)*1000));save();};
      bd.querySelector('#mbx-error-ms').onchange = (e) => {S.scheduler.errorBackoffMs=Math.max(5000,Math.min(300000,num(e.target.value)*1000));save();};
      bd.querySelector('#mbx-preset-save').onclick = savePreset;
      bd.querySelector('#mbx-diagnostics').onclick = exportDiagnostics;
      bd.querySelectorAll('[data-apply]').forEach(b=>b.onclick=()=>applyPreset(b.dataset.apply));
      bd.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>deletePreset(b.dataset.delete));
    } else if (tab === 'health') {
      bd.innerHTML = `
        <div class="mini-note">Persistent statistics across page reloads. These are action attempts recorded by the script, not verified XP or inventory gains.</div>
        <div class="mbx-row"><button id="mbx-health-export">Export report</button><button id="mbx-health-reset">Reset counters</button></div>
        ${moduleKeys().map(key=>{ const m=metric(key); const waiting=Math.max(0,m.nextAllowed-now());return `
          <div class="health-row"><strong>${MODULE_NAMES[key] || key} ${S.modules[key] ? '' : '(disabled)'}</strong>
          <small>${m.actions} actions · ${m.checks} scans · ${m.errors} errors · avg ${m.checks?Math.round(m.totalMs/m.checks):0} ms
          ${waiting?` · backoff ${Math.ceil(waiting/1000)}s`:''}</small>
          ${m.lastError?`<small class="error">Last error: ${escapeHtml(m.lastError)}</small>`:''}</div>`;}).join('')}`;
      bd.querySelector('#mbx-health-export').onclick=exportDiagnostics;
      bd.querySelector('#mbx-health-reset').onclick=resetTelemetry;
    } else if (tab === 'settings') {
      const sec = (id, title, body) => `<details class="sec" data-sec="${id}" ${(S.panel.open || '') === id ? 'open' : ''}><summary>${title}</summary><div class="sec-bd">${body}</div></details>`;
      bd.innerHTML = [
        sec('crimes', 'Crimes, burglary &amp; jail', `
          <div class="row2">
            <div><label class="f">Choose best available crime automatically</label><div class="mini-note">Uses XP or expected cash, depending on your Strategy.</div></div>
            <div class="mini-note">Nerve uses the high/low batch policy from Detailed strategy.</div>
          </div>
          <div class="tog"><span>Mix pickpocketing, car break-ins, shoplifting and burglary</span><div class="sw" data-b="crimes.mixEnabled"></div></div>
          <div class="mini-note">Completes one crime type per nerve turn when available, then moves to the next. XP/Money strategy still chooses the best target within that type.</div>
          <div class="tog"><span>Break into cars</span><div class="sw" data-b="crimes.breakins"></div></div>
          <div class="row2">
            <div><label class="f">Burglary risk limit</label><div class="mini-note">No success cutoff; risk is independently capped.</div></div>
            <div><label class="f">Burglary max jail %</label><input type="number" data-k="burglary.maxJail"></div>
          </div>
          <div class="row2">
            <div><label class="f">Jail bust target</label><div class="mini-note">Best estimated reward; crew priority on ties.</div></div>
            <div><label class="f">Busts per minute</label><input type="number" data-k="busting.maxPerMinute"></div>
          </div>
          <div class="tog"><span>Always bust crew members</span><div class="sw" data-b="busting.alwaysCrew"></div></div>
          <div class="mini-note">Jail activities are automatically selected by expected return. No minimum success setting.</div>`),
        sec('jobs', 'Criminal jobs', `
          <div class="mini-note">Uses actual job eligibility, missing items and daily attempt limits from the game. Joining a multiplayer job can consume its required items, but the reward is not paid until enough players join.</div>
          <div class="tog"><span>Join eligible multiplayer jobs</span><div class="sw" data-b="jobs.joinMultiplayer"></div></div>
          <div class="tog"><span>Wait while another job is pending</span><div class="sw" data-b="jobs.waitForPending"></div></div>
          <label class="f">Daily job attempts to reserve</label><input type="number" min="0" max="12" data-k="jobs.keepDailyAttempts">`),
        sec('gta', 'GTA, heists &amp; gym', `
          <div class="row2">
            <div><label class="f">GTA mode</label><select data-k="gta.mode"><option value="mastery">Mastery on Progression</option><option value="best">Auto XP/Money</option></select></div>
            <div class="mini-note">Focus regenerates to high water, then GTA spends it in batches.</div>
          </div>
          <div class="row2">
            <div><label class="f">Heist targeting</label><div class="mini-note">Automatically picks the best expected XP or cash per wit.</div></div>
            <div class="mini-note">Heists wait for high wit then preserve the configured OC reserve.</div>
          </div>
          <div class="row2">
            <div><label class="f">Gym stat</label><select data-k="gym.stat">
              <option value="auto">Auto (lowest)</option><option>strength</option><option>defence</option><option>speed</option>
              <option>endurance</option><option>stamina</option><option>health</option></select></div>
            <div class="mini-note">Energy uses random small training batches.</div>
          </div>`),
        sec('missions', 'Story missions &amp; challenges', `
          <div class="mini-note">Watches the Missions page and clicks only explicit free Claim buttons. Never auto-starts or cancels missions, spends Points, or selects a jail target.</div>
          <div class="tog"><span>Claim visible mission rewards</span><div class="sw" data-b="missions.claimVisible"></div></div>
          <div class="tog"><span>Open Missions automatically to check</span><div class="sw" data-b="missions.navigateToCheck"></div></div>
          <label class="f">Revisit interval (minutes)</label><input type="number" min="2" data-k="missions.checkMinutes">`),
        sec('empire', 'Empire collection', `
          <div class="mini-note">Checks every 15 minutes, but normally lets Empire operations and business tills reach 90% of their separate caps before collecting. The game reports live fill progress; it is not always 12 hours.</div>
          <div class="tog"><span>Collect Empire earnings automatically</span><div class="sw" data-b="empire.collectVisible"></div></div>
          <div class="tog"><span>Collect any positive earnings immediately instead</span><div class="sw" data-b="empire.collectAny"></div></div>
          <div class="row2"><div><label class="f">Collect at % full</label><input type="number" min="50" max="100" data-k="empire.collectAtPct"></div>
          <div><label class="f">Revisit interval (minutes)</label><input type="number" min="2" max="120" data-k="empire.checkMinutes"></div></div>`),
        sec('garage', 'Garage and smuggling cars', `
          <div class="mini-note">Only acts on confirmed visible Garage rows. Cargo capacity 60+ is protected. Crushing is local to your current district; no travel for crushing. User locks are never removed.</div>
          <div class="tog"><span>Lock high-capacity cars automatically</span><div class="sw" data-b="garage.protect"></div></div>
          <div class="tog"><span>Ship remaining eligible cars to trading City A after crushing</span><div class="sw" data-b="garage.shipAfterCrushToA"></div></div>
          <div class="tog"><span>Crush unprotected local low-capacity cars</span><div class="sw" data-b="garage.crushLocal"></div></div>
          <div class="tog"><span>Repair all damaged cars before crushing</span><div class="sw" data-b="garage.repair"></div></div>
          <div class="tog"><span>Capacity upgrades on visible Smuggling Upgrades tab</span><div class="sw" data-b="garage.upgradeCapacity"></div></div>
          <div class="tog"><span>Open GTA Garage automatically for checks</span><div class="sw" data-b="garage.navigateToGarage"></div></div>
          <div class="row2"><div><label class="f">Protect capacity from</label><input type="number" min="1" data-k="garage.minBaseCapacity"></div>
             <div><label class="f">Garage check interval (minutes)</label><input type="number" min="10" data-k="garage.checkMinutes"></div></div>
          <label class="f">Maximum total crusher fee ($)</label><input type="number" min="0" data-k="garage.maxCrushTotalFee">
          <div class="mini-note">All damaged cars (including locked and high-capacity cars) must be repaired first, across every Garage page. If any car is busy, its damage or repair price is unknown, or repairs cannot be afforded, crushing waits. Only unprotected low-capacity cars in your current district are crushed using the ID-selective request.</div>
          <div class="row2"><div><label class="f">Max repair cost ($)</label><input type="number" min="0" data-k="garage.maxRepairCost"></div>
             <div><label class="f">Max capacity upgrade ($)</label><input type="number" min="0" data-k="garage.maxCapacityUpgradeCost"></div></div>
          <label class="f">Keep cash reserve ($)</label><input type="number" min="0" data-k="garage.keepCash">
          <div class="mini-note">Repairs use the verified /garage/repair API and are checked against a fresh Garage snapshot. Maximum repair cost applies per car and the cash reserve is maintained. Door Panels upgrades still require visible priced controls. An uncertain repair result prevents another paid action until checked.</div>`),
        sec('drugs', 'Drugs, smuggling &amp; trading', `
          <div class="tog"><span>Craft affordable Items before drugs</span><div class="sw" data-b="workshop.itemsFirst"></div></div>
          <div class="tog"><span>Craft selected drugs when no item is affordable</span><div class="sw" data-b="workshop.drugsFallback"></div></div>
          <div class="tog"><span>Open Workshop Items page when needed</span><div class="sw" data-b="workshop.navigateToItems"></div></div>
          <div class="row2"><div><label class="f">Max cash per item craft ($)</label><input type="number" min="0" data-k="workshop.maxItemCost"></div>
          <div><label class="f">Reserve cash for item crafts ($)</label><input type="number" min="0" data-k="workshop.keepCash"></div></div>
          <div class="mini-note">Uses the captured game's verified item-crafting request. Checks materials, queue time, cost and cash reserve, then confirms the queue response. Unknown replies are held for reconciliation.</div>
          <label class="f">Workshop drugs to produce (separate from smuggling)</label>
          <div class="chips">${DRUG_LIST.map((d) => `<div class="chip ${S.drugs.includes(d) ? 'on' : ''}" data-drug="${d}">${d}</div>`).join('')}</div>
          <div class="tog"><span>Use workshop enhancers</span><div class="sw" data-b="workshop.useEnhancer"></div></div>
          <div class="row2">
            <div><label class="f">Smuggle min load</label><input type="number" data-k="smuggling.minLoad"></div>
            <div></div>
          </div>
          <div class="row2"><div><label class="f">Smuggling check every (minutes)</label><input type="number" min="3" max="60" data-k="smuggling.checkMinutes"></div><div></div></div>
          <div class="mini-note">Supply Lines buys cargo for you. It compares live prices from your CURRENT district to each destination. Any available car meeting min load can run; garage's 60+ is only a permanent protection rule.</div>
          <label class="f">Allowed smuggling cargo</label>
          <div class="chips">${DRUG_LIST.map((d) => `<div class="chip ${S.smuggling.allowedDrugs.includes(d) ? 'on' : ''}" data-smuggle-drug="${d}">${d}</div>`).join('')}</div>
          <div class="row2"><div><label class="f">Minimum net profit ($)</label><input type="number" min="0" data-k="smuggling.minExpectedProfit"></div><div><label class="f">Reserve cash ($)</label><input type="number" min="0" data-k="smuggling.keepCash"></div></div>
          <div class="mini-note">Destination and drug change with live prices. The game preview confirms cost, estimated payout, success chance and duration before any paid launch; XP not exposed uses profit/hour as fallback.</div>
          <div class="tog"><span>Travel to finish smuggles</span><div class="sw" data-b="smuggling.autoTravelToComplete"></div></div>
          <div class="tog"><span>Keep travelling A ↔ B even without profitable drugs</span><div class="sw" data-b="trading.loopTravel"></div></div>
          <div class="mini-note">With this on, travel alternates between your two selected cities whenever the game permits, even with no drugs, and always pays the fare. Profitable cargo is optional; keep-cash, travel cooldown, locked destinations and jail/hospital still block travel. Switch off for profit-gated travel.</div>
          <div class="row2">
            <div><label class="f">Trade min profit %</label><input type="number" data-k="trading.minProfitPct"></div>
            <div><label class="f">Max police risk %</label><input type="number" data-k="trading.maxRisk"></div>
          </div>
          <div class="row2">
            <div><label class="f">Keep cash ($)</label><input type="number" min="0" data-k="trading.keepCash"></div>
            <div><label class="f">Minimum cargo profit ($)</label><input type="number" min="1" data-k="trading.minNetProfit"></div>
          </div>
          <div class="tog"><span>Sell all held drugs at the current market</span><div class="sw" data-b="trading.sellInventory"></div></div>
          <div class="mini-note">Crafted, rewarded and manually held drugs are sold locally when the market allows. Planned trading cargo is held for its destination. Continuous travel may lose money on fares when no profitable cargo is available; the keep-cash reserve still applies.</div>`),
        sec('oc', 'Organised crime &amp; bosses', `
          <label class="f">Roles to join (tap to toggle, in order)</label>
          <div class="chips" id="mbx-ocroles">${[4, 2, 3, 5].map((r) => `<div class="chip ${S.oc.roles.includes(r) ? 'on' : ''}" data-ocrole="${r}">${{ 4: 'Driver', 2: 'Weapons', 3: 'Explosives', 5: 'Hacker' }[r]}</div>`).join('')}</div>
          <div class="tog"><span>Accept OC invites</span><div class="sw" data-b="oc.acceptInvites"></div></div>
          <div class="tog"><span>Contribute automatically</span><div class="sw" data-b="oc.contribute"></div></div>
          <div class="tog"><span>Host public five-player OC if none is joinable</span><div class="sw" data-b="oc.hostPublicFive"></div></div>
          <div class="tog"><span>Start only after all five real players are Ready</span><div class="sw" data-b="oc.startWhenReady"></div></div>
          <label class="f">Preferred OC order (highest first)</label>
          <div class="mini-note">Import Dock Raid → Sporting Goods Robbery → Casino Heist. Joins prioritise recognised operations; hosting selects the highest available choice in the verified live form.</div>
          <div class="mini-note">The bot only joins seats whose live readiness says you can contribute. If a planning seat cannot be funded and nothing was submitted, it tries the verified Leave control and another role. Hosting is held unless a usable Leader item is verified—never block other players with an unfunded lobby. No NPC/Points fallback.</div>
          <div class="tog"><span>Attack your solo boss</span><div class="sw" data-b="bosses.solo"></div></div>
          <div class="tog"><span>Attack the world boss</span><div class="sw" data-b="bosses.world"></div></div>`),
        sec('general', 'General, refresh &amp; alerts', `
          <div class="tog"><span>Only one active Mobsteria tab per browser profile</span><div class="sw" data-b="scheduler.singleTab"></div></div>
          <div class="tog"><span>Show pages as it works</span><div class="sw" data-b="followPage"></div></div>
          <div class="tog"><span>Close achievement &amp; level-up pop-ups</span><div class="sw" data-b="closePopups"></div></div>
          <div class="tog"><span>Detect and describe challenges</span><div class="sw" data-b="challengeAssist"></div></div>
          <div class="tog"><span>Auto-solve supported CAPTCHAs (local)</span><div class="sw" data-b="autoSolveChallenges"></div></div>
          <div class="row2">
            <div><label class="f">Refresh if stuck (min)</label><input type="number" min="0" data-k="stuckReloadMins"></div>
            <div><label class="f">Refresh every (min)</label><input type="number" min="0" data-k="autoReloadMins"></div>
          </div>
          <div class="row2">
            <div><label class="f">Delay min (ms)</label><input type="number" min="250" data-k="delays.min"></div>
            <div><label class="f">Delay max (ms)</label><input type="number" min="250" data-k="delays.max"></div>
          </div>
          <label class="f">Minimum gap between API requests (ms)</label><input type="number" min="250" max="3000" step="50" data-k="pacing.requestGapMs">
          <div class="mini-note">Reduces rapid request bursts and respects Retry-After rate limits. Does not imitate trusted human cursor events or guarantee protection from bot detection.</div>
          <label class="f">NTFY topic (phone alerts)</label><input type="text" data-k="ntfyTopic" placeholder="e.g. kyle-mobbot">`),
      ].join('');
      // One section open at a time, remembered between reloads
      bd.querySelectorAll('details.sec').forEach((d) => d.addEventListener('toggle', () => {
        if (d.open) {
          bd.querySelectorAll('details.sec').forEach((o) => { if (o !== d) o.open = false; });
          S.panel.open = d.dataset.sec; save();
        } else if (S.panel.open === d.dataset.sec) { S.panel.open = ''; save(); }
      }));
      const getP = (p) => p.split('.').reduce((o, k) => o?.[k], S);
      const setP = (p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], S)[last] = v; save(); };
      bd.querySelectorAll('[data-k]').forEach((i) => {
        i.value = getP(i.dataset.k);
        i.onchange = () => {setP(i.dataset.k, i.type === 'number'?num(i.value):i.value);normalizeResearchOptions();metric('trading').nextAllowed=0;st.lastTradeCheck=0;st.nextAction=0;renderStatus();};
      });
      S.delays.min=Math.max(1000,Math.min(60000,Number(S.delays.min)||2500));
      S.delays.max=Math.max(S.delays.min,Math.min(60000,Number(S.delays.max)||6000));
      bd.querySelectorAll('[data-drug]').forEach((c) => {
        c.onclick = () => {
          const d = c.dataset.drug;
          S.drugs = S.drugs.includes(d) ? S.drugs.filter((x) => x !== d) : [...S.drugs, d];
          save();
          c.classList.toggle('on', S.drugs.includes(d));
          log(`Drugs: ${S.drugs.join(', ') || 'none'}`, 'info');
        };
      });
      bd.querySelectorAll('[data-smuggle-drug]').forEach((c) => {
        c.onclick=()=>{
          const d=c.dataset.smuggleDrug;
          S.smuggling.allowedDrugs=S.smuggling.allowedDrugs.includes(d)?
            S.smuggling.allowedDrugs.filter(x=>x!==d):[...S.smuggling.allowedDrugs,d];
          save();c.classList.toggle('on',S.smuggling.allowedDrugs.includes(d));
          metric('smuggling').nextAllowed=0;st.lastSmuggleCheck=0;st.nextAction=0;
          log(`Smuggling cargo: ${S.smuggling.allowedDrugs.join(', ')||'none'}`,'info');
        };
      });
      bd.querySelectorAll('[data-ocrole]').forEach((c) => {
        c.onclick = () => {
          const r = Number(c.dataset.ocrole);
          S.oc.roles = S.oc.roles.includes(r) ? S.oc.roles.filter((x) => x !== r) : [...S.oc.roles, r];
          save(); c.classList.toggle('on', S.oc.roles.includes(r));
          log(`OC roles: ${S.oc.roles.map((x) => OC_ROLES[x]).join(', ') || 'none'}`, 'info');
        };
      });
      bd.querySelectorAll('[data-b]').forEach((s) => {
        s.classList.toggle('on', !!getP(s.dataset.b));
        s.onclick = () => { const v = !getP(s.dataset.b); setP(s.dataset.b, v); s.classList.toggle('on', v); };
      });
    } else if (tab === 'log') {
      bd.innerHTML = `<div class="simple-title">Recent activity</div><div class="hint">Actions, waiting reasons and errors. For detailed reports, use Options → Advanced.</div><div class="log" id="mbx-log"></div>`;
      renderLog();
    }
    if(['strategy','settings','health'].includes(tab)) {
      const back=document.createElement('button');back.className='nav-back';back.textContent='← Back to simple options';
      back.onclick=()=>{S.panel.tab='options';save();renderBody();};bd.prepend(back);
    }
  }

  function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function renderStatus() {
    if (!root) return;
    const quick=root.querySelector('#mbx-quick-run');
    if(quick){quick.textContent=S.running?'Stop':'Start';quick.setAttribute('aria-label',S.running?'Stop bot':'Start bot');}
    const dot = root.querySelector('#mbx-dot');
    const retryCaptcha=root.querySelector('#mbx-captcha-refresh');
    if(retryCaptcha)retryCaptcha.hidden=!(st.challengeRecoveryReason && !!challengeDom());
    const stateEl = root.querySelector('#mbx-state');
    let cls = '', text = 'Stopped', dcls = '';
    if (st.challenge) { cls = 'bad'; dcls = 'bad'; text = lastChallengeInfo ? `Challenge active — ${lastChallengeInfo}. Auto-solver will attempt once; manually finish if needed.` : 'Challenge active — local solver or manual verification required.'; }
    else if (S.running && st.otherTab) { cls='wait'; dcls='wait'; text='Another Mobsteria tab is active — standing by.'; }
    else if (S.running && isJailed()) { cls = 'wait'; dcls = 'wait'; text = `In jail - resuming in ${fmt(jailLeft())}`; }
    else if (S.running && st.paused) { cls = 'wait'; dcls = 'wait'; text = `Waiting (${st.paused.reason})`; }
    else if (S.running) { dcls = 'on'; text = `Running${st.char ? ' in ' + st.char.location : ''}`; }
    if (dot) dot.className = 'dot ' + dcls;
    if (stateEl) { stateEl.className = 'state ' + cls; stateEl.textContent = text; }

    const strategyEl = root.querySelector('#mbx-strategy-state');
    if (strategyEl) strategyEl.textContent = ({xp:'XP focus',money:'Money focus',balanced:'Balanced',progression:'Progression',custom:'Custom'}[S.scheduler.mode]||'Balanced');
    const nextEl=root.querySelector('#mbx-next-state');
    const dueAt=S.running?Math.max(now(),Number(st.nextAction||0)):0;
    if(nextEl)nextEl.textContent=S.running?(dueAt>now()?fmt(Math.ceil((dueAt-now())/1000)):'Now'):'Paused';
    const currentEl=root.querySelector('#mbx-current-action');
    if(currentEl)currentEl.textContent=!S.running?'Stopped':st.busy && st.activeModule?(MODULE_NAMES[st.activeModule]||st.activeModule):'Idle / waiting';
    const eligible=prioritizeTimeSensitiveModules(prioritizedModules())
      .map(([key])=>({key,at:Number(metric(key).nextAllowed||0)}))
      .filter(x=>S.modules[x.key])
      .sort((a,b)=>a.at-b.at);
    const nextKey=eligible.find(x=>x.at<=Math.max(now(),dueAt)+1500)?.key || eligible[0]?.key;
    const nm=root.querySelector('#mbx-next-module');if(nm)nm.textContent=!S.running?'Paused':nextKey?(MODULE_NAMES[nextKey]||nextKey):'No modules enabled';
    const wait=root.querySelector('#mbx-waiting-for');
    if(wait){
      let why='Next scheduled scan';
      if(!S.running)why='Press Start';
      else if(st.challenge)why='Complete CAPTCHA';
      else if(st.otherTab)why='Other bot tab to release control';
      else if(st.paused)why=st.paused.reason;
      else if(nextKey==='trading')why=st.tradeStatus;
      else if(nextKey==='oc')why=st.ocStatus;
      else if(nextKey==='smuggling')why=st.smuggleStatus;
      else if(nextKey==='empire')why=st.empireStatus;
      else if(nextKey==='garage')why=st.garageStatus;
      else if(MODULE_RESOURCE[nextKey] && st.char){
        const resource=MODULE_RESOURCE[nextKey], r=res(resource);
        const floor=resourceFloor(resource);
        const target=st.resourceCycles[resource]?floor:Math.ceil(Number(r.max||0)*resourceStartPct(resource)/100);
        why=`${resource[0].toUpperCase()+resource.slice(1)} ${Math.floor(Number(r.current||0))}/${Math.floor(Number(r.max||0))} — ${st.resourceCycles[resource]?'spending down to '+floor:'waiting for '+target}`;
      } else if(nextKey && metric(nextKey).nextAllowed>now()) why=`${MODULE_NAMES[nextKey]||nextKey} check cooldown`;
      wait.textContent=String(why||'Waiting for eligibility').slice(0,170);
    }
    const lastEl=root.querySelector('#mbx-last-state');if(lastEl)lastEl.textContent=st.lastActionModule?(MODULE_NAMES[st.lastActionModule]||st.lastActionModule):'None yet';
    const empEl=root.querySelector('#mbx-empire-state');if(empEl)empEl.textContent=S.modules.empire?st.empireStatus:'Off';
    const smEl=root.querySelector('#mbx-smuggling-state');if(smEl)smEl.textContent=S.modules.smuggling?st.smuggleStatus:'Off';
    const tradingEl=root.querySelector('#mbx-trading-state');if(tradingEl)tradingEl.textContent=S.modules.trading?st.tradeStatus:'Off';
    const ocShort=root.querySelector('#mbx-oc-short-state');if(ocShort)ocShort.textContent=S.modules.oc?st.ocStatus:'Off';
    const garageEl=root.querySelector('#mbx-garage-state');
    if(garageEl) garageEl.textContent=S.modules.garage?st.garageStatus:'Off';
    const cashEl=root.querySelector('#mbx-cash-state');if(cashEl)cashEl.textContent=st.char?money(st.char.money):'—';

    const rotationEl=root.querySelector('#mbx-rotation-state');
    if (rotationEl) rotationEl.textContent=S.scheduler.batchResources
      ? `Batch: nerve ${S.scheduler.nerveStartPct}→${S.scheduler.nerveStopPct}%, focus ${S.scheduler.focusStartPct}→${S.scheduler.focusStopPct}%, wit ${S.scheduler.witStartPct}%→${S.scheduler.witReserve} reserved for OC`
      : `Resource rotation: next ${st.nextResource} · random trigger ${S.scheduler.resourceMinPct}–${S.scheduler.resourceMaxPct}% · batches ${S.scheduler.batchMin}–${S.scheduler.batchMax}`;

    const ocStateEl=root.querySelector('#mbx-oc-state');
    if (ocStateEl) ocStateEl.textContent=`OC: ${S.modules.oc ? st.ocStatus : 'module disabled'}${S.modules.oc && !S.oc.contribute ? ' (auto contribution OFF)' : ''}`;
    const missionEl=root.querySelector('#mbx-mission-state');
    if(missionEl) missionEl.textContent=`Missions: ${S.modules.missions?st.lastMissionSummary:'module disabled'}`;
    const resEl = root.querySelector('#mbx-res');
    if (resEl && st.char) {
      const rows = [['nerve', 'Nerve', 'var(--v4-res-nerve)'], ['focus', 'Focus', 'var(--v4-res-focus)'], ['wit', 'Wit', 'var(--v4-res-wit)'], ['energy', 'Energy', 'var(--v4-res-energy)']];
      resEl.innerHTML = rows.map(([k, label, c]) => {
        const r = res(k), cu = num(r.current), mx = num(r.max) || 1;
        return `<div class="res"><span>${label}</span><div class="bar"><i style="width:${Math.min(100, (cu / mx) * 100)}%;background:${c}"></i></div><em>${Math.floor(cu)}/${Math.floor(mx)}</em></div>`;
      }).join('');
    }
  }

  function renderStats() {
    const g = root?.querySelector('#mbx-stats');
    if (!g) return;
    const s = st.stats;
    g.innerHTML = `
      <div class="cell"><small>Cash</small><b style="color:var(--v4-money)">${st.char ? money(st.char.money) : '-'}</b></div>
      <div class="cell"><small>Actions</small><b>${s.actions}</b></div>
      <div class="cell"><small>Busts</small><b>${s.bustOk}/${s.busts}</b></div>
      <div class="cell"><small>Crafts queued / Runs</small><b>${s.crafts} / ${s.smuggles}</b></div>
      <div class="cell"><small>Boss hits</small><b>${s.bossHits}</b></div>
      <div class="cell"><small>Jailed</small><b>${s.jailed}</b></div>
      <div class="cell"><small>Trades / profit</small><b>${s.trades} / ${money(s.tradeProfit)}</b></div>
      <div class="cell"><small>OCs joined</small><b>${s.ocs}</b></div>`;
  }

  function renderLog() {
    const l = root?.querySelector('#mbx-log');
    if (!l) return;
    l.innerHTML = st.log.map((e) => `<div class="${['info','good','warn','bad'].includes(e.type) ? e.type : 'info'}"><span class="t">${escapeHtml(e.t)}</span>${escapeHtml(e.msg)}</div>`).join('') || '<div>No activity yet</div>';
  }

  // Jail countdown ticker on the panel
  setInterval(() => {
    if (root && S.panel.tab==='home') renderStatus();
    if (st.char?.jail?.isInJail && st.char.jail.timeLeft > 0) {
      st.char.jail.timeLeft = Math.max(0, st.char.jail.timeLeft - 1);
      renderStatus();
    }
  }, 1000);

  function boot() {
    if (!document.body) return setTimeout(boot, 500);
    buildUI();
    log('Mobsteria Bot V2.3.12 loaded — paginated garage, compact Start/Stop', 'info');
    inspectChallenge();
    refreshChar(true).catch(() => {});
    log(S.running ? 'Loaded - bot is running' : 'Loaded - press Start', 'info');
  }
  boot();
})();