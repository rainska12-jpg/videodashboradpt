const STORAGE_KEY = "pd-production-dashboard-v4";
const PREFS_KEY = "pd-production-dashboard-prefs-v1";
const ADMIN_PASSWORD = "0314";
const AUTH_DISABLED = false;
const ENV = window.__ENV__ || {};
const SUPABASE_URL = ENV.SUPABASE_URL || ENV.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = ENV.SUPABASE_ANON_KEY || ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const SUPABASE_ENABLED = Boolean(window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY);
const DASHBOARD_STATE_ROW_ID = "main";
let supabaseClient = null;
let currentProfile = null;
let remoteStateLoaded = false;
let remoteSaveTimer = null;
let isRemoteHydrating = false;

function getSupabaseClient() {
  if (!SUPABASE_ENABLED) return null;
  if (!supabaseClient) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage
      }
    });
  }
  return supabaseClient;
}

function profileToUser(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    username: profile.email,
    email: profile.email,
    name: profile.name || profile.email,
    position: profile.position || "과원",
    role: profile.role || "user",
    status: profile.status || (profile.approved ? "active" : "pending"),
    approved: profile.approved === true || profile.status === "approved"
  };
}

function mergeProfileUser(profile) {
  const user = profileToUser(profile);
  if (!user) return null;
  const index = state.users.findIndex((item) => item.id === user.id || item.email === user.email);
  if (index >= 0) state.users[index] = { ...state.users[index], ...user };
  else state.users.push(user);
  state.currentUser = user.id;
  currentProfile = user;
  return user;
}

async function fetchCurrentProfile() {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data: sessionData } = await client.auth.getSession();
  const session = sessionData?.session;
  if (!session?.user) return null;
  const { data, error } = await client.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error) throw error;
  const profile = data || {
    id: session.user.id,
    email: session.user.email,
    name: session.user.user_metadata?.name || session.user.email,
    position: session.user.user_metadata?.position || "과원",
    role: "user",
    status: "pending",
    approved: false
  };
  return mergeProfileUser(profile);
}

async function loadRemoteDashboardState() {
  const client = getSupabaseClient();
  if (!client || !currentProfile?.approved) return;
  const { data, error } = await client.from("dashboard_state").select("data").eq("id", DASHBOARD_STATE_ROW_ID).maybeSingle();
  if (error) {
    console.warn("Supabase dashboard load failed", error);
    return;
  }
  if (data?.data) {
    isRemoteHydrating = true;
    state = migrateOwnerState(normalizeState(data.data));
    mergeProfileUser(currentProfile);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    isRemoteHydrating = false;
  } else {
    await saveRemoteDashboardState();
  }
  remoteStateLoaded = true;
}

async function saveRemoteDashboardState() {
  const client = getSupabaseClient();
  if (!client || !currentProfile?.approved || isRemoteHydrating) return false;
  const payload = { ...state, currentUser: currentProfile.id };
  const { error } = await client
    .from("dashboard_state")
    .upsert({ id: DASHBOARD_STATE_ROW_ID, data: payload, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) {
    console.warn("Supabase dashboard save failed", error);
    return false;
  }
  return true;
}

function queueRemoteSave() {
  if (!SUPABASE_ENABLED || !currentProfile?.approved || isRemoteHydrating) return;
  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(() => {
    saveRemoteDashboardState();
  }, 700);
}

async function initSupabaseSession() {
  const client = getSupabaseClient();
  if (!client) return;
  try {
    const user = await fetchCurrentProfile();
    if (!user) {
      currentProfile = null;
      state.currentUser = null;
      renderAll();
      return;
    }
    if (!user.approved || user.status === "pending") {
      await client.auth.signOut();
      currentProfile = null;
      state.currentUser = null;
      setAuthMessage("관리자 승인 대기 중입니다.");
      renderAll();
      return;
    }
    await loadRemoteDashboardState();
    await refreshSupabaseProfiles();
    renderAll();
  } catch (error) {
    console.warn("Supabase session init failed", error);
  }
}

async function refreshSupabaseProfiles() {
  const client = getSupabaseClient();
  if (!client || !isAdminUser()) return;
  const { data, error } = await client.from("profiles").select("*").order("created_at", { ascending: false });
  if (error) {
    console.warn("Supabase profile list failed", error);
    return;
  }
  (data || []).forEach((profile) => {
    const user = profileToUser(profile);
    const index = state.users.findIndex((item) => item.id === user.id || item.email === user.email);
    if (index >= 0) state.users[index] = { ...state.users[index], ...user };
    else state.users.push(user);
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function syncProfileToSupabase(user) {
  const client = getSupabaseClient();
  if (!client || !isAdminUser() || !user?.id) return;
  await client.from("profiles").update({
    name: user.name,
    position: user.position,
    role: user.role,
    status: user.approved ? "approved" : user.status || "pending",
    approved: user.approved === true
  }).eq("id", user.id);
}

async function deleteProfileFromSupabase(userId) {
  const client = getSupabaseClient();
  if (!client || !isAdminUser() || !userId) return;
  await client.from("profiles").delete().eq("id", userId);
}

const makeId = () => `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const defaultCalendarFields = { kickoffDate: false, shootDate: false, firstEditDate: false, finalDate: true };
const defaultWorkCalendarFields = { kickoffDate: false, finalDate: true };
const visibleDetailCalendarFields = ["kickoffDate", "finalDate"];
const visibleWorkDetailCalendarFields = ["kickoffDate", "finalDate"];
const defaultOwnerNames = ["김연아", "오상민", "주햇빛", "변명근", "조준호", "유희수"];
const legacyOwnerDefaultSets = [
  ["PD", "작가", "촬영", "편집", "마케팅", "유희수"],
  ["유희수", "김민수", "박지훈", "PD", "작가", "촬영", "편집", "마케팅", "미배정"]
];

const defaultOptions = {
  methods: ["단건", "패키지", "월간 운영", "연간 운영"],
  types: ["홍보영상", "인터뷰", "숏폼", "유튜브", "제안서"],
  statuses: ["기획", "촬영 예정", "촬영", "편집", "검수", "납품 완료"],
  owners: [...defaultOwnerNames],
  clients: ["월드비전", "공공기관", "기업", "내부 프로젝트", "교회", "교육팀", "브랜드팀", "홍보팀"],
  taskTypes: ["촬영", "편집", "기획", "미팅", "기타"],
  projectTaskTypes: ["촬영", "편집", "기획", "미팅", "기타"],
  workTaskTypes: ["기획", "자료 정리", "미팅", "행정", "기타"],
  workTypes: ["일반 업무", "제안", "자료 정리", "운영", "행정"],
  workStatuses: ["대기", "진행", "검토", "완료"],
  workOwners: [...defaultOwnerNames],
  workClients: ["내부", "공공기관", "기업", "교회"],
  studioRooms: ["방송실 A", "방송실 B", "스튜디오", "편집실", "장비실"],
  staffTypes: ["정기교육", "비정기교육", "방송실 스탭", "장비 점검", "외부 지원", "촬영 지원"],
  studioStaffOwners: [...defaultOwnerNames],
  trainingTypes: ["자막 송출 교육", "카메라 기초 교육", "라이브 스위처 교육", "장비 점검 교육", "현장 실습"]
};

const sampleData = {
  options: structuredClone(defaultOptions),
  users: [{ id: "user-admin", username: "videoadmin", email: "admin@videowork.io", password: "0314", name: "관리자", position: "관리자", role: "admin", status: "active", approved: true }],
  currentUser: null,
  projects: [],
  works: [],
  owners: [],
  notifications: [],
  tasks: [],
  schedules: [],
  staffEvents: [],
  recurringTrainings: []
};

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

let dashboardPrefs = loadPrefs();

function savePrefs(patch = {}) {
  dashboardPrefs = { ...dashboardPrefs, ...patch };
  localStorage.setItem(PREFS_KEY, JSON.stringify(dashboardPrefs));
}

function saveViewPrefs(patch = {}) {
  savePrefs({
    views: {
      ...(dashboardPrefs.views || {}),
      ...patch
    }
  });
}

function viewPref(key, fallback) {
  return dashboardPrefs.views && Object.prototype.hasOwnProperty.call(dashboardPrefs.views, key)
    ? dashboardPrefs.views[key]
    : fallback;
}

let state = migrateOwnerState(loadState());
let calendarDate = new Date(viewPref("calendarDate", dateKey(new Date())));
let studioWeekDate = new Date(viewPref("studioWeekDate", dateKey(new Date())));
let studioViewMode = viewPref("studioViewMode", "week");
let studioTrainingTypeFilters = viewPref("studioTrainingTypeFilters", {});
let studioDragDraft = null;
let staffRowDragId = null;
let activeProjectId = null;
let activeWorkId = null;
let isAdminUnlocked = false;
let adminProfilesRefreshing = false;
let taskDraft = { projectId: state.projects[0]?.id || "", owner: ownerOptions()[0] || "", dueDate: dateKey(new Date()) };
let taskOverviewFilter = viewPref("taskOverviewFilter", "all");
let taskOverviewSearch = viewPref("taskOverviewSearch", "");
let taskOverviewSort = viewPref("taskOverviewSort", "dueAsc");
let taskOverviewOwner = viewPref("taskOverviewOwner", "");
let taskOverviewType = viewPref("taskOverviewType", "");
let taskOverviewProject = viewPref("taskOverviewProject", "");
let taskOverviewHideDone = viewPref("taskOverviewHideDone", true);
let scheduleDraft = { editingScheduleId: null, owners: ownerOptions()[0] ? [ownerOptions()[0]] : [], date: dateKey(new Date()), allDay: true, startTime: "09:00", endTime: "10:00" };
let staffScheduleDraft = { title: "", room: "", type: "", owner: "", trainingType: "", date: dateKey(new Date()), allDay: false, startTime: "09:00", endTime: "10:00", repeatEnabled: false, repeatCount: 8, repeatDays: [], repeatEndMode: "none", repeatUntil: "", staffRows: [] };
let recurringTrainingDraft = { room: state.options.studioRooms[0] || "", type: state.options.staffTypes[0] || "정기교육", owner: "", trainingType: state.options.trainingTypes[0] || "", startDate: dateKey(new Date()), repeat: "매주", count: 8, allDay: true, startTime: "09:00", endTime: "10:00" };
let activeStaffEventId = null;
let selectedStaffCalendarId = null;
let activeScheduleEventId = null;
let highlightedProjectTaskId = null;
let highlightedWorkTaskId = null;
let pendingDeleteAction = null;
let pendingRepeatDeleteEventId = null;
let detailTaskDraft = { title: "", detail: "", type: "", owners: [], dueDate: dateKey(new Date()), noDueDate: false, allDay: true, startTime: "09:00", endTime: "10:00", calendar: false, editingTaskId: null };
let detailTaskComposerOpen = false;
let editingRecordId = null;
let recordSearchQuery = "";
let recordFilterMode = viewPref("recordFilterMode", "all");
let activeDetailTab = "basic";
let detailTaskSort = viewPref("detailTaskSort", "created");
let workTaskDraft = { title: "", detail: "", type: "", owners: [], dueDate: dateKey(new Date()), noDueDate: false, allDay: true, startTime: "09:00", endTime: "10:00", calendar: false, editingTaskId: null };
let workTaskComposerOpen = false;
let workTaskSort = viewPref("workTaskSort", "created");
let editingWorkRecordId = null;
let workRecordSearchQuery = "";
let workRecordFilterMode = viewPref("workRecordFilterMode", "all");
let activeWorkDetailTab = "basic";
let projectSearchQuery = viewPref("projectSearchQuery", "");
let projectFilters = viewPref("projectFilters", { type: "", client: "", status: "" });
let projectSort = viewPref("projectSort", { key: "finalDate", direction: "asc" });
let workSearchQuery = viewPref("workSearchQuery", "");
let workSort = viewPref("workSort", { key: "finalDate", direction: "asc" });
let isProjectFilterOpen = false;
let activeCalendarMode = viewPref("activeCalendarMode", "all");
let calendarFilters = viewPref("calendarFilters", { video: true, work: true, staff: true });
let activeView = "overview";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const won = (value) => `${Number(value || 0).toLocaleString("ko-KR")}원`;
const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");


function stableOwnerId(name, index = 0) {
  const encoded = encodeURIComponent(String(name || "owner")).replace(/%/g, "").toLowerCase();
  return `owner-${encoded || "slot"}-${index}`;
}

function makeOwnerSlot(name, index = 0) {
  return {
    id: stableOwnerId(name, index),
    name: String(name || "").trim(),
    linkedUserId: null,
    status: "active"
  };
}

function uniqueValues(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function ownerDefaultSetMatches(names) {
  const sorted = uniqueValues(names).sort();
  return legacyOwnerDefaultSets.some((defaults) => {
    const defaultSorted = uniqueValues(defaults).sort();
    return sorted.length === defaultSorted.length && sorted.every((name, index) => name === defaultSorted[index]);
  });
}

function migrateOwnerState(nextState) {
  const existingOwners = Array.isArray(nextState.owners) ? nextState.owners : [];
  const savedOwnerNames = uniqueValues([
    ...(nextState.options?.owners || []),
    ...(nextState.options?.workOwners || []),
    ...(nextState.options?.studioStaffOwners || []),
    ...existingOwners.map((owner) => owner?.name || owner?.id || "")
  ]);
  if (nextState.ownerDefaultsVersion !== 2 && ownerDefaultSetMatches(savedOwnerNames)) {
    nextState.options = {
      ...nextState.options,
      owners: [...defaultOwnerNames],
      workOwners: [...defaultOwnerNames],
      studioStaffOwners: [...defaultOwnerNames]
    };
    nextState.owners = existingOwners
      .filter((owner) => defaultOwnerNames.includes(owner?.name || owner?.id || ""))
      .map((owner) => ({ ...owner, status: owner.status || "active" }));
  }
  const optionNames = uniqueValues([
    ...(nextState.options?.owners || []),
    ...(nextState.options?.workOwners || []),
    ...(nextState.options?.studioStaffOwners || [])
  ]);
  const ownerByName = new Map();
  existingOwners.forEach((owner, index) => {
    const name = owner?.name || owner?.id || "";
    if (!name) return;
    ownerByName.set(name, {
      id: owner.id || stableOwnerId(name, index),
      name,
      linkedUserId: owner.linkedUserId || null,
      status: owner.status || "active"
    });
  });

  const collectOwners = (values) => uniqueValues(values).forEach((name) => {
    if (!ownerByName.has(name) && ![...ownerByName.values()].some((owner) => owner.id === name)) {
      ownerByName.set(name, makeOwnerSlot(name, ownerByName.size));
    }
  });
  collectOwners(optionNames);
  (nextState.projects || []).forEach((project) => collectOwners(Array.isArray(project.owners) ? project.owners : [project.owner]));
  (nextState.works || []).forEach((work) => {
    collectOwners(Array.isArray(work.owners) ? work.owners : [work.owner]);
    (work.tasks || []).forEach((task) => collectOwners(Array.isArray(task.owners) ? task.owners : [task.owner]));
  });
  (nextState.tasks || []).forEach((task) => collectOwners(Array.isArray(task.owners) ? task.owners : [task.owner]));
  (nextState.schedules || []).forEach((schedule) => collectOwners(schedule.owners || []));
  (nextState.staffEvents || []).forEach((event) => {
    collectOwners(Array.isArray(event.owners) ? event.owners : [event.owner]);
    (event.staffRows || []).forEach((row) => collectOwners([row.owner]));
  });
  (nextState.recurringTrainings || []).forEach((series) => collectOwners(Array.isArray(series.owners) ? series.owners : [series.owner]));

  nextState.owners = [...ownerByName.values()].filter((owner) => owner.name);
  const toOwnerId = (value) => {
    if (!value) return "";
    const raw = String(value);
    if (nextState.owners.some((owner) => owner.id === raw)) return raw;
    const found = nextState.owners.find((owner) => owner.name === raw);
    return found?.id || "";
  };
  const normalizeIds = (values) => uniqueValues(values).map(toOwnerId).filter(Boolean);
  (nextState.projects || []).forEach((project) => {
    project.owners = normalizeIds(Array.isArray(project.owners) ? project.owners : [project.owner]);
    delete project.owner;
  });
  (nextState.works || []).forEach((work) => {
    work.owners = normalizeIds(Array.isArray(work.owners) ? work.owners : [work.owner]);
    delete work.owner;
    (work.tasks || []).forEach((task) => {
      task.owners = normalizeIds(Array.isArray(task.owners) ? task.owners : [task.owner]);
      task.owner = task.owners[0] || "";
    });
  });
  (nextState.tasks || []).forEach((task) => {
    task.owners = normalizeIds(Array.isArray(task.owners) ? task.owners : [task.owner]);
    task.owner = task.owners[0] || "";
  });
  (nextState.schedules || []).forEach((schedule) => {
    schedule.owners = normalizeIds(schedule.owners || []);
  });
  (nextState.staffEvents || []).forEach((event) => {
    event.owners = normalizeIds(Array.isArray(event.owners) ? event.owners : [event.owner]);
    event.owner = event.owners[0] || "";
    (event.staffRows || []).forEach((row) => {
      row.owner = toOwnerId(row.owner);
    });
  });
  (nextState.recurringTrainings || []).forEach((series) => {
    series.owners = normalizeIds(Array.isArray(series.owners) ? series.owners : [series.owner]);
    series.owner = series.owners[0] || "";
  });
  const activeOwnerNames = nextState.owners.filter((owner) => owner.status !== "deleted").map((owner) => owner.name);
  nextState.options.owners = activeOwnerNames;
  nextState.options.workOwners = [...activeOwnerNames];
  nextState.options.studioStaffOwners = [...activeOwnerNames];
  nextState.ownerDefaultsVersion = 2;
  nextState.notifications = Array.isArray(nextState.notifications) ? nextState.notifications : [];
  nextState.users = normalizeUsers(nextState.users);
  const activeUser = nextState.users.find((user) => user.id === nextState.currentUser);
  if (!activeUser || activeUser.status === "inactive" || activeUser.approved === false || activeUser.username === "PD") {
    nextState.currentUser = null;
  }
  return nextState;
}

function ownerSlots() {
  if (!Array.isArray(state.owners)) state.owners = [];
  return state.owners.filter((owner) => owner.status !== "deleted");
}

function ownerById(ownerId) {
  return ownerSlots().find((owner) => owner.id === ownerId) || ownerSlots().find((owner) => owner.name === ownerId) || null;
}

function ownerName(ownerId) {
  const owner = ownerById(ownerId);
  return owner ? owner.name : (ownerId || "");
}

function ownerNames(ownerIds) {
  return (ownerIds || []).map(ownerName).filter(Boolean);
}

function ownerOptionLabel(ownerId) {
  const owner = ownerById(ownerId);
  return owner ? owner.name : (ownerId || "선택");
}

function ownerOptions() {
  return ownerSlots().map((owner) => owner.id);
}

function linkedOwnerIdsForUser(user = currentUser()) {
  if (!user) return [];
  return ownerSlots()
    .filter((owner) => owner.linkedUserId === user.id && owner.status !== "inactive")
    .map((owner) => owner.id);
}

function recordAuthorDisplayName(author) {
  if (!author) return "관리자";
  if (ownerSlots().some((owner) => owner.name === author)) return author;
  const user = state.users.find((item) => item.id === author || item.username === author || item.email === author || item.name === author);
  if (!user) return author;
  const linkedOwnerId = linkedOwnerIdsForUser(user)[0];
  return linkedOwnerId ? ownerName(linkedOwnerId) : (user.name || user.username || author);
}

function currentRecordAuthorName(fallbackOwnerIds = []) {
  const user = currentUser();
  const linkedOwnerId = linkedOwnerIdsForUser(user)[0];
  if (linkedOwnerId) return ownerName(linkedOwnerId);
  return ownerName(fallbackOwnerIds[0]) || user?.name || user?.username || "관리자";
}

function isCurrentUserRecord(record) {
  const user = currentUser();
  if (!user || !record) return false;
  const names = new Set([
    user.id,
    user.username,
    user.email,
    user.name,
    ...ownerNames(linkedOwnerIdsForUser(user))
  ].filter(Boolean));
  return names.has(record.author) || names.has(recordAuthorDisplayName(record.author));
}

function canUserManageOwner(ownerId, user = currentUser()) {
  if (!user) return false;
  if (isAdminUser()) return true;
  return linkedOwnerIdsForUser(user).includes(ownerId);
}

function notifyOwners(ownerIds, message, source = {}) {
  uniqueValues(ownerIds).forEach((ownerId) => {
    const owner = ownerById(ownerId);
    if (!owner?.linkedUserId) return;
    const user = state.users.find((item) => item.id === owner.linkedUserId);
    if (!user || user.status === "inactive" || user.approved === false) return;
    state.notifications.push({
      id: makeId(),
      ownerId,
      userId: user.id,
      message,
      source,
      read: false,
      createdAt: new Date().toISOString()
    });
  });
}

function dateKey(date) {
  const target = date instanceof Date ? date : new Date(`${date}T00:00:00`);
  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(value) {
  if (!value) return "날짜 선택";
  const date = new Date(`${value}T00:00:00`);
  return `${date.getFullYear()}. ${String(date.getMonth() + 1).padStart(2, "0")}. ${String(date.getDate()).padStart(2, "0")}.`;
}

const koreanHolidayFixed = {
  "01-01": "신정",
  "03-01": "삼일절",
  "05-05": "어린이날",
  "06-06": "현충일",
  "08-15": "광복절",
  "10-03": "개천절",
  "10-09": "한글날",
  "12-25": "성탄절"
};

const koreanHolidayMovable = {
  "2026-02-16": "설날 연휴",
  "2026-02-17": "설날",
  "2026-02-18": "설날 연휴",
  "2026-03-02": "대체공휴일",
  "2026-05-24": "부처님오신날",
  "2026-05-25": "대체공휴일",
  "2026-08-17": "대체공휴일",
  "2026-09-24": "추석 연휴",
  "2026-09-25": "추석",
  "2026-09-26": "추석 연휴"
};

function koreanHolidayName(key) {
  const fixedName = koreanHolidayFixed[key.slice(5)];
  return koreanHolidayMovable[key] || fixedName || "";
}

function formatTimeRange(event) {
  if (!event || event.allDay !== false) return "종일";
  const start = event.startTime || "09:00";
  const end = event.endTime || "";
  return end ? `${start}-${end}` : start;
}

function calendarEventClass(event) {
  return `${event.type} ${event.source || ""} ${event.allDay === false ? "is-timed" : "is-all-day"}`;
}

function shiftDate(value, repeat, index) {
  const date = new Date(`${value}T00:00:00`);
  if (repeat === "격주") date.setDate(date.getDate() + index * 14);
  else if (repeat === "매월") date.setMonth(date.getMonth() + index);
  else date.setDate(date.getDate() + index * 7);
  return dateKey(date);
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return normalizeState(structuredClone(sampleData));
  try {
    return normalizeState(JSON.parse(saved));
  } catch {
    return normalizeState(structuredClone(sampleData));
  }
}

function normalizeOptions(source = {}) {
  const normalized = Object.fromEntries(
    Object.entries(defaultOptions).map(([key, fallback]) => {
      const value = source[key];
      return [key, Array.isArray(value) && value.length ? value.filter(Boolean) : [...fallback]];
    })
  );
  const legacyTaskTypes = Array.isArray(source.taskTypes) && source.taskTypes.length ? source.taskTypes.filter(Boolean) : null;
  if (legacyTaskTypes && !Array.isArray(source.projectTaskTypes)) normalized.projectTaskTypes = [...legacyTaskTypes];
  if (legacyTaskTypes && !Array.isArray(source.workTaskTypes)) normalized.workTaskTypes = [...legacyTaskTypes];
  return normalized;
}

function normalizeState(data) {
  const options = normalizeOptions(data.options || {});
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const normalizedProjects = projects.map((project) => {
    const fallbackStart = project.kickoffDate || project.startDate || dateKey(new Date());
    const fallbackFinal = project.finalDate || project.dueDate || fallbackStart;
    return {
      method: options.methods[0] || "단건",
      type: options.types[0] || "홍보영상",
      status: options.statuses[0] || "기획",
      owners: Array.isArray(project.owners) ? project.owners : [project.owner || options.owners[0] || "PD"],
      client: options.clients[0] || "공공기관",
      note: "",
      memo: "",
      ...project,
      kickoffDate: fallbackStart,
      shootDate: project.shootDate || fallbackStart,
      firstEditDate: project.firstEditDate || fallbackFinal,
      finalDate: fallbackFinal,
      calendarFields: { ...defaultCalendarFields, ...(project.calendarFields || {}) },
      records: Array.isArray(project.records) ? project.records : []
    };
  });
  const works = Array.isArray(data.works) ? data.works : [];
  const normalizedWorks = works.map((work) => {
    const fallbackStart = work.kickoffDate || dateKey(new Date());
    const fallbackFinal = work.finalDate || fallbackStart;
    return {
      type: options.workTypes[0] || "일반 업무",
      status: options.workStatuses[0] || "대기",
      owners: Array.isArray(work.owners) ? work.owners : [work.owner || options.workOwners[0] || "PD"],
      client: options.workClients[0] || "내부",
      memo: "",
      ...work,
      noSchedule: Boolean(work.noSchedule),
      kickoffDate: fallbackStart,
      finalDate: fallbackFinal,
      calendarFields: { ...defaultWorkCalendarFields, ...(work.calendarFields || {}) },
      studioReservationEnabled: Boolean(work.studioReservationEnabled),
      studioReservationId: work.studioReservationId || "",
      studioReservation: work.studioReservation || null,
      tasks: Array.isArray(work.tasks)
        ? work.tasks.map((task) => ({
            detail: "",
            type: "",
            owners: Array.isArray(task.owners) ? task.owners : [task.owner].filter(Boolean),
            dueDate: task.noDueDate ? "" : (task.dueDate || dateKey(new Date())),
            noDueDate: Boolean(task.noDueDate || !task.dueDate),
            allDay: task.allDay !== false,
            startTime: task.startTime || "09:00",
            endTime: task.endTime || "10:00",
            createdAt: task.createdAt || new Date().toISOString(),
            calendar: Boolean(task.calendar),
            ...task
          }))
        : [],
      records: Array.isArray(work.records) ? work.records : []
    };
  });
  return {
    options,
    users: normalizeUsers(data.users),
    currentUser: data.currentUser || null,
    projects: normalizedProjects,
    works: normalizedWorks,
    tasks: Array.isArray(data.tasks)
      ? data.tasks.map((task) => ({
          detail: "",
          type: "",
          owners: Array.isArray(task.owners) ? task.owners : [task.owner].filter(Boolean),
          dueDate: task.noDueDate ? "" : (task.dueDate || dateKey(new Date())),
          noDueDate: Boolean(task.noDueDate || !task.dueDate),
          allDay: task.allDay !== false,
          startTime: task.startTime || "09:00",
          endTime: task.endTime || "10:00",
          createdAt: task.createdAt || new Date().toISOString(),
          ...task
        }))
      : [],
    schedules: Array.isArray(data.schedules) ? data.schedules.map((schedule) => ({ allDay: true, startTime: "09:00", endTime: "10:00", ...schedule })) : [],
    staffEvents: Array.isArray(data.staffEvents) ? data.staffEvents.map((event) => {
      const legacyType = event.type === "단발성 교육" ? "비정기교육" : event.type === "스탭 배정" ? "방송실 스탭" : event.type;
      const type = options.staffTypes.includes(legacyType) ? legacyType : (legacyType || options.staffTypes[0] || "");
      const rawOwner = Array.isArray(event.owners) ? event.owners[0] || event.owner : event.owner;
      const owner = rawOwner || "";
      const trainingType = options.trainingTypes.includes(event.trainingType) ? event.trainingType : (event.trainingType || event.title || options.trainingTypes[0] || "");
      return {
        allDay: true,
        startTime: "09:00",
        endTime: "10:00",
        memo: "",
        ...event,
        room: event.room || options.studioRooms[0] || "",
        type,
        owner,
        owners: [owner].filter(Boolean),
        trainingType,
        title: event.title || trainingType
      };
    }) : [],
    recurringTrainings: Array.isArray(data.recurringTrainings) ? data.recurringTrainings.map((series) => {
      const legacyType = series.type === "단발성 교육" ? "비정기교육" : series.type === "스탭 배정" ? "방송실 스탭" : series.type;
      const type = options.staffTypes.includes(legacyType) ? legacyType : (legacyType || "정기교육");
      const rawOwner = Array.isArray(series.owners) ? series.owners[0] || series.owner : series.owner;
      const owner = rawOwner || "";
      const trainingType = options.trainingTypes.includes(series.trainingType) ? series.trainingType : (series.trainingType || series.title || options.trainingTypes[0] || "");
      return {
        allDay: true,
        startTime: "09:00",
        endTime: "10:00",
        ...series,
        room: series.room || options.studioRooms[0] || "",
        type,
        owner,
        owners: [owner].filter(Boolean),
        trainingType,
        title: series.title || trainingType
      };
    }) : [],
    owners: Array.isArray(data.owners) ? data.owners : [],
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
    ownerDefaultsVersion: data.ownerDefaultsVersion || 2
  };
}


function studioRoomOptions() {
  return state.options.studioRooms?.length ? state.options.studioRooms : defaultOptions.studioRooms;
}

function staffTypeOptions() {
  return state.options.staffTypes?.length ? state.options.staffTypes : defaultOptions.staffTypes;
}

function studioStaffOwnerOptions() {
  return ownerOptions();
}

function trainingTypeOptions() {
  return state.options.trainingTypes?.length ? state.options.trainingTypes : defaultOptions.trainingTypes;
}

function staffEventOwnerLabel(event) {
  const owners = ownerNames(event?.owners || [event?.owner].filter(Boolean));
  return owners.length ? owners.join(", ") : "-";
}

function staffEventTitle(event) {
  return event?.trainingType || "선택";
}

function staffReservationTitle(event) {
  return event?.title || event?.trainingType || "방송실 예약";
}

function staffEventTypeColor(type) {
  if (type === "정기교육") return "training";
  if (["비정기교육", "단발성 교육"].includes(type)) return "lesson";
  if (["방송실 스탭", "스탭 배정"].includes(type)) return "staff";
  return "staff";
}

function isUnassignedStudioOwner(owner) {
  return !owner || owner === "미배정";
}

function needsStudioStaffAssignment(event) {
  return (Array.isArray(event?.staffRows) ? event.staffRows : []).some((row) => row.type && isUnassignedStudioOwner(row.owner));
}

function currentUser() {
  if (AUTH_DISABLED) {
    return state.users.find((user) => user.username === "videoadmin") || state.users[0] || { id: "test-admin", username: "videoadmin", role: "admin", approved: true, status: "active" };
  }
  if (SUPABASE_ENABLED && currentProfile) return currentProfile;
  return state.users.find((user) => user.id === state.currentUser) || null;
}

function normalizeUsers(users) {
  const source = Array.isArray(users) && users.length ? users : structuredClone(sampleData.users);
  const normalized = source.map((user, index) => ({
    ...user,
    email: user.email || user.username || "",
    name: user.name || (user.username === "videoadmin" ? "관리자" : user.username || user.email || ""),
    position: user.position || (user.role === "admin" || user.username === "videoadmin" ? "관리자" : "과원"),
    role: user.role || (index === 0 || user.username === "videoadmin" ? "admin" : "user"),
    status: user.status || "active",
    approved: user.approved !== false && user.status !== "pending"
  }));
  if (!normalized.some((user) => user.username === "videoadmin")) {
    normalized.unshift({ id: "user-admin", username: "videoadmin", email: "admin@videowork.io", password: "0314", name: "관리자", position: "관리자", role: "admin", status: "active", approved: true });
  }
  return normalized;
}

function isAdminUser() {
  return currentUser()?.role === "admin";
}

function canEditProject(project) {
  return Boolean(currentUser() && project);
}

function taskOwners(task) {
  if (Array.isArray(task?.owners)) return task.owners.filter(Boolean);
  if (task?.owner) return [task.owner];
  return [];
}

function taskOwnersLabel(task) {
  const owners = ownerNames(taskOwners(task));
  return owners.length ? owners.join(", ") : "-";
}

function formatTaskTime(task) {
  if (!task) return "종일";
  if (task.noDueDate) return "시간 없음";
  if (task.allDay !== false) return "종일";
  const start = task.startTime || "09:00";
  const end = task.endTime || "";
  return end ? `${start}-${end}` : start;
}

function projectTaskTypeOptions() {
  return state.options.projectTaskTypes?.length ? state.options.projectTaskTypes : state.options.taskTypes;
}

function workTaskTypeOptions() {
  return state.options.workTaskTypes?.length ? state.options.workTaskTypes : state.options.taskTypes;
}

function taskTypeOptions() {
  return [...new Set([...projectTaskTypeOptions(), ...workTaskTypeOptions()])];
}

function taskTypeClass(type) {
  const index = Math.max(0, taskTypeOptions().indexOf(type));
  return `type-${index % 5}`;
}

function canManageTask(task) {
  return Boolean(currentUser() && task);
}

function workOwners(work) {
  if (Array.isArray(work.owners)) return work.owners.filter(Boolean);
  if (work.owner) return [work.owner];
  return [];
}

function canEditWork(work) {
  return Boolean(currentUser() && work);
}

function canManageWorkTask(work, task) {
  return Boolean(currentUser() && work && task);
}

function workOwnersLabel(work) {
  const owners = ownerNames(workOwners(work));
  return owners.length ? owners.join(", ") : "-";
}

function workOwnersSummary(work) {
  const owners = ownerNames(workOwners(work));
  if (!owners.length) return "-";
  if (owners.length === 1) return owners[0];
  return `${owners[0]} 외 ${owners.length - 1}명`;
}

function syncOwnerFromUser() {}

function setAuthMessage(message) {
  $("#authMessage").textContent = message;
}

function renderAuth() {
  const user = currentUser();
  const signedIn = AUTH_DISABLED || Boolean(user);
  $("#authOverlay").classList.toggle("hidden", signedIn);
  $("#logoutBtn").classList.toggle("hidden", !signedIn);
  $("#currentUserPanel").classList.toggle("hidden", !signedIn);
  $("#seedBtn").classList.toggle("hidden", !isAdminUser());
  $("#currentUserBadge").textContent = AUTH_DISABLED ? "테스트 모드" : user ? (user.name || user.username || "사용자") : "";
  $("#currentUserMeta").textContent = AUTH_DISABLED ? "개발 확인용" : user ? (user.position || "과원") : "";
}

function showAuthMode(mode) {
  const signupMode = mode === "signup";
  $("#authForm").classList.toggle("signup-mode", signupMode);
  $("#authMessage").textContent = "";
}

async function login(username, password) {
  const cleanId = username.trim();
  if (SUPABASE_ENABLED) {
    const client = getSupabaseClient();
    const { error } = await client.auth.signInWithPassword({ email: cleanId, password });
    if (error) {
      setAuthMessage("이메일 또는 비밀번호가 맞지 않습니다.");
      return;
    }
    const user = await fetchCurrentProfile();
    if (!user?.approved || user.status === "pending") {
      await client.auth.signOut();
      currentProfile = null;
      state.currentUser = null;
      setAuthMessage("관리자 승인 대기 중입니다.");
      renderAll();
      return;
    }
    await loadRemoteDashboardState();
    await refreshSupabaseProfiles();
    saveState();
    renderAll();
    setAuthMessage("");
    return;
  }
  const user = state.users.find((item) => (item.username === cleanId || item.email === cleanId) && item.password === password);
  if (!user) {
    setAuthMessage("이메일 또는 비밀번호가 맞지 않습니다.");
    return;
  }
  if (user.status === "inactive") {
    setAuthMessage("비활성화된 계정입니다. 관리자에게 문의하세요.");
    return;
  }
  if (user.approved === false || user.status === "pending") {
    setAuthMessage("관리자 승인 대기 중입니다.");
    return;
  }
  state.currentUser = user.id;
  saveState();
  renderAll();
  setAuthMessage("");
}

async function signup(email, password, passwordConfirm, name, position) {
  const cleanEmail = email.trim();
  const cleanName = name.trim();
  if (!cleanEmail || !password || !passwordConfirm || !cleanName || !position) {
    setAuthMessage("회원가입 정보를 모두 입력하세요.");
    return;
  }
  if (!cleanEmail.includes("@")) {
    setAuthMessage("아이디는 이메일 형식으로 입력하세요.");
    return;
  }
  if (password !== passwordConfirm) {
    setAuthMessage("비밀번호 확인이 일치하지 않습니다.");
    return;
  }
  if (SUPABASE_ENABLED) {
    const client = getSupabaseClient();
    const { error } = await client.auth.signUp({
      email: cleanEmail,
      password,
      options: { data: { name: cleanName, position } }
    });
    if (error) {
      setAuthMessage(error.message || "회원가입에 실패했습니다.");
      return;
    }
    await client.auth.signOut();
    showAuthMode("login");
    setAuthMessage("회원가입 신청이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.");
    return;
  }
  if (state.users.some((user) => user.username === cleanEmail || user.email === cleanEmail)) {
    setAuthMessage("이미 가입된 이메일입니다.");
    return;
  }
  const user = { id: makeId(), username: cleanEmail, email: cleanEmail, password, name: cleanName, position, role: "user", status: "pending", approved: false };
  state.users.push(user);
  saveState();
  showAuthMode("login");
  setAuthMessage("회원가입 신청이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.");
}

function projectOwners(project) {
  if (Array.isArray(project.owners)) return project.owners.filter(Boolean);
  if (project.owner) return [project.owner];
  return [];
}

function ownersLabel(project) {
  const owners = ownerNames(projectOwners(project));
  return owners.length ? owners.join(", ") : "-";
}

function ownersSummary(project) {
  const owners = ownerNames(projectOwners(project));
  if (!owners.length) return "-";
  if (owners.length === 1) return owners[0];
  return `${owners[0]} 외 ${owners.length - 1}명`;
}

function statusClass(status) {
  const index = state.options.statuses.indexOf(status);
  if (index <= 0) return "stage-0";
  if (index === 1) return "stage-1";
  if (index === 2) return "stage-2";
  if (index === 3) return "stage-3";
  if (index === 4) return "stage-4";
  return "stage-5";
}

function workStatusClass(status) {
  const index = state.options.workStatuses.indexOf(status);
  if (index <= 0) return "stage-0";
  if (index === 1) return "stage-2";
  if (index === 2) return "stage-4";
  return "stage-5";
}

function accountOwners() {
  return state.users.map((user) => user.username).filter(Boolean);
}

function ownerOptions() {
  return ownerSlots().map((owner) => owner.id);
}

function parseMoney(value) {
  return Number(String(value ?? "").replace(/[^\d]/g, "") || 0);
}

function formatMoneyInput(value) {
  return Number(value || 0).toLocaleString("ko-KR");
}

function formatRecordTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}년 ${String(date.getMonth() + 1).padStart(2, "0")}월 ${String(date.getDate()).padStart(2, "0")}일 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  queueRemoteSave();
}

function dateOnly(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function daysUntil(dateString) {
  const today = dateOnly(new Date());
  const target = dateOnly(`${dateString}T00:00:00`);
  return Math.ceil((target - today) / 86400000);
}

function closeDeleteConfirm() {
  pendingDeleteAction = null;
  const modal = $("#deleteConfirmModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function confirmDelete(onConfirm) {
  pendingDeleteAction = typeof onConfirm === "function" ? onConfirm : null;
  const modal = $("#deleteConfirmModal");
  if (!modal) {
    if (pendingDeleteAction) pendingDeleteAction();
    pendingDeleteAction = null;
    return;
  }
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  $("#deleteConfirmCancelBtn")?.focus();
}

function runDeleteConfirm() {
  const action = pendingDeleteAction;
  closeDeleteConfirm();
  if (action) action();
}

function dueBadge(dateString) {
  if (!dateString) return `<span class="badge">마감일 없음</span>`;
  const diff = daysUntil(dateString);
  if (diff < 0) return `<span class="badge danger">지연 ${Math.abs(diff)}일</span>`;
  if (diff <= 3) return `<span class="badge danger">${diff}일 남음</span>`;
  if (diff <= 7) return `<span class="badge warn">${diff}일 남음</span>`;
  return `<span class="badge ok">${diff}일 남음</span>`;
}

function projectName(projectId) {
  return state.projects.find((project) => project.id === projectId)?.title || "미지정";
}

function setView(view) {
  const titles = { overview: "개요", projects: "영상 프로젝트", works: "업무", tasks: "할 일", calendar: "일정 캘린더", studio: "방송실 예약", admin: "관리자 모드" };
  $$(".view").forEach((section) => section.classList.remove("active"));
  const targetView = $(`#${view}View`) ? view : "overview";
  $(`#${targetView}View`).classList.add("active");
  activeView = targetView;
  $(".main")?.classList.toggle("studio-mode", targetView === "studio");
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === targetView));
  $("#viewTitle").textContent = titles[targetView];
  location.hash = targetView;
}

function renderDropdown({ target, value, options, placeholder, onSelect, compact = false, disabled = false, className = "", formatOptionLabel = (option) => option }) {
  target.innerHTML = `
    <button type="button" class="custom-select ${compact ? "compact" : ""} ${className}" ${disabled ? "disabled" : ""}>
      <span>${esc(value ? formatOptionLabel(value) : placeholder)}</span>
      <i>⌄</i>
    </button>
  `;
  if (disabled) return;
  target.querySelector("button").addEventListener("click", (event) => {
    event.stopPropagation();
    openDropdown(event.currentTarget, options, value, onSelect, formatOptionLabel);
  });
}

function renderMultiDropdown({ target, values, options, placeholder, onChange, compact = false, disabled = false, className = "", formatOptionLabel = (option) => option }) {
  const selected = new Set(values || []);
  const label = selected.size ? Array.from(selected).map(formatOptionLabel).join(", ") : placeholder;
  target.innerHTML = `
    <button type="button" class="custom-select multi-select ${compact ? "compact" : ""} ${className}" ${disabled ? "disabled" : ""}>
      <span>${esc(label)}</span>
      <i>⌄</i>
    </button>
  `;
  if (disabled) return;
  target.querySelector("button").addEventListener("click", (event) => {
    event.stopPropagation();
    openMultiDropdown(event.currentTarget, options, selected, onChange, formatOptionLabel);
  });
}

function openDropdown(anchor, options, currentValue, onSelect, formatOptionLabel = (option) => option) {
  closeDatePicker();
  const layer = $("#dropdownLayer");
  const rect = anchor.getBoundingClientRect();
  layer.innerHTML = options
    .map((option) => `
      <button type="button" class="dropdown-option ${option === currentValue ? "selected" : ""}" data-value="${esc(option)}">
        <span>${esc(formatOptionLabel(option))}</span>
        ${option === currentValue ? "<i>✓</i>" : ""}
      </button>
    `)
    .join("");
  const width = Math.min(Math.max(rect.width, 180), Math.max(180, window.innerWidth - 16));
  layer.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  layer.style.top = `${rect.bottom + 8}px`;
  layer.style.minWidth = `${width}px`;
  layer.classList.add("open");
  layer.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(button.dataset.value);
      closeDropdown();
    });
  });
}

function closeDropdown() {
  $("#dropdownLayer").classList.remove("open");
  $("#dropdownLayer").innerHTML = "";
}

function openMultiDropdown(anchor, options, selected, onChange, formatOptionLabel = (option) => option) {
  closeDatePicker();
  const layer = $("#dropdownLayer");
  const rect = anchor.getBoundingClientRect();
  layer.innerHTML = options.length
    ? options
        .map((option) => `
          <button type="button" class="dropdown-option ${selected.has(option) ? "selected" : ""}" data-value="${esc(option)}">
            <span>${esc(formatOptionLabel(option))}</span>
            <i>${selected.has(option) ? "✓" : ""}</i>
          </button>
        `)
        .join("")
    : '<div class="dropdown-empty">관리자 모드에서 담당자를 추가하세요.</div>';
  const width = Math.min(Math.max(rect.width, 220), Math.max(180, window.innerWidth - 16));
  layer.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  layer.style.top = `${rect.bottom + 8}px`;
  layer.style.minWidth = `${width}px`;
  layer.classList.add("open");
  layer.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const value = button.dataset.value;
      if (selected.has(value)) selected.delete(value);
      else selected.add(value);
      button.classList.toggle("selected", selected.has(value));
      button.querySelector("i").textContent = selected.has(value) ? "✓" : "";
      anchor.querySelector("span").textContent = selected.size ? Array.from(selected).map(formatOptionLabel).join(", ") : "담당자 선택";
      onChange(Array.from(selected));
    });
  });
}

function renderDateButton({ target, value, onSelect, compact = false, disabled = false }) {
  target.innerHTML = `
    <button type="button" class="date-button ${compact ? "compact" : ""}" ${disabled ? "disabled" : ""}>
      <span>${formatDate(value)}</span>
      <i>⌄</i>
    </button>
  `;
  if (disabled) return;
  target.querySelector("button").addEventListener("click", (event) => {
    event.stopPropagation();
    openDatePicker(event.currentTarget, value, onSelect);
  });
}

function parseTimeParts(value) {
  const [hourText = "09", minuteText = "00"] = String(value || "09:00").split(":");
  const hour24 = Math.max(0, Math.min(23, Number(hourText) || 0));
  const minute = Math.max(0, Math.min(59, Number(minuteText) || 0));
  return {
    period: hour24 >= 12 ? "PM" : "AM",
    hour: hour24 % 12 || 12,
    minute
  };
}

function timeValueFromParts(period, hour, minute) {
  let hour24 = Number(hour) % 12;
  if (period === "PM") hour24 += 12;
  return `${String(hour24).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;
}

function formatTimeButton(value) {
  const parts = parseTimeParts(value);
  return `${parts.period === "PM" ? "오후" : "오전"} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function minutesFromTime(value) {
  const [hourText = "09", minuteText = "00"] = String(value || "09:00").split(":");
  const hour = Math.max(0, Math.min(23, Number(hourText) || 0));
  const minute = Math.max(0, Math.min(59, Number(minuteText) || 0));
  return hour * 60 + minute;
}

function timeFromMinutes(value) {
  const safeValue = Math.max(0, Math.min(23 * 60 + 59, Number(value) || 0));
  const hour = Math.floor(safeValue / 60);
  const minute = safeValue % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeTaskTimeRange(draft) {
  if (!draft) return;
  const start = minutesFromTime(draft.startTime || "09:00");
  const end = minutesFromTime(draft.endTime || "10:00");
  if (end > start) return;

  const nextEnd = Math.min(23 * 60 + 59, start + 60);
  if (nextEnd > start) {
    draft.endTime = timeFromMinutes(nextEnd);
    return;
  }

  draft.startTime = timeFromMinutes(Math.max(0, end - 60));
  draft.endTime = timeFromMinutes(end);
}

function renderTimeButton({ target, value, onSelect, disabled = false }) {
  target.innerHTML = `
    <input id="${target.id}Value" type="hidden" value="${esc(value || "09:00")}" />
    <button type="button" class="time-button" ${disabled ? "disabled" : ""}>
      <span>${formatTimeButton(value)}</span>
    </button>
  `;
  if (disabled) return;
  target.querySelector("button").addEventListener("click", (event) => {
    event.stopPropagation();
    openTimePicker(event.currentTarget, value, onSelect);
  });
}

function openDatePicker(anchor, currentValue, onSelect) {
  closeDropdown();
  closeTimePicker();
  const layer = $("#datePickerLayer");
  if (layer.classList.contains("open") && activeDateAnchor === anchor) {
    closeDatePicker();
    return;
  }
  activeDateAnchor = anchor;
  let viewDate = currentValue ? new Date(`${currentValue}T00:00:00`) : new Date();

  const draw = () => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const start = new Date(year, month, 1 - firstDay.getDay());
    const selectedKey = currentValue || "";
    const today = dateKey(new Date());

    layer.innerHTML = `
      <div class="date-picker-card">
        <div class="date-picker-top">
          <strong>${year}년 ${month + 1}월</strong>
          <div>
            <button type="button" data-date-prev>‹</button>
            <button type="button" data-date-next>›</button>
          </div>
        </div>
        <div class="date-picker-weekdays">
          <span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span>
        </div>
        <div class="date-picker-days">
          ${Array.from({ length: 42 }, (_, index) => {
            const date = new Date(start);
            date.setDate(start.getDate() + index);
            const key = dateKey(date);
            return `
              <button type="button" class="${date.getMonth() !== month ? "muted" : ""} ${key === selectedKey ? "selected" : ""} ${key === today ? "today" : ""}" data-date-value="${key}">
                ${date.getDate()}
              </button>
            `;
          }).join("")}
        </div>
        <div class="date-picker-bottom">
          <button type="button" data-date-clear>삭제</button>
          <button type="button" data-date-today>오늘</button>
        </div>
      </div>
    `;

    layer.querySelector("[data-date-prev]").addEventListener("click", (event) => {
      event.stopPropagation();
      viewDate = new Date(year, month - 1, 1);
      draw();
    });
    layer.querySelector("[data-date-next]").addEventListener("click", (event) => {
      event.stopPropagation();
      viewDate = new Date(year, month + 1, 1);
      draw();
    });
    layer.querySelector("[data-date-clear]").addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect("");
      closeDatePicker();
    });
    layer.querySelector("[data-date-today]").addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(today);
      closeDatePicker();
    });
    layer.querySelectorAll("[data-date-value]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        onSelect(button.dataset.dateValue);
        closeDatePicker();
      });
    });
  };

  const rect = anchor.getBoundingClientRect();
  layer.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px`;
  layer.style.top = `${rect.bottom + 8}px`;
  layer.classList.add("open");
  draw();
}

function closeDatePicker() {
  activeDateAnchor = null;
  $("#datePickerLayer").classList.remove("open");
  $("#datePickerLayer").innerHTML = "";
}

function openTimePicker(anchor, currentValue, onSelect) {
  closeDropdown();
  closeDatePicker();
  const layer = $("#timePickerLayer");
  if (layer.classList.contains("open") && activeTimeAnchor === anchor) {
    closeTimePicker();
    return;
  }
  activeTimeAnchor = anchor;
  let selected = parseTimeParts(currentValue);
  const draw = () => {
    layer.innerHTML = `
      <div class="time-picker-card">
        <div class="time-picker-column period">
          ${["AM", "PM"].map((period) => `
            <button type="button" class="${selected.period === period ? "selected" : ""}" data-time-period="${period}">
              ${period === "AM" ? "오전" : "오후"}
            </button>
          `).join("")}
        </div>
        <div class="time-picker-column">
          ${Array.from({ length: 12 }, (_, index) => index + 1).map((hour) => `
            <button type="button" class="${selected.hour === hour ? "selected" : ""}" data-time-hour="${hour}">
              ${String(hour).padStart(2, "0")}
            </button>
          `).join("")}
        </div>
        <div class="time-picker-column minute">
          ${Array.from({ length: 60 }, (_, minute) => `
            <button type="button" class="${selected.minute === minute ? "selected" : ""}" data-time-minute="${minute}">
              ${String(minute).padStart(2, "0")}
            </button>
          `).join("")}
        </div>
      </div>
    `;
    layer.querySelectorAll("[data-time-period]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        selected.period = button.dataset.timePeriod;
        onSelect(timeValueFromParts(selected.period, selected.hour, selected.minute));
        draw();
      });
    });
    layer.querySelectorAll("[data-time-hour]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        selected.hour = Number(button.dataset.timeHour);
        onSelect(timeValueFromParts(selected.period, selected.hour, selected.minute));
        draw();
      });
    });
    layer.querySelectorAll("[data-time-minute]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        selected.minute = Number(button.dataset.timeMinute);
        onSelect(timeValueFromParts(selected.period, selected.hour, selected.minute));
        draw();
      });
    });
  };
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 16);
  layer.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  layer.style.top = `${rect.bottom + 8}px`;
  layer.classList.add("open");
  draw();
}

function closeTimePicker() {
  activeTimeAnchor = null;
  $("#timePickerLayer").classList.remove("open");
  $("#timePickerLayer").innerHTML = "";
}

function renderKpis() {
  const active = state.projects.filter((project) => project.status !== "납품 완료").length;
  const weekDue = state.projects.filter((project) => {
    const diff = daysUntil(project.finalDate);
    return diff >= 0 && diff <= 7 && project.status !== "납품 완료";
  }).length;
  const openTasks = state.tasks.filter((task) => !task.done).length;
  const budget = state.projects.reduce((sum, project) => sum + Number(project.budget || 0), 0);
  const spent = state.projects.reduce((sum, project) => sum + Number(project.spent || 0), 0);
  const rate = budget ? Math.round((spent / budget) * 100) : 0;

  $("#activeProjects").textContent = active;
  $("#dueThisWeek").textContent = weekDue;
  $("#openTasks").textContent = openTasks;
  $("#budgetRate").textContent = `${rate}%`;
  $("#budgetText").textContent = `집행 ${won(spent)} / 총 ${won(budget)}`;
}

function summaryItem({ title, meta, date, projectId, badge = "" }) {
  return `
    <article class="compact-item" ${projectId ? `data-open-project="${esc(projectId)}"` : ""}>
      <span class="date-chip">${esc(date ? date.slice(5).replace("-", "/") : "오늘")}</span>
      <div>
        <h3>${esc(title)}</h3>
        <small>${esc(meta)}</small>
      </div>
      ${badge}
    </article>
  `;
}

function renderWorkSummary() {
  const today = dateKey(new Date());
  const todayItems = [
    ...state.tasks
      .filter((task) => !task.done && task.dueDate === today)
      .map((task) => ({
        title: task.text,
        meta: `${projectName(task.projectId)} · 담당 ${task.owner || "-"}`,
        date: task.dueDate,
        projectId: task.projectId,
        badge: '<span class="badge warn">할 일</span>'
      })),
    ...state.schedules
      .filter((schedule) => schedule.date === today)
      .map((schedule) => ({
        title: schedule.title,
        meta: `${projectName(schedule.projectId)} · 일정`,
        date: schedule.date,
        projectId: schedule.projectId,
        badge: '<span class="badge ok">일정</span>'
      }))
  ];

  const weekItems = [
    ...state.projects
      .filter((project) => {
        const diff = daysUntil(project.finalDate);
        return diff >= 0 && diff <= 7 && project.status !== "납품 완료";
      })
      .map((project) => ({
        title: project.title,
        meta: `${project.type} · ${project.status} · 담당 ${ownersLabel(project)}`,
        date: project.finalDate,
        projectId: project.id,
        badge: dueBadge(project.finalDate)
      })),
    ...state.works
      .filter((work) => {
        if (work.noSchedule) return false;
        const diff = daysUntil(work.finalDate);
        return diff >= 0 && diff <= 7 && work.status !== "완료";
      })
      .map((work) => ({
        title: work.title,
        meta: `${work.type} · ${work.status} · 담당 ${workOwnersLabel(work)}`,
        date: work.finalDate,
        badge: dueBadge(work.finalDate)
      }))
  ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);

  $("#todaySummary").innerHTML = todayItems.length
    ? todayItems.slice(0, 5).map(summaryItem).join("")
    : `<div class="empty">오늘 등록된 할 일이나 일정이 없습니다.</div>`;
  $("#weekSummary").innerHTML = weekItems.length
    ? weekItems.map(summaryItem).join("")
    : `<div class="empty">이번 주 마감 항목이 없습니다.</div>`;
}

function renderStatusMix() {
  const total = Math.max(state.projects.length, 1);
  $("#statusMix").innerHTML = state.options.statuses
    .map((status) => {
      const count = state.projects.filter((project) => project.status === status).length;
      const width = Math.round((count / total) * 100);
      return `
        <div class="status-row">
          <strong>${esc(status)}</strong>
          <div class="bar"><span style="width: ${width}%"></span></div>
          <small>${count}건</small>
        </div>
      `;
    })
    .join("");
}

function renderUpcoming() {
  const upcoming = state.projects
    .filter((project) => project.status !== "납품 완료")
    .sort((a, b) => a.finalDate.localeCompare(b.finalDate))
    .slice(0, 5);

  $("#upcomingList").innerHTML = upcoming.length
    ? upcoming
        .map((project) => `
          <article class="compact-item" data-open-project="${project.id}">
            <span class="date-chip">${project.finalDate.slice(5).replace("-", "/")}</span>
            <div>
              <h3>${esc(project.title)}</h3>
              <small>${esc(project.type)} · ${esc(project.status)} · 담당 ${esc(ownersLabel(project))}</small>
            </div>
            ${dueBadge(project.finalDate)}
          </article>
        `)
        .join("")
    : `<div class="empty">예정된 영상 프로젝트 일정이 없습니다.</div>`;
}

function renderProjectList() {
  const query = projectSearchQuery.trim().toLowerCase();
  const filteredProjects = state.projects
    .filter((project) => {
      const matchesQuery = !query || `${project.title} ${ownersLabel(project)} ${project.type} ${project.client} ${project.status}`.toLowerCase().includes(query);
      const matchesType = !projectFilters.type || project.type === projectFilters.type;
      const matchesClient = !projectFilters.client || project.client === projectFilters.client;
      const matchesStatus = !projectFilters.status || project.status === projectFilters.status;
      return matchesQuery && matchesType && matchesClient && matchesStatus;
    })
    .sort((a, b) => {
      const direction = projectSort.direction === "asc" ? 1 : -1;
      const getValue = (project) => {
        if (projectSort.key === "status") return state.options.statuses.indexOf(project.status);
        return String(project[projectSort.key] || "");
      };
      const aValue = getValue(a);
      const bValue = getValue(b);
      if (typeof aValue === "number" && typeof bValue === "number") return (aValue - bValue) * direction;
      return String(aValue).localeCompare(String(bValue), "ko") * direction;
    });

  $("#projectSearchInput").value = projectSearchQuery;
  $("#projectFilterPanel").classList.toggle("open", isProjectFilterOpen);
  $("#projectFilterBtn").setAttribute("aria-expanded", String(isProjectFilterOpen));
  renderDropdown({
    target: $("#projectTypeFilter"),
    value: projectFilters.type || "전체 분류",
    options: ["전체 분류", ...state.options.types],
    placeholder: "전체 분류",
    onSelect: (value) => {
      projectFilters.type = value === "전체 분류" ? "" : value;
      saveViewPrefs({ projectFilters });
      renderProjectList();
    }
  });
  renderDropdown({
    target: $("#projectClientFilter"),
    value: projectFilters.client || "전체 발주부서",
    options: ["전체 발주부서", ...state.options.clients],
    placeholder: "전체 발주부서",
    onSelect: (value) => {
      projectFilters.client = value === "전체 발주부서" ? "" : value;
      saveViewPrefs({ projectFilters });
      renderProjectList();
    }
  });
  renderDropdown({
    target: $("#projectStatusFilter"),
    value: projectFilters.status || "전체 진행상태",
    options: ["전체 진행상태", ...state.options.statuses],
    placeholder: "전체 진행상태",
    onSelect: (value) => {
      projectFilters.status = value === "전체 진행상태" ? "" : value;
      saveViewPrefs({ projectFilters });
      renderProjectList();
    }
  });

  $$("#projectsView [data-project-sort]").forEach((button) => {
    const isActive = projectSort.key === button.dataset.projectSort;
    button.classList.toggle("active", isActive);
    button.dataset.direction = isActive ? projectSort.direction : "";
  });

  $("#projectList").innerHTML = filteredProjects.length
    ? filteredProjects
        .map((project) => `
          <article class="project-row" data-open-project="${project.id}">
            <strong class="project-title-cell">${esc(project.title)}</strong>
            <div data-project-control data-project-owner-cell="${esc(project.id)}"></div>
            <div data-project-type-cell="${esc(project.id)}"></div>
            <div data-project-client-cell="${esc(project.id)}"></div>
            <div class="project-status-cell" data-project-status-cell="${esc(project.id)}"></div>
            <div class="project-date-cell" data-project-first-date-cell="${esc(project.id)}"></div>
            <div class="project-date-cell" data-project-date-cell="${esc(project.id)}"></div>
          </article>
        `)
        .join("")
    : `<div class="empty">조건에 맞는 영상 프로젝트가 없습니다.</div>`;

  document.querySelectorAll("[data-project-owner-cell]").forEach((target) => {
    const project = state.projects.find((item) => item.id === target.dataset.projectOwnerCell);
    if (!project) return;
    renderMultiDropdown({
      target,
      values: projectOwners(project),
      options: ownerOptions(),
      placeholder: "선택",
      formatOptionLabel: ownerOptionLabel,
      compact: true,
      className: "outline-cell",
      disabled: !canEditProject(project),
      onChange: (owners) => {
        project.owners = owners;
        saveState();
        renderAll();
      }
    });
  });
  document.querySelectorAll("[data-project-type-cell]").forEach((target) => {
    const project = state.projects.find((item) => item.id === target.dataset.projectTypeCell);
    if (!project) return;
    renderDropdown({
      target,
      value: project.type,
      options: state.options.types,
      placeholder: "선택",
      compact: true,
      className: "outline-cell",
      disabled: !canEditProject(project),
      onSelect: (value) => {
        project.type = value;
        saveState();
        renderAll();
      }
    });
  });
  document.querySelectorAll("[data-project-client-cell]").forEach((target) => {
    const project = state.projects.find((item) => item.id === target.dataset.projectClientCell);
    if (!project) return;
    renderDropdown({
      target,
      value: project.client,
      options: state.options.clients,
      placeholder: "선택",
      compact: true,
      className: "outline-cell",
      disabled: !canEditProject(project),
      onSelect: (value) => {
        project.client = value;
        saveState();
        renderAll();
      }
    });
  });
  document.querySelectorAll("[data-project-status-cell]").forEach((target) => {
    const project = state.projects.find((item) => item.id === target.dataset.projectStatusCell);
    if (!project) return;
    renderDropdown({
      target,
      value: project.status,
      options: state.options.statuses,
      placeholder: "선택",
      compact: true,
      className: project.status ? statusClass(project.status) : "outline-cell",
      disabled: !canEditProject(project),
      onSelect: (value) => {
        project.status = value;
        if (value === "납품 완료") project.progress = 100;
        saveState();
        renderAll();
      }
    });
  });
  document.querySelectorAll("[data-project-first-date-cell]").forEach((target) => {
    const project = state.projects.find((item) => item.id === target.dataset.projectFirstDateCell);
    if (!project) return;
    renderDateButton({
      target,
      value: project.firstEditDate,
      compact: true,
      disabled: !canEditProject(project),
      onSelect: (date) => {
        project.firstEditDate = date || project.firstEditDate;
        saveState();
        renderAll();
      }
    });
  });
  document.querySelectorAll("[data-project-date-cell]").forEach((target) => {
    const project = state.projects.find((item) => item.id === target.dataset.projectDateCell);
    if (!project) return;
    renderDateButton({
      target,
      value: project.finalDate,
      compact: true,
      disabled: !canEditProject(project),
      onSelect: (date) => {
        project.finalDate = date || project.finalDate;
        saveState();
        renderAll();
      }
    });
  });
}

function renderWorkList() {
  const query = workSearchQuery.trim().toLowerCase();
  const works = [...state.works]
    .filter((work) => !query || `${work.title} ${workOwnersLabel(work)} ${work.type} ${work.client} ${work.status}`.toLowerCase().includes(query))
    .sort((a, b) => {
      const direction = workSort.direction === "asc" ? 1 : -1;
      const getValue = (work) => {
        if (workSort.key === "status") return state.options.workStatuses.indexOf(work.status);
        if (work.noSchedule && ["kickoffDate", "finalDate"].includes(workSort.key)) return "9999-12-31";
        return String(work[workSort.key] || "");
      };
      const aValue = getValue(a);
      const bValue = getValue(b);
      if (typeof aValue === "number" && typeof bValue === "number") return (aValue - bValue) * direction;
      return String(aValue).localeCompare(String(bValue), "ko") * direction;
    });

  $("#workSearchInput").value = workSearchQuery;
  $$("#worksView [data-work-sort]").forEach((button) => {
    const isActive = workSort.key === button.dataset.workSort;
    button.classList.toggle("active", isActive);
    button.dataset.direction = isActive ? workSort.direction : "";
  });
  $("#workList").innerHTML = works.length
    ? works
        .map((work) => `
          <article class="project-row work-row" data-work-id="${esc(work.id)}" data-open-work="${esc(work.id)}">
            <strong class="project-title-cell">${esc(work.title)}</strong>
            <div data-work-control data-work-owner-cell="${esc(work.id)}"></div>
            <div data-work-control data-work-type-cell="${esc(work.id)}"></div>
            <div data-work-control data-work-client-cell="${esc(work.id)}"></div>
            <div data-work-control data-work-status-cell="${esc(work.id)}"></div>
            <label class="mini-toggle" data-work-control>
              <input type="checkbox" data-work-noschedule="${esc(work.id)}" ${work.noSchedule ? "checked" : ""} ${canEditWork(work) ? "" : "disabled"} />
              없음
            </label>
            <div class="project-date-cell" data-work-control data-work-kickoff-cell="${esc(work.id)}"></div>
            <div class="project-date-cell" data-work-control data-work-final-cell="${esc(work.id)}"></div>
          </article>
        `)
        .join("")
    : `<div class="empty">등록된 업무가 없습니다.</div>`;

  document.querySelectorAll("[data-work-owner-cell]").forEach((target) => {
    const work = state.works.find((item) => item.id === target.dataset.workOwnerCell);
    if (!work) return;
    renderMultiDropdown({
      target,
      values: workOwners(work),
      options: ownerOptions(),
      placeholder: "선택",
      formatOptionLabel: ownerOptionLabel,
      compact: true,
      className: "outline-cell",
      disabled: !canEditWork(work),
      onChange: (owners) => {
        work.owners = owners;
        saveState();
        renderWorkList();
      }
    });
  });
  [
    ["type", "workTypes", "선택"],
    ["client", "workClients", "선택"],
    ["status", "workStatuses", "선택"]
  ].forEach(([field, optionKey, placeholder]) => {
    document.querySelectorAll(`[data-work-${field}-cell]`).forEach((target) => {
      const work = state.works.find((item) => item.id === target.dataset[`work${field[0].toUpperCase()}${field.slice(1)}Cell`]);
      if (!work) return;
      renderDropdown({
        target,
        value: work[field],
        options: state.options[optionKey],
        placeholder,
        compact: true,
        className: field === "status" && work.status ? workStatusClass(work.status) : "outline-cell",
        disabled: !canEditWork(work),
        onSelect: (value) => {
          work[field] = value;
          saveState();
          renderAll();
        }
      });
    });
  });
  [
    ["kickoffDate", "workKickoffCell"],
    ["finalDate", "workFinalCell"]
  ].forEach(([field, dataKey]) => {
    document.querySelectorAll(`[data-${dataKey.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}]`).forEach((target) => {
      const work = state.works.find((item) => item.id === target.dataset[dataKey]);
      if (!work) return;
      renderDateButton({
        target,
        value: work[field],
        compact: true,
        disabled: work.noSchedule || !canEditWork(work),
        onSelect: (date) => {
          work[field] = date || work[field];
          saveState();
          renderAll();
        }
      });
    });
  });
}

function addWork() {
  const today = dateKey(new Date());
  const work = {
    id: makeId(),
    title: "새 업무",
    type: "",
    owners: [],
    client: "",
    status: "",
    noSchedule: false,
    kickoffDate: today,
    finalDate: today,
    calendarFields: { ...defaultWorkCalendarFields },
    studioReservationEnabled: false,
    studioReservationId: "",
    studioReservation: null,
    memo: "",
    tasks: [],
    records: []
  };
  state.works.unshift(work);
  saveState();
  renderAll();
  openWorkDetail(work.id);
}

function workDateFieldControl(field) {
  return `
    <div class="date-field-control">
      <div id="work-detail-${field}"></div>
      <label class="calendar-toggle">
        <input type="checkbox" data-work-calendar-field="${field}" />
        <span>캘린더 등록</span>
      </label>
    </div>
  `;
}

function renderWorkDetail() {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work) return;
  const editable = canEditWork(work);

  $("#workDetail .detail-page").classList.toggle("readonly", !editable);
  $("#deleteWorkDetailBtn").disabled = !editable;
  $("#deleteWorkDetailBtn").title = editable ? "" : "담당자 또는 관리자만 삭제할 수 있습니다.";
  $("#workDetailTitle").value = work.title;
  $("#workDetailTitle").disabled = !editable;
  $("#workDetailProperties").innerHTML = `
    ${!editable ? '<div class="readonly-notice">이 업무의 담당자 또는 관리자만 수정할 수 있습니다.</div>' : ""}
    ${propertyRow("☷", "업무분류", '<div id="workDetailType"></div>')}
    ${propertyRow("▾", "담당자", '<div id="workDetailOwners"></div>')}
    ${propertyRow("▾", "발주 부서", '<div id="workDetailClient"></div>')}
    ${propertyRow("▾", "진행", '<div id="workDetailStatus"></div>')}
    ${propertyRow("-", "일정 없음", '<label class="calendar-toggle"><input id="workDetailNoSchedule" type="checkbox" /><span>일정 없이 관리</span></label>')}
    <div class="property-break"></div>
    ${propertyRow("↦", "시작일", workDateFieldControl("kickoffDate"))}
    ${propertyRow("✓", "완료일", workDateFieldControl("finalDate"))}
  `;
  setRichMemoContent("workDetailMemo", work.memo || "", editable);

  [
    ["#workDetailType", "type", "workTypes"],
    ["#workDetailClient", "client", "workClients"],
    ["#workDetailStatus", "status", "workStatuses"]
  ].forEach(([target, field, optionKey]) => {
    renderDropdown({
      target: $(target),
      value: work[field],
      options: state.options[optionKey],
      placeholder: "선택",
      compact: true,
      className: field === "status" && work.status ? workStatusClass(work.status) : "outline-cell",
      disabled: !editable,
      onSelect: (value) => updateActiveWork(field, value)
    });
  });

  renderMultiDropdown({
    target: $("#workDetailOwners"),
    values: workOwners(work),
    options: ownerOptions(),
    placeholder: "선택",
    formatOptionLabel: ownerOptionLabel,
    compact: true,
    disabled: !editable,
    onChange: (owners) => updateActiveWork("owners", owners)
  });

  $("#workDetailNoSchedule").checked = Boolean(work.noSchedule);
  $("#workDetailNoSchedule").disabled = !editable;
  $("#workDetailNoSchedule").addEventListener("change", (event) => updateActiveWork("noSchedule", event.target.checked));

  [
    ["#work-detail-kickoffDate", "kickoffDate"],
    ["#work-detail-finalDate", "finalDate"]
  ].forEach(([target, field]) => {
    renderDateButton({
      target: $(target),
      value: work[field],
      compact: true,
      disabled: work.noSchedule || !editable,
      onSelect: (date) => updateActiveWork(field, date || work[field])
    });
  });

  $("#workDetailProperties").querySelectorAll("[data-work-calendar-field]").forEach((checkbox) => {
    const field = checkbox.dataset.workCalendarField;
    work.calendarFields = { ...defaultWorkCalendarFields, ...(work.calendarFields || {}) };
    checkbox.checked = Boolean(work.calendarFields[field]);
    checkbox.disabled = work.noSchedule || work.studioReservationEnabled || !editable;
    checkbox.addEventListener("change", () => {
      work.calendarFields[field] = checkbox.checked;
      saveState();
      renderCalendar();
    });
  });

  renderWorkTasks(work);
  renderWorkManagementRecords(work);
  renderWorkStudioReservation(work);
  renderWorkDetailTabs();
}

function renderWorkDetailTabs() {
  $$("#workDetail [data-work-detail-tab]").forEach((button) => button.classList.toggle("active", button.dataset.workDetailTab === activeWorkDetailTab));
  $("#workDetailBasicTab").classList.toggle("active", activeWorkDetailTab === "basic");
  $("#workDetailTasksTab").classList.toggle("active", activeWorkDetailTab === "tasks");
  $("#workDetailRecordsTab").classList.toggle("active", activeWorkDetailTab === "records");
  $("#workDetailStudioTab").classList.toggle("active", activeWorkDetailTab === "studio");
}


function defaultWorkStudioReservation(work) {
  return {
    title: work?.title || "",
    room: "",
    trainingType: "",
    date: work?.kickoffDate || dateKey(new Date()),
    allDay: false,
    startTime: "09:00",
    endTime: "10:00",
    memo: "",
    staffRows: [makeDefaultStaffRow(0)]
  };
}

function ensureWorkStudioReservation(work) {
  if (!work.studioReservation) work.studioReservation = defaultWorkStudioReservation(work);
  const reservation = work.studioReservation;
  reservation.title = reservation.title || work.title || "";
  reservation.room = reservation.room || "";
  reservation.trainingType = reservation.trainingType || "";
  reservation.date = reservation.date || work.kickoffDate || dateKey(new Date());
  reservation.allDay = reservation.allDay === true;
  reservation.startTime = reservation.startTime || "09:00";
  reservation.endTime = reservation.endTime || "10:00";
  reservation.memo = reservation.memo || "";
  reservation.staffRows = Array.isArray(reservation.staffRows) && reservation.staffRows.length ? reservation.staffRows.slice(0, 6).map((row) => ({
    id: row.id || makeId(),
    type: row.type || "",
    owner: row.owner || "",
    memo: row.memo || ""
  })) : [makeDefaultStaffRow(0)];
  return reservation;
}

function removeWorkStudioReservation(work) {
  if (work.studioReservationId) {
    state.staffEvents = state.staffEvents.filter((event) => event.id !== work.studioReservationId);
  }
  work.studioReservationEnabled = false;
  work.studioReservationId = "";
  saveState();
  renderAll();
  renderWorkDetail();
}

function syncWorkStudioReservation(work) {
  const reservation = ensureWorkStudioReservation(work);
  const staffRows = reservation.staffRows.map((row) => ({
    type: row.type || "",
    owner: row.owner || "",
    memo: row.memo || ""
  }));
  const owners = [...new Set(staffRows.map((row) => row.owner).filter((owner) => !isUnassignedStudioOwner(owner)))];
  const eventData = {
    title: reservation.title || work.title || "방송실 예약",
    source: "work",
    workId: work.id,
    room: reservation.room || "",
    type: staffRows[0]?.type || "",
    owner: owners[0] || "",
    owners,
    staffRows,
    trainingType: reservation.trainingType || "",
    date: reservation.date || work.kickoffDate || dateKey(new Date()),
    allDay: reservation.allDay === true,
    startTime: reservation.startTime || "09:00",
    endTime: reservation.endTime || "10:00",
    memo: reservation.memo || ""
  };
  const event = state.staffEvents.find((item) => item.id === work.studioReservationId);
  if (event) {
    Object.assign(event, eventData);
  } else {
    const id = makeId();
    work.studioReservationId = id;
    state.staffEvents.push({ id, ...eventData });
  }
  saveState();
  renderAll();
  renderWorkDetail();
  showToast("방송실 예약이 저장되었습니다.");
}

function renderWorkStudioRows(work) {
  const reservation = ensureWorkStudioReservation(work);
  const editable = canEditWork(work);
  const target = $("#workStudioRows");
  if (!target) return;
  target.innerHTML = reservation.staffRows.map((row, index) => `
    <div class="studio-staff-row" data-work-studio-row="${esc(row.id)}">
      <span class="studio-row-drag" aria-hidden="true">⋮⋮</span>
      <span class="studio-row-number">${index + 1}</span>
      <div id="workStudioRowType${index}"></div>
      <div id="workStudioRowOwner${index}"></div>
      <input data-work-studio-row-memo="${esc(row.id)}" value="${esc(row.memo || "")}" placeholder="역할 또는 메모" ${editable ? "" : "disabled"} />
      <button class="studio-row-delete" data-delete-work-studio-row="${esc(row.id)}" type="button" ${editable && reservation.staffRows.length > 1 ? "" : "disabled"}>⌫</button>
    </div>
  `).join("");
  reservation.staffRows.forEach((row, index) => {
    renderDropdown({
      target: $(`#workStudioRowType${index}`),
      value: row.type,
      options: staffTypeOptions(),
      placeholder: "스탭 종류",
      disabled: !editable,
      onSelect: (type) => {
        row.type = type;
        renderWorkStudioReservation(work);
      }
    });
    renderDropdown({
      target: $(`#workStudioRowOwner${index}`),
      value: row.owner,
      options: ownerOptions(),
      placeholder: "담당자",
      formatOptionLabel: ownerOptionLabel,
      disabled: !editable,
      onSelect: (owner) => {
        row.owner = owner;
        renderWorkStudioReservation(work);
      }
    });
  });
}

function renderWorkStudioControls(work) {
  const reservation = ensureWorkStudioReservation(work);
  const editable = canEditWork(work);
  const title = $("#workStudioTitle");
  const memo = $("#workStudioMemo");
  if (title) {
    title.value = reservation.title || "";
    title.disabled = !editable;
  }
  if (memo) {
    memo.value = reservation.memo || "";
    memo.disabled = !editable;
  }
  renderDropdown({
    target: $("#workStudioRoomDropdown"),
    value: reservation.room,
    options: studioRoomOptions(),
    placeholder: "장소 선택",
    disabled: !editable,
    onSelect: (room) => {
      reservation.room = room;
      renderWorkStudioReservation(work);
    }
  });
  renderDropdown({
    target: $("#workStudioTrainingTypeDropdown"),
    value: reservation.trainingType,
    options: trainingTypeOptions(),
    placeholder: "교육 유형 선택",
    disabled: !editable,
    onSelect: (trainingType) => {
      reservation.trainingType = trainingType;
      renderWorkStudioReservation(work);
    }
  });
  renderDateButton({
    target: $("#workStudioDatePicker"),
    value: reservation.date,
    compact: true,
    disabled: !editable,
    onSelect: (date) => {
      reservation.date = date || dateKey(new Date());
      renderWorkStudioReservation(work);
    }
  });
  syncTimeControls("workStudio", reservation);
  renderWorkStudioRows(work);
}

function renderWorkStudioReservation(work) {
  const target = $("#workStudioReservationPanel");
  if (!target) return;
  const editable = canEditWork(work);
  target.innerHTML = `
    <div class="work-studio-panel">
      <label class="studio-repeat-toggle work-studio-toggle">
        <span>방송실 예약</span>
        <input id="workStudioEnabled" type="checkbox" ${work.studioReservationEnabled ? "checked" : ""} ${editable ? "" : "disabled"} />
        <b>${work.studioReservationEnabled ? "사용" : "사용 안함"}</b>
      </label>
      ${work.studioReservationEnabled ? `
        <div class="work-studio-form studio-schedule-section">
          <label>일정 제목<input id="workStudioTitle" type="text" placeholder="일정 제목을 입력하세요" /></label>
          <div class="studio-field-grid two">
            <label>장소<div id="workStudioRoomDropdown"></div></label>
            <label>교육 유형<div id="workStudioTrainingTypeDropdown"></div></label>
          </div>
          <div class="studio-date-line">
            <label>일시<div id="workStudioDatePicker"></div></label>
            <label class="studio-checkbox-line"><input id="workStudioAllDay" type="checkbox" /> 종일 일정</label>
          </div>
          <div class="studio-field-grid time">
            <label>시작 시간<div id="workStudioStartTimePicker"></div></label>
            <span>~</span>
            <label>종료 시간<div id="workStudioEndTimePicker"></div></label>
          </div>
          <label>메모 (선택)<textarea id="workStudioMemo" rows="4" maxlength="200" placeholder="스탭 배정 내용, 준비물, 교육 메모를 입력하세요."></textarea></label>
          <div class="studio-staff-head">
            <h3><span class="studio-section-icon staff-icon">☷</span> 스탭 목록</h3>
            <button id="workStudioAddStaffBtn" class="pill primary small" type="button" ${editable ? "" : "disabled"}>+ 스탭 추가</button>
          </div>
          <div class="studio-staff-table">
            <div class="studio-staff-table-head">
              <span></span><span></span><span>스탭 종류</span><span>담당자</span><span>역할/메모</span><span>관리</span>
            </div>
            <div id="workStudioRows" class="studio-staff-rows"></div>
          </div>
          <div class="work-studio-actions">
            <button id="workStudioSaveBtn" class="pill primary" type="button" ${editable ? "" : "disabled"}>예약 저장</button>
          </div>
        </div>
      ` : `<div class="empty">방송실 예약을 켜면 이 업무에서 바로 방송실을 예약할 수 있습니다.</div>`}
    </div>
  `;
  if (work.studioReservationEnabled) renderWorkStudioControls(work);
}

function syncWorkTaskDraftInputs() {
  const titleInput = $("#workTaskTitle");
  const detailInput = $("#workTaskDetail");
  const typeInput = $("#workTaskTypeValue");
  const noDueDateInput = $("#workTaskNoDueDate");
  const allDayInput = $("#workTaskAllDay");
  const startInput = $("#workTaskStartTimeValue");
  const endInput = $("#workTaskEndTimeValue");
  const calendarInput = $("#workTaskCalendar");
  if (titleInput) workTaskDraft.title = titleInput.value;
  if (detailInput) workTaskDraft.detail = detailInput.value;
  if (typeInput) workTaskDraft.type = typeInput.value;
  if (noDueDateInput) workTaskDraft.noDueDate = noDueDateInput.checked;
  if (allDayInput) workTaskDraft.allDay = allDayInput.checked;
  if (startInput) workTaskDraft.startTime = startInput.value || "09:00";
  if (endInput) workTaskDraft.endTime = endInput.value || "10:00";
  if (calendarInput) workTaskDraft.calendar = calendarInput.checked;
}

function resetWorkTaskDraft(work) {
  workTaskDraft = {
    title: "",
    detail: "",
    type: "",
    owners: [],
    dueDate: dateKey(new Date()),
    noDueDate: false,
    allDay: true,
    startTime: "09:00",
    endTime: "10:00",
    calendar: false,
    editingTaskId: null
  };
}

function renderWorkTasks(work) {
  const editable = canEditWork(work);
  if (!Array.isArray(workTaskDraft.owners)) workTaskDraft.owners = [workTaskDraft.owner].filter(Boolean);
  if (!workTaskDraft.noDueDate && !workTaskDraft.dueDate) workTaskDraft.dueDate = dateKey(new Date());
  if (!workTaskDraft.startTime) workTaskDraft.startTime = "09:00";
  if (!workTaskDraft.endTime) workTaskDraft.endTime = "10:00";
  work.tasks = Array.isArray(work.tasks) ? work.tasks : [];
  const tasks = [...work.tasks].sort((a, b) => {
    if (workTaskSort === "due") return String(a.dueDate || "").localeCompare(String(b.dueDate || ""));
    return String(a.createdAt || a.id || "").localeCompare(String(b.createdAt || b.id || ""));
  });
  const editing = work.tasks.find((task) => task.id === workTaskDraft.editingTaskId);
  const composerOpen = workTaskComposerOpen || Boolean(editing);

  $("#workTaskPanel").innerHTML = `
    <div class="record-composer task-add-card ${composerOpen ? "is-expanded" : "is-collapsed"}">
      <div class="task-add-head" data-work-task-composer-toggle>
        <div class="task-add-title">
          <span class="task-add-icon">✚</span>
          <div>
            <h3>할 일 추가</h3>
            <small>새로운 할 일을 등록하세요.</small>
          </div>
        </div>
        ${composerOpen ? '<button id="resetWorkTaskFormBtn" class="record-control" type="button">↻ 초기화</button>' : ""}
      </div>
      <div class="project-task-composer task-composer-expanded">
        <label class="task-field task-title-field">
          <span>할 일 제목 <b>*</b></span>
          <input id="workTaskTitle" class="task-title-input" value="${esc(workTaskDraft.title || "")}" placeholder="할 일 제목을 입력하세요" ${editable ? "" : "disabled"} />
        </label>
        <div class="task-form-grid">
          <div class="task-form-column">
            <label class="task-field">
              <span>담당자 <b>*</b></span>
              <div id="workTaskOwnerDropdown"></div>
            </label>
            <label class="task-field">
              <span>날짜 <b>*</b></span>
              <div id="workTaskDueDatePicker"></div>
            </label>
          </div>
          <div class="task-form-column">
            <label class="task-field task-type-field">
              <span>업무 분류 <b>*</b></span>
              <input id="workTaskTypeValue" type="hidden" value="${esc(workTaskDraft.type || "")}" />
              <div class="task-type-chip-row">
                ${workTaskTypeOptions().map((type) => `<button class="task-type-chip ${workTaskDraft.type === type ? "active" : ""} ${taskTypeClass(type)}" data-work-task-type-chip="${esc(type)}" type="button">${esc(type)}</button>`).join("")}
              </div>
            </label>
            <div class="task-field">
              <span>시간</span>
              <div class="task-time-range">
                <div id="workTaskStartTime"></div>
                <span>~</span>
                <div id="workTaskEndTime"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="task-option-row">
          <label class="calendar-toggle task-all-day">
            <input id="workTaskAllDay" type="checkbox" ${workTaskDraft.allDay !== false ? "checked" : ""} ${editable ? "" : "disabled"} />
            <span>종일</span>
          </label>
          <label class="calendar-toggle task-no-due">
            <input id="workTaskNoDueDate" type="checkbox" ${workTaskDraft.noDueDate ? "checked" : ""} ${editable ? "" : "disabled"} />
            <span>마감일 없음</span>
          </label>
          <label class="calendar-toggle task-calendar-toggle">
            <input id="workTaskCalendar" type="checkbox" ${workTaskDraft.calendar ? "checked" : ""} ${editable ? "" : "disabled"} />
            <span>캘린더 등록</span>
          </label>
        </div>
        <label class="task-field task-detail-field">
          <span>세부내용 (선택)</span>
          <textarea id="workTaskDetail" placeholder="세부내용을 입력하세요" ${editable ? "" : "disabled"}>${esc(workTaskDraft.detail || "")}</textarea>
        </label>
        <div class="task-form-footer">
          <button id="addWorkTaskBtn" class="pill primary" type="button" ${editable ? "" : "disabled"}>${editing ? "수정 저장" : "+ 할 일 등록"}</button>
        </div>
      </div>
    </div>
    <div class="record-tools task-sort-tools">
      <span>정렬</span>
      <button class="record-control ${workTaskSort === "created" ? "active" : ""}" data-work-task-sort="created" type="button">등록순</button>
      <button class="record-control ${workTaskSort === "due" ? "active" : ""}" data-work-task-sort="due" type="button">완료일 순</button>
    </div>
    <div class="task-list">
      ${
        tasks.length
          ? tasks
              .map((task) => `
                <article class="task-row ${highlightedWorkTaskId === task.id ? "is-highlighted" : ""}">
                  <label class="task-main">
                    <input type="checkbox" data-work-task-check="${esc(task.id)}" ${task.done ? "checked" : ""} ${canManageWorkTask(work, task) ? "" : "disabled"} />
                    <span>
                      <h3>${task.type ? `<span class="task-type-badge ${taskTypeClass(task.type)}">${esc(task.type)}</span>` : ""}${esc(task.text)}</h3>
                      ${task.detail ? `<p class="task-detail-text">${esc(task.detail)}</p>` : ""}
                      <small>담당 ${esc(taskOwnersLabel(task))} · 완료일 ${esc(task.noDueDate || !task.dueDate ? "없음" : task.dueDate)} · ${esc(formatTaskTime(task))}</small>
                    </span>
                  </label>
                  <div class="task-row-actions">
                    ${task.done ? '<span class="badge ok">완료</span>' : dueBadge(task.dueDate)}
                    <button class="record-control" data-edit-work-task="${esc(task.id)}" ${canManageWorkTask(work, task) ? "" : "disabled"} type="button">수정</button>
                    <button class="delete-btn" data-delete-work-task="${esc(task.id)}" ${canManageWorkTask(work, task) ? "" : "disabled"} aria-label="삭제">×</button>
                  </div>
                </article>
              `)
              .join("")
          : '<div class="empty">이 업무에 등록된 할 일이 없습니다.</div>'
      }
    </div>
  `;

  renderMultiDropdown({
    target: $("#workTaskOwnerDropdown"),
    values: workTaskDraft.owners,
    options: ownerOptions(),
    placeholder: "담당자 선택",
    formatOptionLabel: ownerOptionLabel,
    disabled: !editable,
    onChange: (owners) => {
      syncWorkTaskDraftInputs();
      workTaskDraft.owners = owners;
      renderWorkTasks(work);
    }
  });
  renderDateButton({
    target: $("#workTaskDueDatePicker"),
    value: workTaskDraft.dueDate,
    disabled: workTaskDraft.noDueDate || !editable,
    onSelect: (date) => {
      syncWorkTaskDraftInputs();
      workTaskDraft.dueDate = date || dateKey(new Date());
      renderWorkTasks(work);
    }
  });
  renderTimeButton({
    target: $("#workTaskStartTime"),
    value: workTaskDraft.startTime,
    disabled: workTaskDraft.noDueDate || workTaskDraft.allDay !== false || !editable,
    onSelect: (time) => {
      syncWorkTaskDraftInputs();
      workTaskDraft.startTime = time;
      normalizeTaskTimeRange(workTaskDraft);
      renderWorkTasks(work);
    }
  });
  renderTimeButton({
    target: $("#workTaskEndTime"),
    value: workTaskDraft.endTime,
    disabled: workTaskDraft.noDueDate || workTaskDraft.allDay !== false || !editable,
    onSelect: (time) => {
      syncWorkTaskDraftInputs();
      workTaskDraft.endTime = time;
      normalizeTaskTimeRange(workTaskDraft);
      renderWorkTasks(work);
    }
  });

  $("#workTaskNoDueDate")?.addEventListener("change", () => {
    syncWorkTaskDraftInputs();
    renderWorkTasks(work);
  });
  $("#workTaskAllDay")?.addEventListener("change", () => {
    syncWorkTaskDraftInputs();
    renderWorkTasks(work);
  });
}

function renderWorkManagementRecords(work) {
  const editable = canEditWork(work);
  const query = workRecordSearchQuery.trim().toLowerCase();
  work.records = Array.isArray(work.records) ? work.records : [];
  const records = [...work.records]
    .filter((record) => {
      const author = recordAuthorDisplayName(record.author);
      if (workRecordFilterMode === "mine" && !isCurrentUserRecord(record)) return false;
      if (!query) return true;
      return `${author || ""} ${record.author || ""} ${record.body || ""}`.toLowerCase().includes(query);
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const editingRecord = work.records.find((record) => record.id === editingWorkRecordId);
  $("#workManagementRecords").innerHTML = `
    <div class="record-composer">
      <textarea id="workRecordBody" class="record-input" placeholder="새로운 관리 기록을 입력하세요&#10;Enter로 줄바꿈, 버튼으로 등록" ${editable ? "" : "disabled"}>${esc(editingRecord?.body || "")}</textarea>
      <div class="record-actions">
        <span>${editable ? (editingRecord ? "기록 수정 중" : "업무별 관리 메모") : "담당자 또는 관리자만 기록을 추가할 수 있습니다."}</span>
        <div>
          ${editingRecord ? '<button id="cancelWorkRecordEditBtn" class="pill ghost" type="button">취소</button>' : ""}
          <button id="addWorkRecordBtn" class="pill primary" type="button" ${editable ? "" : "disabled"}>${editingRecord ? "수정 저장" : "+ 등록"}</button>
        </div>
      </div>
    </div>
    <div class="record-tools">
      <input id="workRecordSearchInput" class="record-search" value="${esc(workRecordSearchQuery)}" placeholder="관리기록 검색" />
      <button class="record-control ${workRecordFilterMode === "all" ? "active" : ""}" data-work-record-filter="all" type="button">전체</button>
      <button class="record-control ${workRecordFilterMode === "mine" ? "active" : ""}" data-work-record-filter="mine" type="button">내 기록</button>
    </div>
    <div class="record-list">
      ${
        records.length
          ? records
              .map((record) => `
                <article class="record-card">
                  <div class="record-meta">
                    <strong>${esc(recordAuthorDisplayName(record.author))}</strong>
                    <time>${esc(formatRecordTime(record.createdAt))}</time>
                    ${editable ? `<button class="record-control" data-edit-work-record="${esc(record.id)}" type="button">수정</button>` : ""}
                    ${editable ? `<button class="record-control danger" data-delete-work-record="${esc(record.id)}" type="button">삭제</button>` : ""}
                  </div>
                  <p>${esc(record.body).replaceAll("\n", "<br>")}</p>
                </article>
              `)
              .join("")
          : '<div class="empty">아직 등록된 관리기록이 없습니다.</div>'
      }
    </div>
  `;
}

function addWorkTask() {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work || !canEditWork(work)) return;
  syncWorkTaskDraftInputs();
  normalizeTaskTimeRange(workTaskDraft);
  const text = String(workTaskDraft.title || "").trim();
  if (!text) return;
  work.tasks = Array.isArray(work.tasks) ? work.tasks : [];
  const taskPayload = {
    text,
    detail: String(workTaskDraft.detail || "").trim(),
    type: workTaskDraft.type || "",
    owners: Array.isArray(workTaskDraft.owners) ? workTaskDraft.owners : [],
    owner: Array.isArray(workTaskDraft.owners) ? workTaskDraft.owners[0] || "" : "",
    dueDate: workTaskDraft.noDueDate ? "" : (workTaskDraft.dueDate || dateKey(new Date())),
    noDueDate: Boolean(workTaskDraft.noDueDate),
    allDay: workTaskDraft.allDay !== false,
    startTime: workTaskDraft.startTime || "09:00",
    endTime: workTaskDraft.endTime || "10:00",
    calendar: Boolean(workTaskDraft.calendar)
  };
  if (workTaskDraft.editingTaskId) {
    const task = work.tasks.find((item) => item.id === workTaskDraft.editingTaskId);
    if (!task || !canManageWorkTask(work, task)) return;
    Object.assign(task, taskPayload);
    notifyOwners(taskPayload.owners, `할 일이 수정되었습니다: ${text}`, { type: "work-task", workId: work.id, taskId: task.id });
    showToast("할 일이 수정되었습니다.");
  } else {
    const newTask = {
      id: makeId(),
      createdAt: new Date().toISOString(),
      done: false,
      ...taskPayload
    };
    work.tasks.push(newTask);
    notifyOwners(taskPayload.owners, `할 일이 추가되었습니다: ${text}`, { type: "work-task", workId: work.id, taskId: newTask.id });
    showToast("할 일이 추가되었습니다.");
  }
  resetWorkTaskDraft(work);
  workTaskComposerOpen = false;
  saveState();
  renderAll();
  renderWorkDetail();
}

function editWorkTask(taskId) {
  const work = state.works.find((item) => item.id === activeWorkId);
  const task = work?.tasks?.find((item) => item.id === taskId);
  if (!work || !task || !canManageWorkTask(work, task)) {
    showToast("담당자 또는 관리자만 수정할 수 있습니다.");
    return;
  }
  workTaskDraft = {
    title: task.text || "",
    detail: task.detail || "",
    type: task.type || "",
    owners: taskOwners(task),
    dueDate: task.noDueDate ? "" : (task.dueDate || dateKey(new Date())),
    noDueDate: Boolean(task.noDueDate || !task.dueDate),
    allDay: task.allDay !== false,
    startTime: task.startTime || "09:00",
    endTime: task.endTime || "10:00",
    calendar: Boolean(task.calendar),
    editingTaskId: task.id
  };
  workTaskComposerOpen = true;
  renderWorkTasks(work);
}

function addWorkManagementRecord() {
  const work = state.works.find((item) => item.id === activeWorkId);
  const textarea = $("#workRecordBody");
  if (!work || !textarea) return;
  if (!canEditWork(work)) {
    showToast("담당자 또는 관리자만 기록할 수 있습니다.");
    return;
  }
  const body = textarea.value.trim();
  if (!body) return;
  work.records = Array.isArray(work.records) ? work.records : [];
  const user = currentUser();
  const authorName = currentRecordAuthorName(workOwners(work));
  if (editingWorkRecordId) {
    const record = work.records.find((item) => item.id === editingWorkRecordId);
    if (record) {
      record.body = body;
      record.updatedAt = new Date().toISOString();
      record.author = authorName || record.author || "관리자";
    }
    editingWorkRecordId = null;
    notifyOwners(workOwners(work), `관리기록이 수정되었습니다: ${work.title}`, { type: "work-record", workId: work.id });
    saveState();
    renderWorkDetail();
    showToast("관리기록이 수정되었습니다.");
    return;
  }
  work.records.push({
    id: makeId(),
    author: authorName,
    body,
    createdAt: new Date().toISOString()
  });
  notifyOwners(workOwners(work), `관리기록이 등록되었습니다: ${work.title}`, { type: "work-record", workId: work.id });
  saveState();
  renderWorkDetail();
  showToast("관리기록이 등록되었습니다.");
}

function deleteWorkManagementRecord(recordId) {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work) return;
  if (!canEditWork(work)) {
    showToast("담당자 또는 관리자만 삭제할 수 있습니다.");
    return;
  }
  work.records = (work.records || []).filter((record) => record.id !== recordId);
  if (editingWorkRecordId === recordId) editingWorkRecordId = null;
  saveState();
  renderWorkDetail();
  showToast("관리기록이 삭제되었습니다.");
}

function openWorkDetail(workId) {
  if (!state.works.some((work) => work.id === workId)) return;
  activeWorkId = workId;
  editingWorkRecordId = null;
  workTaskComposerOpen = false;
  activeWorkDetailTab = "basic";
  renderWorkDetail();
  $("#workDetail").classList.add("open");
  $("#workDetail").setAttribute("aria-hidden", "false");
}

function closeWorkDetail() {
  $("#workDetail").classList.remove("open");
  $("#workDetail").setAttribute("aria-hidden", "true");
  activeWorkId = null;
  renderAll();
}

function updateActiveWork(field, value, rerender = true) {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work) return;
  if (!canEditWork(work)) {
    showToast("담당자 또는 관리자만 수정할 수 있습니다.");
    renderWorkDetail();
    return;
  }
  const previousOwners = field === "owners" ? workOwners(work) : [];
  work[field] = value;
  if (field === "owners") {
    notifyOwners(uniqueValues([...(Array.isArray(value) ? value : []), ...previousOwners]), `담당 업무가 변경되었습니다: ${work.title}`, { type: "work", workId: work.id });
  }
  saveState();
  if (rerender) {
    renderAll();
    renderWorkDetail();
  }
}

function deleteWork(workId) {
  const work = state.works.find((item) => item.id === workId);
  if (!canEditWork(work)) {
    showToast("담당자 또는 관리자만 삭제할 수 있습니다.");
    return;
  }
  if (work?.studioReservationId) state.staffEvents = state.staffEvents.filter((event) => event.id !== work.studioReservationId);
  if (work?.studioReservationId) state.staffEvents = state.staffEvents.filter((event) => event.id !== work.studioReservationId);
  if (work?.studioReservationId) state.staffEvents = state.staffEvents.filter((event) => event.id !== work.studioReservationId);
  if (work?.studioReservationId) state.staffEvents = state.staffEvents.filter((event) => event.id !== work.studioReservationId);
  state.works = state.works.filter((item) => item.id !== workId);
  saveState();
  closeWorkDetail();
}

function taskOverviewItems() {
  const projectItems = state.tasks.map((task) => {
    const project = state.projects.find((item) => item.id === task.projectId);
    return {
      id: task.id,
      source: "project",
      sourceLabel: "영상 프로젝트",
      sourceId: task.projectId,
      sourceTitle: project?.title || "삭제된 영상 프로젝트",
      task,
      canManage: canManageTask(task)
    };
  });
  const workItems = state.works.flatMap((work) =>
    (Array.isArray(work.tasks) ? work.tasks : []).map((task) => ({
      id: task.id,
      source: "work",
      sourceLabel: "업무",
      sourceId: work.id,
      sourceTitle: work.title || "업무",
      task,
      canManage: canManageWorkTask(work, task)
    }))
  );
  return [...projectItems, ...workItems];
}

function taskOverviewDayDiff(item) {
  if (item.task.noDueDate || !item.task.dueDate) return null;
  return daysUntil(item.task.dueDate);
}

function taskOverviewStatus(item) {
  if (item.task.done) return "done";
  const diff = taskOverviewDayDiff(item);
  if (diff === null) return "none";
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= 3) return "three";
  if (diff <= 7) return "week";
  return "later";
}

function taskOverviewDueBadge(item) {
  if (item.task.done) return '<span class="overview-due done">완료</span>';
  const diff = taskOverviewDayDiff(item);
  if (diff === null) return '<span class="overview-due none">마감일 없음</span>';
  if (diff < 0) return `<span class="overview-due overdue">지연 ${Math.abs(diff)}일</span>`;
  if (diff === 0) return '<span class="overview-due today">오늘</span>';
  return `<span class="overview-due upcoming">D-${diff}</span>`;
}

const taskSortOptions = [
  ["dueAsc", "마감일 빠른 순"],
  ["dueDesc", "마감일 늦은 순"],
  ["createdDesc", "등록일 최신순"],
  ["createdAsc", "등록일 오래된순"],
  ["project", "프로젝트명순"],
  ["owner", "담당자순"]
];

function normalizeTaskSort(value) {
  const aliases = { due: "dueAsc", created: "createdAsc" };
  const key = aliases[value] || value || "dueAsc";
  return taskSortOptions.some(([option]) => option === key) ? key : "dueAsc";
}

function taskSortLabel(value) {
  const key = normalizeTaskSort(value);
  return taskSortOptions.find(([option]) => option === key)?.[1] || "마감일 빠른 순";
}

function taskDueSortRank(item) {
  if (item.task.done) return 4;
  const diff = taskOverviewDayDiff(item);
  if (diff === null) return 3;
  if (diff < 0) return 0;
  if (diff === 0) return 1;
  return 2;
}

function taskCreatedValue(item) {
  return new Date(item.task.createdAt || item.id || 0).getTime() || 0;
}

function compareTaskOverviewItems(a, b, sortValue = taskOverviewSort) {
  const sort = normalizeTaskSort(sortValue);
  if (sort === "createdDesc") return taskCreatedValue(b) - taskCreatedValue(a);
  if (sort === "createdAsc") return taskCreatedValue(a) - taskCreatedValue(b);
  if (sort === "project") return `${a.sourceTitle} ${a.task.text || ""}`.localeCompare(`${b.sourceTitle} ${b.task.text || ""}`, "ko");
  if (sort === "owner") return `${taskOwnersLabel(a.task)} ${a.sourceTitle}`.localeCompare(`${taskOwnersLabel(b.task)} ${b.sourceTitle}`, "ko");
  if (sort === "dueDesc") {
    const aDue = a.task.done ? "0000-00-00" : (a.task.dueDate || "0000-00-00");
    const bDue = b.task.done ? "0000-00-00" : (b.task.dueDate || "0000-00-00");
    return bDue.localeCompare(aDue) || a.sourceTitle.localeCompare(b.sourceTitle, "ko");
  }
  const rank = taskDueSortRank(a) - taskDueSortRank(b);
  if (rank) return rank;
  const aDue = a.task.dueDate || "9999-12-31";
  const bDue = b.task.dueDate || "9999-12-31";
  return aDue.localeCompare(bDue) || a.sourceTitle.localeCompare(b.sourceTitle, "ko");
}

function taskDdayInfo(item) {
  if (item.task.done) return { label: "완료", className: "done" };
  const diff = taskOverviewDayDiff(item);
  if (diff === null) return { label: "마감 없음", className: "none" };
  if (diff < 0) return { label: `${Math.abs(diff)}일 지연`, className: "overdue" };
  if (diff === 0) return { label: "D-DAY", className: "today" };
  if (diff <= 3) return { label: `D-${diff}`, className: "soon" };
  if (diff <= 6) return { label: `D-${diff}`, className: "mid" };
  return { label: `D-${diff}`, className: "safe" };
}

function filteredTaskOverviewItems() {
  const query = taskOverviewSearch.trim().toLowerCase();
  return taskOverviewItems()
    .filter((item) => {
      if (taskOverviewHideDone && item.task.done) return false;
      const status = taskOverviewStatus(item);
      if (taskOverviewFilter !== "all") {
        if (taskOverviewFilter === "three" && !["today", "three"].includes(status)) return false;
        else if (taskOverviewFilter === "week" && !["today", "three", "week"].includes(status)) return false;
        else if (!["three", "week"].includes(taskOverviewFilter) && status !== taskOverviewFilter) return false;
      }
      if (taskOverviewOwner && !taskOwners(item.task).includes(taskOverviewOwner)) return false;
      if (taskOverviewType && item.task.type !== taskOverviewType) return false;
      if (taskOverviewProject && taskOverviewProjectKey(item) !== taskOverviewProject) return false;
      if (!query) return true;
      return [item.task.text, item.task.detail, item.task.type, item.sourceTitle, item.sourceLabel, taskOwnersLabel(item.task)]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => compareTaskOverviewItems(a, b, taskOverviewSort));
}

function renderTaskOverviewSelect(select, value, options, defaultLabel) {
  if (!select) return;
  select.innerHTML = [`<option value="">${esc(defaultLabel)}</option>`, ...options.map((option) => `<option value="${esc(option)}">${esc(option)}</option>`)].join("");
  select.value = value;
}

function taskOverviewProjectKey(item) {
  return `${item.source}:${item.sourceId}`;
}

function taskOverviewProjectOptions(items) {
  const map = new Map();
  items.forEach((item) => {
    const key = taskOverviewProjectKey(item);
    if (!map.has(key)) map.set(key, `${item.sourceTitle} · ${item.sourceLabel}`);
  });
  return Array.from(map, ([value, label]) => ({ value, label }));
}

function taskOverviewFilterOptions(kind, items = taskOverviewItems()) {
  if (kind === "owner") {
    return [...new Set(items.flatMap((item) => taskOwners(item.task)).filter(Boolean))].map((value) => ({ value, label: value }));
  }
  if (kind === "type") {
    return [...new Set(items.map((item) => item.task.type).filter(Boolean))].map((value) => ({ value, label: value }));
  }
  return taskOverviewProjectOptions(items);
}

function taskOverviewFilterValue(kind) {
  if (kind === "owner") return taskOverviewOwner;
  if (kind === "type") return taskOverviewType;
  return taskOverviewProject;
}

function setTaskOverviewFilterValue(kind, value) {
  if (kind === "owner") taskOverviewOwner = value;
  else if (kind === "type") taskOverviewType = value;
  else taskOverviewProject = value;
}

function taskOverviewFilterLabel(kind, value, options) {
  if (!value) return "전체";
  return options.find((option) => option.value === value)?.label || value;
}

function taskOverviewActiveFilterCount() {
  return [taskOverviewOwner, taskOverviewType, taskOverviewProject].filter(Boolean).length;
}

function taskOverviewFilterSummary(items = taskOverviewItems()) {
  const filters = [
    ["담당자", "owner", taskOverviewOwner],
    ["업무 분류", "type", taskOverviewType],
    ["프로젝트", "project", taskOverviewProject]
  ]
    .filter(([, , value]) => value)
    .map(([label, kind, value]) => `${label}: ${taskOverviewFilterLabel(kind, value, taskOverviewFilterOptions(kind, items))}`);
  return filters.length ? filters.join(" · ") : "적용된 필터 없음";
}

function renderTaskOverviewFilterSection(kind, title, items) {
  const options = taskOverviewFilterOptions(kind, items);
  const currentValue = taskOverviewFilterValue(kind);
  return `
    <section class="task-filter-section">
      <h4>${esc(title)}</h4>
      <div class="task-filter-chip-row">
        <button class="task-filter-chip ${!currentValue ? "active" : ""}" data-task-filter-kind="${esc(kind)}" data-task-filter-value="" type="button">전체</button>
        ${options.map((option) => `
          <button class="task-filter-chip ${option.value === currentValue ? "active" : ""}" data-task-filter-kind="${esc(kind)}" data-task-filter-value="${esc(option.value)}" type="button">${esc(option.label)}</button>
        `).join("")}
      </div>
    </section>
  `;
}

function openTaskOverviewFilter() {
  const modal = $("#taskOverviewFilterModal");
  const title = $("#taskOverviewFilterTitle");
  const optionWrap = $("#taskOverviewFilterOptions");
  const summary = $("#taskOverviewFilterSummary");
  if (!modal || !title || !optionWrap) return;
  const items = taskOverviewItems();
  title.textContent = "필터";
  if (summary) summary.textContent = taskOverviewFilterSummary(items);
  optionWrap.innerHTML = [
    renderTaskOverviewFilterSection("owner", "담당자", items),
    renderTaskOverviewFilterSection("type", "업무 분류", items),
    renderTaskOverviewFilterSection("project", "프로젝트", items)
  ].join("");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function closeTaskOverviewFilter() {
  const modal = $("#taskOverviewFilterModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function renderTaskOverviewControls(items) {
  const filterButton = $("#taskOverviewFilterBtn");
  if (filterButton) {
    const count = taskOverviewActiveFilterCount();
    filterButton.textContent = count ? `☷ 필터 ${count}` : "☷ 필터";
    filterButton.classList.toggle("active", count > 0);
  }
  const sortSelect = $("#taskOverviewSort");
  if (sortSelect) {
    taskOverviewSort = normalizeTaskSort(taskOverviewSort);
    sortSelect.innerHTML = taskSortOptions.map(([value, label]) => `<option value="${esc(value)}">정렬: ${esc(label)}</option>`).join("");
    sortSelect.value = taskOverviewSort;
  }
  const searchInput = $("#taskOverviewSearch");
  if (searchInput && searchInput.value !== taskOverviewSearch) searchInput.value = taskOverviewSearch;
  const hideInput = $("#hideDoneTasks");
  if (hideInput) hideInput.checked = taskOverviewHideDone;
  $$("[data-task-overview-filter]").forEach((button) => button.classList.toggle("active", button.dataset.taskOverviewFilter === taskOverviewFilter));
}

function renderTaskOverviewStats(items) {
  const openItems = items.filter((item) => !item.task.done);
  const counts = {
    overdue: openItems.filter((item) => taskOverviewStatus(item) === "overdue").length,
    today: openItems.filter((item) => taskOverviewStatus(item) === "today").length,
    three: openItems.filter((item) => ["today", "three"].includes(taskOverviewStatus(item))).length,
    week: openItems.filter((item) => ["today", "three", "week"].includes(taskOverviewStatus(item))).length,
    total: openItems.length
  };
  $("#taskOverviewStats").innerHTML = [
    ["overdue", "!", "지연", counts.overdue],
    ["today", "▣", "오늘", counts.today],
    ["three", "◷", "3일 이내", counts.three],
    ["week", "▣", "이번 주", counts.week],
    ["total", "✓", "전체 미완료", counts.total]
  ]
    .map(([key, icon, label, value]) => `
      <article class="task-stat ${key}">
        <span>${icon}</span>
        <strong>${esc(label)}</strong>
        <b>${value}</b>
      </article>
    `)
    .join("");
}

function renderTaskOverviewGroup(title, key, items) {
  if (!items.length) return "";
  const iconMap = { overdue: "!", today: "▣", three: "◷", week: "▣", none: "▣", later: "✓", done: "✓" };
  return `
    <section class="task-overview-group ${key}">
      <h3><span>${iconMap[key] || "✓"}</span>${esc(title)} <small>(${items.length})</small></h3>
      <div class="task-overview-items">
        ${items
          .map((item) => `
            <article class="overview-task-row">
              <div class="task-main">
                <input type="checkbox" data-overview-task-source="${esc(item.source)}" data-overview-task-check="${esc(item.id)}" ${item.task.done ? "checked" : ""} ${item.canManage ? "" : "disabled"} />
                <span>
                  <h4>${esc(item.task.text || "제목 없음")}</h4>
                  <small>${esc(item.sourceTitle)} · ${esc(taskOwnersLabel(item.task))}${item.task.type ? ` · ${esc(item.task.type)}` : ""}</small>
                </span>
              </div>
              <div class="overview-task-meta">
                <span>마감일</span>
                <b>${item.task.dueDate ? esc(formatDate(item.task.dueDate)) : "없음"}</b>
                ${taskOverviewDueBadge(item)}
              </div>
            </article>
          `)
          .join("")}
      </div>
    </section>
  `;
}

function renderTasks() {
  const allItems = taskOverviewItems();
  renderTaskOverviewControls(allItems);
  renderTaskOverviewStats(allItems);
  const items = filteredTaskOverviewItems();
  const groups = [
    ["지연된 할 일", "overdue", items.filter((item) => taskOverviewStatus(item) === "overdue")],
    ["오늘", "today", items.filter((item) => taskOverviewStatus(item) === "today")],
    ["3일 이내", "three", items.filter((item) => taskOverviewStatus(item) === "three")],
    ["이번 주", "week", items.filter((item) => taskOverviewStatus(item) === "week")],
    ["이후", "later", items.filter((item) => taskOverviewStatus(item) === "later")],
    ["마감일 없음", "none", items.filter((item) => taskOverviewStatus(item) === "none")],
    ["완료됨", "done", items.filter((item) => taskOverviewStatus(item) === "done")]
  ];
  $("#taskList").innerHTML = items.length
    ? groups.map(([title, key, groupItems]) => renderTaskOverviewGroup(title, key, groupItems)).join("")
    : `<div class="empty">조건에 맞는 할 일이 없습니다.</div>`;
}

function renderPriority() {
  const nextItem = taskOverviewItems()
    .filter((item) => !item.task.done && item.task.dueDate)
    .sort((a, b) => String(a.task.dueDate || "").localeCompare(String(b.task.dueDate || "")))[0];
  $("#priorityNote").textContent = nextItem ? `${nextItem.sourceTitle} · ${nextItem.task.text}` : "미완료 업무가 없습니다.";
}

function projectEventsForDate(key) {
  const milestoneLabels = [
    ["kickoffDate", "시작"],
    ["shootDate", "촬영"],
    ["firstEditDate", "1차 완성"],
    ["finalDate", "완료"]
  ];
  const milestones = state.projects.flatMap((project) =>
    milestoneLabels
      .filter(([field]) => visibleDetailCalendarFields.includes(field) && project[field] === key && (project.calendarFields || defaultCalendarFields)[field])
      .map(([field, label]) => ({
        id: `${project.id}:${field}`,
        source: "project",
        projectId: project.id,
        field,
        label: label === "완료" ? project.title : `${label} · ${project.title}`,
        type: label === "완료" ? "due" : "start",
        allDay: true
      }))
  );
  const workMilestoneLabels = [
    ["kickoffDate", "업무 시작"],
    ["finalDate", "업무 완료"]
  ];
  const workMilestones = state.works.flatMap((work) =>
    work.noSchedule
      ? []
      : workMilestoneLabels
          .filter(([field]) => visibleWorkDetailCalendarFields.includes(field) && work[field] === key && (work.calendarFields || defaultWorkCalendarFields)[field])
          .map(([field, label]) => ({
            id: `${work.id}:${field}`,
            source: "work",
            workId: work.id,
            field,
            label: label.includes("완료") ? work.title : `${label} · ${work.title}`,
            type: label.includes("완료") ? "due" : "start",
            allDay: true
          }))
  );
  const projectTaskEvents = state.tasks
    .filter((task) => task.calendar && task.dueDate === key)
    .map((task) => ({
      id: task.id,
      source: "projectTask",
      taskId: task.id,
      projectId: task.projectId,
      label: `${projectName(task.projectId)} - ${task.text}`,
      type: "custom",
      allDay: task.allDay !== false,
      startTime: task.startTime || "09:00",
      endTime: task.endTime || "10:00"
    }));
  const workTaskEvents = state.works.flatMap((work) =>
    (Array.isArray(work.tasks) ? work.tasks : [])
      .filter((task) => task.calendar && task.dueDate === key)
      .map((task) => ({
        id: task.id,
        source: "workTask",
        workId: work.id,
        taskId: task.id,
        label: `${work.title} - ${task.text}`,
        type: "work",
        allDay: task.allDay !== false,
        startTime: task.startTime || "09:00",
        endTime: task.endTime || "10:00"
      }))
  );
  const schedules = state.schedules
    .filter((schedule) => schedule.date === key)
    .map((schedule) => ({
      id: schedule.id,
      source: "schedule",
      scheduleId: schedule.id,
      label: schedule.title,
      type: "schedule",
      allDay: schedule.allDay !== false,
      startTime: schedule.startTime || "09:00",
      endTime: schedule.endTime || "10:00"
    }));
  const staffEvents = state.staffEvents
    .filter((event) => event.date === key)
    .map((event) => ({
      id: event.id,
      source: "staff",
      staffEventId: event.id,
      label: `${staffReservationTitle(event)} · ${event.room || ""}${staffEventOwnerLabel(event) !== "-" ? ` · ${staffEventOwnerLabel(event)}` : ""}`,
      type: staffEventTypeColor(event.type),
      allDay: event.allDay !== false,
      startTime: event.startTime || "09:00",
      endTime: event.endTime || "10:00"
    }));
  const videoEvents = [...milestones, ...projectTaskEvents];
  const workEvents = [...workMilestones, ...workTaskEvents];
  const showAllCalendarGroups = calendarFilters.video && calendarFilters.work && calendarFilters.staff;
  const projectEvents = [
    ...(calendarFilters.video ? videoEvents : []),
    ...(calendarFilters.work ? workEvents : []),
    ...(showAllCalendarGroups ? schedules : [])
  ];
  const sortEvents = (events) => [...events].sort((a, b) => {
    if ((a.allDay !== false) !== (b.allDay !== false)) return a.allDay === false ? 1 : -1;
    return (a.startTime || "").localeCompare(b.startTime || "");
  });
  return sortEvents([...projectEvents, ...(calendarFilters.staff ? staffEvents : [])]);
}

function renderCalendar() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const start = new Date(year, month, 1 - firstDay.getDay());
  const todayKey = dateKey(new Date());

  $("#calendarTitle").textContent = `${year}년 ${month + 1}월 일정`;
  $("#calendarBoard")?.classList.remove("is-staff-mode");
  const allChecked = calendarFilters.video && calendarFilters.work && calendarFilters.staff;
  $$("[data-calendar-filter]").forEach((input) => {
    const key = input.dataset.calendarFilter;
    input.checked = key === "all" ? allChecked : Boolean(calendarFilters[key]);
  });
  $("#calendarGrid").innerHTML = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = dateKey(date);
    const events = projectEventsForDate(key);
    const holidayName = koreanHolidayName(key);
    return `
      <div class="calendar-day ${date.getMonth() !== month ? "is-muted" : ""} ${key === todayKey ? "is-today" : ""} ${date.getDay() === 0 ? "is-sunday" : ""} ${holidayName ? "is-holiday" : ""}" data-calendar-date="${key}">
        <span class="day-number"><b>${date.getDate()}</b>${holidayName ? `<em>${esc(holidayName)}</em>` : ""}</span>
        ${events
          .map((event) => `
            <button
              class="calendar-event ${calendarEventClass(event)}"
              draggable="true"
              data-event-source="${event.source}"
              data-event-id="${esc(event.id)}"
              data-project-id="${esc(event.projectId || "")}"
              data-work-id="${esc(event.workId || "")}"
              data-event-field="${esc(event.field || "")}"
              data-schedule-id="${esc(event.scheduleId || "")}"
              data-staff-event-id="${esc(event.staffEventId || "")}"
              title="드래그해서 날짜 이동"
              type="button"
            >${event.allDay === false ? `<span class="event-time">${esc(event.startTime || "")}</span>` : ""}<span>${esc(event.label)}</span></button>
          `)
          .join("")}
      </div>
    `;
  }).join("");
  renderStaffCalendarDetail();
}

function staffTypeClass(type) {
  return staffEventTypeColor(type);
}

function renderStaffCalendarDetail() {
  const detail = $("#staffCalendarDetail");
  if (detail) detail.innerHTML = "";
}

function openCalendarEventDetail(eventButton) {
  if (!eventButton) return;
  const source = eventButton.dataset.eventSource;
  if (source === "schedule") {
    openScheduleEventDetail(eventButton.dataset.scheduleId);
    return;
  }
  if (source === "staff") {
    selectedStaffCalendarId = eventButton.dataset.staffEventId;
    openStaffEventDetail(eventButton.dataset.staffEventId);
    return;
  }
  if (["project", "projectTask"].includes(source) && eventButton.dataset.projectId) {
    if (source === "projectTask") highlightedProjectTaskId = eventButton.dataset.eventId;
    openProjectDetail(eventButton.dataset.projectId);
    if (source === "projectTask") {
      activeDetailTab = "tasks";
      renderDetailTabs();
      clearTaskHighlight("project");
    }
    return;
  }
  if (["work", "workTask"].includes(source) && eventButton.dataset.workId) {
    if (source === "workTask") highlightedWorkTaskId = eventButton.dataset.eventId;
    openWorkDetail(eventButton.dataset.workId);
    if (source === "workTask") {
      activeWorkDetailTab = "tasks";
      renderWorkDetailTabs();
      clearTaskHighlight("work");
    }
  }
}

function clearTaskHighlight(scope) {
  setTimeout(() => {
    if (scope === "project") {
      highlightedProjectTaskId = null;
      const project = state.projects.find((item) => item.id === activeProjectId);
      if (project) renderProjectTasks(project);
      renderDetailTabs();
    }
    if (scope === "work") {
      highlightedWorkTaskId = null;
      const work = state.works.find((item) => item.id === activeWorkId);
      if (work) renderWorkTasks(work);
      renderWorkDetailTabs();
    }
  }, 1800);
}

function moveCalendarEvent(payload, targetDate) {
  if (!payload || !targetDate) return;
  if (payload.source === "project") {
    const project = state.projects.find((item) => item.id === payload.projectId);
    if (!canEditProject(project)) {
      showToast("담당자 또는 관리자만 일정을 변경할 수 있습니다.");
      return;
    }
    if (project && payload.field) project[payload.field] = targetDate;
  }
  if (payload.source === "work") {
    const work = state.works.find((item) => item.id === payload.workId);
    if (!canEditWork(work)) {
      showToast("담당자 또는 관리자만 일정을 변경할 수 있습니다.");
      return;
    }
    if (work && payload.field) work[payload.field] = targetDate;
  }
  if (payload.source === "projectTask") {
    const task = state.tasks.find((item) => item.id === payload.id);
    if (!canManageTask(task)) {
      showToast("담당자 또는 관리자만 할 일 일정을 변경할 수 있습니다.");
      return;
    }
    if (task) {
      task.dueDate = targetDate;
      task.noDueDate = false;
      task.calendar = true;
    }
  }
  if (payload.source === "workTask") {
    const work = state.works.find((item) => item.id === payload.workId);
    const task = work?.tasks?.find((item) => item.id === payload.id);
    if (!canManageWorkTask(work, task)) {
      showToast("담당자 또는 관리자만 할 일 일정을 변경할 수 있습니다.");
      return;
    }
    if (task) {
      task.dueDate = targetDate;
      task.noDueDate = false;
      task.calendar = true;
    }
  }
  if (payload.source === "schedule") {
    const schedule = state.schedules.find((item) => item.id === payload.scheduleId);
    if (schedule) schedule.date = targetDate;
  }
  if (payload.source === "staff") {
    const event = state.staffEvents.find((item) => item.id === payload.staffEventId);
    if (event) event.date = targetDate;
  }
  saveState();
  renderAll();
  showToast("일정 날짜가 변경되었습니다.");
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 240);
  }, 1800);
}

function propertyRow(icon, label, content) {
  return `
    <div class="property-row">
      <div class="property-label"><span>${icon}</span>${label}</div>
      <div class="property-value">${content}</div>
    </div>
  `;
}

function memoTextToHtml(value) {
  const raw = String(value || "");
  if (/<\/?[a-z][\s\S]*>/i.test(raw)) return raw;
  return esc(raw).replaceAll("\n", "<br>");
}

function setRichMemoContent(targetId, value, editable) {
  const editor = $(`#${targetId}`);
  if (!editor) return;
  editor.innerHTML = memoTextToHtml(value);
  editor.contentEditable = editable ? "true" : "false";
  editor.classList.toggle("readonly", !editable);
}

function richMemoValue(editor) {
  if (!editor || !editor.textContent.trim()) return "";
  return editor.innerHTML;
}

function selectionBelongsToEditor(editor) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer);
}

function placeCursorAtEnd(editor) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function currentMemoBlockFormat(editor) {
  const selection = window.getSelection();
  if (!selection.rangeCount || !selectionBelongsToEditor(editor)) return "text";
  let node = selection.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  while (node && node !== editor) {
    const tag = node.tagName?.toLowerCase();
    if (["h1", "h2", "h3", "h4"].includes(tag)) return tag;
    node = node.parentElement;
  }
  return "text";
}

function updateMemoToolbarState(targetId) {
  const editor = $(`#${targetId}`);
  if (!editor) return;
  const isActiveEditor = document.activeElement === editor || selectionBelongsToEditor(editor);
  const blockFormat = isActiveEditor ? currentMemoBlockFormat(editor) : "text";
  const inlineStates = {
    bold: isActiveEditor && document.queryCommandState("bold"),
    italic: isActiveEditor && document.queryCommandState("italic"),
    underline: isActiveEditor && document.queryCommandState("underline")
  };

  $$(`[data-memo-target="${targetId}"]`).forEach((button) => {
    const format = button.dataset.memoFormat;
    const isBlockActive = ["text", "h1", "h2", "h3", "h4"].includes(format) && format === blockFormat;
    const isInlineActive = Boolean(inlineStates[format]);
    button.classList.toggle("active", isBlockActive || isInlineActive);
  });
}

function updateAllMemoToolbarStates() {
  updateMemoToolbarState("detailMemo");
  updateMemoToolbarState("workDetailMemo");
}

function applyMemoFormat(targetId, format) {
  const editor = $(`#${targetId}`);
  if (!editor || editor.contentEditable !== "true") return;

  if (!selectionBelongsToEditor(editor)) placeCursorAtEnd(editor);

  if (format === "text") document.execCommand("formatBlock", false, "div");
  if (["h1", "h2", "h3", "h4"].includes(format)) document.execCommand("formatBlock", false, format);
  if (format === "bold") document.execCommand("bold", false);
  if (format === "italic") document.execCommand("italic", false);
  if (format === "underline") document.execCommand("underline", false);
  if (format === "clear") {
    document.execCommand("removeFormat", false);
    document.execCommand("formatBlock", false, "div");
  }

  editor.focus();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  updateMemoToolbarState(targetId);
}

function dateFieldControl(field) {
  return `
    <div class="date-field-control">
      <div id="detail-${field}"></div>
      <label class="calendar-toggle">
        <input type="checkbox" data-calendar-field="${field}" />
        <span>캘린더 등록</span>
      </label>
    </div>
  `;
}

function renderProjectDetail() {
  const project = state.projects.find((item) => item.id === activeProjectId);
  if (!project) return;
  const editable = canEditProject(project);

  $(".detail-page").classList.toggle("readonly", !editable);
  $("#deleteDetailBtn").disabled = !editable;
  $("#deleteDetailBtn").title = editable ? "" : "담당자 또는 관리자만 삭제할 수 있습니다.";
  $("#detailTitle").value = project.title;
  $("#detailTitle").disabled = !editable;
  $("#detailProperties").innerHTML = `
    ${!editable ? '<div class="readonly-notice">이 영상 프로젝트의 담당자 또는 관리자만 수정할 수 있습니다.</div>' : ""}
    ${propertyRow("☷", "업무분류", '<div id="detailType"></div>')}
    ${propertyRow("▾", "담당자", '<div id="detailOwners"></div>')}
    ${propertyRow("▾", "발주 부서", '<div id="detailClient"></div>')}
    ${propertyRow("▣", "예산", '<input class="notion-input money-input" id="detailBudget" inputmode="numeric" />')}
    ${propertyRow("▾", "진행", '<div id="detailStatus"></div>')}
    <div class="property-break"></div>
    ${propertyRow("↦", "시작일", dateFieldControl("kickoffDate"))}
    ${propertyRow("✓", "완료일", dateFieldControl("finalDate"))}
  `;
  setRichMemoContent("detailMemo", project.memo || "", editable);
  $("#detailBudget").value = formatMoneyInput(project.budget);
  $("#detailBudget").disabled = !editable;

  [
    ["#detailType", "type", "types"],
    ["#detailClient", "client", "clients"],
    ["#detailStatus", "status", "statuses"]
  ].forEach(([target, field, optionKey]) => {
    renderDropdown({
      target: $(target),
      value: project[field],
      options: state.options[optionKey],
      placeholder: "선택",
      compact: true,
      className: field === "status" && project.status ? statusClass(project.status) : "outline-cell",
      disabled: !editable,
      onSelect: (value) => updateActiveProject(field, value)
    });
  });

  renderOwnerPicker(project);

  [
    ["#detail-kickoffDate", "kickoffDate"],
    ["#detail-finalDate", "finalDate"]
  ].forEach(([target, field]) => {
    renderDateButton({
      target: $(target),
      value: project[field],
      compact: true,
      disabled: !editable,
      onSelect: (date) => updateActiveProject(field, date || project[field])
    });
  });

  $("#detailProperties").querySelectorAll("[data-calendar-field]").forEach((checkbox) => {
    const field = checkbox.dataset.calendarField;
    project.calendarFields = { ...defaultCalendarFields, ...(project.calendarFields || {}) };
    checkbox.checked = Boolean(project.calendarFields[field]);
    checkbox.disabled = !editable;
    checkbox.addEventListener("change", () => {
      project.calendarFields[field] = checkbox.checked;
      saveState();
      renderCalendar();
    });
  });

  [["#detailBudget", "budget"]].forEach(([selector, field]) => {
    $(selector).addEventListener("input", (event) => {
      const nextValue = formatMoneyInput(parseMoney(event.target.value));
      event.target.value = nextValue;
      event.target.setSelectionRange(nextValue.length, nextValue.length);
      updateActiveProject(field, parseMoney(nextValue), false);
    });
    $(selector).addEventListener("change", (event) => updateActiveProject(field, parseMoney(event.target.value)));
  });

  renderManagementRecords(project);
  renderProjectTasks(project);
  renderDetailTabs();
}

function renderOwnerPicker(project) {
  const editable = canEditProject(project);
  renderMultiDropdown({
    target: $("#detailOwners"),
    values: projectOwners(project),
    options: ownerOptions(),
    placeholder: "선택",
    formatOptionLabel: ownerOptionLabel,
    compact: true,
    disabled: !editable,
    onChange: (owners) => {
      project.owners = owners;
      saveState();
      renderAll();
    }
  });
}

function renderManagementRecords(project) {
  const editable = canEditProject(project);
  const query = recordSearchQuery.trim().toLowerCase();
  const records = [...(project.records || [])]
    .filter((record) => {
      const author = recordAuthorDisplayName(record.author);
      if (recordFilterMode === "mine" && !isCurrentUserRecord(record)) return false;
      if (!query) return true;
      return `${author || ""} ${record.author || ""} ${record.body || ""}`.toLowerCase().includes(query);
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const editingRecord = project.records?.find((record) => record.id === editingRecordId);
  $("#managementRecords").innerHTML = `
    <div class="record-composer">
      <textarea id="recordBody" class="record-input" placeholder="새로운 관리 기록을 입력하세요&#10;Enter로 줄바꿈, 버튼으로 등록" ${editable ? "" : "disabled"}>${esc(editingRecord?.body || "")}</textarea>
      <div class="record-actions">
        <span>${editable ? (editingRecord ? "기록 수정 중" : "영상 프로젝트별 관리 메모") : "담당자 또는 관리자만 기록을 추가할 수 있습니다."}</span>
        <div>
          ${editingRecord ? '<button id="cancelRecordEditBtn" class="pill ghost" type="button">취소</button>' : ""}
          <button id="addRecordBtn" class="pill primary" type="button" ${editable ? "" : "disabled"}>${editingRecord ? "수정 저장" : "+ 등록"}</button>
        </div>
      </div>
    </div>
    <div class="record-tools">
      <input id="recordSearchInput" class="record-search" value="${esc(recordSearchQuery)}" placeholder="관리기록 검색" />
      <button class="record-control ${recordFilterMode === "all" ? "active" : ""}" data-record-filter="all" type="button">전체</button>
      <button class="record-control ${recordFilterMode === "mine" ? "active" : ""}" data-record-filter="mine" type="button">내 기록</button>
    </div>
    <div class="record-list">
      ${
        records.length
          ? records
              .map((record) => `
                <article class="record-card">
                  <div class="record-meta">
                    <strong>${esc(recordAuthorDisplayName(record.author))}</strong>
                    <time>${esc(formatRecordTime(record.createdAt))}</time>
                    ${editable ? `<button class="record-control" data-edit-record="${esc(record.id)}" type="button">수정</button>` : ""}
                    ${editable ? `<button class="record-control danger" data-delete-record="${esc(record.id)}" type="button">삭제</button>` : ""}
                  </div>
                  <p>${esc(record.body).replaceAll("\n", "<br>")}</p>
                </article>
              `)
              .join("")
          : '<div class="empty">아직 등록된 관리기록이 없습니다.</div>'
      }
    </div>
  `;
}

function renderDetailTabs() {
  $$(".detail-tab").forEach((button) => button.classList.toggle("active", button.dataset.detailTab === activeDetailTab));
  $("#detailBasicTab").classList.toggle("active", activeDetailTab === "basic");
  $("#detailTasksTab").classList.toggle("active", activeDetailTab === "tasks");
  $("#detailRecordsTab").classList.toggle("active", activeDetailTab === "records");
}

function syncProjectTaskDraftInputs() {
  const titleInput = $("#projectTaskTitle");
  const detailInput = $("#projectTaskDetail");
  const typeInput = $("#projectTaskTypeValue");
  const noDueDateInput = $("#projectTaskNoDueDate");
  const allDayInput = $("#projectTaskAllDay");
  const startInput = $("#projectTaskStartTimeValue");
  const endInput = $("#projectTaskEndTimeValue");
  const calendarInput = $("#projectTaskCalendar");
  if (titleInput) detailTaskDraft.title = titleInput.value;
  if (detailInput) detailTaskDraft.detail = detailInput.value;
  if (typeInput) detailTaskDraft.type = typeInput.value;
  if (noDueDateInput) detailTaskDraft.noDueDate = noDueDateInput.checked;
  if (allDayInput) detailTaskDraft.allDay = allDayInput.checked;
  if (startInput) detailTaskDraft.startTime = startInput.value || "09:00";
  if (endInput) detailTaskDraft.endTime = endInput.value || "10:00";
  if (calendarInput) detailTaskDraft.calendar = calendarInput.checked;
}

function resetProjectTaskDraft(project) {
  detailTaskDraft = {
    title: "",
    detail: "",
    type: "",
    owners: [],
    dueDate: dateKey(new Date()),
    noDueDate: false,
    allDay: true,
    startTime: "09:00",
    endTime: "10:00",
    calendar: false,
    editingTaskId: null
  };
}

function renderProjectTasks(project) {
  const editable = canEditProject(project);
  if (!Array.isArray(detailTaskDraft.owners)) detailTaskDraft.owners = [detailTaskDraft.owner].filter(Boolean);
  if (!detailTaskDraft.noDueDate && !detailTaskDraft.dueDate) detailTaskDraft.dueDate = dateKey(new Date());
  if (!detailTaskDraft.startTime) detailTaskDraft.startTime = "09:00";
  if (!detailTaskDraft.endTime) detailTaskDraft.endTime = "10:00";

  const tasks = state.tasks
    .filter((task) => task.projectId === project.id)
    .sort((a, b) => {
      if (detailTaskSort === "due") return String(a.dueDate || "").localeCompare(String(b.dueDate || ""));
      return String(a.createdAt || a.id || "").localeCompare(String(b.createdAt || b.id || ""));
  });
  const editing = state.tasks.find((task) => task.id === detailTaskDraft.editingTaskId);
  const composerOpen = detailTaskComposerOpen || Boolean(editing);

  $("#projectTaskPanel").innerHTML = `
    <div class="record-composer task-add-card ${composerOpen ? "is-expanded" : "is-collapsed"}">
      <div class="task-add-head" data-project-task-composer-toggle>
        <div class="task-add-title">
          <span class="task-add-icon">✚</span>
          <div>
            <h3>할 일 추가</h3>
            <small>새로운 할 일을 등록하세요.</small>
          </div>
        </div>
        ${composerOpen ? '<button id="resetProjectTaskFormBtn" class="record-control" type="button">↻ 초기화</button>' : ""}
      </div>
      <div class="project-task-composer task-composer-expanded">
        <label class="task-field task-title-field">
          <span>할 일 제목 <b>*</b></span>
          <input id="projectTaskTitle" class="task-title-input" value="${esc(detailTaskDraft.title || "")}" placeholder="할 일 제목을 입력하세요" ${editable ? "" : "disabled"} />
        </label>
        <div class="task-form-grid">
          <div class="task-form-column">
            <label class="task-field">
              <span>담당자 <b>*</b></span>
              <div id="projectTaskOwnerDropdown"></div>
            </label>
            <label class="task-field">
              <span>날짜 <b>*</b></span>
              <div id="projectTaskDueDatePicker"></div>
            </label>
          </div>
          <div class="task-form-column">
            <label class="task-field task-type-field">
              <span>업무 분류 <b>*</b></span>
              <input id="projectTaskTypeValue" type="hidden" value="${esc(detailTaskDraft.type || "")}" />
              <div class="task-type-chip-row">
                ${projectTaskTypeOptions().map((type) => `<button class="task-type-chip ${detailTaskDraft.type === type ? "active" : ""} ${taskTypeClass(type)}" data-project-task-type-chip="${esc(type)}" type="button">${esc(type)}</button>`).join("")}
              </div>
            </label>
            <div class="task-field">
              <span>시간</span>
              <div class="task-time-range">
                <div id="projectTaskStartTime"></div>
                <span>~</span>
                <div id="projectTaskEndTime"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="task-option-row">
          <label class="calendar-toggle task-all-day">
            <input id="projectTaskAllDay" type="checkbox" ${detailTaskDraft.allDay !== false ? "checked" : ""} ${editable ? "" : "disabled"} />
            <span>종일</span>
          </label>
          <label class="calendar-toggle task-no-due">
            <input id="projectTaskNoDueDate" type="checkbox" ${detailTaskDraft.noDueDate ? "checked" : ""} ${editable ? "" : "disabled"} />
            <span>마감일 없음</span>
          </label>
          <label class="calendar-toggle task-calendar-toggle">
            <input id="projectTaskCalendar" type="checkbox" ${detailTaskDraft.calendar ? "checked" : ""} ${editable ? "" : "disabled"} />
            <span>캘린더 등록</span>
          </label>
        </div>
        <label class="task-field task-detail-field">
          <span>세부내용 (선택)</span>
          <textarea id="projectTaskDetail" placeholder="세부내용을 입력하세요" ${editable ? "" : "disabled"}>${esc(detailTaskDraft.detail || "")}</textarea>
        </label>
        <div class="task-form-footer">
          <button id="addProjectTaskBtn" class="pill primary" type="button" ${editable ? "" : "disabled"}>${editing ? "수정 저장" : "+ 할 일 등록"}</button>
        </div>
      </div>
    </div>
    <div class="record-tools task-sort-tools">
      <span>정렬</span>
      <button class="record-control ${detailTaskSort === "created" ? "active" : ""}" data-project-task-sort="created" type="button">등록순</button>
      <button class="record-control ${detailTaskSort === "due" ? "active" : ""}" data-project-task-sort="due" type="button">완료일 순</button>
    </div>
    <div class="task-list">
      ${
        tasks.length
          ? tasks
              .map((task) => `
                <article class="task-row ${highlightedProjectTaskId === task.id ? "is-highlighted" : ""}">
                  <label class="task-main">
                    <input type="checkbox" data-project-task-check="${esc(task.id)}" ${task.done ? "checked" : ""} ${canManageTask(task) ? "" : "disabled"} />
                    <span>
                      <h3>${task.type ? `<span class="task-type-badge ${taskTypeClass(task.type)}">${esc(task.type)}</span>` : ""}${esc(task.text)}</h3>
                      ${task.detail ? `<p class="task-detail-text">${esc(task.detail)}</p>` : ""}
                      <small>담당 ${esc(taskOwnersLabel(task))} · 완료일 ${esc(task.noDueDate || !task.dueDate ? "없음" : task.dueDate)} · ${esc(formatTaskTime(task))}</small>
                    </span>
                  </label>
                  <div class="task-row-actions">
                    ${task.done ? '<span class="badge ok">완료</span>' : dueBadge(task.dueDate)}
                    <button class="record-control" data-edit-project-task="${esc(task.id)}" ${canManageTask(task) ? "" : "disabled"} type="button">수정</button>
                    <button class="delete-btn" data-delete-project-task="${esc(task.id)}" ${canManageTask(task) ? "" : "disabled"} aria-label="삭제">×</button>
                  </div>
                </article>
              `)
              .join("")
          : '<div class="empty">이 영상 프로젝트에 등록된 할 일이 없습니다.</div>'
      }
    </div>
  `;

  renderMultiDropdown({
    target: $("#projectTaskOwnerDropdown"),
    values: detailTaskDraft.owners,
    options: ownerOptions(),
    placeholder: "담당자 선택",
    formatOptionLabel: ownerOptionLabel,
    disabled: !editable,
    onChange: (owners) => {
      syncProjectTaskDraftInputs();
      detailTaskDraft.owners = owners;
      renderProjectTasks(project);
    }
  });
  renderDateButton({
    target: $("#projectTaskDueDatePicker"),
    value: detailTaskDraft.dueDate,
    disabled: detailTaskDraft.noDueDate || !editable,
    onSelect: (date) => {
      syncProjectTaskDraftInputs();
      detailTaskDraft.dueDate = date || dateKey(new Date());
      renderProjectTasks(project);
    }
  });
  renderTimeButton({
    target: $("#projectTaskStartTime"),
    value: detailTaskDraft.startTime,
    disabled: detailTaskDraft.noDueDate || detailTaskDraft.allDay !== false || !editable,
    onSelect: (time) => {
      syncProjectTaskDraftInputs();
      detailTaskDraft.startTime = time;
      normalizeTaskTimeRange(detailTaskDraft);
      renderProjectTasks(project);
    }
  });
  renderTimeButton({
    target: $("#projectTaskEndTime"),
    value: detailTaskDraft.endTime,
    disabled: detailTaskDraft.noDueDate || detailTaskDraft.allDay !== false || !editable,
    onSelect: (time) => {
      syncProjectTaskDraftInputs();
      detailTaskDraft.endTime = time;
      normalizeTaskTimeRange(detailTaskDraft);
      renderProjectTasks(project);
    }
  });

  $("#projectTaskNoDueDate")?.addEventListener("change", () => {
    syncProjectTaskDraftInputs();
    renderProjectTasks(project);
  });
  $("#projectTaskAllDay")?.addEventListener("change", () => {
    syncProjectTaskDraftInputs();
    renderProjectTasks(project);
  });
}

function addProjectTask() {
  const project = state.projects.find((item) => item.id === activeProjectId);
  if (!project || !canEditProject(project)) return;
  syncProjectTaskDraftInputs();
  normalizeTaskTimeRange(detailTaskDraft);
  const text = String(detailTaskDraft.title || "").trim();
  if (!text) return;
  const taskPayload = {
    projectId: project.id,
    text,
    detail: String(detailTaskDraft.detail || "").trim(),
    type: detailTaskDraft.type || "",
    owners: Array.isArray(detailTaskDraft.owners) ? detailTaskDraft.owners : [],
    owner: Array.isArray(detailTaskDraft.owners) ? detailTaskDraft.owners[0] || "" : "",
    dueDate: detailTaskDraft.noDueDate ? "" : (detailTaskDraft.dueDate || dateKey(new Date())),
    noDueDate: Boolean(detailTaskDraft.noDueDate),
    allDay: detailTaskDraft.allDay !== false,
    startTime: detailTaskDraft.startTime || "09:00",
    endTime: detailTaskDraft.endTime || "10:00",
    calendar: Boolean(detailTaskDraft.calendar)
  };
  if (detailTaskDraft.editingTaskId) {
    const task = state.tasks.find((item) => item.id === detailTaskDraft.editingTaskId);
    if (!task || !canManageTask(task)) return;
    Object.assign(task, taskPayload);
    notifyOwners(taskPayload.owners, `할 일이 수정되었습니다: ${text}`, { type: "project-task", projectId: project.id, taskId: task.id });
    showToast("할 일이 수정되었습니다.");
  } else {
    const newTask = {
      id: makeId(),
      createdAt: new Date().toISOString(),
      done: false,
      ...taskPayload
    };
    state.tasks.push(newTask);
    notifyOwners(taskPayload.owners, `할 일이 추가되었습니다: ${text}`, { type: "project-task", projectId: project.id, taskId: newTask.id });
    showToast("할 일이 추가되었습니다.");
  }
  resetProjectTaskDraft(project);
  detailTaskComposerOpen = false;
  saveState();
  renderAll();
  renderProjectDetail();
}

function editProjectTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || !canManageTask(task)) {
    showToast("담당자 또는 관리자만 수정할 수 있습니다.");
    return;
  }
  detailTaskDraft = {
    title: task.text || "",
    detail: task.detail || "",
    type: task.type || "",
    owners: taskOwners(task),
    dueDate: task.noDueDate ? "" : (task.dueDate || dateKey(new Date())),
    noDueDate: Boolean(task.noDueDate || !task.dueDate),
    allDay: task.allDay !== false,
    startTime: task.startTime || "09:00",
    endTime: task.endTime || "10:00",
    calendar: Boolean(task.calendar),
    editingTaskId: task.id
  };
  detailTaskComposerOpen = true;
  const project = state.projects.find((item) => item.id === activeProjectId);
  if (project) renderProjectTasks(project);
}

function addManagementRecord() {
  const project = state.projects.find((item) => item.id === activeProjectId);
  const textarea = $("#recordBody");
  if (!project || !textarea) return;
  if (!canEditProject(project)) {
    showToast("담당자 또는 관리자만 기록할 수 있습니다.");
    return;
  }
  const body = textarea.value.trim();
  if (!body) return;
  project.records = Array.isArray(project.records) ? project.records : [];
  const user = currentUser();
  const authorName = currentRecordAuthorName(projectOwners(project));
  if (editingRecordId) {
    const record = project.records.find((item) => item.id === editingRecordId);
    if (record) {
      record.body = body;
      record.updatedAt = new Date().toISOString();
      record.author = authorName || record.author || "관리자";
    }
    editingRecordId = null;
    notifyOwners(projectOwners(project), `관리기록이 수정되었습니다: ${project.title}`, { type: "project-record", projectId: project.id });
    saveState();
    renderProjectDetail();
    showToast("관리기록이 수정되었습니다.");
    return;
  }
  project.records.push({
    id: makeId(),
    author: authorName,
    body,
    createdAt: new Date().toISOString()
  });
  notifyOwners(projectOwners(project), `관리기록이 등록되었습니다: ${project.title}`, { type: "project-record", projectId: project.id });
  saveState();
  renderProjectDetail();
  showToast("관리기록이 등록되었습니다.");
}

function deleteManagementRecord(recordId) {
  const project = state.projects.find((item) => item.id === activeProjectId);
  if (!project) return;
  if (!canEditProject(project)) {
    showToast("담당자 또는 관리자만 삭제할 수 있습니다.");
    return;
  }
  project.records = (project.records || []).filter((record) => record.id !== recordId);
  if (editingRecordId === recordId) editingRecordId = null;
  saveState();
  renderProjectDetail();
  showToast("관리기록이 삭제되었습니다.");
}

function openProjectDetail(projectId) {
  if (!state.projects.some((project) => project.id === projectId)) return;
  activeProjectId = projectId;
  editingRecordId = null;
  detailTaskComposerOpen = false;
  activeDetailTab = "basic";
  renderProjectDetail();
  $("#projectDetail").classList.add("open");
  $("#projectDetail").setAttribute("aria-hidden", "false");
}

function closeProjectDetail() {
  $("#projectDetail").classList.remove("open");
  $("#projectDetail").setAttribute("aria-hidden", "true");
  activeProjectId = null;
  renderAll();
}

function updateActiveProject(field, value, rerender = true) {
  const project = state.projects.find((item) => item.id === activeProjectId);
  if (!project) return;
  if (!canEditProject(project)) {
    showToast("담당자 또는 관리자만 수정할 수 있습니다.");
    renderProjectDetail();
    return;
  }
  const previousOwners = field === "owners" ? projectOwners(project) : [];
  project[field] = ["budget", "spent", "progress"].includes(field) ? Number(value || 0) : value;
  if (field === "owners") {
    notifyOwners(uniqueValues([...(Array.isArray(value) ? value : []), ...previousOwners]), `담당 프로젝트가 변경되었습니다: ${project.title}`, { type: "project", projectId: project.id });
  }
  if (field === "status" && value === "납품 완료") project.progress = 100;
  saveState();
  if (rerender) {
    renderAll();
    renderProjectDetail();
  }
}

function addProject() {
  const today = dateKey(new Date());
  const user = currentUser();
  const project = {
    id: makeId(),
    title: "새 영상 프로젝트",
    method: "",
    type: "",
    owners: [],
    client: "",
    note: "",
    status: "",
    kickoffDate: today,
    shootDate: today,
    firstEditDate: today,
    finalDate: today,
    progress: 0,
    budget: 0,
    spent: 0,
    memo: "",
    records: []
  };
  state.projects.unshift(project);
  saveState();
  renderAll();
  openProjectDetail(project.id);
}

function deleteProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!canEditProject(project)) {
    showToast("담당자 또는 관리자만 삭제할 수 있습니다.");
    return;
  }
  state.projects = state.projects.filter((project) => project.id !== projectId);
  state.tasks = state.tasks.filter((task) => task.projectId !== projectId);
  state.schedules = state.schedules.filter((schedule) => schedule.projectId !== projectId);
  saveState();
  closeProjectDetail();
}

function syncTimeControls(prefix, draft) {
  const allDayInput = $(`#${prefix}AllDay`);
  const startInput = $(`#${prefix}StartTime`);
  const endInput = $(`#${prefix}EndTime`);
  const startPicker = $(`#${prefix}StartTimePicker`);
  const endPicker = $(`#${prefix}EndTimePicker`);
  if (!allDayInput) return;
  allDayInput.checked = draft.allDay !== false;
  if (startInput && endInput) {
    startInput.value = draft.startTime || "09:00";
    endInput.value = draft.endTime || "10:00";
    startInput.disabled = allDayInput.checked;
    endInput.disabled = allDayInput.checked;
  }
  if (startPicker && endPicker) {
    renderTimeButton({
      target: startPicker,
      value: draft.startTime || "09:00",
      disabled: allDayInput.checked,
      onSelect: (time) => {
        draft.startTime = time;
        normalizeTaskTimeRange(draft);
        syncTimeControls(prefix, draft);
      }
    });
    renderTimeButton({
      target: endPicker,
      value: draft.endTime || "10:00",
      disabled: allDayInput.checked,
      onSelect: (time) => {
        draft.endTime = time;
        normalizeTaskTimeRange(draft);
        syncTimeControls(prefix, draft);
      }
    });
  }
}

function openScheduleModal(date) {
  scheduleDraft = { editingScheduleId: null, owners: ownerOptions()[0] ? [ownerOptions()[0]] : [], date, allDay: true, startTime: "09:00", endTime: "10:00" };
  $("#scheduleTitle").value = "";
  $("#scheduleLocation").value = "";
  $("#scheduleMemo").value = "";
  $("#scheduleForm .section-head h2").textContent = "일정 등록";
  $("#scheduleForm .pill.primary").textContent = "일정 등록";
  renderScheduleModalControls();
  $("#scheduleModal").classList.add("open");
  $("#scheduleModal").setAttribute("aria-hidden", "false");
}

function closeScheduleModal() {
  $("#scheduleModal").classList.remove("open");
  $("#scheduleModal").setAttribute("aria-hidden", "true");
}

function openScheduleEditModal(scheduleId) {
  const schedule = state.schedules.find((item) => item.id === scheduleId);
  if (!schedule) return;
  scheduleDraft = {
    editingScheduleId: schedule.id,
    owners: Array.isArray(schedule.owners) ? schedule.owners : [],
    date: schedule.date || dateKey(new Date()),
    allDay: schedule.allDay !== false,
    startTime: schedule.startTime || "09:00",
    endTime: schedule.endTime || "10:00"
  };
  $("#scheduleTitle").value = schedule.title || "";
  $("#scheduleLocation").value = schedule.location || "";
  $("#scheduleMemo").value = schedule.memo || "";
  $("#scheduleForm .section-head h2").textContent = "일정 수정";
  $("#scheduleForm .pill.primary").textContent = "수정 저장";
  closeStaffEventDetail();
  renderScheduleModalControls();
  $("#scheduleModal").classList.add("open");
  $("#scheduleModal").setAttribute("aria-hidden", "false");
}

function makeDefaultStaffRow(index = 0) {
  return {
    id: makeId(),
    type: "",
    owner: "",
    memo: ""
  };
}

function ensureStaffScheduleRows() {
  if (!Array.isArray(staffScheduleDraft.staffRows) || !staffScheduleDraft.staffRows.length) {
    staffScheduleDraft.staffRows = [makeDefaultStaffRow(0)];
  }
  staffScheduleDraft.staffRows = staffScheduleDraft.staffRows.slice(0, 6).map((row, index) => ({
    id: row.id || makeId(),
    type: row.type || "",
    owner: row.owner || "",
    memo: row.memo || ""
  }));
}

function openStaffScheduleModal(date, preset = {}) {
  staffScheduleDraft = {
    title: "",
    room: "",
    type: "",
    owner: "",
    trainingType: "",
    date,
    allDay: preset.allDay ?? false,
    startTime: preset.startTime || "09:00",
    endTime: preset.endTime || "10:00",
    repeatEnabled: false,
    repeatCount: 8,
    repeatDays: [],
    repeatEndMode: "none",
    repeatUntil: date,
    staffRows: preset.staffRows || [makeDefaultStaffRow(0)]
  };
  $("#staffScheduleTitle").value = "";
  $("#staffScheduleMemo").value = "";
  $("#staffScheduleForm .pill.primary").textContent = "예약 등록";
  ensureStaffScheduleRows();
  renderStaffScheduleModalControls();
  $("#staffScheduleModal").classList.add("open");
  $("#staffScheduleModal").setAttribute("aria-hidden", "false");
}

function closeStaffScheduleModal() {
  delete staffScheduleDraft.editingStaffEventId;
  $("#staffScheduleModal").classList.remove("open");
  $("#staffScheduleModal").setAttribute("aria-hidden", "true");
}

function openStaffScheduleEditModal(staffEventId) {
  const event = state.staffEvents.find((item) => item.id === staffEventId);
  if (!event) return;
  staffScheduleDraft = {
    title: event.title || "",
    room: event.room || "",
    type: event.type || "",
    owner: event.owner || "",
    trainingType: event.trainingType || "",
    date: event.date || dateKey(new Date()),
    allDay: event.allDay !== false,
    startTime: event.startTime || "09:00",
    endTime: event.endTime || "10:00",
    repeatEnabled: false,
    repeatCount: 8,
    repeatDays: [],
    repeatEndMode: "none",
    repeatUntil: event.date || dateKey(new Date()),
    staffRows: Array.isArray(event.staffRows) && event.staffRows.length ? structuredClone(event.staffRows) : [{ id: makeId(), type: event.type || "", owner: event.owner || "", memo: "" }],
    editingStaffEventId: staffEventId
  };
  $("#staffScheduleTitle").value = staffScheduleDraft.title;
  $("#staffScheduleMemo").value = event.memo || "";
  renderStaffScheduleModalControls();
  $("#staffScheduleForm .pill.primary").textContent = "예약 수정";
  $("#staffScheduleModal").classList.add("open");
  $("#staffScheduleModal").setAttribute("aria-hidden", "false");
}

function renderStaffScheduleRows() {
  ensureStaffScheduleRows();
  const target = $("#staffScheduleRows");
  if (!target) return;
  target.innerHTML = staffScheduleDraft.staffRows.map((row, index) => `
    <div class="studio-staff-row" draggable="true" data-staff-row="${esc(row.id)}">
      <span class="studio-row-drag" aria-hidden="true">⋮⋮</span>
      <span class="studio-row-number">${index + 1}</span>
      <div id="staffScheduleRowType${index}"></div>
      <div id="staffScheduleRowOwner${index}"></div>
      <input data-staff-row-memo="${esc(row.id)}" value="${esc(row.memo || "")}" placeholder="역할 또는 메모" />
      <button class="studio-row-delete" data-delete-staff-row="${esc(row.id)}" type="button">⌫</button>
    </div>
  `).join("");
  staffScheduleDraft.staffRows.forEach((row, index) => {
    renderDropdown({
      target: $(`#staffScheduleRowType${index}`),
      value: row.type,
      options: staffTypeOptions(),
      placeholder: "스탭 종류",
      onSelect: (type) => {
        row.type = type;
        renderStaffScheduleModalControls();
      }
    });
    renderDropdown({
      target: $(`#staffScheduleRowOwner${index}`),
      value: row.owner,
      options: ownerOptions(),
      placeholder: "담당자",
      formatOptionLabel: ownerOptionLabel,
      onSelect: (owner) => {
        row.owner = owner;
        if (index === 0) staffScheduleDraft.owner = owner;
        renderStaffScheduleModalControls();
      }
    });
  });
}

function renderStaffScheduleModalControls() {
  ensureStaffScheduleRows();
  renderDropdown({
    target: $("#staffScheduleRoomDropdown"),
    value: staffScheduleDraft.room,
    options: studioRoomOptions(),
    placeholder: "장소 선택",
    onSelect: (room) => {
      staffScheduleDraft.room = room;
      renderStaffScheduleModalControls();
    }
  });
  renderDropdown({
    target: $("#staffScheduleTrainingTypeDropdown"),
    value: staffScheduleDraft.trainingType,
    options: trainingTypeOptions(),
    placeholder: "교육 유형 선택",
    onSelect: (trainingType) => {
      staffScheduleDraft.trainingType = trainingType;
      renderStaffScheduleModalControls();
    }
  });
  renderDateButton({
    target: $("#staffScheduleDatePicker"),
    value: staffScheduleDraft.date,
    onSelect: (date) => {
      staffScheduleDraft.date = date || dateKey(new Date());
      renderStaffScheduleModalControls();
    }
  });
  syncTimeControls("staffSchedule", staffScheduleDraft);
  renderStaffScheduleRows();
  const memo = $("#staffScheduleMemo");
  const count = $("#staffScheduleMemoCount");
  if (count && memo) count.textContent = `${memo.value.length} / 200`;
  const repeatEnabled = $("#staffScheduleRepeatEnabled");
  const repeatControls = $("#staffScheduleRepeatControls");
  const repeatLabel = $(".studio-repeat-toggle b");
  const repeatCount = $("#staffScheduleRepeatCount");
  if (repeatEnabled) repeatEnabled.checked = Boolean(staffScheduleDraft.repeatEnabled);
  if (repeatControls) {
    repeatControls.classList.toggle("open", Boolean(staffScheduleDraft.repeatEnabled));
    repeatControls.classList.toggle("disabled", !staffScheduleDraft.repeatEnabled);
    repeatControls.querySelectorAll("button, input").forEach((control) => {
      control.disabled = !staffScheduleDraft.repeatEnabled;
    });
  }
  if (repeatLabel) repeatLabel.textContent = staffScheduleDraft.repeatEnabled ? "반복 사용" : "반복 안함";
  if (repeatCount) repeatCount.value = String(staffScheduleDraft.repeatCount || 8);
  $$("[data-staff-repeat-day]").forEach((button) => {
    button.classList.toggle("active", (staffScheduleDraft.repeatDays || []).includes(Number(button.dataset.staffRepeatDay)));
  });
}

function renderScheduleModalControls() {
  renderMultiDropdown({
    target: $("#scheduleOwnersDropdown"),
    values: scheduleDraft.owners,
    options: ownerOptions(),
    placeholder: "담당자 선택",
    formatOptionLabel: ownerOptionLabel,
    onChange: (owners) => {
      scheduleDraft.owners = owners;
    }
  });
  renderDateButton({
    target: $("#scheduleDatePicker"),
    value: scheduleDraft.date,
    onSelect: (date) => {
      scheduleDraft.date = date || dateKey(new Date());
      renderScheduleModalControls();
    }
  });
  syncTimeControls("schedule", scheduleDraft);
}

function addSchedule() {
  if (!scheduleDraft.date) return;
  const scheduleData = {
    title: $("#scheduleTitle").value.trim() || "새 일정",
    owners: scheduleDraft.owners || [],
    location: $("#scheduleLocation").value.trim(),
    memo: $("#scheduleMemo").value.trim(),
    date: scheduleDraft.date,
    allDay: scheduleDraft.allDay !== false,
    startTime: scheduleDraft.startTime || "09:00",
    endTime: scheduleDraft.endTime || "10:00"
  };
  if (scheduleDraft.editingScheduleId) {
    const schedule = state.schedules.find((item) => item.id === scheduleDraft.editingScheduleId);
    if (schedule) Object.assign(schedule, scheduleData);
  } else {
    state.schedules.push({ id: makeId(), ...scheduleData });
  }
  saveState();
  closeScheduleModal();
  renderAll();
}

function openScheduleEventDetail(scheduleId) {
  const schedule = state.schedules.find((item) => item.id === scheduleId);
  if (!schedule) return;
  activeScheduleEventId = scheduleId;
  activeStaffEventId = null;
  $("#editScheduleEventBtn").hidden = false;
  $("#staffEventDetailContent").innerHTML = `
    <div class="event-detail-row">
      <span>구분</span>
      <strong>간단 일정</strong>
    </div>
    <div class="event-detail-row">
      <span>일정명</span>
      <strong>${esc(schedule.title || "새 일정")}</strong>
    </div>
    <div class="event-detail-row">
      <span>날짜</span>
      <strong>${formatDate(schedule.date)}</strong>
    </div>
    <div class="event-detail-row">
      <span>시간</span>
      <strong>${esc(formatTimeRange(schedule))}</strong>
    </div>
    <div class="event-detail-row">
      <span>담당자</span>
      <strong>${esc(ownerNames(schedule.owners || []).join(", ") || "-")}</strong>
    </div>
    <div class="event-detail-row">
      <span>장소</span>
      <strong>${esc(schedule.location || "-")}</strong>
    </div>
    <div class="event-memo">
      <span>내용</span>
      <p>${esc(schedule.memo || "등록된 내용이 없습니다.")}</p>
    </div>
  `;
  $("#staffEventDetailModal").classList.add("open");
  $("#staffEventDetailModal").setAttribute("aria-hidden", "false");
}

function addStaffSchedule() {
  if (!staffScheduleDraft.date) return;
  ensureStaffScheduleRows();
  const staffRows = staffScheduleDraft.staffRows.map((row) => ({
    type: row.type || "",
    owner: row.owner || "",
    memo: row.memo || ""
  }));
  const owners = [...new Set(staffRows.map((row) => row.owner).filter((owner) => !isUnassignedStudioOwner(owner)))];
  const title = $("#staffScheduleTitle").value.trim() || staffScheduleDraft.trainingType || "방송실 예약";
  const eventData = {
    title,
    room: staffScheduleDraft.room || "",
    type: staffRows[0]?.type || staffScheduleDraft.type || "",
    owner: owners[0] || staffScheduleDraft.owner || "",
    owners,
    staffRows,
    trainingType: staffScheduleDraft.trainingType || "",
    allDay: staffScheduleDraft.allDay !== false,
    startTime: staffScheduleDraft.startTime || "09:00",
    endTime: staffScheduleDraft.endTime || "10:00",
    memo: $("#staffScheduleMemo").value.trim()
  };
  if (staffScheduleDraft.editingStaffEventId) {
    const event = state.staffEvents.find((item) => item.id === staffScheduleDraft.editingStaffEventId);
    if (event) Object.assign(event, eventData, { date: staffScheduleDraft.date || event.date });
    saveState();
    closeStaffScheduleModal();
    renderAll();
    return;
  }
  const baseDate = new Date(`${staffScheduleDraft.date}T00:00:00`);
  const repeatDays = (staffScheduleDraft.repeatDays || []).length ? staffScheduleDraft.repeatDays : [baseDate.getDay()];
  const maxRepeatCount = Math.max(1, Math.min(52, Number(staffScheduleDraft.repeatCount) || 1));
  const seriesId = staffScheduleDraft.repeatEnabled ? makeId() : "";
  const dates = [];
  if (!staffScheduleDraft.repeatEnabled) {
    dates.push(baseDate);
  } else {
    const cursor = new Date(baseDate);
    const limit = new Date(baseDate);
    limit.setDate(baseDate.getDate() + 370);
    while (dates.length < maxRepeatCount && cursor <= limit) {
      if (repeatDays.includes(cursor.getDay()) && cursor >= baseDate) {
        dates.push(new Date(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  dates.forEach((nextDate) => {
    state.staffEvents.push({
      id: makeId(),
      ...eventData,
      seriesId,
      date: dateKey(nextDate),
    });
  });
  saveState();
  closeStaffScheduleModal();
  renderAll();
}

function normalizeStaffEventRows(event) {
  if (!Array.isArray(event.staffRows) || !event.staffRows.length) {
    event.staffRows = [{ id: makeId(), type: event.type || "", owner: event.owner || "", memo: "" }];
  }
  event.staffRows = event.staffRows.slice(0, 6).map((row) => ({
    id: row.id || makeId(),
    type: row.type || "",
    owner: row.owner || "",
    memo: row.memo || ""
  }));
  return event.staffRows;
}

function syncStaffEventSummary(event) {
  const rows = normalizeStaffEventRows(event);
  const owners = [...new Set(rows.map((row) => row.owner).filter((owner) => !isUnassignedStudioOwner(owner)))];
  event.owners = owners;
  event.owner = owners[0] || "";
  event.type = rows[0]?.type || event.type || "";
}

function renderStaffEventDetailStaffRows(event) {
  normalizeStaffEventRows(event);
  const target = $("#staffEventDetailStaffRows");
  if (!target) return;
  target.innerHTML = event.staffRows.map((row, index) => `
    <div class="event-detail-staff-row" data-detail-staff-row="${esc(row.id)}">
      <span>${index + 1}</span>
      <div id="staffEventDetailRowType${index}"></div>
      <div id="staffEventDetailRowOwner${index}"></div>
      <input data-detail-staff-row-memo="${esc(row.id)}" value="${esc(row.memo || "")}" placeholder="역할 또는 메모" />
      <button class="studio-row-delete" data-delete-detail-staff-row="${esc(row.id)}" type="button">⌫</button>
    </div>
  `).join("");
  event.staffRows.forEach((row, index) => {
    renderDropdown({
      target: $(`#staffEventDetailRowType${index}`),
      value: row.type,
      options: staffTypeOptions(),
      placeholder: "스탭 종류",
      onSelect: (type) => {
        row.type = type;
        syncStaffEventSummary(event);
        saveState();
        renderAll();
        renderStaffEventDetailStaffRows(event);
      }
    });
    renderDropdown({
      target: $(`#staffEventDetailRowOwner${index}`),
      value: row.owner,
      options: ownerOptions(),
      placeholder: "담당자",
      formatOptionLabel: ownerOptionLabel,
      onSelect: (owner) => {
        row.owner = owner;
        syncStaffEventSummary(event);
        saveState();
        renderAll();
        renderStaffEventDetailStaffRows(event);
      }
    });
  });
}

function openStaffEventDetail(staffEventId) {
  const event = state.staffEvents.find((item) => item.id === staffEventId);
  if (!event) return;
  normalizeStaffEventRows(event);
  activeStaffEventId = staffEventId;
  activeScheduleEventId = null;
  $("#editScheduleEventBtn").hidden = false;
  $("#staffEventDetailContent").innerHTML = `
    <div class="event-detail-row">
      <span>일정 제목</span>
      <strong>${esc(staffReservationTitle(event))}</strong>
    </div>
    <div class="event-detail-row">
      <span>교육 유형</span>
      <strong>${esc(event.trainingType || "선택")}</strong>
    </div>
    <div class="event-detail-row">
      <span>장소</span>
      <strong>${esc(event.room || "-")}</strong>
    </div>
    <div class="event-detail-row">
      <span>날짜시간</span>
      <strong>${formatDate(event.date)} ${esc(formatTimeRange(event))}</strong>
    </div>
    <div class="event-detail-staff">
      <div class="event-detail-staff-head">
        <span>스탭명단</span>
        <button class="pill primary small" data-add-detail-staff-row type="button">+ 스탭 추가</button>
      </div>
      <div class="event-detail-staff-table-head">
        <span></span>
        <span>스탭 종류</span>
        <span>담당자</span>
        <span>역할/메모</span>
        <span>관리</span>
      </div>
      <div id="staffEventDetailStaffRows"></div>
    </div>
    <div class="event-memo">
      <span>메모</span>
      <p>${esc(event.memo || "등록된 메모가 없습니다.")}</p>
    </div>
  `;
  renderStaffEventDetailStaffRows(event);
  $("#staffEventDetailModal").classList.add("open");
  $("#staffEventDetailModal").setAttribute("aria-hidden", "false");
}

function closeStaffEventDetail() {
  activeStaffEventId = null;
  activeScheduleEventId = null;
  $("#staffEventDetailModal").classList.remove("open");
  $("#staffEventDetailModal").setAttribute("aria-hidden", "true");
}

function deleteScheduleEvent(scheduleId) {
  state.schedules = state.schedules.filter((schedule) => schedule.id !== scheduleId);
  saveState();
  closeStaffEventDetail();
  renderAll();
}

function deleteStaffEvent(staffEventId) {
  state.staffEvents = state.staffEvents.filter((event) => event.id !== staffEventId);
  saveState();
  closeStaffEventDetail();
  renderAll();
}

function deleteStaffEventSeries(staffEventId) {
  const event = state.staffEvents.find((item) => item.id === staffEventId);
  if (!event?.seriesId) {
    deleteStaffEvent(staffEventId);
    return;
  }
  state.staffEvents = state.staffEvents.filter((item) => item.seriesId !== event.seriesId);
  saveState();
  closeRepeatDeleteModal();
  closeStaffEventDetail();
  renderAll();
}

function openRepeatDeleteModal(staffEventId) {
  pendingRepeatDeleteEventId = staffEventId;
  const modal = $("#repeatDeleteModal");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function closeRepeatDeleteModal() {
  pendingRepeatDeleteEventId = null;
  const modal = $("#repeatDeleteModal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function openRecurringTrainingModal() {
  recurringTrainingDraft = { room: studioRoomOptions()[0] || "", type: staffTypeOptions().includes("정기교육") ? "정기교육" : staffTypeOptions()[0] || "", owner: "", trainingType: trainingTypeOptions()[0] || "", startDate: dateKey(new Date()), repeat: "매주", count: 8, allDay: true, startTime: "09:00", endTime: "10:00" };
  $("#recurringTrainingCount").value = "8";
  $("#recurringTrainingMemo").value = "";
  renderRecurringTrainingControls();
  $("#recurringTrainingModal").classList.add("open");
  $("#recurringTrainingModal").setAttribute("aria-hidden", "false");
}

function closeRecurringTrainingModal() {
  $("#recurringTrainingModal").classList.remove("open");
  $("#recurringTrainingModal").setAttribute("aria-hidden", "true");
}

function renderRecurringTrainingControls() {
  renderDropdown({
    target: $("#recurringTrainingRoomDropdown"),
    value: recurringTrainingDraft.room,
    options: studioRoomOptions(),
    placeholder: "장소 선택",
    onSelect: (room) => {
      recurringTrainingDraft.room = room;
      renderRecurringTrainingControls();
    }
  });
  renderDropdown({
    target: $("#recurringTrainingStaffTypeDropdown"),
    value: recurringTrainingDraft.type,
    options: staffTypeOptions(),
    placeholder: "스탭 종류 선택",
    onSelect: (type) => {
      recurringTrainingDraft.type = type;
      renderRecurringTrainingControls();
    }
  });
  renderDropdown({
    target: $("#recurringTrainingOwnerDropdown"),
    value: recurringTrainingDraft.owner,
    options: ownerOptions(),
    placeholder: "담당자 선택",
    formatOptionLabel: ownerOptionLabel,
    onSelect: (owner) => {
      recurringTrainingDraft.owner = owner;
      renderRecurringTrainingControls();
    }
  });
  renderDropdown({
    target: $("#recurringTrainingTypeDropdown"),
    value: recurringTrainingDraft.trainingType,
    options: trainingTypeOptions(),
    placeholder: "교육 유형 선택",
    onSelect: (trainingType) => {
      recurringTrainingDraft.trainingType = trainingType;
      renderRecurringTrainingControls();
    }
  });
  renderDateButton({
    target: $("#recurringTrainingStartDatePicker"),
    value: recurringTrainingDraft.startDate,
    onSelect: (date) => {
      recurringTrainingDraft.startDate = date || dateKey(new Date());
      renderRecurringTrainingControls();
    }
  });
  renderDropdown({
    target: $("#recurringTrainingRepeatDropdown"),
    value: recurringTrainingDraft.repeat,
    options: ["매주", "격주", "매월"],
    placeholder: "반복 방식",
    onSelect: (repeat) => {
      recurringTrainingDraft.repeat = repeat;
      renderRecurringTrainingControls();
    }
  });
  syncTimeControls("recurringTraining", recurringTrainingDraft);
}

function addRecurringTraining() {
  const title = recurringTrainingDraft.trainingType || "정기교육";
  const count = Math.max(1, Math.min(52, Number($("#recurringTrainingCount").value) || 8));
  const seriesId = makeId();
  const series = {
    id: seriesId,
    title,
    room: recurringTrainingDraft.room || studioRoomOptions()[0] || "",
    type: recurringTrainingDraft.type || staffTypeOptions()[0] || "정기교육",
    owner: recurringTrainingDraft.owner || "",
    owners: [recurringTrainingDraft.owner || ""].filter(Boolean),
    trainingType: recurringTrainingDraft.trainingType || title,
    startDate: recurringTrainingDraft.startDate,
    repeat: recurringTrainingDraft.repeat || "매주",
    count,
    allDay: recurringTrainingDraft.allDay !== false,
    startTime: recurringTrainingDraft.startTime || "09:00",
    endTime: recurringTrainingDraft.endTime || "10:00",
    memo: $("#recurringTrainingMemo").value.trim(),
    createdAt: new Date().toISOString()
  };
  state.recurringTrainings.push(series);
  Array.from({ length: count }, (_, index) => {
    state.staffEvents.push({
      id: makeId(),
      seriesId,
      title,
      room: series.room,
      type: series.type,
      owner: series.owner,
      owners: series.owners,
      trainingType: series.trainingType,
      date: shiftDate(series.startDate, series.repeat, index),
      allDay: series.allDay,
      startTime: series.startTime,
      endTime: series.endTime,
      memo: series.memo
    });
  });
  saveState();
  closeRecurringTrainingModal();
  renderAll();
  showToast("정기교육 반복 일정이 등록되었습니다.");
}

function openRecurringTrainingManageModal() {
  renderRecurringTrainingList();
  $("#recurringTrainingManageModal").classList.add("open");
  $("#recurringTrainingManageModal").setAttribute("aria-hidden", "false");
}

function closeRecurringTrainingManageModal() {
  $("#recurringTrainingManageModal").classList.remove("open");
  $("#recurringTrainingManageModal").setAttribute("aria-hidden", "true");
}

function renderRecurringTrainingList() {
  const list = $("#recurringTrainingList");
  if (!state.recurringTrainings.length) {
    list.innerHTML = `<div class="empty-state">등록된 정기교육이 없습니다.</div>`;
    return;
  }
  list.innerHTML = state.recurringTrainings.map((series) => `
    <article class="training-card">
      <div>
        <strong>${esc(series.title)}</strong>
        <span>${esc(series.room || "-")} · ${formatDate(series.startDate)} 시작 · ${esc(series.repeat)} · ${series.count}회 · ${esc(formatTimeRange(series))}</span>
        <small>${esc(series.type || "정기교육")} · ${esc(staffEventOwnerLabel(series))}</small>
      </div>
      <button class="pill danger-pill" type="button" data-delete-training-series="${esc(series.id)}">삭제</button>
    </article>
  `).join("");
}

function deleteRecurringTraining(seriesId) {
  state.recurringTrainings = state.recurringTrainings.filter((series) => series.id !== seriesId);
  state.staffEvents = state.staffEvents.filter((event) => event.seriesId !== seriesId);
  saveState();
  renderRecurringTrainingList();
  renderAll();
  showToast("정기교육 반복 일정이 삭제되었습니다.");
}

function studioWeekStart(date = studioWeekDate) {
  const target = new Date(date);
  const day = target.getDay();
  const diff = -day;
  target.setDate(target.getDate() + diff);
  target.setHours(0, 0, 0, 0);
  return target;
}

function studioWeekDates() {
  const start = studioWeekStart();
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function studioWeekRangeLabel() {
  if (studioViewMode === "month") {
    return `${studioWeekDate.getFullYear()}년 ${studioWeekDate.getMonth() + 1}월`;
  }
  const dates = studioWeekDates();
  const first = dates[0];
  const last = dates[6];
  return `${first.getFullYear()}년 ${first.getMonth() + 1}월 ${first.getDate()}일 ~ ${last.getMonth() + 1}월 ${last.getDate()}일`;
}

function studioTypeColor(type) {
  const palette = ["#2f8cff", "#ff971c", "#1ed760", "#a78bfa", "#f97373", "#22d3ee", "#facc15", "#fb7185"];
  const options = trainingTypeOptions();
  const index = Math.max(0, options.indexOf(type));
  return palette[index % palette.length];
}

function studioTypeStyle(type) {
  return `style="--studio-type-color: ${studioTypeColor(type)}"`;
}

function studioWeekEventStyle(event) {
  const start = studioEventMinutes(event, "start");
  const end = studioEventMinutes(event, "end");
  const duration = Math.max(30, end - start || 60);
  const top = ((start % 60) / 60) * 100;
  const height = (duration / 60) * 100;
  return `style="--studio-type-color: ${studioTypeColor(staffEventTitle(event))}; --studio-event-top: ${top}%; --studio-event-height: ${height}%;"`;
}

function studioTrainingFilterEnabled(type) {
  if (!(type in studioTrainingTypeFilters)) return true;
  return Boolean(studioTrainingTypeFilters[type]);
}

function studioEventMatchesFilter(event) {
  return studioTrainingFilterEnabled(staffEventTitle(event));
}

function studioWeekEventClass(event) {
  const duration = Math.max(30, studioEventMinutes(event, "end") - studioEventMinutes(event, "start") || 60);
  return [
    "typed",
    duration <= 30 ? "short" : "",
    needsStudioStaffAssignment(event) ? "needs-assignment" : ""
  ].filter(Boolean).join(" ");
}

function renderStudioLegend() {
  const target = $("#studioLegend");
  if (!target) return;
  target.innerHTML = trainingTypeOptions().map((type) => `
    <span ${studioTypeStyle(type)}><i class="studio-dot"></i>${esc(type)}</span>
  `).join("");
}

function renderStudioTrainingTypeFilters() {
  const target = $("#studioTrainingTypeFilters");
  if (!target) return;
  const types = trainingTypeOptions();
  const allChecked = types.length === 0 || types.every(studioTrainingFilterEnabled);
  target.innerHTML = `
    <label class="studio-training-filter all">
      <input type="checkbox" data-studio-training-filter="all" ${allChecked ? "checked" : ""} />
      <span>전체</span>
    </label>
    ${types.map((type) => `
      <label class="studio-training-filter" ${studioTypeStyle(type)}>
        <input type="checkbox" data-studio-training-filter="${esc(type)}" ${studioTrainingFilterEnabled(type) ? "checked" : ""} />
        <span>${esc(type)}</span>
      </label>
    `).join("")}
  `;
}

function renderStudioUnassignedNotice() {
  const target = $("#studioUnassignedNotice");
  if (!target) return;
  const count = state.staffEvents.filter(needsStudioStaffAssignment).length;
  target.innerHTML = count
    ? `<div class="studio-unassigned-alert"><span>스탭 배정이 안된 방송실 예약 건이 있습니다! <b>${count}건</b></span><button type="button" data-open-nearest-unassigned>가까운 날짜 배정하기</button></div>`
    : "";
}

function openNearestUnassignedStudioEvent() {
  const today = dateKey(new Date());
  const target = state.staffEvents
    .filter(needsStudioStaffAssignment)
    .sort((a, b) => {
      const aPast = String(a.date || "") < today ? 1 : 0;
      const bPast = String(b.date || "") < today ? 1 : 0;
      return aPast - bPast || String(a.date || "").localeCompare(String(b.date || "")) || String(a.startTime || "").localeCompare(String(b.startTime || ""));
    })[0];
  if (target) openStaffEventDetail(target.id);
}

function studioVisibleEvents() {
  const events = [...state.staffEvents].filter(studioEventMatchesFilter);
  return events.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.startTime || "").localeCompare(String(b.startTime || "")));
}

function studioGridHourLabel(hour) {
  return `${String(hour === 24 ? 0 : hour).padStart(2, "0")}:00`;
}

function studioTimeFromHour(hour) {
  return hour >= 24 ? "00:00" : `${String(hour).padStart(2, "0")}:00`;
}

function studioEventMinutes(event, key) {
  const raw = minutesFromTime(key === "end" ? event.endTime : event.startTime);
  if (key === "end" && raw === 0 && minutesFromTime(event.startTime || "09:00") > 0) return 24 * 60;
  return raw;
}

function renderStudioWeekGrid(events) {
  const dates = studioWeekDates();
  const keys = dates.map(dateKey);
  const weekEvents = events.filter((event) => keys.includes(event.date));
  const hours = Array.from({ length: 19 }, (_, index) => index + 6);
  const dayHead = dates.map((date) => {
    const key = dateKey(date);
    const holidayName = koreanHolidayName(key);
    return `
    <div class="studio-day-head ${key === dateKey(new Date()) ? "today" : ""} ${date.getDay() === 0 ? "sunday" : ""} ${holidayName ? "holiday" : ""}">
      <span>${["일", "월", "화", "수", "목", "금", "토"][date.getDay()]}</span>
      <strong>${date.getMonth() + 1}.${date.getDate()}</strong>
      ${holidayName ? `<em>${esc(holidayName)}</em>` : ""}
    </div>
  `;
  }).join("");
  const rows = hours.map((hour) => `
    <div class="studio-time-label">${studioGridHourLabel(hour)}</div>
    ${dates.map((date) => {
      const dayEvents = weekEvents.filter((event) => {
        const startHour = Math.floor(studioEventMinutes(event, "start") / 60);
        return event.date === dateKey(date) && startHour === hour;
      });
      return `
        <div class="studio-time-cell" data-studio-date="${dateKey(date)}" data-studio-hour="${hour}">
          ${dayEvents.map((event) => `
            <button class="studio-week-event ${studioWeekEventClass(event)}" ${studioWeekEventStyle(event)} draggable="true" type="button" data-open-studio-event="${esc(event.id)}" data-drag-studio-event="${esc(event.id)}">
              ${needsStudioStaffAssignment(event) ? `<i class="studio-assignment-badge" title="스탭 배정 필요">!</i>` : ""}
              <span>${esc(event.startTime || "09:00")} ~ ${esc(event.endTime || "")}</span>
              <strong>${esc(staffReservationTitle(event))}</strong>
            </button>
          `).join("")}
        </div>
      `;
    }).join("")}
  `).join("");
  return `
    <div class="studio-time-label studio-corner"></div>
    ${dayHead}
    ${rows}
  `;
}

function renderStudioMonthGrid(events) {
  const year = studioWeekDate.getFullYear();
  const month = studioWeekDate.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const heads = ["일", "월", "화", "수", "목", "금", "토"].map((day, index) => `<div class="studio-month-head ${index === 0 ? "sunday" : ""}">${day}</div>`).join("");
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = dateKey(date);
    const dayEvents = events.filter((event) => event.date === key);
    const holidayName = koreanHolidayName(key);
    return `
      <div class="studio-month-day ${date.getMonth() !== month ? "muted" : ""} ${key === dateKey(new Date()) ? "today" : ""} ${date.getDay() === 0 ? "sunday" : ""} ${holidayName ? "holiday" : ""}" data-studio-month-date="${key}">
        <span><b>${date.getDate()}</b>${holidayName ? `<em>${esc(holidayName)}</em>` : ""}</span>
        ${dayEvents.map((event) => `
          <button class="studio-month-event ${studioWeekEventClass(event)}" ${studioTypeStyle(staffEventTitle(event))} draggable="true" type="button" data-open-studio-event="${esc(event.id)}" data-drag-studio-event="${esc(event.id)}">
            ${needsStudioStaffAssignment(event) ? `<i class="studio-assignment-badge" title="스탭 배정 필요">!</i>` : ""}
            ${esc(staffReservationTitle(event))}
          </button>
        `).join("")}
      </div>
    `;
  }).join("");
  return heads + days;
}

function scrollStudioGridToDefaultHour() {
  const grid = $("#studioWeekGrid");
  if (!grid || studioViewMode !== "week") return;
  requestAnimationFrame(() => {
    grid.scrollTop = 0;
  });
}

function renderStudioManage({ preserveScroll = false } = {}) {
  const title = $("#studioWeekTitle");
  if (title) title.textContent = studioWeekRangeLabel();
  $$("[data-studio-view-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.studioViewMode === studioViewMode);
  });
  renderStudioLegend();
  renderStudioUnassignedNotice();
  renderStudioTrainingTypeFilters();
  const grid = $("#studioWeekGrid");
  if (!grid) return;
  const scrollTop = preserveScroll ? grid.scrollTop : null;
  const scrollLeft = preserveScroll ? grid.scrollLeft : null;
  const events = studioVisibleEvents();
  grid.classList.toggle("is-month", studioViewMode === "month");
  grid.innerHTML = studioViewMode === "month" ? renderStudioMonthGrid(events) : renderStudioWeekGrid(events);
  if (preserveScroll) {
    requestAnimationFrame(() => {
      grid.scrollTop = scrollTop || 0;
      grid.scrollLeft = scrollLeft || 0;
    });
  } else {
    scrollStudioGridToDefaultHour();
  }
}

function studioCellPointerMinute(cell, pointerEvent) {
  const hour = Number(cell?.dataset.studioHour || 0);
  if (!cell || !pointerEvent?.clientY) return hour * 60;
  const rect = cell.getBoundingClientRect();
  const y = Math.max(0, Math.min(rect.height, pointerEvent.clientY - rect.top));
  return hour * 60 + (y >= rect.height / 2 ? 30 : 0);
}

function beginStudioCellDrag(cell, pointerEvent) {
  if (!cell || studioViewMode !== "week") return;
  const minute = studioCellPointerMinute(cell, pointerEvent);
  studioDragDraft = {
    kind: "create",
    date: cell.dataset.studioDate,
    startMinute: minute,
    endMinute: minute
  };
  updateStudioCellDrag(cell, pointerEvent);
}

function updateStudioCellDrag(cell, pointerEvent) {
  if (!studioDragDraft || studioDragDraft.kind !== "create" || !cell || cell.dataset.studioDate !== studioDragDraft.date) return;
  studioDragDraft.endMinute = studioCellPointerMinute(cell, pointerEvent);
  $$(".studio-time-cell").forEach((item) => {
    const itemStart = Number(item.dataset.studioHour) * 60;
    const itemEnd = itemStart + 60;
    const min = Math.min(studioDragDraft.startMinute, studioDragDraft.endMinute);
    const max = Math.max(studioDragDraft.startMinute, studioDragDraft.endMinute) + 30;
    const active = item.dataset.studioDate === studioDragDraft.date && itemEnd > min && itemStart < max;
    item.classList.toggle("drag-selecting", active);
    if (active) {
      const selectStart = Math.max(0, min - itemStart);
      const selectEnd = Math.min(60, max - itemStart);
      item.style.setProperty("--studio-select-top", `${(selectStart / 60) * 100}%`);
      item.style.setProperty("--studio-select-height", `${((selectEnd - selectStart) / 60) * 100}%`);
    } else {
      item.style.removeProperty("--studio-select-top");
      item.style.removeProperty("--studio-select-height");
    }
  });
}

function finishStudioCellDrag() {
  if (!studioDragDraft || studioDragDraft.kind !== "create") return;
  const draft = studioDragDraft;
  studioDragDraft = null;
  $$(".studio-time-cell.drag-selecting").forEach((cell) => {
    cell.classList.remove("drag-selecting");
    cell.style.removeProperty("--studio-select-top");
    cell.style.removeProperty("--studio-select-height");
  });
  const startMinute = Math.min(draft.startMinute, draft.endMinute);
  const endMinute = Math.min(24 * 60, Math.max(draft.startMinute, draft.endMinute) + 30);
  openStaffScheduleModal(draft.date, {
    allDay: false,
    startTime: timeFromMinutes(startMinute),
    endTime: endMinute >= 24 * 60 ? "00:00" : timeFromMinutes(endMinute)
  });
}

function moveStudioEventToCell(eventId, cell, pointerEvent) {
  const event = state.staffEvents.find((item) => item.id === eventId);
  if (!event || !cell) return;
  const start = studioEventMinutes(event, "start");
  const end = studioEventMinutes(event, "end");
  const duration = Math.max(30, end - start || 60);
  const nextStart = studioCellPointerMinute(cell, pointerEvent);
  const nextEnd = Math.min(24 * 60, nextStart + duration);
  event.date = cell.dataset.studioDate;
  event.allDay = false;
  event.startTime = timeFromMinutes(nextStart);
  event.endTime = studioTimeFromHour(Math.ceil(nextEnd / 60));
  if (nextEnd % 60) event.endTime = timeFromMinutes(Math.min(23 * 60 + 59, nextEnd));
  saveState();
  renderAll();
  showToast("방송실 예약 시간이 변경되었습니다.");
}

function moveStudioEventToDate(eventId, date) {
  const event = state.staffEvents.find((item) => item.id === eventId);
  if (!event || !date) return;
  event.date = date;
  saveState();
  renderAll();
  showToast("방송실 예약 날짜가 변경되었습니다.");
}

function renderAdmin() {
  if (SUPABASE_ENABLED && isAdminUser() && !adminProfilesRefreshing) {
    adminProfilesRefreshing = true;
    refreshSupabaseProfiles()
      .then(() => {
        if (activeView === "admin") renderAdmin();
      })
      .finally(() => {
        adminProfilesRefreshing = false;
      });
  }
  if (!isAdminUser()) {
    $("#adminLogin").classList.add("hidden");
    $("#adminContent").classList.add("open");
    $("#adminContent").innerHTML = `<div class="empty">관리자 권한 계정만 드롭다운과 계정을 관리할 수 있습니다.</div>`;
    return;
  }
  isAdminUnlocked = true;
  $("#adminLogin").classList.add("hidden");
  $("#adminContent").classList.add("open");

  const groups = [
    ["types", "영상 프로젝트", "업무분류"],
    ["statuses", "영상 프로젝트", "진행"],
    ["owners", "공통", "담당자 슬롯"],
    ["clients", "영상 프로젝트", "발주 부서"],
    ["projectTaskTypes", "영상 프로젝트", "할 일 분류"],
    ["workTaskTypes", "업무", "할 일 분류"],
    ["workTypes", "업무", "업무분류"],
    ["workStatuses", "업무", "진행"],
    ["workClients", "업무", "발주 부서"],
    ["studioRooms", "방송실 예약 드롭다운", "장소 관리"],
    ["staffTypes", "방송실 예약 드롭다운", "스탭 종류 관리"],
    ["trainingTypes", "방송실 예약 드롭다운", "교육 유형 관리"]
  ];

  $("#adminContent").innerHTML = groups
    .map(([key, section, label]) => `
      <article class="option-manager" data-option-group="${key}">
        <div>
          <p class="eyebrow">${esc(section)}</p>
          <h3>${esc(label)}</h3>
        </div>
        <form class="option-form">
          <input name="option" placeholder="${label} 추가" />
          <button class="pill primary" type="submit">추가</button>
        </form>
        <div class="option-list">
          ${state.options[key]
            .map((option, index) => `
              <span class="admin-chip" draggable="true" data-option-index="${index}" data-option-value="${esc(option)}">
                <i class="drag-handle">☰</i>
                <input class="admin-option-input" data-option-edit-value value="${esc(option)}" aria-label="${esc(option)} 이름 수정" readonly />
                <button data-edit-option="${esc(option)}" type="button">수정</button>
                <button data-delete-option="${esc(option)}" aria-label="${esc(option)} 삭제">×</button>
              </span>
            `)
            .join("")}
        </div>
      </article>
    `)
    .join("") + renderOwnerLinkManager() + renderAccountManager();
}



function renderOwnerLinkManager() {
  const users = state.users.filter((user) => user.status !== "inactive" && user.approved !== false);
  return `
    <article class="option-manager account-manager owner-link-manager">
      <div>
        <p class="eyebrow">owners</p>
        <h3>담당자 연결 관리</h3>
      </div>
      <div class="owner-link-actions">
        <small>계정을 선택한 뒤 연결 저장을 눌러야 반영됩니다.</small>
        <button class="pill primary" type="button" data-save-owner-links>연결 저장</button>
      </div>
      <div class="owner-link-table">
        <div class="owner-link-head"><span>담당자</span><span>연결 계정</span><span>상태</span><span>관리</span></div>
        ${ownerSlots().map((owner) => {
          const user = state.users.find((item) => item.id === owner.linkedUserId);
          const stateText = !owner.linkedUserId ? "알림 없음" : !user || user.status === "inactive" ? "비활성 계정" : "연결됨";
          return `
            <div class="owner-link-row" data-owner-id="${esc(owner.id)}">
              <strong>${esc(owner.name)}</strong>
              <span>${esc(user?.username || "미연결")}</span>
              <small>${esc(stateText)}</small>
              <select data-link-owner-id="${esc(owner.id)}">
                <option value="">미연결</option>
                ${users.map((account) => `<option value="${esc(account.id)}" ${owner.linkedUserId === account.id ? "selected" : ""}>${esc(account.username)}</option>`).join("")}
              </select>
            </div>
          `;
        }).join("")}
      </div>
    </article>
  `;
}

function renderAccountManager() {
  if (!isAdminUser()) {
    return `
      <article class="option-manager account-manager">
        <div>
          <p class="eyebrow">accounts</p>
          <h3>계정 관리</h3>
        </div>
        <div class="empty">관리자 권한 계정만 계정 권한을 변경할 수 있습니다.</div>
      </article>
    `;
  }

  return `
    <article class="option-manager account-manager">
      <div>
        <p class="eyebrow">accounts</p>
        <h3>계정 관리</h3>
      </div>
      <div class="account-list">
        ${state.users
          .map((user) => `
            <div class="account-row" data-user-id="${esc(user.id)}">
              <div>
                <strong>${esc(user.name || user.username)}</strong>
                <small>${esc(user.position || "과원")} · ${user.status === "inactive" ? "삭제됨" : user.approved === false || user.status === "pending" ? "미승인" : user.role === "admin" ? "관리자" : "일반 계정"}</small>
                <small>${esc(user.email || user.username || "-")}</small>
              </div>
              <div class="account-actions">
                <button class="role-chip ${user.role === "admin" && user.approved !== false && user.status !== "pending" && user.status !== "inactive" ? "active" : ""}" data-set-role="admin" type="button">관리자</button>
                <button class="role-chip ${user.role !== "admin" && user.approved !== false && user.status !== "pending" && user.status !== "inactive" ? "active" : ""}" data-set-role="user" type="button">일반</button>
                <button class="role-chip ${user.approved === false || user.status === "pending" ? "active" : ""}" data-mark-pending="${esc(user.id)}" type="button">미승인</button>
                <button class="delete-btn" data-delete-user="${esc(user.id)}" ${user.id === state.currentUser ? "disabled" : ""} type="button" aria-label="계정 삭제">×</button>
              </div>
            </div>
          `)
          .join("")}
      </div>
    </article>
  `;
}

function setUserRole(userId, role) {
  if (!isAdminUser()) return;
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  user.role = role;
  user.status = "active";
  user.approved = true;
  saveState();
  syncProfileToSupabase(user);
  renderAll();
  showToast("계정 권한이 변경되었습니다.");
}

function markUserPending(userId) {
  if (!isAdminUser() || userId === currentUser()?.id) return;
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  user.status = "pending";
  user.approved = false;
  ownerSlots().forEach((owner) => {
    if (owner.linkedUserId === userId) owner.linkedUserId = null;
  });
  saveState();
  syncProfileToSupabase(user);
  renderAll();
  showToast("계정을 미승인 상태로 변경했습니다.");
}

function deleteUser(userId) {
  if (!isAdminUser() || userId === currentUser()?.id) return;
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  state.users = state.users.filter((item) => item.id !== userId);
  ownerSlots().forEach((owner) => {
    if (owner.linkedUserId === userId) owner.linkedUserId = null;
  });
  state.notifications = (state.notifications || []).filter((notification) => notification.userId !== userId);
  deleteProfileFromSupabase(userId);
  saveState();
  renderAll();
  showToast("계정이 삭제되었습니다.");
}

function approveUser(userId) {
  if (!isAdminUser()) return;
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  user.approved = true;
  user.status = "active";
  saveState();
  syncProfileToSupabase(user);
  renderAll();
  showToast("가입 계정이 승인되었습니다.");
}

async function linkOwnerToUser(ownerId, userId) {
  if (!isAdminUser()) return;
  ownerSlots().forEach((owner) => {
    if (userId && owner.linkedUserId === userId) owner.linkedUserId = null;
  });
  const owner = ownerById(ownerId);
  if (!owner) return;
  owner.linkedUserId = userId || null;
  saveState();
  const saved = await saveRemoteDashboardState();
  renderAll();
  showToast(saved === false ? "연결 저장에 실패했습니다. Supabase 권한을 확인해주세요." : userId ? "담당자 슬롯에 계정을 연결했습니다." : "담당자 슬롯 연결을 해제했습니다.");
}

async function saveOwnerLinkSettings() {
  if (!isAdminUser()) return;
  const selects = Array.from(document.querySelectorAll("[data-link-owner-id]"));
  const usedUserIds = new Set();
  const nextLinks = new Map();
  let hasDuplicate = false;

  selects.forEach((select) => {
    const ownerId = select.dataset.linkOwnerId;
    const userId = select.value || "";
    if (userId && usedUserIds.has(userId)) {
      hasDuplicate = true;
      nextLinks.set(ownerId, "");
      return;
    }
    if (userId) usedUserIds.add(userId);
    nextLinks.set(ownerId, userId);
  });

  ownerSlots().forEach((owner) => {
    owner.linkedUserId = null;
  });
  nextLinks.forEach((userId, ownerId) => {
    const owner = ownerById(ownerId);
    if (owner) owner.linkedUserId = userId || null;
  });

  saveState();
  const saved = await saveRemoteDashboardState();
  renderAll();
  if (saved === false) {
    showToast("연결 저장에 실패했습니다. Supabase 권한을 확인해주세요.");
    return;
  }
  showToast(hasDuplicate ? "중복 계정은 하나만 연결하고 저장했습니다." : "담당자 연결 설정을 저장했습니다.");
}

function addOption(group, value) {
  const clean = value.trim();
  if (!clean || state.options[group].includes(clean)) return;
  state.options[group].push(clean);
  if (group === "owners") {
    state.options.workOwners = [...state.options.owners];
    state.options.studioStaffOwners = [...state.options.owners];
    const existingOwner = state.owners.find((owner) => owner.name === clean);
    if (existingOwner) {
      existingOwner.status = "active";
    } else {
      state.owners.push(makeOwnerSlot(clean, state.owners.length));
    }
  }
  saveState();
  renderAll();
}

function reorderOption(group, fromIndex, toIndex) {
  const options = state.options[group];
  if (!Array.isArray(options) || fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
  const [item] = options.splice(fromIndex, 1);
  options.splice(toIndex, 0, item);
  saveState();
  renderAll();
}


function renameOption(group, oldValue, nextValue) {
  const clean = nextValue.trim();
  if (!clean || oldValue === clean || state.options[group].includes(clean)) return;
  state.options[group] = state.options[group].map((option) => option === oldValue ? clean : option);
  if (group === "owners") {
    state.options.workOwners = [...state.options.owners];
    state.options.studioStaffOwners = [...state.options.owners];
    const owner = ownerSlots().find((item) => item.name === oldValue);
    if (owner) owner.name = clean;
  }
  const updateValue = (item, field) => {
    if (item && item[field] === oldValue) item[field] = clean;
  };
  const fieldMap = { methods: "method", types: "type", statuses: "status", clients: "client" };
  const workFieldMap = { workTypes: "type", workStatuses: "status", workClients: "client" };
  state.projects.forEach((project) => {
    if (fieldMap[group]) updateValue(project, fieldMap[group]);
  });
  state.works.forEach((work) => {
    if (workFieldMap[group]) updateValue(work, workFieldMap[group]);
    (work.tasks || []).forEach((task) => {
      if ((group === "taskTypes" || group === "workTaskTypes") && task.type === oldValue) task.type = clean;
    });
  });
  state.tasks.forEach((task) => {
    if ((group === "taskTypes" || group === "projectTaskTypes") && task.type === oldValue) task.type = clean;
  });
  state.staffEvents.forEach((event) => {
    if (group === "studioRooms") updateValue(event, "room");
    if (group === "staffTypes") updateValue(event, "type");
    if (group === "trainingTypes") {
      updateValue(event, "trainingType");
      if (event.title === oldValue) event.title = clean;
    }
  });
  state.recurringTrainings.forEach((series) => {
    if (group === "studioRooms") updateValue(series, "room");
    if (group === "staffTypes") updateValue(series, "type");
    if (group === "trainingTypes") {
      updateValue(series, "trainingType");
      if (series.title === oldValue) series.title = clean;
    }
  });
  saveState();
  renderAll();
}

function deleteOption(group, value) {
  state.options[group] = state.options[group].filter((option) => option !== value);
  if (group === "owners") {
    state.options.workOwners = [...state.options.owners];
    state.options.studioStaffOwners = [...state.options.owners];
    const owner = state.owners.find((item) => item.name === value);
    if (owner) owner.status = "deleted";
  }
  const clearValue = (item, field) => {
    if (item && item[field] === value) item[field] = "";
  };
  const fieldMap = { methods: "method", types: "type", statuses: "status", clients: "client" };
  const workFieldMap = { workTypes: "type", workStatuses: "status", workClients: "client" };
  state.projects.forEach((project) => {
    if (fieldMap[group]) clearValue(project, fieldMap[group]);
  });
  state.works.forEach((work) => {
    if (workFieldMap[group]) clearValue(work, workFieldMap[group]);
    (work.tasks || []).forEach((task) => {
      if ((group === "taskTypes" || group === "workTaskTypes") && task.type === value) task.type = "";
    });
  });
  state.tasks.forEach((task) => {
    if ((group === "taskTypes" || group === "projectTaskTypes") && task.type === value) task.type = "";
  });
  state.staffEvents.forEach((event) => {
    if (group === "studioRooms") clearValue(event, "room");
    if (group === "staffTypes") clearValue(event, "type");
    if (group === "trainingTypes") {
      clearValue(event, "trainingType");
      if (event.title === value) event.title = "";
    }
  });
  state.recurringTrainings.forEach((series) => {
    if (group === "studioRooms") clearValue(series, "room");
    if (group === "staffTypes") clearValue(series, "type");
    if (group === "trainingTypes") {
      clearValue(series, "trainingType");
      if (series.title === value) series.title = "";
    }
  });
  saveState();
  renderAll();
}

function exportCsv() {
  const header = ["영상 프로젝트명", "업무분류", "진행", "담당자", "발주 부서", "시작일자", "촬영일자", "1차 완성", "최종 출고일자", "진행률", "총예산", "집행액"];
  const rows = state.projects.map((project) => [
    project.title,
    project.type,
    project.status,
    ownersLabel(project),
    project.client,
    project.kickoffDate,
    project.shootDate,
    project.firstEditDate,
    project.finalDate,
    `${project.progress}%`,
    project.budget,
    project.spent
  ]);
  const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "video-work-dashboard-projects.csv";
  link.click();
  URL.revokeObjectURL(url);
}



let mobileActiveSection = "tasks";
let mobileTaskFilter = viewPref("mobileTaskFilter", "all");
let mobileTaskSort = viewPref("mobileTaskSort", taskOverviewSort);
let mobileTaskHideDone = viewPref("mobileTaskHideDone", true);
let mobileTaskSortOpen = false;
let mobileAddMode = "";

function isMobileViewport() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function mobileTitleForView(view) {
  return { projects: "영상", works: "업무", tasks: "할 일", calendar: "캘린더", studio: "방송실", admin: "관리자", notifications: "알림", settings: "설정" }[view] || "영상";
}

function unreadNotifications() {
  const user = currentUser();
  return (state.notifications || []).filter((item) => !item.read && (!item.userId || item.userId === user?.id));
}

function mobileTodayKey() {
  return dateKey(new Date());
}

function mobileWeekLimitKey() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return dateKey(date);
}

function mobileKpis() {
  const today = mobileTodayKey();
  const openProjects = state.projects.filter((project) => project.status !== "납품 완료").length;
  const todayTasks = taskOverviewItems().filter((item) => !item.task.done && item.task.dueDate === today).length;
  const todayEvents = projectEventsForDate(today).length;
  return [
    ["진행중 프로젝트", openProjects],
    ["오늘 할 일", todayTasks],
    ["오늘 일정", todayEvents]
  ];
}

function mobileOwnersText(ids) {
  const names = ownerNames(Array.isArray(ids) ? ids : []);
  if (!names.length) return "담당자 없음";
  if (names.length === 1) return names[0];
  return `${names[0]} 외 ${names.length - 1}명`;
}

function mobileStatusText(value) {
  return value || "상태 선택";
}

function renderMobileKpiStrip() {
  return `<div class="mobile-kpi-strip">${mobileKpis().map(([label, value]) => `<article><span>${esc(label)}</span><b>${value}</b></article>`).join("")}</div>`;
}

function renderMobileProjectCards() {
  const projects = [...state.projects].sort((a, b) => String(a.finalDate || "").localeCompare(String(b.finalDate || "")));
  return `
    ${renderMobileKpiStrip()}
    <div class="mobile-section-head"><h2>영상</h2><span>${projects.length}건</span></div>
    <div class="mobile-card-list">
      ${projects.length ? projects.map((project) => `
        <button class="mobile-work-card" data-mobile-open-project="${esc(project.id)}" type="button">
          <strong>${esc(project.title || "제목 없음")}</strong>
          <div><span class="mobile-chip">${esc(mobileStatusText(project.status))}</span><span>${esc(mobileOwnersText(projectOwners(project)))}</span></div>
          <small>마감일 ${project.finalDate ? esc(formatDate(project.finalDate)) : "없음"}</small>
        </button>
      `).join("") : `<div class="empty">등록된 영상 프로젝트가 없습니다.</div>`}
    </div>
  `;
}

function renderMobileWorkCards() {
  const works = [...state.works].sort((a, b) => String(a.finalDate || "").localeCompare(String(b.finalDate || "")));
  return `
    ${renderMobileKpiStrip()}
    <div class="mobile-section-head"><h2>업무</h2><span>${works.length}건</span></div>
    <div class="mobile-card-list">
      ${works.length ? works.map((work) => `
        <button class="mobile-work-card" data-mobile-open-work="${esc(work.id)}" type="button">
          <strong>${esc(work.title || "제목 없음")}</strong>
          <div><span class="mobile-chip">${esc(mobileStatusText(work.status))}</span><span>${esc(mobileOwnersText(workOwners(work)))}</span></div>
          <small>마감일 ${work.noSchedule ? "일정 없음" : work.finalDate ? esc(formatDate(work.finalDate)) : "없음"}</small>
        </button>
      `).join("") : `<div class="empty">등록된 업무가 없습니다.</div>`}
    </div>
  `;
}

function mobileFilteredTasks() {
  const today = mobileTodayKey();
  const week = mobileWeekLimitKey();
  const allItems = taskOverviewItems();
  if (!["all", "today", "overdue", "week"].includes(mobileTaskFilter)) mobileTaskFilter = "all";
  mobileTaskSort = normalizeTaskSort(mobileTaskSort);
  const matchingItems = allItems.filter((item) => {
    const due = item.task.dueDate || "";
    if (mobileTaskFilter === "today") return !item.task.done && due === today;
    if (mobileTaskFilter === "overdue") return !item.task.done && due && due < today;
    if (mobileTaskFilter === "week") return !item.task.done && due && due >= today && due <= week;
    return true;
  });
  const visibleItems = matchingItems
    .filter((item) => !(mobileTaskHideDone && item.task.done))
    .sort((a, b) => compareTaskOverviewItems(a, b, mobileTaskSort));
  return { allItems, matchingItems, visibleItems };
}

function mobileTaskEmptyMessage(totalCount, visibleCount) {
  if (!visibleCount && totalCount && mobileTaskHideDone) return "표시할 할 일이 없습니다. 완료된 항목 숨기기를 해제하면 완료 업무를 볼 수 있습니다.";
  if (mobileTaskFilter === "today") return "오늘 마감인 할 일이 없습니다.";
  if (mobileTaskFilter === "overdue") return "지연된 할 일이 없습니다.";
  if (mobileTaskFilter === "week") return "이번주 할 일이 없습니다.";
  return "등록된 할 일이 없습니다.";
}

function mobileTaskDueText(task) {
  const date = task.dueDate ? formatDate(task.dueDate) : "마감일 없음";
  return `${date} · ${formatTaskTime(task)}`;
}

function renderMobileTaskCard(item) {
  const badge = taskDdayInfo(item);
  return `
    <article class="mobile-task-card ${item.task.done ? "is-done" : ""}" data-mobile-task-card="${esc(item.id)}">
      <input class="mobile-task-check" type="checkbox" data-overview-task-source="${esc(item.source)}" data-overview-task-check="${esc(item.id)}" ${item.task.done ? "checked" : ""} ${item.canManage ? "" : "disabled"} />
      <button class="mobile-task-open" type="button" data-mobile-open-task-source="${esc(item.source)}" data-mobile-open-task-id="${esc(item.id)}">
        <strong>${esc(item.task.text || "제목 없음")}</strong>
        <span>${esc(item.sourceTitle)} · ${esc(taskOwnersLabel(item.task))}</span>
        <small>${esc(mobileTaskDueText(item.task))}</small>
      </button>
      <b class="mobile-dday-badge ${esc(badge.className)}">${esc(badge.label)}</b>
    </article>
  `;
}

function renderMobileSortSheet() {
  if (!mobileTaskSortOpen) return "";
  return `
    <div class="mobile-sort-backdrop" data-mobile-close-sort></div>
    <section class="mobile-sort-sheet">
      <i></i>
      <h3>정렬 방식</h3>
      ${taskSortOptions.map(([value, label]) => `
        <button class="${normalizeTaskSort(mobileTaskSort) === value ? "active" : ""}" data-mobile-task-sort="${esc(value)}" type="button">
          <span></span>
          ${esc(label)}
          ${normalizeTaskSort(mobileTaskSort) === value ? "<b>✓</b>" : ""}
        </button>
      `).join("")}
    </section>
  `;
}

function renderMobileTasks() {
  const { matchingItems, visibleItems } = mobileFilteredTasks();
  const filters = [["all", "전체"], ["today", "오늘"], ["overdue", "지연"], ["week", "이번주"]];
  const emptyMessage = mobileTaskEmptyMessage(matchingItems.length, visibleItems.length);
  return `
    <div class="mobile-task-page">
      <div class="mobile-filter-chips">
        ${filters.map(([key, label]) => `<button class="${mobileTaskFilter === key ? "active" : ""}" data-mobile-task-filter="${key}" type="button">${label}</button>`).join("")}
      </div>
      <div class="mobile-task-tools">
        <button class="mobile-sort-trigger ${mobileTaskSortOpen ? "active" : ""}" data-mobile-open-sort type="button">
          <span>☰</span> 정렬: ${esc(taskSortLabel(mobileTaskSort))} <i>${mobileTaskSortOpen ? "⌃" : "⌄"}</i>
        </button>
        <label class="mobile-hide-done-toggle">
          <span>완료된 항목 숨기기</span>
          <input data-mobile-hide-done type="checkbox" ${mobileTaskHideDone ? "checked" : ""} />
          <b></b>
        </label>
      </div>
      <div class="mobile-card-list mobile-task-list">
        ${visibleItems.length ? visibleItems.map(renderMobileTaskCard).join("") : `<div class="mobile-task-empty"><div>✓</div><strong>${esc(emptyMessage)}</strong><span>새 할 일을 추가하거나 다른 필터를 확인해보세요.</span></div>`}
      </div>
      ${renderMobileSortSheet()}
    </div>
  `;
}

function mobileScheduleItems(from, to) {
  const start = from || mobileTodayKey();
  const end = to || start;
  const items = [];
  for (let date = new Date(`${start}T00:00:00`); dateKey(date) <= end; date.setDate(date.getDate() + 1)) {
    const key = dateKey(date);
    projectEventsForDate(key).forEach((event) => items.push({ ...event, date: key }));
  }
  return items.sort((a, b) => `${a.date} ${a.startTime || ""}`.localeCompare(`${b.date} ${b.startTime || ""}`));
}

function renderMobileScheduleList(title, items) {
  return `
    <section class="mobile-schedule-section">
      <h3>${esc(title)}</h3>
      ${items.length ? items.map((event) => `
        <button class="mobile-schedule-card ${esc(event.source)}" data-mobile-calendar-source="${esc(event.source)}" data-mobile-calendar-id="${esc(event.id)}" data-mobile-calendar-date="${esc(event.date)}" type="button">
          <b>${esc(event.label)}</b>
          <span>${esc(formatDate(event.date))} · ${event.allDay === false ? `${esc(event.startTime || "")}-${esc(event.endTime || "")}` : "종일"}</span>
        </button>
      `).join("") : `<div class="empty">일정이 없습니다.</div>`}
    </section>
  `;
}

function renderMobileMonthMini() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const start = new Date(year, month, 1 - firstDay.getDay());
  return `
    <section class="mobile-month-mini">
      <div class="mobile-section-head"><h3>${year}년 ${month + 1}월</h3><span>월간</span></div>
      <div class="mobile-month-weekdays"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>
      <div class="mobile-month-grid">
        ${Array.from({ length: 42 }, (_, index) => {
          const date = new Date(start);
          date.setDate(start.getDate() + index);
          const key = dateKey(date);
          const count = projectEventsForDate(key).length;
          return `<button class="${date.getMonth() !== month ? "muted" : ""} ${key === mobileTodayKey() ? "today" : ""}" data-mobile-month-date="${key}" type="button"><b>${date.getDate()}</b>${count ? `<i>${count}</i>` : ""}</button>`;
        }).join("")}
      </div>
    </section>
  `;
}

function renderMobileCalendar() {
  const today = mobileTodayKey();
  const week = mobileWeekLimitKey();
  return `
    <div class="mobile-section-head"><h2>캘린더</h2><span>방송실 포함</span></div>
    ${renderMobileScheduleList("오늘 일정", mobileScheduleItems(today, today))}
    ${renderMobileScheduleList("이번주 일정", mobileScheduleItems(today, week))}
    ${renderMobileMonthMini()}
  `;
}

function renderMobileMoreInline() {
  return `
    <div class="mobile-section-head"><h2>더보기</h2><span>설정</span></div>
    <div class="mobile-more-grid">
      <button data-mobile-more-target="admin" type="button">관리자</button>
      <button data-mobile-more-target="projects" type="button">프로젝트</button>
      <button data-mobile-more-target="works" type="button">업무</button>
      <button data-mobile-more-target="studio" type="button">방송실</button>
      <button data-mobile-more-target="notifications" type="button">알림</button>
      <button data-mobile-more-target="settings" type="button">설정</button>
      <button id="mobileInlineLogoutBtn" type="button">로그아웃</button>
    </div>
  `;
}

function renderMobileDashboard() {
  const app = $("#mobileApp");
  if (!app) return;
  const current = mobileActiveSection || "projects";
  $("#mobileViewTitle") && ($("#mobileViewTitle").textContent = mobileTitleForView(current));
  $$(".mobile-tab").forEach((button) => {
    const section = button.dataset.mobileSection;
    button.classList.toggle("active", section === current);
  });
  const user = currentUser();
  $("#mobileUserName") && ($("#mobileUserName").textContent = user?.name || user?.username || "사용자");
  $("#mobileUserMeta") && ($("#mobileUserMeta").textContent = user?.position || "과원");
  const unread = unreadNotifications();
  $("#mobileNotifyCount") && ($("#mobileNotifyCount").textContent = String(unread.length));
  const notificationTarget = $("#mobileNotifications");
  if (notificationTarget) {
    notificationTarget.innerHTML = unread.length
      ? unread.slice(0, 6).map((item) => `<article><b>${esc(item.title || "알림")}</b><span>${esc(item.body || item.message || "")}</span></article>`).join("")
      : `<div class="empty">새 알림이 없습니다.</div>`;
  }
  const renderers = {
    projects: renderMobileProjectCards,
    works: renderMobileWorkCards,
    tasks: renderMobileTasks,
    calendar: renderMobileCalendar,
    studio: renderMobileCalendar,
    admin: renderMobileMoreInline,
    notifications: renderMobileMoreInline,
    settings: renderMobileMoreInline
  };
  app.innerHTML = (renderers[current] || renderMobileProjectCards)();
}

function toggleMobileFab(force) {
  const menu = $("#mobileFabMenu");
  if (!menu) return;
  const open = typeof force === "boolean" ? force : !menu.classList.contains("open");
  menu.classList.toggle("open", open);
  menu.setAttribute("aria-hidden", String(!open));
}

function openMobileMoreSheet(open = true) {
  const sheet = $("#mobileMoreSheet");
  if (!sheet) return;
  sheet.classList.toggle("open", open);
  sheet.setAttribute("aria-hidden", String(!open));
}

function openMobileSection(section) {
  document.body.classList.toggle("mobile-pc-view", section === "admin");
  if (["projects", "works", "tasks", "calendar"].includes(section)) {
    mobileActiveSection = section;
    setView(section === "calendar" ? "calendar" : section);
    renderMobileDashboard();
    return;
  }
  if (section === "studio") {
    mobileActiveSection = "calendar";
    setView("calendar");
    renderMobileDashboard();
    return;
  }
  if (section === "admin") {
    mobileActiveSection = "admin";
    setView("admin");
    renderMobileDashboard();
    return;
  }
  mobileActiveSection = "admin";
  renderMobileDashboard();
}

function closeMobileAddSheet() {
  const sheet = $("#mobileAddSheet");
  if (!sheet) return;
  sheet.classList.remove("open");
  sheet.setAttribute("aria-hidden", "true");
  mobileAddMode = "";
}

function mobileOwnerCheckboxes(name, selected = []) {
  return `
    <div class="mobile-check-list">
      ${ownerOptions().map((ownerId) => `
        <label><input type="checkbox" name="${name}" value="${esc(ownerId)}" ${selected.includes(ownerId) ? "checked" : ""} /><span>${esc(ownerOptionLabel(ownerId))}</span></label>
      `).join("")}
    </div>
  `;
}

function mobileSelect(name, options, placeholder = "선택") {
  return `<select name="${name}"><option value="">${esc(placeholder)}</option>${options.map((option) => `<option value="${esc(option)}">${esc(option)}</option>`).join("")}</select>`;
}

function mobileProjectWorkSelect() {
  return `
    <select name="target">
      <option value="">연결 대상 선택</option>
      ${state.projects.map((project) => `<option value="project:${esc(project.id)}">영상 · ${esc(project.title)}</option>`).join("")}
      ${state.works.map((work) => `<option value="work:${esc(work.id)}">업무 · ${esc(work.title)}</option>`).join("")}
    </select>
  `;
}

function renderMobileAddForm(mode) {
  const today = dateKey(new Date());
  const configs = {
    project: ["영상 추가", "영상 등록"],
    work: ["업무 추가", "업무 등록"],
    task: ["할 일 추가", "할 일 등록"],
    schedule: ["일정 추가", "일정 등록"]
  };
  const [title, submitLabel] = configs[mode] || configs.project;
  let body = "";
  if (mode === "project") {
    body = `
      <section><h3>기본정보</h3><input name="title" placeholder="영상명" required />${mobileSelect("type", state.options.types, "분류 선택")}${mobileSelect("client", state.options.clients, "발주부서 선택")}</section>
      <section><h3>담당/상태</h3>${mobileOwnerCheckboxes("owners")}${mobileSelect("status", state.options.statuses, "진행상태 선택")}</section>
      <section><h3>일정</h3><label>시작일<input name="kickoffDate" type="date" value="${today}" /></label><label>촬영일<input name="shootDate" type="date" value="${today}" /></label><label>1차 완성일<input name="firstEditDate" type="date" value="${today}" /></label><label>최종 출고일<input name="finalDate" type="date" value="${today}" /></label></section>
      <section><h3>메모</h3><textarea name="memo" placeholder="메모"></textarea></section>
    `;
  } else if (mode === "work") {
    body = `
      <section><h3>기본정보</h3><input name="title" placeholder="업무명" required />${mobileSelect("type", state.options.workTypes, "분류 선택")}${mobileSelect("client", state.options.workClients, "발주부서 선택")}</section>
      <section><h3>담당/상태</h3>${mobileOwnerCheckboxes("owners")}${mobileSelect("status", state.options.workStatuses, "진행상태 선택")}</section>
      <section><h3>일정</h3><label class="mobile-toggle-line"><input name="noSchedule" type="checkbox" /> 일정 없음</label><label>시작일<input name="kickoffDate" type="date" value="${today}" /></label><label>완료일<input name="finalDate" type="date" value="${today}" /></label></section>
      <section><h3>메모</h3><textarea name="memo" placeholder="메모"></textarea></section>
    `;
  } else if (mode === "task") {
    body = `
      <section><h3>기본정보</h3><input name="title" placeholder="할 일 제목" required /></section>
      <section><h3>연결</h3>${mobileProjectWorkSelect()}</section>
      <section><h3>담당/분류</h3>${mobileOwnerCheckboxes("owners")}${mobileSelect("type", taskTypeOptions(), "업무 분류 선택")}</section>
      <section><h3>일정</h3><label>마감일<input name="dueDate" type="date" value="${today}" /></label><label class="mobile-toggle-line"><input name="noDueDate" type="checkbox" /> 마감일 없음</label><label class="mobile-toggle-line"><input name="allDay" type="checkbox" checked /> 종일</label><div class="mobile-time-row"><input name="startTime" type="time" value="09:00" /><input name="endTime" type="time" value="10:00" /></div></section>
      <section><h3>세부내용</h3><textarea name="detail" placeholder="세부내용"></textarea></section>
    `;
  } else {
    body = `
      <section><h3>기본정보</h3><input name="title" placeholder="일정명" required />${mobileProjectWorkSelect()}</section>
      <section><h3>일정</h3><label>날짜<input name="date" type="date" value="${today}" /></label><label class="mobile-toggle-line"><input name="allDay" type="checkbox" checked /> 종일</label><div class="mobile-time-row"><input name="startTime" type="time" value="09:00" /><input name="endTime" type="time" value="10:00" /></div></section>
      <section><h3>담당자</h3>${mobileOwnerCheckboxes("owners")}</section>
      <section><h3>메모</h3><input name="location" placeholder="장소" /><textarea name="memo" placeholder="메모"></textarea></section>
    `;
  }
  return `
    <header><button type="button" data-close-mobile-add>닫기</button><strong>${esc(title)}</strong><button type="submit">${esc(submitLabel)}</button></header>
    <div class="mobile-add-body">${body}</div>
    <footer><button class="pill primary" type="submit">${esc(submitLabel)}</button></footer>
  `;
}

function openMobileAddSheet(mode) {
  mobileAddMode = mode;
  const sheet = $("#mobileAddSheet");
  const form = $("#mobileAddForm");
  if (!sheet || !form) return;
  form.innerHTML = renderMobileAddForm(mode);
  sheet.classList.add("open");
  sheet.setAttribute("aria-hidden", "false");
}

function mobileFormOwners(form) {
  return Array.from(form.querySelectorAll('input[name="owners"]:checked')).map((input) => input.value);
}

function submitMobileAddForm(form) {
  const data = new FormData(form);
  const today = dateKey(new Date());
  if (mobileAddMode === "project") {
    const project = {
      id: makeId(),
      title: String(data.get("title") || "").trim() || "새 영상 프로젝트",
      method: "",
      type: String(data.get("type") || ""),
      owners: mobileFormOwners(form),
      client: String(data.get("client") || ""),
      note: "",
      status: String(data.get("status") || ""),
      kickoffDate: String(data.get("kickoffDate") || today),
      shootDate: String(data.get("shootDate") || today),
      firstEditDate: String(data.get("firstEditDate") || today),
      finalDate: String(data.get("finalDate") || today),
      progress: 0,
      budget: 0,
      spent: 0,
      memo: String(data.get("memo") || ""),
      records: []
    };
    state.projects.unshift(project);
    saveState();
    closeMobileAddSheet();
    mobileActiveSection = "projects";
    renderAll();
    return;
  }
  if (mobileAddMode === "work") {
    const work = {
      id: makeId(),
      title: String(data.get("title") || "").trim() || "새 업무",
      type: String(data.get("type") || ""),
      owners: mobileFormOwners(form),
      client: String(data.get("client") || ""),
      status: String(data.get("status") || ""),
      noSchedule: Boolean(data.get("noSchedule")),
      kickoffDate: String(data.get("kickoffDate") || today),
      finalDate: String(data.get("finalDate") || today),
      calendarFields: { ...defaultWorkCalendarFields },
      studioReservationEnabled: false,
      studioReservationId: "",
      studioReservation: null,
      memo: String(data.get("memo") || ""),
      tasks: [],
      records: []
    };
    state.works.unshift(work);
    saveState();
    closeMobileAddSheet();
    mobileActiveSection = "works";
    renderAll();
    return;
  }
  if (mobileAddMode === "task") {
    const target = String(data.get("target") || "");
    if (!target) {
      showToast("프로젝트 또는 업무를 선택하세요.");
      return;
    }
    const task = {
      id: makeId(),
      text: String(data.get("title") || "").trim() || "새 할 일",
      detail: String(data.get("detail") || ""),
      type: String(data.get("type") || ""),
      owners: mobileFormOwners(form),
      owner: mobileFormOwners(form)[0] || "",
      dueDate: data.get("noDueDate") ? "" : String(data.get("dueDate") || today),
      noDueDate: Boolean(data.get("noDueDate")),
      allDay: Boolean(data.get("allDay")),
      startTime: String(data.get("startTime") || "09:00"),
      endTime: String(data.get("endTime") || "10:00"),
      calendar: true,
      done: false,
      createdAt: new Date().toISOString()
    };
    if (target.startsWith("project:")) {
      task.projectId = target.replace("project:", "");
      state.tasks.unshift(task);
    } else {
      const work = state.works.find((item) => item.id === target.replace("work:", ""));
      if (!work) return;
      work.tasks = Array.isArray(work.tasks) ? work.tasks : [];
      work.tasks.unshift(task);
    }
    saveState();
    closeMobileAddSheet();
    mobileActiveSection = "tasks";
    renderAll();
    return;
  }
  if (mobileAddMode === "schedule") {
    state.schedules.push({
      id: makeId(),
      title: String(data.get("title") || "").trim() || "새 일정",
      owners: mobileFormOwners(form),
      location: String(data.get("location") || ""),
      memo: String(data.get("memo") || ""),
      date: String(data.get("date") || today),
      allDay: Boolean(data.get("allDay")),
      startTime: String(data.get("startTime") || "09:00"),
      endTime: String(data.get("endTime") || "10:00")
    });
    saveState();
    closeMobileAddSheet();
    mobileActiveSection = "calendar";
    renderAll();
  }
}

function renderAll() {
  renderKpis();
  renderWorkSummary();
  renderStatusMix();
  renderUpcoming();
  renderProjectList();
  renderWorkList();
  renderTasks();
  renderPriority();
  renderCalendar();
  renderStudioManage();
  renderAdmin();
  renderAuth();
  renderMobileDashboard();
}

document.addEventListener("click", () => {
  closeDropdown();
  closeDatePicker();
  closeTimePicker();
  if (isProjectFilterOpen) {
    isProjectFilterOpen = false;
    $("#projectFilterPanel")?.classList.remove("open");
    $("#projectFilterBtn")?.setAttribute("aria-expanded", "false");
  }
});
$("#dropdownLayer").addEventListener("click", (event) => event.stopPropagation());
$("#datePickerLayer").addEventListener("click", (event) => event.stopPropagation());
$("#timePickerLayer").addEventListener("click", (event) => event.stopPropagation());
$$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$$("[data-mobile-section]").forEach((button) => button.addEventListener("click", () => { openMobileSection(button.dataset.mobileSection); openMobileMoreSheet(false); toggleMobileFab(false); }));
$("[data-mobile-more]")?.addEventListener("click", () => openMobileMoreSheet(true));
$$("[data-close-mobile-sheet]").forEach((button) => button.addEventListener("click", () => openMobileMoreSheet(false)));
$$("[data-close-mobile-add]").forEach((button) => button.addEventListener("click", () => closeMobileAddSheet()));
$("#mobileNotifyBtn")?.addEventListener("click", () => openMobileMoreSheet(true));
$("#mobileFabBtn")?.addEventListener("click", () => toggleMobileFab());
$("#mobileFabMenu")?.addEventListener("click", (event) => {
  const mode = event.target.closest("[data-mobile-add]")?.dataset.mobileAdd;
  if (!mode) return;
  toggleMobileFab(false);
  openMobileAddSheet(mode);
});
$("#mobileMoreSheet")?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-mobile-more-target]")?.dataset.mobileMoreTarget;
  if (!target) return;
  openMobileMoreSheet(false);
  openMobileSection(target);
});
$("#mobileAddSheet")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-mobile-add]")) closeMobileAddSheet();
});
$("#mobileAddForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitMobileAddForm(event.currentTarget);
});
$("#mobileApp")?.addEventListener("change", (event) => {
  const hideDone = event.target.closest("[data-mobile-hide-done]");
  if (hideDone) {
    mobileTaskHideDone = hideDone.checked;
    saveViewPrefs({ mobileTaskHideDone });
    renderMobileDashboard();
    return;
  }
  const taskId = event.target.dataset.overviewTaskCheck;
  if (!taskId) return;
  const source = event.target.dataset.overviewTaskSource;
  const item = taskOverviewItems().find((entry) => entry.id === taskId && entry.source === source);
  if (!item || !item.canManage) {
    event.target.checked = !event.target.checked;
    showToast("담당자 또는 관리자만 할 일을 변경할 수 있습니다.");
    return;
  }
  item.task.done = event.target.checked;
  saveState();
  renderAll();
});
$("#mobileApp")?.addEventListener("click", (event) => {
  if (event.target.closest("#mobileInlineLogoutBtn")) {
    $("#logoutBtn")?.click();
    return;
  }
  const moreTarget = event.target.closest("[data-mobile-more-target]")?.dataset.mobileMoreTarget;
  if (moreTarget) {
    openMobileSection(moreTarget);
    return;
  }
  const projectId = event.target.closest("[data-mobile-open-project]")?.dataset.mobileOpenProject;
  if (projectId) openProjectDetail(projectId);
  const workId = event.target.closest("[data-mobile-open-work]")?.dataset.mobileOpenWork;
  if (workId) openWorkDetail(workId);
  const filter = event.target.closest("[data-mobile-task-filter]")?.dataset.mobileTaskFilter;
  if (filter) {
    mobileTaskFilter = filter;
    mobileTaskSortOpen = false;
    saveViewPrefs({ mobileTaskFilter });
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-open-sort]")) {
    mobileTaskSortOpen = !mobileTaskSortOpen;
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-close-sort]")) {
    mobileTaskSortOpen = false;
    renderMobileDashboard();
    return;
  }
  const sort = event.target.closest("[data-mobile-task-sort]")?.dataset.mobileTaskSort;
  if (sort) {
    mobileTaskSort = normalizeTaskSort(sort);
    mobileTaskSortOpen = false;
    saveViewPrefs({ mobileTaskSort });
    renderMobileDashboard();
    return;
  }
  const taskButton = event.target.closest("[data-mobile-open-task-id]");
  if (taskButton) {
    const item = taskOverviewItems().find((entry) => entry.id === taskButton.dataset.mobileOpenTaskId && entry.source === taskButton.dataset.mobileOpenTaskSource);
    if (item?.source === "project" && item.projectId) {
      highlightedProjectTaskId = item.id;
      openProjectDetail(item.projectId);
      activeDetailTab = "tasks";
      renderDetailTabs();
    }
    if (item?.source === "work" && item.workId) {
      highlightedWorkTaskId = item.id;
      openWorkDetail(item.workId);
      activeWorkDetailTab = "tasks";
      renderWorkDetailTabs();
    }
  }
  const monthDate = event.target.closest("[data-mobile-month-date]")?.dataset.mobileMonthDate;
  if (monthDate) openScheduleModal(monthDate);
});
$("#mobileLogoutBtn")?.addEventListener("click", () => $("#logoutBtn")?.click());
$("#mobileInlineLogoutBtn")?.addEventListener("click", () => $("#logoutBtn")?.click());
$$("[data-go]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.go)));

$("#addProjectBtn").addEventListener("click", addProject);
$("#addWorkBtn").addEventListener("click", addWork);
$("#projectSearchInput").addEventListener("input", (event) => {
  projectSearchQuery = event.target.value;
  saveViewPrefs({ projectSearchQuery });
  renderProjectList();
  const input = $("#projectSearchInput");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
});

$("#projectFilterBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  isProjectFilterOpen = !isProjectFilterOpen;
  renderProjectList();
});

$("#projectFilterPanel").addEventListener("click", (event) => {
  event.stopPropagation();
});

$("#projectsView").addEventListener("click", (event) => {
  const sortButton = event.target.closest("[data-project-sort]");
  if (!sortButton) return;
  const key = sortButton.dataset.projectSort;
  if (projectSort.key === key) {
    projectSort.direction = projectSort.direction === "asc" ? "desc" : "asc";
  } else {
    projectSort = { key, direction: "asc" };
  }
  saveViewPrefs({ projectSort });
  renderProjectList();
});
$("#workSearchInput").addEventListener("input", (event) => {
  workSearchQuery = event.target.value;
  saveViewPrefs({ workSearchQuery });
  renderWorkList();
  const input = $("#workSearchInput");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
});
$("#worksView").addEventListener("click", (event) => {
  const sortButton = event.target.closest("[data-work-sort]");
  if (!sortButton) return;
  const key = sortButton.dataset.workSort;
  if (workSort.key === key) {
    workSort.direction = workSort.direction === "asc" ? "desc" : "asc";
  } else {
    workSort = { key, direction: "asc" };
  }
  saveViewPrefs({ workSort });
  renderWorkList();
});
$("#worksView").addEventListener("input", (event) => {
  const titleInput = event.target.closest("[data-work-title]");
  if (!titleInput) return;
  const work = state.works.find((item) => item.id === titleInput.dataset.workTitle);
  if (!work || !canEditWork(work)) return;
  work.title = titleInput.value;
  saveState();
});
$("#worksView").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-work-noschedule]");
  if (!checkbox) return;
  const work = state.works.find((item) => item.id === checkbox.dataset.workNoschedule);
  if (!work || !canEditWork(work)) return;
  work.noSchedule = checkbox.checked;
  saveState();
  renderAll();
});
$("#exportBtn").addEventListener("click", exportCsv);
$("#seedBtn").addEventListener("click", () => {
  if (!isAdminUser()) return;
  const preservedOptions = structuredClone(state.options || sampleData.options);
  const currentOwnerDefaultsVersion = state.ownerDefaultsVersion || 2;
  state = migrateOwnerState({ ...structuredClone(sampleData), options: preservedOptions, ownerDefaultsVersion: currentOwnerDefaultsVersion });
  taskDraft = { projectId: state.projects[0]?.id || "", owner: ownerOptions()[0] || "", dueDate: dateKey(new Date()) };
  detailTaskDraft = { title: "", detail: "", type: "", owners: [], dueDate: dateKey(new Date()), noDueDate: false, allDay: true, startTime: "09:00", endTime: "10:00", calendar: false, editingTaskId: null };
  scheduleDraft = { owners: ownerOptions()[0] ? [ownerOptions()[0]] : [], date: dateKey(new Date()), allDay: true, startTime: "09:00", endTime: "10:00" };
  staffScheduleDraft = { title: "", room: "", type: "", owner: "", trainingType: "", date: dateKey(new Date()), allDay: false, startTime: "09:00", endTime: "10:00", repeatEnabled: false, repeatCount: 8, repeatDays: [], repeatEndMode: "none", repeatUntil: "", staffRows: [] };
  recurringTrainingDraft = { room: studioRoomOptions()[0] || "", type: staffTypeOptions().includes("정기교육") ? "정기교육" : staffTypeOptions()[0] || "", owner: "", trainingType: trainingTypeOptions()[0] || "", startDate: dateKey(new Date()), repeat: "매주", count: 8, allDay: true, startTime: "09:00", endTime: "10:00" };
  saveState();
  renderAll();
});

$("#authForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if ($("#authForm").classList.contains("signup-mode")) return;
  login($("#authId").value, $("#authPassword").value);
});

$("#signupBtn").addEventListener("click", () => showAuthMode("signup"));

$("#backLoginBtn").addEventListener("click", () => showAuthMode("login"));

$("#createAccountBtn").addEventListener("click", () => {
  signup(
    $("#signupEmail").value,
    $("#signupPassword").value,
    $("#signupPasswordConfirm").value,
    $("#signupName").value,
    $("#signupPosition").value
  );
});

$("#logoutBtn").addEventListener("click", async () => {
  if (SUPABASE_ENABLED) await getSupabaseClient()?.auth.signOut();
  currentProfile = null;
  state.currentUser = null;
  saveState();
  renderAll();
});

document.body.addEventListener("click", (event) => {
  const projectId = event.target.closest("[data-open-project]")?.dataset.openProject;
  if (projectId) openProjectDetail(projectId);
  if (event.target.closest("button, input, label, textarea, .custom-select, .date-button")) return;
  const workId = event.target.closest("[data-open-work]")?.dataset.openWork;
  if (workId) openWorkDetail(workId);
});

$("#calendarView").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-calendar-filter]");
  if (!checkbox) return;
  const key = checkbox.dataset.calendarFilter;
  if (key === "all") {
    calendarFilters = { video: checkbox.checked, work: checkbox.checked, staff: checkbox.checked };
  } else {
    calendarFilters[key] = checkbox.checked;
  }
  saveViewPrefs({ calendarFilters });
  renderCalendar();
});

$("#studioView").addEventListener("click", (event) => {
  const modeButton = event.target.closest("[data-studio-view-mode]");
  if (modeButton) {
    studioViewMode = modeButton.dataset.studioViewMode;
    saveViewPrefs({ studioViewMode });
    renderStudioManage();
    return;
  }
  if (event.target.closest("#studioTodayBtn")) {
    studioWeekDate = new Date();
    saveViewPrefs({ studioWeekDate: dateKey(studioWeekDate) });
    renderStudioManage();
    return;
  }
  if (event.target.closest("#studioPrevWeekInlineBtn")) {
    studioWeekDate.setDate(studioWeekDate.getDate() + (studioViewMode === "month" ? -31 : -7));
    saveViewPrefs({ studioWeekDate: dateKey(studioWeekDate) });
    renderStudioManage();
    return;
  }
  if (event.target.closest("#studioNextWeekInlineBtn")) {
    studioWeekDate.setDate(studioWeekDate.getDate() + (studioViewMode === "month" ? 31 : 7));
    saveViewPrefs({ studioWeekDate: dateKey(studioWeekDate) });
    renderStudioManage();
    return;
  }
  if (event.target.closest("#studioAddStaffBtn")) openStaffScheduleModal(dateKey(studioWeekDate));
  if (event.target.closest("[data-open-nearest-unassigned]")) {
    openNearestUnassignedStudioEvent();
    return;
  }
  const eventButton = event.target.closest("[data-open-studio-event]");
  if (eventButton) {
    openStaffEventDetail(eventButton.dataset.openStudioEvent);
    return;
  }
  const monthDay = event.target.closest("[data-studio-month-date]");
  if (monthDay && studioViewMode === "month") openStaffScheduleModal(monthDay.dataset.studioMonthDate);
});

$("#studioView").addEventListener("change", (event) => {
  const filter = event.target.closest("[data-studio-training-filter]");
  if (!filter) return;
  const types = trainingTypeOptions();
  if (filter.dataset.studioTrainingFilter === "all") {
    types.forEach((type) => {
      studioTrainingTypeFilters[type] = filter.checked;
    });
  } else {
    studioTrainingTypeFilters[filter.dataset.studioTrainingFilter] = filter.checked;
  }
  saveViewPrefs({ studioTrainingTypeFilters });
  renderStudioManage({ preserveScroll: true });
});

$("#studioView").addEventListener("pointerdown", (event) => {
  if (event.target.closest("[data-open-studio-event], button, input, label")) return;
  if (studioViewMode === "month") return;
  const cell = event.target.closest(".studio-time-cell");
  if (!cell) return;
  event.preventDefault();
  beginStudioCellDrag(cell, event);
});

$("#studioView").addEventListener("pointerover", (event) => {
  if (!studioDragDraft) return;
  updateStudioCellDrag(event.target.closest(".studio-time-cell"), event);
});

$("#studioView").addEventListener("pointermove", (event) => {
  if (!studioDragDraft) return;
  updateStudioCellDrag(event.target.closest(".studio-time-cell"), event);
});

document.addEventListener("pointerup", finishStudioCellDrag);

$("#studioView").addEventListener("dragstart", (event) => {
  const button = event.target.closest("[data-drag-studio-event]");
  if (!button) return;
  event.dataTransfer.setData("text/plain", button.dataset.dragStudioEvent);
  event.dataTransfer.effectAllowed = "move";
});

$("#studioView").addEventListener("dragover", (event) => {
  if (!event.target.closest(".studio-time-cell, [data-studio-month-date]")) return;
  event.preventDefault();
});

$("#studioView").addEventListener("drop", (event) => {
  const cell = event.target.closest(".studio-time-cell");
  const monthDay = event.target.closest("[data-studio-month-date]");
  const eventId = event.dataTransfer.getData("text/plain");
  if (!eventId) return;
  event.preventDefault();
  if (cell) moveStudioEventToCell(eventId, cell, event);
  else if (monthDay) moveStudioEventToDate(eventId, monthDay.dataset.studioMonthDate);
});

$("#calendarGrid").addEventListener("click", (event) => {
  const calendarEvent = event.target.closest(".calendar-event");
  if (calendarEvent) {
    openCalendarEventDetail(calendarEvent);
    return;
  }
  const day = event.target.closest("[data-calendar-date]");
  if (!day) return;
  openScheduleModal(day.dataset.calendarDate);
});


$("#calendarGrid").addEventListener("dragstart", (event) => {
  const eventButton = event.target.closest(".calendar-event");
  if (!eventButton) return;
  const payload = {
    source: eventButton.dataset.eventSource,
    id: eventButton.dataset.eventId,
    projectId: eventButton.dataset.projectId,
    workId: eventButton.dataset.workId,
    field: eventButton.dataset.eventField,
    scheduleId: eventButton.dataset.scheduleId,
    staffEventId: eventButton.dataset.staffEventId
  };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/json", JSON.stringify(payload));
  eventButton.classList.add("is-dragging");
});

$("#calendarGrid").addEventListener("dragend", (event) => {
  event.target.closest(".calendar-event")?.classList.remove("is-dragging");
  $$(".calendar-day").forEach((day) => day.classList.remove("is-drop-target"));
});

$("#calendarGrid").addEventListener("dragover", (event) => {
  const day = event.target.closest("[data-calendar-date]");
  if (!day) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  $$(".calendar-day").forEach((item) => item.classList.toggle("is-drop-target", item === day));
});

$("#calendarGrid").addEventListener("dragleave", (event) => {
  const day = event.target.closest("[data-calendar-date]");
  if (day && !day.contains(event.relatedTarget)) day.classList.remove("is-drop-target");
});

$("#calendarGrid").addEventListener("drop", (event) => {
  const day = event.target.closest("[data-calendar-date]");
  if (!day) return;
  event.preventDefault();
  $$(".calendar-day").forEach((item) => item.classList.remove("is-drop-target"));
  try {
    moveCalendarEvent(JSON.parse(event.dataTransfer.getData("application/json")), day.dataset.calendarDate);
  } catch {
    showToast("일정을 이동하지 못했습니다.");
  }
});

$("#closeDetailBtn").addEventListener("click", closeProjectDetail);
$("#deleteDetailBtn").addEventListener("click", () => {
  if (activeProjectId) confirmDelete(() => deleteProject(activeProjectId));
});
$("#projectDetail").addEventListener("click", (event) => {
  if (event.target.id === "projectDetail") closeProjectDetail();
});
$("#detailTitle").addEventListener("input", (event) => updateActiveProject("title", event.target.value, false));
$("#detailTitle").addEventListener("change", (event) => updateActiveProject("title", event.target.value));
$("#detailMemo").addEventListener("input", (event) => updateActiveProject("memo", richMemoValue(event.target), false));
$("#detailMemo").addEventListener("keyup", () => updateMemoToolbarState("detailMemo"));
$("#detailMemo").addEventListener("mouseup", () => updateMemoToolbarState("detailMemo"));
$("#detailMemo").addEventListener("focus", () => updateMemoToolbarState("detailMemo"));
$("#closeWorkDetailBtn").addEventListener("click", closeWorkDetail);
$("#deleteWorkDetailBtn").addEventListener("click", () => {
  if (activeWorkId) confirmDelete(() => deleteWork(activeWorkId));
});
$("#deleteConfirmCancelBtn").addEventListener("click", closeDeleteConfirm);
$("#deleteConfirmBtn").addEventListener("click", runDeleteConfirm);
$("#deleteConfirmModal").addEventListener("click", (event) => {
  if (event.target.id === "deleteConfirmModal") closeDeleteConfirm();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#deleteConfirmModal")?.classList.contains("open")) closeDeleteConfirm();
});
$("#workDetail").addEventListener("click", (event) => {
  if (event.target.id === "workDetail") closeWorkDetail();
});
$("#workDetailTitle").addEventListener("input", (event) => updateActiveWork("title", event.target.value, false));
$("#workDetailTitle").addEventListener("change", (event) => updateActiveWork("title", event.target.value));
$("#workDetailMemo").addEventListener("input", (event) => updateActiveWork("memo", richMemoValue(event.target), false));

$("#workDetailStudioTab").addEventListener("change", (event) => {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work || !canEditWork(work)) return;
  if (event.target.id === "workStudioEnabled") {
    work.studioReservationEnabled = event.target.checked;
    if (work.studioReservationEnabled) {
      work.calendarFields = { ...defaultWorkCalendarFields, kickoffDate: false, finalDate: false };
      ensureWorkStudioReservation(work);
    } else {
      removeWorkStudioReservation(work);
      return;
    }
    saveState();
    renderAll();
    renderWorkDetail();
  }
  if (event.target.id === "workStudioAllDay") {
    ensureWorkStudioReservation(work).allDay = event.target.checked;
    renderWorkStudioReservation(work);
  }
});

$("#workDetailStudioTab").addEventListener("input", (event) => {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work || !canEditWork(work) || !work.studioReservationEnabled) return;
  const reservation = ensureWorkStudioReservation(work);
  if (event.target.id === "workStudioTitle") reservation.title = event.target.value;
  if (event.target.id === "workStudioMemo") reservation.memo = event.target.value;
  const memoInput = event.target.closest("[data-work-studio-row-memo]");
  if (memoInput) {
    const row = reservation.staffRows.find((item) => item.id === memoInput.dataset.workStudioRowMemo);
    if (row) row.memo = memoInput.value;
  }
});

$("#workDetailStudioTab").addEventListener("click", (event) => {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work || !canEditWork(work) || !work.studioReservationEnabled) return;
  const reservation = ensureWorkStudioReservation(work);
  if (event.target.closest("#workStudioAddStaffBtn")) {
    if (reservation.staffRows.length < 6) reservation.staffRows.push(makeDefaultStaffRow(reservation.staffRows.length));
    renderWorkStudioReservation(work);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-work-studio-row]");
  if (deleteButton && reservation.staffRows.length > 1) {
    reservation.staffRows = reservation.staffRows.filter((row) => row.id !== deleteButton.dataset.deleteWorkStudioRow);
    renderWorkStudioReservation(work);
    return;
  }
  if (event.target.closest("#workStudioSaveBtn")) {
    const title = $("#workStudioTitle");
    const memo = $("#workStudioMemo");
    if (title) reservation.title = title.value.trim();
    if (memo) reservation.memo = memo.value.trim();
    syncWorkStudioReservation(work);
  }
});

$("#workDetailMemo").addEventListener("keyup", () => updateMemoToolbarState("workDetailMemo"));
$("#workDetailMemo").addEventListener("mouseup", () => updateMemoToolbarState("workDetailMemo"));
$("#workDetailMemo").addEventListener("focus", () => updateMemoToolbarState("workDetailMemo"));
$$("[data-memo-format]").forEach((button) => {
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => applyMemoFormat(button.dataset.memoTarget, button.dataset.memoFormat));
});
document.addEventListener("selectionchange", updateAllMemoToolbarStates);
$("#workDetail .detail-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-work-detail-tab]");
  if (!tab) return;
  activeWorkDetailTab = tab.dataset.workDetailTab;
  renderWorkDetailTabs();
});
document.querySelector(".detail-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-detail-tab]");
  if (!tab) return;
  activeDetailTab = tab.dataset.detailTab;
  renderDetailTabs();
});

$("#workTaskPanel").addEventListener("click", (event) => {
  const sortButton = event.target.closest("[data-work-task-sort]");
  if (sortButton) {
    syncWorkTaskDraftInputs();
    workTaskSort = sortButton.dataset.workTaskSort;
    saveViewPrefs({ workTaskSort });
    const work = state.works.find((item) => item.id === activeWorkId);
    if (work) renderWorkTasks(work);
    return;
  }
  const workTypeChip = event.target.closest("[data-work-task-type-chip]");
  if (workTypeChip) {
    const work = state.works.find((item) => item.id === activeWorkId);
    if (work) {
      syncWorkTaskDraftInputs();
      workTaskDraft.type = workTypeChip.dataset.workTaskTypeChip;
      renderWorkTasks(work);
    }
    return;
  }
  if (event.target.closest("#resetWorkTaskFormBtn")) {
    const work = state.works.find((item) => item.id === activeWorkId);
    if (work) {
      resetWorkTaskDraft(work);
      workTaskComposerOpen = true;
      renderWorkTasks(work);
    }
    return;
  }
  if (event.target.closest("[data-work-task-composer-toggle]")) {
    const work = state.works.find((item) => item.id === activeWorkId);
    if (work && canEditWork(work)) {
      if (workTaskComposerOpen || workTaskDraft.editingTaskId) {
        syncWorkTaskDraftInputs();
        if (workTaskDraft.editingTaskId) resetWorkTaskDraft(work);
        workTaskComposerOpen = false;
      } else {
        workTaskComposerOpen = true;
      }
      renderWorkTasks(work);
    }
    return;
  }
  if (event.target.closest("#addWorkTaskBtn")) {
    addWorkTask();
    return;
  }
  const editButton = event.target.closest("[data-edit-work-task]");
  if (editButton) {
    editWorkTask(editButton.dataset.editWorkTask);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-work-task]");
  if (!deleteButton) return;
  const work = state.works.find((item) => item.id === activeWorkId);
  const taskId = deleteButton.dataset.deleteWorkTask;
  const task = work?.tasks?.find((item) => item.id === taskId);
  if (!canManageWorkTask(work, task)) {
    showToast("담당자 또는 관리자만 삭제할 수 있습니다.");
    return;
  }
  confirmDelete(() => {
    work.tasks = work.tasks.filter((item) => item.id !== taskId);
    saveState();
    renderAll();
    renderWorkDetail();
  });
});

$("#workTaskPanel").addEventListener("change", (event) => {
  const taskId = event.target.dataset.workTaskCheck;
  if (!taskId) return;
  const work = state.works.find((item) => item.id === activeWorkId);
  const task = work?.tasks?.find((item) => item.id === taskId);
  if (!canManageWorkTask(work, task)) {
    event.target.checked = !event.target.checked;
    showToast("담당자 또는 관리자만 할 일을 변경할 수 있습니다.");
    return;
  }
  task.done = event.target.checked;
  saveState();
  renderAll();
  renderWorkDetail();
});

$("#workManagementRecords").addEventListener("click", (event) => {
  const filterButton = event.target.closest("[data-work-record-filter]");
  if (filterButton) {
    workRecordFilterMode = filterButton.dataset.workRecordFilter;
    saveViewPrefs({ workRecordFilterMode });
    const work = state.works.find((item) => item.id === activeWorkId);
    if (work) renderWorkManagementRecords(work);
    return;
  }
  const editButton = event.target.closest("[data-edit-work-record]");
  if (editButton) {
    editingWorkRecordId = editButton.dataset.editWorkRecord;
    const work = state.works.find((item) => item.id === activeWorkId);
    if (work) renderWorkManagementRecords(work);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-work-record]");
  if (deleteButton) {
    confirmDelete(() => deleteWorkManagementRecord(deleteButton.dataset.deleteWorkRecord));
    return;
  }
  if (event.target.closest("#cancelWorkRecordEditBtn")) {
    editingWorkRecordId = null;
    const work = state.works.find((item) => item.id === activeWorkId);
    if (work) renderWorkManagementRecords(work);
    return;
  }
  if (event.target.closest("#addWorkRecordBtn")) addWorkManagementRecord();
});

$("#workManagementRecords").addEventListener("input", (event) => {
  if (event.target.id !== "workRecordSearchInput") return;
  workRecordSearchQuery = event.target.value;
  const work = state.works.find((item) => item.id === activeWorkId);
  if (work) {
    renderWorkManagementRecords(work);
    const input = $("#workRecordSearchInput");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
});

$("#managementRecords").addEventListener("click", (event) => {
  const filterButton = event.target.closest("[data-record-filter]");
  if (filterButton) {
    recordFilterMode = filterButton.dataset.recordFilter;
    saveViewPrefs({ recordFilterMode });
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project) renderManagementRecords(project);
    return;
  }
  const editButton = event.target.closest("[data-edit-record]");
  if (editButton) {
    editingRecordId = editButton.dataset.editRecord;
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project) renderManagementRecords(project);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-record]");
  if (deleteButton) {
    confirmDelete(() => deleteManagementRecord(deleteButton.dataset.deleteRecord));
    return;
  }
  if (event.target.closest("#cancelRecordEditBtn")) {
    editingRecordId = null;
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project) renderManagementRecords(project);
    return;
  }
  if (event.target.closest("#addRecordBtn")) addManagementRecord();
});

$("#managementRecords").addEventListener("input", (event) => {
  if (event.target.id !== "recordSearchInput") return;
  recordSearchQuery = event.target.value;
  const project = state.projects.find((item) => item.id === activeProjectId);
  if (project) {
    renderManagementRecords(project);
    const input = $("#recordSearchInput");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
});

$("#projectTaskPanel").addEventListener("click", (event) => {
  const sortButton = event.target.closest("[data-project-task-sort]");
  if (sortButton) {
    syncProjectTaskDraftInputs();
    detailTaskSort = sortButton.dataset.projectTaskSort;
    saveViewPrefs({ detailTaskSort });
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project) renderProjectTasks(project);
    return;
  }
  const projectTypeChip = event.target.closest("[data-project-task-type-chip]");
  if (projectTypeChip) {
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project) {
      syncProjectTaskDraftInputs();
      detailTaskDraft.type = projectTypeChip.dataset.projectTaskTypeChip;
      renderProjectTasks(project);
    }
    return;
  }
  if (event.target.closest("#resetProjectTaskFormBtn")) {
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project) {
      resetProjectTaskDraft(project);
      detailTaskComposerOpen = true;
      renderProjectTasks(project);
    }
    return;
  }
  if (event.target.closest("[data-project-task-composer-toggle]")) {
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project && canEditProject(project)) {
      if (detailTaskComposerOpen || detailTaskDraft.editingTaskId) {
        syncProjectTaskDraftInputs();
        if (detailTaskDraft.editingTaskId) resetProjectTaskDraft(project);
        detailTaskComposerOpen = false;
      } else {
        detailTaskComposerOpen = true;
      }
      renderProjectTasks(project);
    }
    return;
  }
  if (event.target.closest("#addProjectTaskBtn")) {
    addProjectTask();
    return;
  }
  const editButton = event.target.closest("[data-edit-project-task]");
  if (editButton) {
    editProjectTask(editButton.dataset.editProjectTask);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-project-task]");
  if (!deleteButton) return;
  const taskId = deleteButton.dataset.deleteProjectTask;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!canManageTask(task)) {
    showToast("담당자 또는 관리자만 삭제할 수 있습니다.");
    return;
  }
  confirmDelete(() => {
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    saveState();
    renderAll();
    renderProjectDetail();
  });
});

$("#projectTaskPanel").addEventListener("change", (event) => {
  const taskId = event.target.dataset.projectTaskCheck;
  if (!taskId) return;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!canManageTask(task)) {
    event.target.checked = !event.target.checked;
    showToast("담당자 또는 관리자만 할 일을 변경할 수 있습니다.");
    return;
  }
  task.done = event.target.checked;
  saveState();
  renderAll();
  renderProjectDetail();
});

$("#taskList").addEventListener("change", (event) => {
  const taskId = event.target.dataset.overviewTaskCheck;
  if (!taskId) return;
  const source = event.target.dataset.overviewTaskSource;
  const item = taskOverviewItems().find((entry) => entry.id === taskId && entry.source === source);
  if (!item || !item.canManage) {
    event.target.checked = !event.target.checked;
    showToast("담당자 또는 관리자만 할 일을 변경할 수 있습니다.");
    return;
  }
  item.task.done = event.target.checked;
  saveState();
  renderAll();
});

$("#taskList").addEventListener("click", (event) => {
  const row = event.target.closest(".overview-task-row");
  if (!row || event.target.closest("input")) return;
  const checkbox = row.querySelector("[data-overview-task-check]");
  const item = taskOverviewItems().find((entry) => entry.id === checkbox?.dataset.overviewTaskCheck && entry.source === checkbox?.dataset.overviewTaskSource);
  if (!item) return;
  if (item.source === "project") {
    highlightedProjectTaskId = item.id;
    openProjectDetail(item.sourceId);
    activeDetailTab = "tasks";
    renderDetailTabs();
    clearTaskHighlight("project");
  }
  if (item.source === "work") {
    highlightedWorkTaskId = item.id;
    openWorkDetail(item.sourceId);
    activeWorkDetailTab = "tasks";
    renderWorkDetailTabs();
    clearTaskHighlight("work");
  }
});

$("#hideDoneTasks").addEventListener("change", (event) => {
  taskOverviewHideDone = event.target.checked;
  saveViewPrefs({ taskOverviewHideDone });
  renderTasks();
});

$("#taskOverviewSearch").addEventListener("input", (event) => {
  taskOverviewSearch = event.target.value;
  saveViewPrefs({ taskOverviewSearch });
  renderTasks();
  $("#taskOverviewSearch").focus();
});

$("#tasksView").addEventListener("click", (event) => {
  const filterButton = event.target.closest("[data-task-overview-filter]");
  if (!filterButton) return;
  taskOverviewFilter = filterButton.dataset.taskOverviewFilter;
  saveViewPrefs({ taskOverviewFilter });
  renderTasks();
});

$("#taskOverviewSort").addEventListener("change", (event) => {
  taskOverviewSort = normalizeTaskSort(event.target.value);
  saveViewPrefs({ taskOverviewSort });
  renderTasks();
});

$("#taskOverviewFilterBtn").addEventListener("click", openTaskOverviewFilter);

$("#closeTaskOverviewFilterBtn").addEventListener("click", closeTaskOverviewFilter);
$("#taskOverviewFilterModal").addEventListener("click", (event) => {
  if (event.target.id === "taskOverviewFilterModal") closeTaskOverviewFilter();
  const chip = event.target.closest("[data-task-filter-kind]");
  if (!chip) return;
  setTaskOverviewFilterValue(chip.dataset.taskFilterKind, chip.dataset.taskFilterValue || "");
  saveViewPrefs({ taskOverviewOwner, taskOverviewType, taskOverviewProject });
  renderTasks();
  openTaskOverviewFilter();
});

$("#prevMonth").addEventListener("click", () => {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1);
  saveViewPrefs({ calendarDate: dateKey(calendarDate) });
  renderCalendar();
});

$("#nextMonth").addEventListener("click", () => {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1);
  saveViewPrefs({ calendarDate: dateKey(calendarDate) });
  renderCalendar();
});

$("#todayBtn").addEventListener("click", () => {
  calendarDate = new Date();
  saveViewPrefs({ calendarDate: dateKey(calendarDate) });
  renderCalendar();
});

function bindTimeInputs(prefix, getDraft, renderControls) {
  const allDayInput = $(`#${prefix}AllDay`);
  const startInput = $(`#${prefix}StartTime`);
  const endInput = $(`#${prefix}EndTime`);
  if (!allDayInput) return;
  allDayInput.addEventListener("change", () => {
    const draft = getDraft();
    draft.allDay = allDayInput.checked;
    renderControls();
  });
  if (!startInput || !endInput) return;
  startInput.addEventListener("input", () => {
    getDraft().startTime = startInput.value || "09:00";
  });
  endInput.addEventListener("input", () => {
    getDraft().endTime = endInput.value || "10:00";
  });
}

bindTimeInputs("schedule", () => scheduleDraft, renderScheduleModalControls);
bindTimeInputs("staffSchedule", () => staffScheduleDraft, renderStaffScheduleModalControls);
bindTimeInputs("recurringTraining", () => recurringTrainingDraft, renderRecurringTrainingControls);


$("#editScheduleEventBtn").addEventListener("click", () => {
  if (activeScheduleEventId) openScheduleEditModal(activeScheduleEventId);
  else if (activeStaffEventId) {
    const staffEventId = activeStaffEventId;
    closeStaffEventDetail();
    openStaffScheduleEditModal(staffEventId);
  }
});
$("#closeScheduleBtn").addEventListener("click", closeScheduleModal);
$("#scheduleModal").addEventListener("click", (event) => {
  if (event.target.id === "scheduleModal") closeScheduleModal();
});
$("#scheduleForm").addEventListener("submit", (event) => {
  event.preventDefault();
  addSchedule();
});

$("#closeStaffScheduleBtn").addEventListener("click", closeStaffScheduleModal);
$("#cancelStaffScheduleBtn").addEventListener("click", closeStaffScheduleModal);
$("#staffScheduleModal").addEventListener("click", (event) => {
  if (event.target.id === "staffScheduleModal") closeStaffScheduleModal();
  if (event.target.closest("#staffScheduleAddStaffBtn, #staffScheduleAddStaffWideBtn")) {
    ensureStaffScheduleRows();
    if (staffScheduleDraft.staffRows.length < 6) {
      staffScheduleDraft.staffRows.push(makeDefaultStaffRow(staffScheduleDraft.staffRows.length));
      renderStaffScheduleModalControls();
    }
  }
  const deleteButton = event.target.closest("[data-delete-staff-row]");
  if (deleteButton) {
    ensureStaffScheduleRows();
    if (staffScheduleDraft.staffRows.length > 1) {
      staffScheduleDraft.staffRows = staffScheduleDraft.staffRows.filter((row) => row.id !== deleteButton.dataset.deleteStaffRow);
      staffScheduleDraft.owner = staffScheduleDraft.staffRows[0]?.owner || staffScheduleDraft.owner;
      renderStaffScheduleModalControls();
    }
  }
});
$("#staffScheduleModal").addEventListener("input", (event) => {
  const memoInput = event.target.closest("[data-staff-row-memo]");
  if (memoInput) {
    const row = staffScheduleDraft.staffRows.find((item) => item.id === memoInput.dataset.staffRowMemo);
    if (row) row.memo = memoInput.value;
  }
  if (event.target.id === "staffScheduleMemo") {
    const count = $("#staffScheduleMemoCount");
    if (count) count.textContent = `${event.target.value.length} / 200`;
  }
  if (event.target.id === "staffScheduleRepeatCount") {
    event.target.value = event.target.value.replace(/\D/g, "");
    staffScheduleDraft.repeatCount = Number(event.target.value) || 1;
  }
});
$("#staffScheduleRepeatEnabled").addEventListener("change", (event) => {
  staffScheduleDraft.repeatEnabled = event.target.checked;
  renderStaffScheduleModalControls();
});
$("#staffScheduleRepeatControls").addEventListener("click", (event) => {
  const dayButton = event.target.closest("[data-staff-repeat-day]");
  if (!dayButton) return;
  const day = Number(dayButton.dataset.staffRepeatDay);
  const days = new Set(staffScheduleDraft.repeatDays || []);
  if (days.has(day)) days.delete(day);
  else days.add(day);
  staffScheduleDraft.repeatDays = [...days].sort((a, b) => a - b);
  renderStaffScheduleModalControls();
});
$("#staffScheduleRepeatControls").addEventListener("change", (event) => {
  if (event.target.id === "staffScheduleRepeatCount") {
    event.target.value = event.target.value.replace(/\D/g, "");
    staffScheduleDraft.repeatCount = Number(event.target.value) || 1;
  }
});
$("#staffScheduleRows").addEventListener("dragstart", (event) => {
  const row = event.target.closest("[data-staff-row]");
  if (!row) return;
  staffRowDragId = row.dataset.staffRow;
  event.dataTransfer.effectAllowed = "move";
});
$("#staffScheduleRows").addEventListener("dragover", (event) => {
  if (event.target.closest("[data-staff-row]")) event.preventDefault();
});
$("#staffScheduleRows").addEventListener("drop", (event) => {
  const target = event.target.closest("[data-staff-row]");
  if (!target || !staffRowDragId || target.dataset.staffRow === staffRowDragId) return;
  event.preventDefault();
  const rows = staffScheduleDraft.staffRows;
  const from = rows.findIndex((row) => row.id === staffRowDragId);
  const to = rows.findIndex((row) => row.id === target.dataset.staffRow);
  if (from < 0 || to < 0) return;
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  staffRowDragId = null;
  staffScheduleDraft.owner = rows[0]?.owner || staffScheduleDraft.owner;
  renderStaffScheduleModalControls();
});
$("#staffScheduleForm").addEventListener("submit", (event) => {
  event.preventDefault();
  addStaffSchedule();
});

$("#closeStaffEventDetailBtn").addEventListener("click", closeStaffEventDetail);
$("#staffEventDetailModal").addEventListener("click", (event) => {
  if (event.target.id === "staffEventDetailModal") closeStaffEventDetail();
  const activeEvent = state.staffEvents.find((item) => item.id === activeStaffEventId);
  if (!activeEvent) return;
  if (event.target.closest("[data-add-detail-staff-row]")) {
    normalizeStaffEventRows(activeEvent);
    if (activeEvent.staffRows.length < 6) {
      activeEvent.staffRows.push(makeDefaultStaffRow(activeEvent.staffRows.length));
      syncStaffEventSummary(activeEvent);
      saveState();
      renderAll();
      renderStaffEventDetailStaffRows(activeEvent);
    }
    return;
  }
  const deleteButton = event.target.closest("[data-delete-detail-staff-row]");
  if (deleteButton) {
    normalizeStaffEventRows(activeEvent);
    if (activeEvent.staffRows.length > 1) {
      activeEvent.staffRows = activeEvent.staffRows.filter((row) => row.id !== deleteButton.dataset.deleteDetailStaffRow);
      syncStaffEventSummary(activeEvent);
      saveState();
      renderAll();
      renderStaffEventDetailStaffRows(activeEvent);
    }
  }
});
$("#staffEventDetailContent").addEventListener("input", (event) => {
  const memoInput = event.target.closest("[data-detail-staff-row-memo]");
  if (!memoInput) return;
  const activeEvent = state.staffEvents.find((item) => item.id === activeStaffEventId);
  if (!activeEvent) return;
  const row = normalizeStaffEventRows(activeEvent).find((item) => item.id === memoInput.dataset.detailStaffRowMemo);
  if (!row) return;
  row.memo = memoInput.value;
  saveState();
});
$("#deleteStaffEventBtn").addEventListener("click", () => {
  if (activeScheduleEventId) confirmDelete(() => deleteScheduleEvent(activeScheduleEventId));
  else if (activeStaffEventId) {
    const event = state.staffEvents.find((item) => item.id === activeStaffEventId);
    if (event?.seriesId) openRepeatDeleteModal(activeStaffEventId);
    else confirmDelete(() => deleteStaffEvent(activeStaffEventId));
  }
});

$("#repeatDeleteCancelBtn").addEventListener("click", closeRepeatDeleteModal);
$("#repeatDeleteOnlyBtn").addEventListener("click", () => {
  if (pendingRepeatDeleteEventId) deleteStaffEvent(pendingRepeatDeleteEventId);
  closeRepeatDeleteModal();
});
$("#repeatDeleteAllBtn").addEventListener("click", () => {
  if (pendingRepeatDeleteEventId) deleteStaffEventSeries(pendingRepeatDeleteEventId);
});
$("#repeatDeleteModal").addEventListener("click", (event) => {
  if (event.target.id === "repeatDeleteModal") closeRepeatDeleteModal();
});

$("#closeRecurringTrainingBtn").addEventListener("click", closeRecurringTrainingModal);
$("#recurringTrainingModal").addEventListener("click", (event) => {
  if (event.target.id === "recurringTrainingModal") closeRecurringTrainingModal();
});
$("#recurringTrainingForm").addEventListener("submit", (event) => {
  event.preventDefault();
  addRecurringTraining();
});

$("#closeRecurringTrainingManageBtn").addEventListener("click", closeRecurringTrainingManageModal);
$("#recurringTrainingManageModal").addEventListener("click", (event) => {
  if (event.target.id === "recurringTrainingManageModal") closeRecurringTrainingManageModal();
  const deleteButton = event.target.closest("[data-delete-training-series]");
  if (deleteButton) confirmDelete(() => deleteRecurringTraining(deleteButton.dataset.deleteTrainingSeries));
});

$("#adminUnlockBtn").addEventListener("click", () => {
  if (!isAdminUser()) {
    $("#adminMessage").textContent = "관리자 권한 계정만 입장할 수 있습니다.";
    return;
  }
  if ($("#adminPassword").value === ADMIN_PASSWORD) {
    isAdminUnlocked = true;
    $("#adminPassword").value = "";
    renderAdmin();
    return;
  }
  $("#adminMessage").textContent = "비밀번호가 맞지 않습니다.";
});

$("#adminContent").addEventListener("submit", (event) => {
  event.preventDefault();
  const manager = event.target.closest("[data-option-group]");
  addOption(manager.dataset.optionGroup, new FormData(event.target).get("option"));
});

$("#adminContent").addEventListener("click", (event) => {
  const saveOwnerLinksButton = event.target.closest("[data-save-owner-links]");
  if (saveOwnerLinksButton) {
    saveOwnerLinksButton.disabled = true;
    saveOwnerLinkSettings().finally(() => {
      saveOwnerLinksButton.disabled = false;
    });
    return;
  }
  const pendingButton = event.target.closest("[data-mark-pending]");
  if (pendingButton) {
    markUserPending(pendingButton.dataset.markPending);
    return;
  }
  const roleButton = event.target.closest("[data-set-role]");
  if (roleButton) {
    const row = roleButton.closest("[data-user-id]");
    setUserRole(row.dataset.userId, roleButton.dataset.setRole);
    return;
  }
  const deleteUserButton = event.target.closest("[data-delete-user]");
  if (deleteUserButton) {
    confirmDelete(() => deleteUser(deleteUserButton.dataset.deleteUser));
    return;
  }
  const editButton = event.target.closest("[data-edit-option]");
  if (editButton) {
    const input = editButton.closest(".admin-chip")?.querySelector("[data-option-edit-value]");
    if (input) {
      input.readOnly = false;
      input.focus();
      input.select();
      input.dataset.editingOption = editButton.dataset.editOption;
    }
    return;
  }
  const value = event.target.dataset.deleteOption;
  if (!value) return;
  const manager = event.target.closest("[data-option-group]");
  confirmDelete(() => deleteOption(manager.dataset.optionGroup, value));
});

$("#adminContent").addEventListener("change", async (event) => {
  const linkSelect = event.target.closest("[data-link-owner-id]");
  if (linkSelect) {
    linkSelect.closest(".owner-link-row")?.classList.add("is-dirty");
    $("#adminContent [data-save-owner-links]")?.classList.add("attention");
    return;
  }
  const input = event.target.closest("[data-option-edit-value]");
  if (!input || input.readOnly || !input.dataset.editingOption) return;
  const manager = input.closest("[data-option-group]");
  renameOption(manager.dataset.optionGroup, input.dataset.editingOption, input.value || "");
});

$("#adminContent").addEventListener("keydown", (event) => {
  const input = event.target.closest("[data-option-edit-value]");
  if (!input || event.key !== "Enter") return;
  event.preventDefault();
  input.blur();
});

$("#adminContent").addEventListener("dragstart", (event) => {
  const chip = event.target.closest("[data-option-index]");
  const manager = event.target.closest("[data-option-group]");
  if (!chip || !manager) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/json", JSON.stringify({
    group: manager.dataset.optionGroup,
    index: Number(chip.dataset.optionIndex)
  }));
});

$("#adminContent").addEventListener("dragover", (event) => {
  if (!event.target.closest("[data-option-index]")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
});

$("#adminContent").addEventListener("drop", (event) => {
  const chip = event.target.closest("[data-option-index]");
  const manager = event.target.closest("[data-option-group]");
  if (!chip || !manager) return;
  event.preventDefault();
  try {
    const payload = JSON.parse(event.dataTransfer.getData("application/json"));
    if (payload.group !== manager.dataset.optionGroup) return;
    reorderOption(payload.group, Number(payload.index), Number(chip.dataset.optionIndex));
  } catch {
    showToast("순서를 변경하지 못했습니다.");
  }
});

const hashView = location.hash.replace("#", "");
if (["overview", "projects", "works", "tasks", "calendar", "studio", "admin"].includes(hashView)) setView(hashView);
renderAll();
initSupabaseSession();

document.addEventListener("pointerdown", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  const rect = button.getBoundingClientRect();
  const ripple = document.createElement("span");
  const size = Math.max(rect.width, rect.height);
  ripple.className = "tap-ripple";
  ripple.style.width = `${size}px`;
  ripple.style.height = `${size}px`;
  ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
  button.appendChild(ripple);
  setTimeout(() => ripple.remove(), 520);
});


if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}
