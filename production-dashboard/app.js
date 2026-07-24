const STORAGE_KEY = "pd-production-dashboard-v4";
const PREFS_KEY = "pd-production-dashboard-prefs-v1";
const ADMIN_PASSWORD = "0314";
const AUTH_DISABLED = false;
const IS_LOCAL_ENV = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname) || window.location.hostname.endsWith(".local");
const ENV = window.__ENV__ || {};
const SUPABASE_URL = ENV.SUPABASE_URL || ENV.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = ENV.SUPABASE_ANON_KEY || ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const SUPABASE_ENABLED = Boolean(window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY);
const DASHBOARD_STATE_ROW_ID = "main";
const SHARE_TOKEN = new URLSearchParams(window.location.search).get("share")?.trim() || "";
const SHARE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let supabaseClient = null;
let currentProfile = null;
let remoteStateLoaded = false;
let remoteSaveTimer = null;
let isRemoteHydrating = false;
let isAuthInitializing = SUPABASE_ENABLED;
let sharedGuestMode = false;
let sharedLinkPayload = null;

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
    department: profile.department || "",
    phone: profile.phone || "",
    avatarPath: profile.avatar_path || profile.avatarPath || "",
    avatarUrl: profile.avatar_url || profile.avatarUrl || "",
    organizationVisible: profile.organization_visible !== false,
    sortOrder: Number(profile.sort_order || profile.sortOrder || 0),
    createdAt: profile.created_at || profile.createdAt || "",
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
  const user = mergeProfileUser(profile);
  if (user?.avatarPath) {
    user.avatarUrl = await signedProfileImageUrl(user.avatarPath);
    currentProfile.avatarUrl = user.avatarUrl;
  }
  return user;
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
    monthlyReportSharedPromptSnapshot = state.monthlyReport?.prompt || window.MonthlyReportCore?.DEFAULT_PROMPT || "";
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

async function fetchSharedLinkPayload() {
  if (!SUPABASE_ENABLED || !SHARE_TOKEN || !SHARE_TOKEN_PATTERN.test(SHARE_TOKEN)) return null;
  const { data, error } = await getSupabaseClient().rpc("get_shared_item", { p_token: SHARE_TOKEN });
  if (error) throw error;
  if (!data?.entity || !["project", "work"].includes(data.entityType)) return null;
  return data;
}

function installSharedGuestState(payload) {
  const guestState = structuredClone(sampleData);
  guestState.options = { ...structuredClone(defaultOptions), ...(payload.options || {}) };
  guestState.optionColors = payload.optionColors || {};
  guestState.owners = Array.isArray(payload.owners) ? payload.owners : [];
  guestState.projects = payload.entityType === "project" ? [payload.entity] : [];
  guestState.works = payload.entityType === "work" ? [payload.entity] : [];
  guestState.tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  guestState.currentUser = null;
  state = migrateOwnerState(normalizeState(guestState));
  sharedLinkPayload = payload;
  sharedGuestMode = true;
}

function openSharedLinkTarget(payload = sharedLinkPayload) {
  if (!payload) return false;
  const entityId = payload.entityId || payload.entity?.id;
  if (payload.entityType === "project" && state.projects.some((item) => item.id === entityId)) {
    performOpenProjectDetail(entityId);
    return true;
  }
  if (payload.entityType === "work" && state.works.some((item) => item.id === entityId)) {
    performOpenWorkDetail(entityId);
    return true;
  }
  return false;
}

async function openSharedLinkForSignedIn() {
  if (!SHARE_TOKEN) return false;
  try {
    sharedLinkPayload = await fetchSharedLinkPayload();
    sharedGuestMode = false;
    if (!sharedLinkPayload) {
      showToast("유효하지 않거나 해제된 공유 링크입니다.");
      return false;
    }
    if (!openSharedLinkTarget(sharedLinkPayload)) {
      showToast("공유된 항목을 찾을 수 없습니다.");
      return false;
    }
    return true;
  } catch (error) {
    console.warn("Shared link load failed", error);
    showToast("공유 링크를 불러오지 못했습니다.");
    return false;
  }
}

async function initSupabaseSession() {
  const client = getSupabaseClient();
  if (!client) {
    isAuthInitializing = false;
    renderAll();
    return;
  }
  try {
    const user = await fetchCurrentProfile();
    if (!user) {
      currentProfile = null;
      state.currentUser = null;
      if (SHARE_TOKEN) {
        const payload = await fetchSharedLinkPayload();
        if (payload) {
          installSharedGuestState(payload);
          isAuthInitializing = false;
          renderAll();
          openSharedLinkTarget(payload);
          return;
        }
        setAuthMessage("유효하지 않거나 해제된 공유 링크입니다.");
      }
      isAuthInitializing = false;
      renderAll();
      return;
    }
    if (!user.approved || user.status === "pending") {
      await client.auth.signOut();
      currentProfile = null;
      state.currentUser = null;
      setAuthMessage("관리자 승인 대기 중입니다.");
      isAuthInitializing = false;
      renderAll();
      return;
    }
    await loadRemoteDashboardState();
    await refreshSupabaseProfiles();
    isAuthInitializing = false;
    renderAll();
    await openSharedLinkForSignedIn();
  } catch (error) {
    console.warn("Supabase session init failed", error);
    if (SHARE_TOKEN) setAuthMessage("공유 링크를 불러오지 못했습니다. 잠시 후 다시 시도하세요.");
    isAuthInitializing = false;
    renderAll();
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
  await Promise.all(state.users.filter((user) => user.avatarPath).map(async (user) => {
    user.avatarUrl = await signedProfileImageUrl(user.avatarPath);
  }));
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
const PROGRESS_ACTIVITY_TYPES = new Set(["status_change", "task_check", "management_record_created"]);
const MANAGEMENT_RECORD_THEMES = [
  { value: "work_content", label: "업무 내용" },
  { value: "internal_share", label: "내부 공유" }
];
const defaultCalendarFields = { kickoffDate: false, shootDate: false, firstEditDate: false, finalDate: true };
const defaultWorkCalendarFields = { kickoffDate: false, finalDate: true };
const defaultTelegramDigestSettings = {
  deliveryMode: "manual",
  deliveryTime: "09:00",
  include: {
    tasksToday: true,
    tasksThreeDays: true,
    tasksWeek: true,
    projectsToday: true,
    projectsSoon: true,
    worksToday: true,
    worksSoon: true
  },
  additionalMessage: ""
};
const defaultStudioTelegramSettings = { fixedNotice: "", rules: [] };
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
  staffTypes: ["정기교육", "비정기교육", "방송실 일정", "장비 점검", "외부 지원", "촬영 지원"],
  studioStaffOwners: [...defaultOwnerNames],
  trainingTypes: ["자막 송출 교육", "카메라 기초 교육", "라이브 스위처 교육", "장비 점검 교육", "현장 실습"],
  boardPrefixes: ["일반"],
  positions: ["관리자", "과장", "팀장", "PD", "기획", "촬영", "편집", "과원"]
};

const OPTION_COLOR_PALETTE = {
  default: { label: "기본", color: "#8f8f8f" },
  gray: { label: "회색", color: "#858780" },
  brown: { label: "갈색", color: "#8b684f" },
  orange: { label: "주황색", color: "#b86432" },
  yellow: { label: "노란색", color: "#a88028" },
  green: { label: "초록색", color: "#3e805d" },
  blue: { label: "파란색", color: "#3977b7" },
  purple: { label: "보라색", color: "#75568f" },
  pink: { label: "분홍색", color: "#9b506f" },
  red: { label: "빨간색", color: "#b5524d" }
};

const COLORABLE_OPTION_GROUPS = new Set([
  "types", "statuses", "clients", "projectTaskTypes",
  "workTaskTypes", "workTypes", "workStatuses", "workClients",
  "boardPrefixes", "studioRooms", "staffTypes", "trainingTypes"
]);

const sampleData = {
  options: structuredClone(defaultOptions),
  optionColors: {},
  users: [
    { id: "user-admin", username: "videoadmin", email: "admin@videowork.io", password: "0314", name: "관리자", position: "관리자", role: "admin", status: "active", approved: true },
    { id: "user-test-admin", username: "1", email: "", password: "1", name: "테스트 관리자", position: "관리자", role: "admin", status: "active", approved: true }
  ],
  currentUser: null,
  projects: [],
  works: [],
  owners: [],
  notifications: [],
  activityLogs: [],
  tasks: [],
  schedules: [],
  staffEvents: [],
  recurringTrainings: [],
  boardPosts: [],
  boardComments: [],
  telegramDigest: structuredClone(defaultTelegramDigestSettings),
  studioTelegram: structuredClone(defaultStudioTelegramSettings),
  monthlyReport: { prompt: window.MonthlyReportCore?.DEFAULT_PROMPT || "" }
};

function normalizeTelegramDigestSettings(value = {}) {
  const include = value && typeof value.include === "object" ? value.include : {};
  const rawHour = Number(String(value.deliveryTime || defaultTelegramDigestSettings.deliveryTime).split(":")[0]);
  const hour = Math.max(0, Math.min(23, Number.isFinite(rawHour) ? rawHour : 9));
  return {
    deliveryMode: value.deliveryMode === "daily" ? "daily" : "manual",
    deliveryTime: `${String(hour).padStart(2, "0")}:00`,
    include: Object.fromEntries(Object.keys(defaultTelegramDigestSettings.include).map((key) => [key, include[key] !== false])),
    additionalMessage: String(value.additionalMessage || "").slice(0, 1000)
  };
}

const STUDIO_CALL_TIME_OPTIONS = [30, 60, 120, 180, 240, 300, 360];

function normalizeStudioCallTimeOffset(value) {
  const minutes = Number(value);
  return STUDIO_CALL_TIME_OPTIONS.includes(minutes) ? minutes : 60;
}

function studioCallTimeOffsetLabel(value) {
  const minutes = normalizeStudioCallTimeOffset(value);
  return minutes === 30 ? "30분 전" : `${minutes / 60}시간 전`;
}

function studioCallTimeOffsetOptions(value) {
  const selected = normalizeStudioCallTimeOffset(value);
  return STUDIO_CALL_TIME_OPTIONS
    .map((minutes) => `<option value="${minutes}" ${selected === minutes ? "selected" : ""}>${studioCallTimeOffsetLabel(minutes)}</option>`)
    .join("");
}

function normalizeStudioTelegramSettings(value = {}) {
  const rules = Array.isArray(value?.rules) ? value.rules : [];
  return {
    fixedNotice: String(value.fixedNotice || "").trim().slice(0, 1500),
    rules: rules.slice(0, 30).map((rule, index) => {
      const rawHour = Number(String(rule.deliveryTime || "09:00").split(":")[0]);
      const hour = Math.max(0, Math.min(23, Number.isFinite(rawHour) ? rawHour : 9));
      const notice = rule.notice !== undefined ? rule.notice : rule.fixedNotice;
      return {
        id: String(rule.id || `studio-rule-${index + 1}`),
        name: String(rule.name || `공지 규칙 ${index + 1}`).slice(0, 80),
        enabled: rule.enabled !== false,
        trainingType: String(rule.trainingType || "all").slice(0, 120),
        mode: rule.mode === "weekly" ? "weekly" : "previous-day",
        weekday: Math.max(0, Math.min(6, Number(rule.weekday) || 0)),
        deliveryTime: `${String(hour).padStart(2, "0")}:00`,
        includeCallTime: true,
        callTimeOffsetMinutes: normalizeStudioCallTimeOffset(rule.callTimeOffsetMinutes),
        notice: String(notice || "").trim().slice(0, 1500)
      };
    })
  };
}

function studioGlobalFixedNotice() {
  return normalizeStudioTelegramSettings(state.studioTelegram || {}).fixedNotice;
}

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
let monthlyReportSharedPromptSnapshot = state.monthlyReport?.prompt || window.MonthlyReportCore?.DEFAULT_PROMPT || "";
let calendarDate = new Date(viewPref("calendarDate", dateKey(new Date())));
let studioWeekDate = new Date(viewPref("studioWeekDate", dateKey(new Date())));
let studioViewMode = viewPref("studioViewMode", "week");
let studioTrainingTypeFilters = viewPref("studioTrainingTypeFilters", {});
let studioOwnerFilters = viewPref("studioOwnerFilters", {});
let studioHideRecurring = viewPref("studioHideRecurring", false);
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
let projectHideDone = viewPref("projectHideDone", true);
let workHideDone = viewPref("workHideDone", true);
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
let detailTaskDraft = { title: "", detail: "", type: "", owners: [], dueDate: dateKey(new Date()), noDueDate: false, allDay: true, startTime: "09:00", endTime: "10:00", calendar: false, ...defaultWorkTaskRecurrenceDraft(dateKey(new Date())), editingTaskId: null };
let detailTaskComposerOpen = false;
let detailTaskDetailOpen = false;
let detailTaskRecurrenceOpen = false;
let editingRecordId = null;
let selectedRecordTheme = "work_content";
let recordSearchQuery = "";
let recordFilterMode = viewPref("recordFilterMode", "all");
let activeDetailTab = "basic";
let projectBasicDraft = null;
let projectChangeBuffer = new Set();
let detailTaskSort = viewPref("detailTaskSort", "created");
let detailTaskHideDone = viewPref("detailTaskHideDone", true);
let workTaskDraft = { title: "", detail: "", type: "", owners: [], dueDate: dateKey(new Date()), noDueDate: false, allDay: true, startTime: "09:00", endTime: "10:00", calendar: false, recurrenceType: "none", recurrenceCustomFrequency: "weekly", recurrenceWeekdays: [new Date().getDay()], recurrenceMonthlyMode: "day", recurrenceMonthlyDay: new Date().getDate(), recurrenceMonthlyOrdinal: 1, recurrenceMonthlyWeekday: new Date().getDay(), recurrenceEndType: "none", recurrenceEndDate: "", recurrenceCount: 10, editingTaskId: null, editingScope: "single" };
let workTaskComposerOpen = false;
let workTaskSort = viewPref("workTaskSort", "created");
let workTaskHideDone = viewPref("workTaskHideDone", true);
let workTaskDetailOpen = false;
let workTaskRecurrenceOpen = false;
let workStudioMemoOpen = false;
let editingWorkRecordId = null;
let selectedWorkRecordTheme = "work_content";
let workRecordSearchQuery = "";
let workRecordFilterMode = viewPref("workRecordFilterMode", "all");
let activeWorkDetailTab = "basic";
let workBasicDraft = null;
let workChangeBuffer = new Set();
let pendingBasicLeaveAction = null;
let pendingBasicLeaveScope = "";
let pendingWorkTaskScopeAction = null;
let projectSearchQuery = viewPref("projectSearchQuery", "");
let projectFilters = viewPref("projectFilters", { type: "", client: "", status: "" });
let projectSort = viewPref("projectSort", { key: "finalDate", direction: "asc" });
let workSearchQuery = viewPref("workSearchQuery", "");
let workSort = viewPref("workSort", { key: "finalDate", direction: "asc" });
let isProjectFilterOpen = false;
let activeCalendarMode = viewPref("activeCalendarMode", "all");
let calendarFilters = { video: true, work: true, staff: true, schedule: true, ...viewPref("calendarFilters", {}) };
let calendarOwnerFilters = viewPref("calendarOwnerFilters", {});
let calendarHideRecurring = viewPref("calendarHideRecurring", false);
let calendarSourceFilters = viewPref("calendarSourceFilters", { project: true, work: true, task: true, staff: true, schedule: true });
let calendarRecurringFilter = viewPref("calendarRecurringFilter", "include");
let calendarShowCompleted = viewPref("calendarShowCompleted", true);
let selectedCalendarDate = viewPref("selectedCalendarDate", dateKey(new Date()));
let mobileCalendarViewMode = viewPref("mobileCalendarViewMode", "month");
let mobileCalendarFilterOpen = false;
let mobileCalendarFilterDraft = null;
let mobileWorkSortOpen = false;
let mobileCalendarSearchOpen = false;
let mobileCalendarSearchQuery = "";
let mobileCalendarSwipeStart = null;
let webNotificationsOpen = false;
let notificationCenterOpen = false;
let notificationSettingsOpen = false;
let notificationShowRead = viewPref("notificationShowRead", false);
let boardSearchQuery = viewPref("boardSearchQuery", "");
let boardSearchScope = viewPref("boardSearchScope", "titleContent");
let boardPrefixFilter = viewPref("boardPrefixFilter", "");
let boardPostFilter = viewPref("boardPostFilter", "all");
let boardActiveTab = viewPref("boardActiveTab", "all");
let activeBoardPostId = null;
let boardEditorPostId = null;
let boardViewerPostId = null;
let editingBoardCommentId = null;
let replyingBoardCommentId = null;
let mobileBoardFilterOpen = false;
let adminSection = viewPref("adminSection", "dropdowns");
let adminActivityMonth = viewPref("adminActivityMonth", dateKey(new Date()).slice(0, 7));
let adminActivityEntityFilter = viewPref("adminActivityEntityFilter", "all");
let adminActivityTypeFilter = viewPref("adminActivityTypeFilter", "all");
let telegramDigestRuntimeStatus = null;
let telegramDigestStatusLoading = false;
let studioTelegramDraft = null;
let studioTelegramRuleEditor = null;
let studioTelegramPreviewContext = null;
let monthlyReportMonth = viewPref("monthlyReportMonth", dateKey(new Date()).slice(0, 7));
let monthlyReportMonthPickerOpen = false;
let monthlyReportPickerYear = Number(monthlyReportMonth.slice(0, 4)) || new Date().getFullYear();
let monthlyReportSources = [];
let monthlyReportDraft = { activity: [], production: [], next: [] };
let monthlyReportPreview = { activity: "", production: "", next: "" };
let monthlyReportMessage = "";
let monthlyReportGeneratedByGpt = false;
let monthlyReportLoadedMonth = "";
let monthlyReportStep = 1;
let activeView = "overview";
let activeDropdownAnchor = null;

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
  nextState.notificationSettingsByUser = nextState.notificationSettingsByUser && typeof nextState.notificationSettingsByUser === "object"
    ? nextState.notificationSettingsByUser
    : {};
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

function decodeStableOwnerId(ownerId) {
  const match = String(ownerId || "").match(/^owner-([0-9a-f]+)-\d+$/i);
  if (!match) return "";
  try {
    const encoded = match[1].replace(/([0-9a-f]{2})/gi, "%$1");
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

function ownerName(ownerId) {
  const owner = ownerById(ownerId);
  return owner ? owner.name : (decodeStableOwnerId(ownerId) || ownerId || "");
}

function ownerNames(ownerIds) {
  return (ownerIds || []).map(ownerName).filter(Boolean);
}

function ownerOptionLabel(ownerId) {
  const owner = ownerById(ownerId);
  return owner ? owner.name : (decodeStableOwnerId(ownerId) || ownerId || "선택");
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
  if (record.authorUserId) return record.authorUserId === user.id;
  const names = new Set([
    user.id,
    user.username,
    user.email,
    user.name,
    ...ownerNames(linkedOwnerIdsForUser(user))
  ].filter(Boolean));
  return names.has(record.author) || names.has(recordAuthorDisplayName(record.author));
}

function canManageRecord(record) {
  return Boolean(record && currentUser() && (isAdminUser() || isCurrentUserRecord(record)));
}

function canUserManageOwner(ownerId, user = currentUser()) {
  if (!user) return false;
  if (isAdminUser()) return true;
  return linkedOwnerIdsForUser(user).includes(ownerId);
}

const defaultNotificationSettings = {
  darkMode: false,
  all: true,
  projectStatus: true,
  projectContent: true,
  ownerChange: true,
  record: true,
  task: true,
  work: true,
  studio: true,
  schedule: true,
  system: true
};

function notificationSettingsForUser(userId) {
  state.notificationSettingsByUser = state.notificationSettingsByUser || {};
  return { ...defaultNotificationSettings, ...(state.notificationSettingsByUser[userId] || {}) };
}

function applyUserTheme() {
  const user = currentUser();
  const darkMode = Boolean(user && notificationSettingsForUser(user.id).darkMode);
  const mode = darkMode ? "dark" : "light";
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  document.body.dataset.theme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", darkMode ? "#0b0e0c" : "#00ed64");
}

function notificationSettingKey(actionType = "") {
  if (actionType.includes("owner")) return "ownerChange";
  if (actionType.includes("record")) return "record";
  if (actionType.includes("task")) return "task";
  if (actionType.includes("studio") || actionType.includes("staff")) return "studio";
  if (actionType.includes("schedule") || actionType.includes("calendar") || actionType.includes("recurring")) return "schedule";
  if (actionType.startsWith("work_")) return "work";
  if (actionType.includes("status")) return "projectStatus";
  if (actionType.startsWith("project_")) return "projectContent";
  return "system";
}

function notificationActor() {
  const actor = currentUser();
  return {
    id: actor?.id || "",
    name: actor?.name || actor?.username || actor?.email || "사용자"
  };
}

function cleanupNotifications() {
  const cutoff = Date.now() - 90 * 86400000;
  const recent = (state.notifications || []).filter((item) => {
    const created = new Date(item.createdAt || 0).getTime();
    return !created || created >= cutoff || !item.read;
  });
  const grouped = new Map();
  recent.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).forEach((item) => {
    const key = item.userId || "global";
    const items = grouped.get(key) || [];
    if (items.length < 300) items.push(item);
    grouped.set(key, items);
  });
  state.notifications = [...grouped.values()].flat();
}

function notifyAssignedUsers({
  ownerIds = [],
  actorUserId,
  actorName,
  actionType = "system_update",
  category = "system",
  title = "알림",
  message = "",
  sourceType = "",
  sourceId = "",
  parentType = "",
  parentId = "",
  subTargetId = "",
  targetView = "",
  targetTab = "basic",
  eventDate = ""
} = {}) {
  const actor = notificationActor();
  const resolvedActorId = actorUserId ?? actor.id;
  const resolvedActorName = actorName || actor.name;
  const now = new Date();
  const dedupeWindow = now.getTime() - 5000;
  let added = 0;
  uniqueValues(ownerIds).forEach((ownerId) => {
    const owner = ownerById(ownerId);
    if (!owner?.linkedUserId || owner.status === "inactive" || owner.status === "deleted") return;
    const user = state.users.find((item) => item.id === owner.linkedUserId);
    if (!user || user.id === resolvedActorId || user.status === "inactive" || user.status === "pending" || user.approved === false) return;
    if (notificationSettingsForUser(user.id).all === false) return;
    const settingKey = notificationSettingKey(actionType);
    if (notificationSettingsForUser(user.id)[settingKey] === false) return;
    const dedupeKey = `${user.id}:${actionType}:${sourceType}:${sourceId}:${subTargetId}`;
    const duplicate = (state.notifications || []).some((item) => item.dedupeKey === dedupeKey && new Date(item.createdAt || 0).getTime() >= dedupeWindow);
    if (duplicate) return;
    state.notifications.push({
      id: makeId(),
      userId: user.id,
      ownerId,
      actorUserId: resolvedActorId,
      actorName: resolvedActorName,
      actionType,
      category,
      title,
      body: message,
      message,
      sourceType,
      sourceId,
      parentType,
      parentId,
      subTargetId,
      targetView,
      targetTab,
      eventDate,
      source: { type: sourceType, id: sourceId, projectId: parentType === "project" ? parentId : "", workId: parentType === "work" ? parentId : "", taskId: subTargetId },
      dedupeKey,
      read: false,
      createdAt: now.toISOString()
    });
    added += 1;
  });
  if (added) {
    cleanupNotifications();
    saveState();
    renderNotificationSurfaces();
  }
  return added;
}

function notifyOwners(ownerIds, message, source = {}) {
  const sourceType = source.type || "system";
  const actionType = source.actionType || `${sourceType.replaceAll("-", "_")}_${source.action || "updated"}`;
  const parentType = source.projectId ? "project" : source.workId ? "work" : "";
  return notifyAssignedUsers({
    ownerIds,
    actionType,
    category: source.category || sourceType,
    title: source.title || "담당 항목 변경",
    message,
    sourceType,
    sourceId: source.id || source.taskId || source.recordId || source.scheduleId || source.staffEventId || source.projectId || source.workId || "",
    parentType,
    parentId: source.projectId || source.workId || "",
    subTargetId: source.taskId || source.recordId || "",
    targetView: source.projectId ? "projects" : source.workId ? "works" : source.targetView || "",
    targetTab: source.targetTab || (sourceType.includes("record") ? "records" : sourceType.includes("task") ? "tasks" : "basic"),
    eventDate: source.eventDate || source.date || ""
  });
}

const notificationFieldLabels = {
  title: "프로젝트명",
  type: "업무 분류",
  owners: "담당자",
  client: "발주 부서",
  budget: "예산",
  kickoffDate: "시작일",
  shootDate: "촬영일",
  firstEditDate: "1차 완성일",
  finalDate: "마감일",
  status: "상태",
  broadcastCompleted: "방영완료",
  memo: "메모",
  noSchedule: "일정 설정"
};

function notifyEntityFieldChanges({ entityType, entity, ownerIds, fields }) {
  const changedFields = uniqueValues(fields);
  if (!entity || !changedFields.length) return 0;
  const actor = notificationActor();
  const labels = changedFields.map((field) => notificationFieldLabels[field] || field);
  const isProject = entityType === "project";
  const label = isProject ? "프로젝트" : "업무 프로젝트";
  const actionType = changedFields.length === 1 && changedFields[0] === "status"
    ? `${entityType}_status_changed`
    : `${entityType}_content_changed`;
  const detail = labels.length > 3 ? "정보" : labels.join(", ");
  return notifyAssignedUsers({
    ownerIds,
    actionType,
    category: entityType,
    title: `${label} ${changedFields.includes("status") && changedFields.length === 1 ? "상태 변경" : "내용 수정"}`,
    message: `${actor.name}님이 ‘${entity.title}’의 ${detail}를 수정했습니다.`,
    sourceType: entityType,
    sourceId: entity.id,
    parentType: entityType,
    parentId: entity.id,
    targetView: isProject ? "projects" : "works",
    targetTab: "basic"
  });
}

function notifyOwnerAssignmentChanges({ entityType, entity, previousOwners = [], nextOwners = [] }) {
  const actor = notificationActor();
  const previous = uniqueValues(previousOwners);
  const next = uniqueValues(nextOwners);
  const added = next.filter((ownerId) => !previous.includes(ownerId));
  const removed = previous.filter((ownerId) => !next.includes(ownerId));
  const retained = next.filter((ownerId) => previous.includes(ownerId));
  const targetView = entityType === "project" ? "projects" : "works";
  const common = {
    category: entityType,
    sourceType: entityType,
    sourceId: entity.id,
    parentType: entityType,
    parentId: entity.id,
    targetView,
    targetTab: "basic"
  };
  if (added.length) notifyAssignedUsers({ ...common, ownerIds: added, actionType: `${entityType}_owner_added`, title: "담당자 지정", message: `${actor.name}님이 회원님을 ‘${entity.title}’ 담당자로 지정했습니다.` });
  if (removed.length) notifyAssignedUsers({ ...common, ownerIds: removed, actionType: `${entityType}_owner_removed`, title: "담당자 제외", message: `${actor.name}님이 회원님을 ‘${entity.title}’ 담당자에서 제외했습니다.` });
  if (retained.length) notifyAssignedUsers({ ...common, ownerIds: retained, actionType: `${entityType}_owner_changed`, title: "담당자 변경", message: `${actor.name}님이 ‘${entity.title}’의 담당자를 변경했습니다.` });
}

function dateKey(date) {
  const target = date instanceof Date ? date : new Date(`${date}T00:00:00`);
  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeManagementRecordTheme(value) {
  return MANAGEMENT_RECORD_THEMES.some((theme) => theme.value === value) ? value : "work_content";
}

function managementRecordThemeLabel(value) {
  const normalized = normalizeManagementRecordTheme(value);
  return MANAGEMENT_RECORD_THEMES.find((theme) => theme.value === normalized)?.label || "업무 내용";
}

function managementRecordThemeIcon(value) {
  if (normalizeManagementRecordTheme(value) === "internal_share") {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm9 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2 16v-1.5A3.5 3.5 0 0 1 5.5 11h1A3.5 3.5 0 0 1 10 14.5V16m0-1.5a3.5 3.5 0 0 1 3.5-3.5h1a3.5 3.5 0 0 1 3.5 3.5V16" /></svg>';
  }
  return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12" rx="2" /><path d="M7 4.5v-2h6v2M3 9.5h14M8 9.5v1h4v-1" /></svg>';
}

function managementRecordThemePicker({ selectedTheme, editable, scope }) {
  const normalized = normalizeManagementRecordTheme(selectedTheme);
  const dataAttribute = scope === "work" ? "data-work-record-theme" : "data-record-theme";
  return `
    <div class="record-theme-picker" role="group" aria-label="관리기록 테마">
      ${MANAGEMENT_RECORD_THEMES.map((theme) => `
        <button class="record-theme-button theme-${theme.value} ${normalized === theme.value ? "active" : ""}" ${dataAttribute}="${theme.value}" type="button" aria-pressed="${normalized === theme.value}" ${editable ? "" : "disabled"}>
          ${managementRecordThemeIcon(theme.value)}
          <span>${theme.label}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function updateManagementRecordThemePicker(container, attribute, selectedTheme) {
  const normalized = normalizeManagementRecordTheme(selectedTheme);
  container?.querySelectorAll(`[${attribute}]`).forEach((button) => {
    const active = button.getAttribute(attribute) === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function normalizeActivityLog(item = {}) {
  const occurredAt = String(item.occurredAt || item.createdAt || "");
  const occurredDate = new Date(occurredAt);
  const fallbackDate = Number.isNaN(occurredDate.getTime()) ? "" : dateKey(occurredDate);
  const activityType = PROGRESS_ACTIVITY_TYPES.has(item.activityType) ? item.activityType : "status_change";
  return {
    id: item.id || makeId(),
    entityType: item.entityType === "work" ? "work" : "project",
    entityId: String(item.entityId || ""),
    entityTitle: String(item.entityTitle || ""),
    activityType,
    activityDate: /^\d{4}-\d{2}-\d{2}$/.test(String(item.activityDate || "")) ? String(item.activityDate) : fallbackDate,
    occurredAt,
    actorUserId: String(item.actorUserId || ""),
    actorName: String(item.actorName || "사용자"),
    previousStatus: String(item.previousStatus || ""),
    nextStatus: String(item.nextStatus || ""),
    taskId: String(item.taskId || ""),
    taskChecked: typeof item.taskChecked === "boolean" ? item.taskChecked : null,
    managementRecordCreated: Boolean(item.managementRecordCreated),
    managementRecordTheme: activityType === "management_record_created" ? normalizeManagementRecordTheme(item.managementRecordTheme) : ""
  };
}

function recordProgressActivity({
  entityType,
  entity,
  activityType,
  previousStatus = "",
  nextStatus = "",
  taskId = "",
  taskChecked = null,
  managementRecordTheme = "work_content"
} = {}) {
  if (!entity?.id || !["project", "work"].includes(entityType) || !PROGRESS_ACTIVITY_TYPES.has(activityType)) return null;
  const now = new Date();
  const actor = notificationActor();
  const log = normalizeActivityLog({
    id: makeId(),
    entityType,
    entityId: entity.id,
    entityTitle: entity.title || "",
    activityType,
    activityDate: dateKey(now),
    occurredAt: now.toISOString(),
    actorUserId: actor.id,
    actorName: actor.name,
    previousStatus: activityType === "status_change" ? previousStatus : "",
    nextStatus: activityType === "status_change" ? nextStatus : "",
    taskId: activityType === "task_check" ? taskId : "",
    taskChecked: activityType === "task_check" ? Boolean(taskChecked) : null,
    managementRecordCreated: activityType === "management_record_created",
    managementRecordTheme: activityType === "management_record_created" ? managementRecordTheme : ""
  });
  state.activityLogs = Array.isArray(state.activityLogs) ? state.activityLogs : [];
  state.activityLogs.push(log);
  return log;
}

function progressActivityLogsFor(entityType, entityId) {
  return (state.activityLogs || [])
    .filter((log) => log.entityType === entityType && log.entityId === entityId)
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
}

function progressActivityDatesFor(entityType, entityId) {
  return [...new Set(progressActivityLogsFor(entityType, entityId).map((log) => log.activityDate).filter(Boolean))].sort();
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
  normalized.staffTypes = normalized.staffTypes.map((value) => ["방송실 스탭", "스탭 배정"].includes(value) ? "방송실 일정" : value);
  normalized.staffTypes = [...new Set(normalized.staffTypes)];
  if (!normalized.positions.includes("과장")) normalized.positions.splice(Math.min(1, normalized.positions.length), 0, "과장");
  return normalized;
}

function normalizeOptionColors(source = {}, options = {}) {
  const normalized = {};
  COLORABLE_OPTION_GROUPS.forEach((group) => {
    const values = new Set(Array.isArray(options[group]) ? options[group] : []);
    const groupColors = source && typeof source[group] === "object" ? source[group] : {};
    const next = {};
    Object.entries(groupColors || {}).forEach(([value, colorKey]) => {
      if (values.has(value) && OPTION_COLOR_PALETTE[colorKey] && colorKey !== "default") next[value] = colorKey;
    });
    normalized[group] = next;
  });
  return normalized;
}

function optionColorKey(group, value) {
  if (!group || !value || !COLORABLE_OPTION_GROUPS.has(group)) return "default";
  const key = state?.optionColors?.[group]?.[value];
  return OPTION_COLOR_PALETTE[key] ? key : "default";
}

function optionColorStyle(group, value) {
  const key = optionColorKey(group, value);
  if (key === "default") return "";
  return `--option-accent:${OPTION_COLOR_PALETTE[key].color}`;
}

function optionColorAttributes(group, value) {
  const key = optionColorKey(group, value);
  if (key === "default") return "";
  return ` data-option-color="${key}" style="${optionColorStyle(group, value)}"`;
}

function optionColorClass(group, value) {
  return optionColorKey(group, value) === "default" ? "" : "has-option-color";
}

const WORK_TASK_RECURRENCE_TYPES = new Set(["daily", "weekly", "biweekly", "monthly", "custom"]);
const WORK_TASK_RECURRENCE_END_TYPES = new Set(["none", "date", "count"]);

function stripWorkTaskOccurrenceTitle(value) {
  return String(value || "").replace(/\s+\d+회차$/, "").trim();
}

function normalizeWorkTaskRecurrence(task = {}) {
  const recurrenceType = WORK_TASK_RECURRENCE_TYPES.has(task.recurrenceType) ? task.recurrenceType : "none";
  const isRecurring = Boolean(task.isRecurring || task.recurrenceGroupId || recurrenceType !== "none");
  const weekdays = [...new Set((Array.isArray(task.recurrenceWeekdays) ? task.recurrenceWeekdays : []).map(Number).filter((day) => day >= 0 && day <= 6))].sort((a, b) => a - b);
  const occurrenceNumber = Math.max(1, Number(task.recurrenceOccurrenceNumber) || 1);
  return {
    isRecurring,
    recurrenceGroupId: isRecurring ? String(task.recurrenceGroupId || "") : "",
    recurrenceType: isRecurring ? recurrenceType : "none",
    recurrenceInterval: Math.max(1, Number(task.recurrenceInterval) || (recurrenceType === "biweekly" ? 2 : 1)),
    recurrenceStartDate: isRecurring ? String(task.recurrenceStartDate || task.dueDate || "") : "",
    recurrenceEndType: isRecurring && WORK_TASK_RECURRENCE_END_TYPES.has(task.recurrenceEndType) ? task.recurrenceEndType : "none",
    recurrenceEndDate: isRecurring ? String(task.recurrenceEndDate || "") : "",
    recurrenceCount: isRecurring && task.recurrenceEndType === "count" ? Math.max(1, Number(task.recurrenceCount) || occurrenceNumber) : 0,
    recurrenceCustomFrequency: task.recurrenceCustomFrequency === "monthly" ? "monthly" : "weekly",
    recurrenceWeekdays: weekdays,
    recurrenceMonthlyMode: task.recurrenceMonthlyMode === "ordinal" ? "ordinal" : "day",
    recurrenceMonthlyDay: Math.max(1, Math.min(31, Number(task.recurrenceMonthlyDay) || new Date(`${task.dueDate || dateKey(new Date())}T00:00:00`).getDate() || 1)),
    recurrenceMonthlyOrdinal: [-1, 1, 2, 3, 4].includes(Number(task.recurrenceMonthlyOrdinal)) ? Number(task.recurrenceMonthlyOrdinal) : 1,
    recurrenceMonthlyWeekday: Math.max(0, Math.min(6, Number(task.recurrenceMonthlyWeekday) || 0)),
    recurrenceOccurrenceNumber: occurrenceNumber,
    recurrenceOriginId: isRecurring ? String(task.recurrenceOriginId || task.id || "") : "",
    recurrenceBaseTitle: isRecurring ? String(task.recurrenceBaseTitle || stripWorkTaskOccurrenceTitle(task.text)) : "",
    recurrenceDate: isRecurring ? String(task.recurrenceDate || task.dueDate || "") : "",
    recurrenceDetached: Boolean(task.recurrenceDetached),
    recurrenceExcludedDates: isRecurring ? [...new Set((Array.isArray(task.recurrenceExcludedDates) ? task.recurrenceExcludedDates : []).filter(Boolean))].sort() : []
  };
}

function normalizeState(data) {
  const options = normalizeOptions(data.options || {});
  const optionColors = normalizeOptionColors(data.optionColors || {}, options);
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const normalizedProjects = projects.map((project) => {
    const fallbackStart = project.kickoffDate || project.startDate || dateKey(new Date());
    const fallbackFinal = project.finalDate || project.dueDate || fallbackStart;
    return {
      method: options.methods[0] || "단건",
      type: options.types[0] || "홍보영상",
      status: options.statuses[0] || "기획",
      broadcastCompleted: false,
      owners: Array.isArray(project.owners) ? project.owners : [project.owner || options.owners[0] || "PD"],
      client: options.clients[0] || "공공기관",
      note: "",
      memo: "",
      ...project,
      broadcastCompleted: Boolean(project.broadcastCompleted),
      kickoffDate: fallbackStart,
      shootDate: project.shootDate || fallbackStart,
      firstEditDate: project.firstEditDate || fallbackFinal,
      finalDate: fallbackFinal,
      calendarFields: { ...defaultCalendarFields, ...(project.calendarFields || {}) },
      records: Array.isArray(project.records)
        ? project.records.map((record) => ({ authorUserId: "", ...record, theme: normalizeManagementRecordTheme(record.theme) }))
        : []
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
      allDay: work.allDay !== false,
      startTime: work.startTime || "09:00",
      endTime: work.endTime || "10:00",
      kickoffDate: fallbackStart,
      finalDate: fallbackFinal,
      calendarFields: { ...defaultWorkCalendarFields, ...(work.calendarFields || {}) },
      studioReservationEnabled: Boolean(work.studioReservationEnabled),
      studioReservationId: work.studioReservationId || "",
      studioReservation: work.studioReservation || null,
      tasks: Array.isArray(work.tasks)
        ? work.tasks.map((task) => {
          const normalizedTask = {
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
          };
          return { ...normalizedTask, ...normalizeWorkTaskRecurrence(normalizedTask) };
        })
        : [],
      records: Array.isArray(work.records)
        ? work.records.map((record) => ({ authorUserId: "", ...record, theme: normalizeManagementRecordTheme(record.theme) }))
        : []
    };
  });
  return {
    options,
    optionColors,
    users: normalizeUsers(data.users),
    currentUser: data.currentUser || null,
    projects: normalizedProjects,
    works: normalizedWorks,
    tasks: Array.isArray(data.tasks)
      ? data.tasks.map((task) => {
        const normalizedTask = {
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
        };
        return { ...normalizedTask, ...normalizeWorkTaskRecurrence(normalizedTask) };
      })
      : [],
    schedules: Array.isArray(data.schedules) ? data.schedules.map((schedule) => ({ allDay: true, startTime: "09:00", endTime: "10:00", ...schedule })) : [],
    staffEvents: Array.isArray(data.staffEvents) ? data.staffEvents.map((event) => {
      const legacyType = event.type === "단발성 교육" ? "비정기교육" : ["스탭 배정", "방송실 스탭"].includes(event.type) ? "방송실 일정" : event.type;
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
        title: displayStudioTerminology(event.title || trainingType),
        telegramCallTimeEnabled: true,
        telegramCallTimeOffsetMinutes: normalizeStudioCallTimeOffset(event.telegramCallTimeOffsetMinutes),
        telegramNote: String(event.telegramNote || "").slice(0, 1000)
      };
    }) : [],
    recurringTrainings: Array.isArray(data.recurringTrainings) ? data.recurringTrainings.map((series) => {
      const legacyType = series.type === "단발성 교육" ? "비정기교육" : ["스탭 배정", "방송실 스탭"].includes(series.type) ? "방송실 일정" : series.type;
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
        title: displayStudioTerminology(series.title || trainingType)
      };
    }) : [],
    boardPosts: Array.isArray(data.boardPosts) ? data.boardPosts.map((post, index) => ({
      id: post.id || makeId(),
      number: Number(post.number || index + 1),
      prefix: post.prefix || options.boardPrefixes[0] || "일반",
      title: post.title || "",
      contentHtml: post.contentHtml || "",
      authorUserId: post.authorUserId || "",
      authorName: post.authorName || "사용자",
      isNotice: Boolean(post.isNotice),
      noticeUntil: post.noticeUntil || null,
      noticePeriodType: post.noticePeriodType || null,
      notifyOff: Boolean(post.notifyOff),
      viewUserIds: Array.isArray(post.viewUserIds) ? post.viewUserIds : [],
      viewLogs: Array.isArray(post.viewLogs) ? post.viewLogs : [],
      createdAt: post.createdAt || new Date().toISOString(),
      updatedAt: post.updatedAt || null,
      deletedAt: post.deletedAt || null
    })) : [],
    boardComments: Array.isArray(data.boardComments) ? data.boardComments.map((comment) => ({
      id: comment.id || makeId(),
      postId: comment.postId || "",
      parentCommentId: comment.parentCommentId || null,
      body: comment.body || "",
      authorUserId: comment.authorUserId || "",
      authorName: comment.authorName || "사용자",
      createdAt: comment.createdAt || new Date().toISOString(),
      updatedAt: comment.updatedAt || null,
      deletedAt: comment.deletedAt || null
    })) : [],
    owners: Array.isArray(data.owners) ? data.owners : [],
    notifications: Array.isArray(data.notifications) ? data.notifications.map((item) => ({
      ...item,
      title: displayStudioTerminology(item.title),
      body: displayStudioTerminology(item.body),
      message: displayStudioTerminology(item.message)
    })) : [],
    activityLogs: Array.isArray(data.activityLogs)
      ? data.activityLogs.map(normalizeActivityLog).filter((item) => item.entityId && item.activityDate)
      : [],
    telegramDigest: normalizeTelegramDigestSettings(data.telegramDigest || {}),
    studioTelegram: normalizeStudioTelegramSettings(data.studioTelegram || {}),
    monthlyReport: {
      prompt: String(data.monthlyReport?.prompt || window.MonthlyReportCore?.DEFAULT_PROMPT || "").slice(0, 12000)
    },
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
  return displayStudioTerminology(event?.title || event?.trainingType || "방송실 일정");
}

function displayStudioTerminology(value) {
  return typeof value === "string" ? value.replaceAll(["방송실", "예약"].join(" "), "방송실 일정").replaceAll("방송실 스탭", "방송실 일정") : value;
}

function staffEventTypeColor(type) {
  if (type === "정기교육") return "training";
  if (["비정기교육", "단발성 교육"].includes(type)) return "lesson";
  if (["방송실 일정", "방송실 스탭", "스탭 배정"].includes(type)) return "staff";
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
    department: user.department || "",
    phone: user.phone || "",
    avatarPath: user.avatarPath || user.avatar_path || "",
    avatarUrl: user.avatarUrl || user.avatar_url || "",
    organizationVisible: user.organizationVisible !== false && user.organization_visible !== false,
    sortOrder: Number(user.sortOrder || user.sort_order || 0),
    createdAt: user.createdAt || user.created_at || "",
    role: user.role || (index === 0 || user.username === "videoadmin" ? "admin" : "user"),
    status: user.status || "active",
    approved: user.approved !== false && user.status !== "pending"
  }));
  normalized.forEach((user) => {
    if (user.username === "1" && !IS_LOCAL_ENV) {
      user.status = "inactive";
      user.approved = false;
      user.localOnly = true;
    }
  });
  if (!normalized.some((user) => user.username === "videoadmin")) {
    normalized.unshift({ id: "user-admin", username: "videoadmin", email: "admin@videowork.io", password: "0314", name: "관리자", position: "관리자", role: "admin", status: "active", approved: true });
  }
  if (IS_LOCAL_ENV && !normalized.some((user) => user.username === "1")) {
    normalized.push({ id: "user-test-admin", username: "1", email: "", password: "1", name: "테스트 관리자", position: "관리자", role: "admin", status: "active", approved: true });
  }
  return normalized;
}

function isAdminUser() {
  return currentUser()?.role === "admin";
}

function canEditProject(project) {
  const user = currentUser();
  return Boolean(user && project);
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
  const user = currentUser();
  if (!user || !task) return false;
  if (isAdminUser()) return true;
  const project = state.projects.find((item) => item.id === task.projectId);
  if (canEditProject(project)) return true;
  return taskOwners(task).some((ownerId) => canUserManageOwner(ownerId, user));
}

function workOwners(work) {
  if (Array.isArray(work.owners)) return work.owners.filter(Boolean);
  if (work.owner) return [work.owner];
  return [];
}

function canEditWork(work) {
  const user = currentUser();
  return Boolean(user && work);
}

function canManageWorkTask(work, task) {
  const user = currentUser();
  if (!user || !work || !task) return false;
  return isAdminUser()
    || taskOwners(task).some((ownerId) => canUserManageOwner(ownerId, user))
    || workOwners(work).some((ownerId) => canUserManageOwner(ownerId, user));
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

function positionAuthPositionMenu() {
  const button = $("#signupPositionButton");
  const menu = $("#signupPositionMenu");
  if (!button || !menu || !menu.classList.contains("open")) return;

  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop || 0;
  const viewportBottom = viewportTop + (viewport?.height || window.innerHeight);
  const buttonRect = button.getBoundingClientRect();
  const bottomGuard = window.matchMedia("(max-width: 480px)").matches ? 96 : 14;
  const spaceAbove = Math.max(0, buttonRect.top - viewportTop - 14);
  const spaceBelow = Math.max(0, viewportBottom - buttonRect.bottom - bottomGuard);
  const desiredHeight = Math.min(menu.scrollHeight || 224, 224);
  const opensUpward = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
  const availableHeight = opensUpward ? spaceAbove : spaceBelow;

  menu.classList.toggle("opens-upward", opensUpward);
  menu.style.setProperty(
    "--auth-position-menu-max-height",
    `${Math.max(120, Math.min(224, Math.floor(availableHeight - 7)))}px`
  );
}

function setAuthPositionMenu(open) {
  const button = $("#signupPositionButton");
  const menu = $("#signupPositionMenu");
  if (!button || !menu) return;
  button.classList.toggle("open", open);
  button.setAttribute("aria-expanded", String(open));
  menu.classList.toggle("open", open);
  menu.setAttribute("aria-hidden", String(!open));
  if (open) {
    positionAuthPositionMenu();
  } else {
    menu.classList.remove("opens-upward");
    menu.style.removeProperty("--auth-position-menu-max-height");
  }
}

window.addEventListener("resize", positionAuthPositionMenu);
window.visualViewport?.addEventListener("resize", positionAuthPositionMenu);
window.visualViewport?.addEventListener("scroll", positionAuthPositionMenu);

function selectAuthPosition(position) {
  const input = $("#signupPosition");
  const button = $("#signupPositionButton");
  if (!input || !button) return;
  input.value = position;
  button.querySelector("span").textContent = position || "직책 선택";
  $$("[data-auth-position]").forEach((option) => {
    const selected = option.dataset.authPosition === position;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-selected", String(selected));
  });
  setAuthPositionMenu(false);
}

function renderAuth() {
  const overlay = $("#authOverlay");
  if (isAuthInitializing) {
    overlay.classList.remove("hidden");
    overlay.classList.add("auth-loading");
    document.body.classList.add("auth-locked");
    return;
  }
  const user = currentUser();
  const signedIn = AUTH_DISABLED || Boolean(user);
  const canView = signedIn || sharedGuestMode;
  overlay.classList.remove("auth-loading");
  overlay.classList.toggle("hidden", canView);
  document.body.classList.toggle("auth-locked", !canView);
  document.body.classList.toggle("shared-readonly", sharedGuestMode);
  $("#logoutBtn").classList.toggle("hidden", !signedIn);
  $("#currentUserPanel").classList.toggle("hidden", !signedIn);
  $("#seedBtn")?.classList.toggle("hidden", !isAdminUser());
  $("#currentUserBadge").textContent = AUTH_DISABLED ? "테스트 모드" : user ? (user.name || user.username || "사용자") : "";
  $("#currentUserMeta").textContent = AUTH_DISABLED ? "개발 확인용" : user ? (user.position || "과원") : "";
}

function showAuthMode(mode) {
  const signupMode = mode === "signup";
  $("#authForm").classList.toggle("signup-mode", signupMode);
  $("#authMessage").textContent = "";
  setAuthPositionMenu(false);
}

function requestSharedLinkLogin() {
  sharedGuestMode = false;
  showAuthMode("login");
  renderAuth();
  setAuthMessage("로그인하면 공유된 항목을 수정할 수 있습니다.");
  setTimeout(() => $("#authId")?.focus(), 0);
}

async function login(username, password) {
  const cleanId = username.trim();
  if (cleanId === "1" && password === "1") {
    if (!IS_LOCAL_ENV) {
      setAuthMessage("테스트 관리자 계정은 로컬 환경에서만 사용할 수 있습니다.");
      return;
    }
    const testAdmin = state.users.find((item) => item.username === "1");
    if (testAdmin) {
      currentProfile = null;
      state.currentUser = testAdmin.id;
      saveState();
      renderAll();
      setAuthMessage("");
      return;
    }
  }
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
    sharedGuestMode = false;
    renderAll();
    await openSharedLinkForSignedIn();
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

function isSharedGuestItem(entityType, entityId) {
  return Boolean(
    sharedGuestMode
    && sharedLinkPayload?.entityType === entityType
    && (sharedLinkPayload.entityId || sharedLinkPayload.entity?.id) === entityId
  );
}

function shareUrlForToken(token) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("share", token);
  return url.toString();
}

async function copyShareUrl(url) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch (error) {
      console.warn("Clipboard API failed; using copy fallback", error);
    }
  }
  const input = document.createElement("textarea");
  input.value = url;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.top = "0";
  input.style.fontSize = "16px";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.focus();
  input.select();
  input.setSelectionRange(0, input.value.length);
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("copy failed");
  return true;
}

async function createAndCopyShareLink(entityType, entityId, button) {
  const entityLabel = entityType === "project" ? "영상" : "업무";
  if (!currentUser()) {
    showToast("공유 링크 생성은 로그인 후 사용할 수 있습니다.");
    return;
  }
  if (!SUPABASE_ENABLED) {
    showToast("배포 환경에서 Supabase를 연결한 뒤 공유할 수 있습니다.");
    return;
  }

  if (button) {
    button.disabled = true;
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-label", `${entityLabel} 공유 링크 생성 중`);
    button.title = "공유 링크 생성 중";
  }
  try {
    await saveRemoteDashboardState();
    const { data: token, error } = await getSupabaseClient().rpc("create_share_link", {
      p_entity_type: entityType,
      p_entity_id: entityId
    });
    if (error) throw error;
    await copyShareUrl(shareUrlForToken(token));
    showToast(`✓ ${entityLabel} 공유 링크가 복사되었습니다.`, { type: "success", duration: 2800 });
  } catch (error) {
    console.warn("Share link creation failed", error);
    const missingSetup = String(error?.message || "").includes("create_share_link");
    showToast(missingSetup ? "Supabase에서 최신 schema.sql을 먼저 실행하세요." : "공유 링크를 만들지 못했습니다.");
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("is-loading");
      button.removeAttribute("aria-busy");
      button.setAttribute("aria-label", `${entityLabel} 공유 링크 복사`);
      button.title = `${entityLabel} 공유 링크 복사`;
    }
  }
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
  const titles = { overview: "개요", projects: "영상", works: "업무", tasks: "할 일", calendar: "일정 캘린더", studio: "방송실 일정", board: "게시판", admin: "관리자 모드" };
  const eyebrows = { projects: "VIDEO", works: "WORK", tasks: "TASK", calendar: "CALENDAR", studio: "STUDIO", board: "BOARD", admin: "ADMIN" };
  $$(".view").forEach((section) => section.classList.remove("active"));
  const targetView = $(`#${view}View`) ? view : "overview";
  $(`#${targetView}View`).classList.add("active");
  activeView = targetView;
  $(".main")?.classList.toggle("studio-mode", targetView === "studio");
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === targetView));
  $("#viewEyebrow").textContent = eyebrows[targetView] || "VIDEO WORK DASHBOARD";
  $("#viewTitle").textContent = titles[targetView];
  location.hash = targetView;
}

function renderDropdown({ target, value, options, placeholder, onSelect, compact = false, disabled = false, className = "", colorGroup = "", formatOptionLabel = (option) => option }) {
  if (!target) return;
  const colorClass = optionColorClass(colorGroup, value);
  target.innerHTML = `
    <button type="button" class="custom-select ${compact ? "compact" : ""} ${className} ${colorClass}"${optionColorAttributes(colorGroup, value)} ${disabled ? "disabled" : ""}>
      <span>${esc(value ? formatOptionLabel(value) : placeholder)}</span>
      <i>⌄</i>
    </button>
  `;
  if (disabled) return;
  target.querySelector("button").addEventListener("click", (event) => {
    event.stopPropagation();
    openDropdown(event.currentTarget, options, value, onSelect, formatOptionLabel, colorGroup);
  });
}

function renderMultiDropdown({ target, values, options, placeholder, onChange, compact = false, disabled = false, className = "", formatOptionLabel = (option) => option }) {
  if (!target) return;
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

function openDropdown(anchor, options, currentValue, onSelect, formatOptionLabel = (option) => option, colorGroup = "") {
  closeDatePicker();
  const layer = $("#dropdownLayer");
  if (layer.classList.contains("open") && activeDropdownAnchor === anchor) {
    closeDropdown();
    return;
  }
  activeDropdownAnchor = anchor;
  const rect = anchor.getBoundingClientRect();
  layer.innerHTML = options
    .map((option) => `
      <button type="button" class="dropdown-option ${option === currentValue ? "selected" : ""} ${optionColorClass(colorGroup, option)}" data-value="${esc(option)}"${optionColorAttributes(colorGroup, option)}>
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
  activeDropdownAnchor = null;
  $("#dropdownLayer").classList.remove("open", "option-color-layer");
  $("#dropdownLayer").innerHTML = "";
}

function setOptionColor(group, value, colorKey) {
  if (!COLORABLE_OPTION_GROUPS.has(group) || !state.options[group]?.includes(value) || !OPTION_COLOR_PALETTE[colorKey]) return;
  if (!state.optionColors[group]) state.optionColors[group] = {};
  if (colorKey === "default") delete state.optionColors[group][value];
  else state.optionColors[group][value] = colorKey;
  saveState();
  renderAll();
}

function openOptionColorPicker(anchor, group, value) {
  closeDatePicker();
  const layer = $("#dropdownLayer");
  if (!layer || !COLORABLE_OPTION_GROUPS.has(group)) return;
  if (layer.classList.contains("open") && activeDropdownAnchor === anchor) {
    closeDropdown();
    return;
  }
  activeDropdownAnchor = anchor;
  const currentKey = optionColorKey(group, value);
  const rect = anchor.getBoundingClientRect();
  layer.innerHTML = `
    <div class="option-color-menu" role="menu" aria-label="${esc(value)} 색상 선택">
      ${Object.entries(OPTION_COLOR_PALETTE).map(([key, item]) => `
        <button type="button" class="option-color-choice ${key === currentKey ? "selected" : ""}" data-color-key="${key}">
          <i style="--option-accent:${item.color}"></i>
          <span>${esc(item.label)}</span>
          <b>${key === currentKey ? "✓" : ""}</b>
        </button>
      `).join("")}
    </div>
  `;
  const width = Math.min(220, Math.max(180, window.innerWidth - 16));
  layer.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  layer.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 360))}px`;
  layer.style.minWidth = `${width}px`;
  layer.classList.add("open", "option-color-layer");
  layer.querySelectorAll("[data-color-key]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeDropdown();
      layer.classList.remove("option-color-layer");
      setOptionColor(group, value, button.dataset.colorKey);
    });
  });
}

function openMultiDropdown(anchor, options, selected, onChange, formatOptionLabel = (option) => option) {
  closeDatePicker();
  const layer = $("#dropdownLayer");
  if (layer.classList.contains("open") && activeDropdownAnchor === anchor) {
    closeDropdown();
    return;
  }
  activeDropdownAnchor = anchor;
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
  if (!target) return;
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

  const latestTime = 23 * 60 + 50;
  const nextEnd = Math.min(latestTime, start + 60);
  if (nextEnd > start) {
    draft.endTime = timeFromMinutes(nextEnd);
    return;
  }

  draft.startTime = "22:50";
  draft.endTime = "23:50";
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

let pickerLockedScrollTop = 0;
let activeDateAnchor = null;
let activeTimeAnchor = null;

function lockPickerBackground() {
  const detailCard = document.querySelector("#workDetail.open .detail-card, #projectDetail.open .detail-card");
  pickerLockedScrollTop = detailCard?.scrollTop || 0;
  document.body.classList.add("picker-scroll-locked");
  detailCard?.classList.add("picker-scroll-locked-panel");
}

function unlockPickerBackground() {
  if ($("#datePickerLayer")?.classList.contains("open") || $("#timePickerLayer")?.classList.contains("open")) return;
  document.body.classList.remove("picker-scroll-locked");
  document.querySelectorAll(".picker-scroll-locked-panel").forEach((panel) => {
    panel.classList.remove("picker-scroll-locked-panel");
    panel.scrollTop = pickerLockedScrollTop;
  });
}

function positionPickerLayer(layer, anchor, preferredWidth, preferredHeight) {
  if (isMobileViewport()) {
    layer.style.left = "0px";
    layer.style.top = "auto";
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(preferredWidth, window.innerWidth - 16);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 8;
  const top = below + preferredHeight <= window.innerHeight - 8
    ? below
    : Math.max(8, rect.top - preferredHeight - 8);
  layer.style.left = `${left}px`;
  layer.style.top = `${top}px`;
}

function repositionActivePicker() {
  if (activeDateAnchor && $("#datePickerLayer")?.classList.contains("open")) positionPickerLayer($("#datePickerLayer"), activeDateAnchor, 320, 390);
  if (activeTimeAnchor && $("#timePickerLayer")?.classList.contains("open")) positionPickerLayer($("#timePickerLayer"), activeTimeAnchor, 300, 316);
}

window.addEventListener("resize", repositionActivePicker);
window.visualViewport?.addEventListener("resize", repositionActivePicker);

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

  positionPickerLayer(layer, anchor, 320, 390);
  layer.classList.add("open");
  lockPickerBackground();
  draw();
}

function closeDatePicker() {
  activeDateAnchor = null;
  $("#datePickerLayer").classList.remove("open");
  $("#datePickerLayer").innerHTML = "";
  unlockPickerBackground();
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
        <div class="time-picker-heading"><strong>시간 선택</strong><small>10분 단위</small></div>
        <div class="time-picker-columns">
        <div class="time-picker-column period">
          ${["AM", "PM"].map((period) => `
            <button type="button" class="${selected.period === period ? "selected" : ""}" data-time-period="${period}">
              ${period === "AM" ? "오전" : "오후"}
            </button>
          `).join("")}
        </div>
        <div class="time-picker-column">
          ${[12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((hour) => `
            <button type="button" class="${selected.hour === hour ? "selected" : ""}" data-time-hour="${hour}">
              ${String(hour).padStart(2, "0")}
            </button>
          `).join("")}
        </div>
        <div class="time-picker-column minute">
          ${[0, 10, 20, 30, 40, 50].map((minute) => `
            <button type="button" class="${selected.minute === minute ? "selected" : ""}" data-time-minute="${minute}">
              ${String(minute).padStart(2, "0")}
            </button>
          `).join("")}
        </div>
        </div>
        <div class="time-picker-actions">
          <button type="button" data-time-cancel>취소</button>
          <button type="button" data-time-apply>적용</button>
        </div>
      </div>
    `;
    layer.querySelectorAll("[data-time-period]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        selected.period = button.dataset.timePeriod;
        draw();
      });
    });
    layer.querySelectorAll("[data-time-hour]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        selected.hour = Number(button.dataset.timeHour);
        draw();
      });
    });
    layer.querySelectorAll("[data-time-minute]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        selected.minute = Number(button.dataset.timeMinute);
        draw();
      });
    });
    layer.querySelector("[data-time-cancel]").addEventListener("click", (event) => {
      event.stopPropagation();
      closeTimePicker();
    });
    layer.querySelector("[data-time-apply]").addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(timeValueFromParts(selected.period, selected.hour, selected.minute));
      closeTimePicker();
    });
  };
  positionPickerLayer(layer, anchor, 300, 316);
  layer.classList.add("open");
  lockPickerBackground();
  draw();
}

function closeTimePicker() {
  activeTimeAnchor = null;
  $("#timePickerLayer").classList.remove("open");
  $("#timePickerLayer").innerHTML = "";
  unlockPickerBackground();
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
    : `<div class="empty">예정된 프로젝트 일정이 없습니다.</div>`;
}

function renderProjectList() {
  const query = projectSearchQuery.trim().toLowerCase();
  const filteredProjects = state.projects
    .filter((project) => {
      if (projectHideDone && project.broadcastCompleted) return false;
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
  $("#hideCompletedProjects").checked = projectHideDone;
  $("#projectFilterPanel").classList.toggle("open", isProjectFilterOpen);
  $("#projectFilterBtn").setAttribute("aria-expanded", String(isProjectFilterOpen));
  renderDropdown({
    target: $("#projectTypeFilter"),
    value: projectFilters.type || "전체 분류",
    options: ["전체 분류", ...state.options.types],
    placeholder: "전체 분류",
    colorGroup: "types",
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
    colorGroup: "clients",
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
    colorGroup: "statuses",
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
            <label class="project-complete-check" title="방영완료 상태 변경">
              <input type="checkbox" data-project-complete="${esc(project.id)}" ${project.broadcastCompleted ? "checked" : ""} ${canEditProject(project) ? "" : "disabled"} />
              <span></span>
            </label>
            <div class="project-date-cell" data-project-first-date-cell="${esc(project.id)}"></div>
            <div class="project-date-cell" data-project-date-cell="${esc(project.id)}"></div>
          </article>
        `)
        .join("")
    : `<div class="empty">${projectHideDone && state.projects.some((project) => project.broadcastCompleted) ? "표시할 프로젝트가 없습니다. 방영완료 항목 표시를 켜면 확인할 수 있습니다." : "조건에 맞는 프로젝트가 없습니다."}</div>`;

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
      colorGroup: "types",
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
      colorGroup: "clients",
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
      colorGroup: "statuses",
      compact: true,
      className: project.status ? statusClass(project.status) : "outline-cell",
      disabled: !canEditProject(project),
      onSelect: (value) => {
        const previousStatus = project.status || "";
        if (previousStatus === value) return;
        project.status = value;
        if (value === "납품 완료") project.progress = 100;
        recordProgressActivity({
          entityType: "project",
          entity: project,
          activityType: "status_change",
          previousStatus,
          nextStatus: value
        });
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
    .filter((work) => !(workHideDone && work.status === "완료"))
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
  $("#hideCompletedWorks").checked = workHideDone;
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
    : `<div class="empty">${workHideDone && state.works.some((work) => work.status === "완료") ? "표시할 업무가 없습니다. 완료 스위치를 켜면 완료된 업무를 볼 수 있습니다." : "등록된 업무가 없습니다."}</div>`;

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
        colorGroup: optionKey,
        compact: true,
        className: field === "status" && work.status ? workStatusClass(work.status) : "outline-cell",
        disabled: !canEditWork(work),
        onSelect: (value) => {
          const previousStatus = work[field];
          if (previousStatus === value) return;
          work[field] = value;
          if (field === "status") {
            recordProgressActivity({
              entityType: "work",
              entity: work,
              activityType: "status_change",
              previousStatus,
              nextStatus: value
            });
          }
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
    allDay: true,
    startTime: "09:00",
    endTime: "10:00",
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

function workStartDateFieldControl() {
  return `
    <div class="date-field-control work-start-date-control">
      <div id="work-detail-kickoffDate"></div>
      <label class="calendar-toggle work-start-calendar-toggle">
        <input type="checkbox" data-work-calendar-field="kickoffDate" />
        <span>캘린더 등록</span>
      </label>
    </div>
  `;
}

function workFinalScheduleFieldControl() {
  return `
    <div class="work-schedule-control">
      <div class="work-schedule-date" id="work-detail-finalDate"></div>
      <div class="work-schedule-time-range">
        <div id="work-detail-startTime"></div>
        <span aria-hidden="true">~</span>
        <div id="work-detail-endTime"></div>
      </div>
      <div class="work-schedule-options">
        <label class="calendar-toggle">
          <input id="workDetailAllDay" type="checkbox" />
          <span>종일</span>
        </label>
        <label class="calendar-toggle">
          <input id="workDetailNoSchedule" type="checkbox" />
          <span>일정 없음</span>
        </label>
        <label class="calendar-toggle">
          <input type="checkbox" data-work-calendar-field="finalDate" />
          <span>캘린더 등록</span>
        </label>
      </div>
    </div>
  `;
}

function setActiveWorkScheduleTime(field, value) {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work || !canEditWork(work) || work.noSchedule || work.allDay !== false) return;
  let nextValue = String(value || (field === "startTime" ? "09:00" : "10:00"));
  if (field === "endTime" && minutesFromTime(nextValue) <= minutesFromTime(work.startTime || "09:00")) {
    showToast("종료 시간은 시작 시간보다 늦어야 합니다.");
    return;
  }
  if (field === "startTime" && minutesFromTime(work.endTime || "10:00") <= minutesFromTime(nextValue)) {
    const normalized = { startTime: nextValue, endTime: work.endTime || "10:00" };
    normalizeTaskTimeRange(normalized);
    nextValue = normalized.startTime;
    work.endTime = normalized.endTime;
  }
  updateActiveWork(field, nextValue);
}

function createProjectBasicDraft(project) {
  return {
    projectId: project.id,
    status: project.status || "",
    memo: project.memo || "",
    originalStatus: project.status || "",
    originalMemo: project.memo || ""
  };
}

function createWorkBasicDraft(work) {
  return {
    workId: work.id,
    status: work.status || "",
    memo: work.memo || "",
    originalStatus: work.status || "",
    originalMemo: work.memo || ""
  };
}

function ensureProjectBasicDraft(project) {
  if (!projectBasicDraft || projectBasicDraft.projectId !== project.id) projectBasicDraft = createProjectBasicDraft(project);
  return projectBasicDraft;
}

function ensureWorkBasicDraft(work) {
  if (!workBasicDraft || workBasicDraft.workId !== work.id) workBasicDraft = createWorkBasicDraft(work);
  return workBasicDraft;
}

function projectBasicIsDirty() {
  return Boolean(projectBasicDraft && (
    projectBasicDraft.status !== projectBasicDraft.originalStatus ||
    projectBasicDraft.memo !== projectBasicDraft.originalMemo
  ));
}

function workBasicIsDirty() {
  return Boolean(workBasicDraft && (
    workBasicDraft.status !== workBasicDraft.originalStatus ||
    workBasicDraft.memo !== workBasicDraft.originalMemo
  ));
}

function syncBasicSaveButton(scope, editable = true) {
  const isProject = scope === "project";
  const button = $(isProject ? "#saveProjectBasicBtn" : "#saveWorkBasicBtn");
  if (!button) return;
  const isBasicTab = isProject ? activeDetailTab === "basic" : activeWorkDetailTab === "basic";
  const dirty = isProject ? projectBasicIsDirty() : workBasicIsDirty();
  button.hidden = !editable || !isBasicTab;
  button.disabled = !dirty;
  button.classList.toggle("is-dirty", dirty);
  button.setAttribute("aria-label", dirty ? "상태와 메모 변경사항 저장" : "저장할 상태 또는 메모 변경사항 없음");
}

function saveProjectBasicChanges({ showMessage = true } = {}) {
  const project = state.projects.find((item) => item.id === projectBasicDraft?.projectId);
  if (!project || !projectBasicDraft) return false;
  const previousStatus = projectBasicDraft.originalStatus;
  const changedFields = [];
  if (projectBasicDraft.status !== projectBasicDraft.originalStatus) changedFields.push("status");
  if (projectBasicDraft.memo !== projectBasicDraft.originalMemo) changedFields.push("memo");
  if (!changedFields.length) return false;
  project.status = projectBasicDraft.status;
  project.memo = projectBasicDraft.memo;
  if (project.status === "납품 완료") project.progress = 100;
  if (changedFields.includes("status")) {
    recordProgressActivity({
      entityType: "project",
      entity: project,
      activityType: "status_change",
      previousStatus,
      nextStatus: project.status
    });
  }
  saveState();
  notifyEntityFieldChanges({ entityType: "project", entity: project, ownerIds: projectOwners(project), fields: changedFields });
  projectBasicDraft = createProjectBasicDraft(project);
  renderAll();
  if (activeProjectId === project.id) renderProjectDetail();
  if (showMessage) showToast("프로젝트 상태와 메모가 저장되었습니다.");
  return true;
}

function saveWorkBasicChanges({ showMessage = true } = {}) {
  const work = state.works.find((item) => item.id === workBasicDraft?.workId);
  if (!work || !workBasicDraft) return false;
  const previousStatus = workBasicDraft.originalStatus;
  const changedFields = [];
  if (workBasicDraft.status !== workBasicDraft.originalStatus) changedFields.push("status");
  if (workBasicDraft.memo !== workBasicDraft.originalMemo) changedFields.push("memo");
  if (!changedFields.length) return false;
  work.status = workBasicDraft.status;
  work.memo = workBasicDraft.memo;
  if (changedFields.includes("status")) {
    recordProgressActivity({
      entityType: "work",
      entity: work,
      activityType: "status_change",
      previousStatus,
      nextStatus: work.status
    });
  }
  saveState();
  notifyEntityFieldChanges({ entityType: "work", entity: work, ownerIds: workOwners(work), fields: changedFields });
  workBasicDraft = createWorkBasicDraft(work);
  renderAll();
  if (activeWorkId === work.id) renderWorkDetail();
  if (showMessage) showToast("업무 프로젝트 상태와 메모가 저장되었습니다.");
  return true;
}

function discardBasicChanges(scope) {
  if (scope === "project") {
    const project = state.projects.find((item) => item.id === activeProjectId);
    projectBasicDraft = project ? createProjectBasicDraft(project) : null;
    if (project && $("#projectDetail")?.classList.contains("open")) renderProjectDetail();
  }
  if (scope === "work") {
    const work = state.works.find((item) => item.id === activeWorkId);
    workBasicDraft = work ? createWorkBasicDraft(work) : null;
    if (work && $("#workDetail")?.classList.contains("open")) renderWorkDetail();
  }
}

function closeUnsavedBasicModal({ restoreFocus = false } = {}) {
  const modal = $("#unsavedBasicModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  if (restoreFocus) pendingBasicLeaveAction?.focusTarget?.focus?.();
}

function requestBasicLeave(scope, action, focusTarget = document.activeElement) {
  const dirty = scope === "project" ? projectBasicIsDirty() : workBasicIsDirty();
  if (!dirty) {
    action();
    return true;
  }
  pendingBasicLeaveScope = scope;
  pendingBasicLeaveAction = { run: action, focusTarget };
  $("#unsavedBasicTitle").textContent = `${scope === "project" ? "프로젝트" : "업무 프로젝트"} 변경사항을 저장할까요?`;
  const modal = $("#unsavedBasicModal");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  setTimeout(() => $("#unsavedBasicSaveBtn")?.focus(), 0);
  return false;
}

function requestAnyBasicLeave(action, focusTarget = document.activeElement) {
  if ($("#projectDetail")?.classList.contains("open") && projectBasicIsDirty()) return requestBasicLeave("project", action, focusTarget);
  if ($("#workDetail")?.classList.contains("open") && workBasicIsDirty()) return requestBasicLeave("work", action, focusTarget);
  action();
  return true;
}

function renderWorkDetail() {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work) return;
  const editable = canEditWork(work);
  const sharedGuest = isSharedGuestItem("work", work.id);
  const basicDraft = ensureWorkBasicDraft(work);

  $("#workDetail .detail-page").classList.toggle("readonly", !editable);
  $("#workShareBanner").hidden = !sharedGuest;
  $("#workDetail .detail-actions").hidden = sharedGuest;
  $("#shareWorkBtn").hidden = !editable;
  $("#deleteWorkDetailBtn").disabled = !editable;
  $("#deleteWorkDetailBtn").title = editable ? "" : "담당자 또는 관리자만 삭제할 수 있습니다.";
  $("#workDetailTitle").value = work.title;
  $("#workDetailTitle").disabled = !editable;
  $("#workDetailProperties").innerHTML = `
    ${!editable ? `<div class="readonly-notice">${sharedGuest ? "공유 링크에서는 내용을 볼 수만 있습니다. 로그인하면 수정할 수 있습니다." : "이 업무의 담당자 또는 관리자만 수정할 수 있습니다."}</div>` : ""}
    ${propertyRow("☷", "업무분류", '<div id="workDetailType"></div>')}
    ${propertyRow("▾", "담당자", '<div id="workDetailOwners"></div>')}
    ${propertyRow("▾", "발주 부서", '<div id="workDetailClient"></div>')}
    ${propertyRow("▾", "진행", '<div id="workDetailStatus"></div>')}
    <div class="property-break"></div>
    ${propertyRow("↦", "시작일", workStartDateFieldControl(), "work-schedule-row work-schedule-start-row")}
    ${propertyRow("✓", "마감일", workFinalScheduleFieldControl(), "work-schedule-row work-schedule-final-row")}
  `;
  setRichMemoContent("workDetailMemo", basicDraft.memo, editable);

  [
    ["#workDetailType", "type", "workTypes"],
    ["#workDetailClient", "client", "workClients"],
    ["#workDetailStatus", "status", "workStatuses"]
  ].forEach(([target, field, optionKey]) => {
    renderDropdown({
      target: $(target),
      value: field === "status" ? basicDraft.status : work[field],
      options: state.options[optionKey],
      placeholder: "선택",
      colorGroup: optionKey,
      compact: true,
      className: field === "status" && basicDraft.status ? workStatusClass(basicDraft.status) : "outline-cell",
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

  $("#workDetailAllDay").checked = work.allDay !== false;
  $("#workDetailAllDay").disabled = work.noSchedule || !editable;
  $("#workDetailAllDay").addEventListener("change", (event) => updateActiveWork("allDay", event.target.checked));

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

  renderTimeButton({
    target: $("#work-detail-startTime"),
    value: work.startTime || "09:00",
    disabled: work.noSchedule || work.allDay !== false || !editable,
    onSelect: (time) => setActiveWorkScheduleTime("startTime", time)
  });
  renderTimeButton({
    target: $("#work-detail-endTime"),
    value: work.endTime || "10:00",
    disabled: work.noSchedule || work.allDay !== false || !editable,
    onSelect: (time) => setActiveWorkScheduleTime("endTime", time)
  });

  $("#workDetailProperties").querySelectorAll("[data-work-calendar-field]").forEach((checkbox) => {
    const field = checkbox.dataset.workCalendarField;
    work.calendarFields = { ...defaultWorkCalendarFields, ...(work.calendarFields || {}) };
    checkbox.checked = Boolean(work.calendarFields[field]);
    checkbox.disabled = work.noSchedule || !editable;
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
  syncBasicSaveButton("work", editable);
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
  const event = state.staffEvents.find((item) => item.id === work.studioReservationId);
  const recipientOwners = uniqueValues([...workOwners(work), ...(event?.owners || [])]);
  notifyOwners(recipientOwners, `${notificationActor().name}님이 ‘${work.title}’의 방송실 일정을 삭제했습니다.`, {
    type: "work-studio",
    workId: work.id,
    staffEventId: work.studioReservationId,
    actionType: "studio_reservation_deleted",
    title: "방송실 일정 삭제",
    targetTab: "studio"
  });
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
  normalizeTaskTimeRange(reservation);
  const staffRows = reservation.staffRows.map((row) => ({
    type: row.type || "",
    owner: row.owner || "",
    memo: row.memo || ""
  }));
  const owners = [...new Set(staffRows.map((row) => row.owner).filter((owner) => !isUnassignedStudioOwner(owner)))];
  const eventData = {
    title: reservation.title || work.title || "방송실 일정",
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
  const wasExisting = Boolean(event);
  const previousOwners = event?.owners || [];
  if (event) {
    Object.assign(event, eventData);
  } else {
    const id = makeId();
    work.studioReservationId = id;
    state.staffEvents.push({ id, ...eventData });
  }
  notifyOwners(uniqueValues([...workOwners(work), ...previousOwners, ...owners]), `${notificationActor().name}님이 ‘${work.title}’의 방송실 일정을 ${wasExisting ? "수정" : "생성"}했습니다.`, {
    type: "work-studio",
    workId: work.id,
    staffEventId: work.studioReservationId,
    actionType: wasExisting ? "studio_reservation_updated" : "studio_reservation_created",
    title: wasExisting ? "방송실 일정 수정" : "방송실 일정 생성",
    targetTab: "studio"
  });
  saveState();
  queueRemoteSave();
  renderAll();
  renderWorkDetail();
  showToast("방송실 일정이 저장되었습니다.");
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
      colorGroup: "staffTypes",
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
    colorGroup: "studioRooms",
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
    colorGroup: "trainingTypes",
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
  const reservation = ensureWorkStudioReservation(work);
  if (reservation.memo) workStudioMemoOpen = true;
  target.innerHTML = `
    <div class="work-studio-panel">
      <label class="work-studio-toggle studio-compact-toggle">
        <strong>방송실 일정</strong>
        <span>${work.studioReservationEnabled ? "사용" : "사용 안함"}</span>
        <input id="workStudioEnabled" type="checkbox" ${work.studioReservationEnabled ? "checked" : ""} ${editable ? "" : "disabled"} />
        <b></b>
      </label>
      ${work.studioReservationEnabled ? `
        <div class="work-studio-form studio-reservation-form">
          <section class="studio-reservation-basic">
            <label class="studio-reservation-title">일정 제목<input id="workStudioTitle" type="text" placeholder="일정 제목을 입력하세요" /></label>
            <div class="studio-reservation-grid studio-reservation-main-row ${reservation.allDay ? "is-all-day" : ""}">
              <label>장소<div id="workStudioRoomDropdown"></div></label>
              <label>교육 유형<div id="workStudioTrainingTypeDropdown"></div></label>
              <label class="studio-reservation-date">날짜<div id="workStudioDatePicker"></div></label>
              <label class="studio-checkbox-line studio-reservation-all-day"><input id="workStudioAllDay" type="checkbox" /> 종일 일정</label>
              ${reservation.allDay ? "" : `
                <label class="studio-reservation-start">시작 시간<div id="workStudioStartTimePicker"></div></label>
                <span class="studio-time-separator">~</span>
                <label class="studio-reservation-end">종료 시간<div id="workStudioEndTimePicker"></div></label>
              `}
            </div>
          </section>
          <button class="studio-memo-toggle" data-work-studio-memo-toggle type="button">
            <span>${workStudioMemoOpen ? "−" : "+"} 메모 ${workStudioMemoOpen ? "접기" : "추가"}</span><b>${workStudioMemoOpen ? "⌃" : "⌄"}</b>
          </button>
          ${workStudioMemoOpen ? `<label class="studio-reservation-memo"><textarea id="workStudioMemo" rows="3" maxlength="200" placeholder="준비물, 교육 내용, 진행 메모를 입력하세요.">${esc(reservation.memo || "")}</textarea></label>` : ""}
          <div class="studio-staff-head">
            <h3>스탭 목록</h3>
            <button id="workStudioAddStaffBtn" class="pill small" type="button" ${editable ? "" : "disabled"}>+ 스탭 추가</button>
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
      ` : ""}
    </div>
  `;
  if (work.studioReservationEnabled) renderWorkStudioControls(work);
}

const WORK_TASK_RECURRENCE_OPTIONS = [
  ["none", "반복 안 함"],
  ["daily", "매일"],
  ["weekly", "매주"],
  ["biweekly", "격주"],
  ["monthly", "매월"],
  ["custom", "사용자화"]
];
const WORK_TASK_WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const WORK_TASK_ORDINAL_OPTIONS = [["1", "첫 번째"], ["2", "두 번째"], ["3", "세 번째"], ["4", "네 번째"], ["-1", "마지막"]];

function workTaskDateObject(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function workTaskAddDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function workTaskAddMonths(date, amount) {
  const target = new Date(date.getFullYear(), date.getMonth() + amount, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

function workTaskMonthDay(year, month, day) {
  const candidate = new Date(year, month, day);
  return candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day ? candidate : null;
}

function workTaskOrdinalWeekday(year, month, ordinal, weekday) {
  if (ordinal === -1) {
    const last = new Date(year, month + 1, 0);
    const offset = (last.getDay() - weekday + 7) % 7;
    return new Date(year, month, last.getDate() - offset);
  }
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (ordinal - 1) * 7;
  return workTaskMonthDay(year, month, day);
}

function workTaskRecurrenceRule(source = {}) {
  const startDate = source.dueDate || source.recurrenceStartDate || dateKey(new Date());
  const start = workTaskDateObject(startDate) || dateOnly(new Date());
  const type = WORK_TASK_RECURRENCE_TYPES.has(source.recurrenceType) ? source.recurrenceType : "none";
  const weekdays = [...new Set((source.recurrenceWeekdays || []).map(Number).filter((day) => day >= 0 && day <= 6))].sort((a, b) => a - b);
  return {
    type,
    interval: type === "biweekly" ? 2 : Math.max(1, Number(source.recurrenceInterval) || 1),
    startDate: dateKey(start),
    endType: WORK_TASK_RECURRENCE_END_TYPES.has(source.recurrenceEndType) ? source.recurrenceEndType : "none",
    endDate: source.recurrenceEndDate || "",
    count: Math.max(1, Math.min(10, Number(source.recurrenceCount) || 10)),
    customFrequency: source.recurrenceCustomFrequency === "monthly" ? "monthly" : "weekly",
    weekdays: weekdays.length ? weekdays : [start.getDay()],
    monthlyMode: source.recurrenceMonthlyMode === "ordinal" ? "ordinal" : "day",
    monthlyDay: Math.max(1, Math.min(31, Number(source.recurrenceMonthlyDay) || start.getDate())),
    monthlyOrdinal: [-1, 1, 2, 3, 4].includes(Number(source.recurrenceMonthlyOrdinal)) ? Number(source.recurrenceMonthlyOrdinal) : 1,
    monthlyWeekday: Math.max(0, Math.min(6, Number(source.recurrenceMonthlyWeekday) || 0)),
    excludedDates: [...new Set((source.recurrenceExcludedDates || []).filter(Boolean))]
  };
}

function generateWorkTaskRecurrenceDates(source, { horizonDate = "" } = {}) {
  const rule = workTaskRecurrenceRule(source);
  const start = workTaskDateObject(rule.startDate);
  if (!start || rule.type === "none") return start ? [rule.startDate] : [];
  const endLimit = rule.endType === "date"
    ? workTaskDateObject(rule.endDate)
    : rule.endType === "none"
      ? (workTaskDateObject(horizonDate) || workTaskAddMonths(start, 12))
      : null;
  if (rule.endType === "date" && (!endLimit || endLimit < start)) return [];
  const targetCount = rule.endType === "count" ? rule.count : Infinity;
  const excluded = new Set(rule.excludedDates);
  const results = [];
  const seen = new Set();
  const addCandidate = (candidate) => {
    if (!candidate || candidate < start || (endLimit && candidate > endLimit)) return;
    const key = dateKey(candidate);
    if (excluded.has(key) || seen.has(key)) return;
    seen.add(key);
    results.push(key);
  };
  let iterations = 0;
  const canContinue = () => results.length < targetCount && iterations < 40000;

  if (rule.type === "daily" || rule.type === "weekly" || rule.type === "biweekly") {
    const step = rule.type === "daily" ? rule.interval : rule.interval * 7;
    let cursor = new Date(start);
    while (canContinue() && (!endLimit || cursor <= endLimit)) {
      addCandidate(cursor);
      cursor = workTaskAddDays(cursor, step);
      iterations += 1;
    }
  } else if (rule.type === "monthly") {
    let monthOffset = 0;
    while (canContinue()) {
      const anchor = new Date(start.getFullYear(), start.getMonth() + monthOffset, 1);
      const candidate = workTaskMonthDay(anchor.getFullYear(), anchor.getMonth(), start.getDate());
      if (endLimit && anchor > endLimit) break;
      addCandidate(candidate);
      monthOffset += rule.interval;
      iterations += 1;
    }
  } else if (rule.customFrequency === "weekly") {
    let cursor = new Date(start);
    while (canContinue() && (!endLimit || cursor <= endLimit)) {
      if (rule.weekdays.includes(cursor.getDay())) addCandidate(cursor);
      cursor = workTaskAddDays(cursor, 1);
      iterations += 1;
    }
  } else {
    let monthOffset = 0;
    while (canContinue()) {
      const anchor = new Date(start.getFullYear(), start.getMonth() + monthOffset, 1);
      if (endLimit && anchor > endLimit) break;
      const candidate = rule.monthlyMode === "ordinal"
        ? workTaskOrdinalWeekday(anchor.getFullYear(), anchor.getMonth(), rule.monthlyOrdinal, rule.monthlyWeekday)
        : workTaskMonthDay(anchor.getFullYear(), anchor.getMonth(), rule.monthlyDay);
      addCandidate(candidate);
      monthOffset += 1;
      iterations += 1;
    }
  }
  return results.slice(0, targetCount);
}

function workTaskRecurrenceFields(ruleSource, { groupId, originId, baseTitle, occurrenceNumber, occurrenceDate, excludedDates = [] } = {}) {
  const rule = workTaskRecurrenceRule(ruleSource);
  return {
    isRecurring: true,
    recurrenceGroupId: groupId,
    recurrenceType: rule.type,
    recurrenceInterval: rule.interval,
    recurrenceStartDate: rule.startDate,
    recurrenceEndType: rule.endType,
    recurrenceEndDate: rule.endType === "date" ? rule.endDate : "",
    recurrenceCount: rule.endType === "count" ? rule.count : 0,
    recurrenceCustomFrequency: rule.customFrequency,
    recurrenceWeekdays: [...rule.weekdays].sort((a, b) => a - b),
    recurrenceMonthlyMode: rule.monthlyMode,
    recurrenceMonthlyDay: rule.monthlyDay,
    recurrenceMonthlyOrdinal: rule.monthlyOrdinal,
    recurrenceMonthlyWeekday: rule.monthlyWeekday,
    recurrenceOccurrenceNumber: occurrenceNumber,
    recurrenceOriginId: originId,
    recurrenceBaseTitle: baseTitle,
    recurrenceDate: occurrenceDate,
    recurrenceDetached: false,
    recurrenceExcludedDates: [...new Set(excludedDates)].sort()
  };
}

function workTaskOccurrenceTitle(baseTitle, occurrenceNumber) {
  return `${stripWorkTaskOccurrenceTitle(baseTitle)} ${occurrenceNumber}회차`;
}

function buildWorkTaskRecurrenceTasks(taskPayload, draft, { groupId = makeId(), originId = "", startNumber = 1, reusableTasks = [] } = {}) {
  const dates = generateWorkTaskRecurrenceDates(draft);
  if (!dates.length) return [];
  const actualOriginId = originId || reusableTasks[0]?.recurrenceOriginId || reusableTasks[0]?.id || makeId();
  const baseTitle = stripWorkTaskOccurrenceTitle(taskPayload.text);
  const createdBase = Date.now();
  return dates.map((dueDate, index) => {
    const occurrenceNumber = startNumber + index;
    const previous = reusableTasks[index];
    const id = previous?.id || (index === 0 && !originId ? actualOriginId : makeId());
    return {
      ...previous,
      id,
      createdAt: previous?.createdAt || new Date(createdBase + index).toISOString(),
      done: Boolean(previous?.done),
      ...taskPayload,
      text: workTaskOccurrenceTitle(baseTitle, occurrenceNumber),
      dueDate,
      noDueDate: false,
      ...workTaskRecurrenceFields({ ...draft, dueDate: draft.dueDate }, {
        groupId,
        originId: actualOriginId,
        baseTitle,
        occurrenceNumber,
        occurrenceDate: dueDate,
        excludedDates: draft.recurrenceExcludedDates || []
      })
    };
  });
}

function ensureWorkRecurringTaskHorizon(work) {
  if (!work || !Array.isArray(work.tasks)) return false;
  const groups = new Map();
  work.tasks.filter((task) => task.isRecurring && task.recurrenceGroupId && task.recurrenceEndType === "none").forEach((task) => {
    if (!groups.has(task.recurrenceGroupId)) groups.set(task.recurrenceGroupId, []);
    groups.get(task.recurrenceGroupId).push(task);
  });
  let changed = false;
  const horizon = dateKey(workTaskAddMonths(dateOnly(new Date()), 12));
  groups.forEach((tasks) => {
    tasks.sort((a, b) => Number(a.recurrenceOccurrenceNumber || 0) - Number(b.recurrenceOccurrenceNumber || 0));
    const reference = tasks[0];
    const existingDates = new Set(tasks.map((task) => task.recurrenceDate || task.dueDate));
    const maxDate = [...existingDates].sort().at(-1) || "";
    const dates = generateWorkTaskRecurrenceDates({ ...reference, dueDate: reference.recurrenceStartDate || reference.dueDate }, { horizonDate: horizon });
    const additions = dates.filter((dueDate) => dueDate > maxDate && !existingDates.has(dueDate));
    if (!additions.length) return;
    const baseTitle = reference.recurrenceBaseTitle || stripWorkTaskOccurrenceTitle(reference.text);
    let nextNumber = Math.max(...tasks.map((task) => Number(task.recurrenceOccurrenceNumber) || 0)) + 1;
    additions.forEach((dueDate, index) => {
      work.tasks.push({
        ...reference,
        id: makeId(),
        createdAt: new Date(Date.now() + index).toISOString(),
        done: false,
        text: workTaskOccurrenceTitle(baseTitle, nextNumber),
        dueDate,
        recurrenceDate: dueDate,
        recurrenceOccurrenceNumber: nextNumber,
        recurrenceDetached: false
      });
      nextNumber += 1;
      changed = true;
    });
  });
  return changed;
}

function defaultWorkTaskRecurrenceDraft(value = dateKey(new Date())) {
  const date = workTaskDateObject(value) || dateOnly(new Date());
  return {
    recurrenceType: "none",
    recurrenceInterval: 1,
    recurrenceCustomFrequency: "weekly",
    recurrenceWeekdays: [date.getDay()],
    recurrenceMonthlyMode: "day",
    recurrenceMonthlyDay: date.getDate(),
    recurrenceMonthlyOrdinal: 1,
    recurrenceMonthlyWeekday: date.getDay(),
    recurrenceEndType: "count",
    recurrenceEndDate: dateKey(workTaskAddMonths(date, 1)),
    recurrenceCount: 10,
    recurrenceExcludedDates: [],
    editingScope: "single"
  };
}

function workTaskWeekdayText(days) {
  const labels = [...new Set(days)].sort((a, b) => a - b).map((day) => `${WORK_TASK_WEEKDAY_LABELS[day]}요일`);
  if (labels.length <= 1) return labels[0] || "요일 미선택";
  if (labels.length === 2) return `${labels[0]}과 ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}과 ${labels.at(-1)}`;
}

function workTaskRecurrenceSummary(source = {}) {
  const rule = workTaskRecurrenceRule(source);
  if (rule.type === "none") return "반복 안 함";
  const start = workTaskDateObject(rule.startDate) || dateOnly(new Date());
  let summary = "";
  if (rule.type === "daily") summary = "매일 반복";
  if (rule.type === "weekly") summary = `매주 ${WORK_TASK_WEEKDAY_LABELS[start.getDay()]}요일 반복`;
  if (rule.type === "biweekly") summary = `2주마다 ${WORK_TASK_WEEKDAY_LABELS[start.getDay()]}요일 반복`;
  if (rule.type === "monthly") summary = `매월 ${start.getDate()}일 반복`;
  if (rule.type === "custom" && rule.customFrequency === "weekly") summary = `매주 ${workTaskWeekdayText(rule.weekdays)} 반복`;
  if (rule.type === "custom" && rule.customFrequency === "monthly" && rule.monthlyMode === "day") summary = `매월 ${rule.monthlyDay}일 반복`;
  if (rule.type === "custom" && rule.customFrequency === "monthly" && rule.monthlyMode === "ordinal") {
    const ordinal = new Map(WORK_TASK_ORDINAL_OPTIONS).get(String(rule.monthlyOrdinal)) || "첫 번째";
    summary = `매월 ${ordinal} ${WORK_TASK_WEEKDAY_LABELS[rule.monthlyWeekday]}요일 반복`;
  }
  if (rule.endType === "count") summary += `, 총 ${rule.count}회 반복`;
  if (rule.endType === "date" && rule.endDate) summary += `, ${formatDate(rule.endDate)}까지`;
  return summary;
}

function validateWorkTaskRecurrenceDraft(draft) {
  if (draft.recurrenceType === "none") return true;
  if (draft.noDueDate || !draft.dueDate) return showToast("반복 할 일에는 시작 날짜가 필요합니다."), false;
  if (draft.recurrenceType === "custom" && draft.recurrenceCustomFrequency === "weekly" && !(draft.recurrenceWeekdays || []).length) {
    showToast("반복 요일을 1개 이상 선택하세요.");
    return false;
  }
  if (draft.recurrenceEndType === "date" && (!draft.recurrenceEndDate || draft.recurrenceEndDate < draft.dueDate)) {
    showToast("반복 종료일은 시작일 이후로 선택하세요.");
    return false;
  }
  if (draft.recurrenceEndType === "count" && (Number(draft.recurrenceCount) < 1 || Number(draft.recurrenceCount) > 10)) {
    showToast("반복 횟수는 1회부터 10회까지 입력하세요.");
    return false;
  }
  if (!generateWorkTaskRecurrenceDates(draft).length) {
    showToast("선택한 조건으로 생성할 반복 날짜가 없습니다.");
    return false;
  }
  return true;
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
  const recurrenceCountInput = $("#workTaskRecurrenceCount");
  if (titleInput) workTaskDraft.title = titleInput.value;
  if (detailInput) workTaskDraft.detail = detailInput.value;
  if (typeInput) workTaskDraft.type = typeInput.value;
  if (noDueDateInput) workTaskDraft.noDueDate = noDueDateInput.checked;
  if (allDayInput) workTaskDraft.allDay = allDayInput.checked;
  if (startInput) workTaskDraft.startTime = startInput.value || "09:00";
  if (endInput) workTaskDraft.endTime = endInput.value || "10:00";
  if (calendarInput) workTaskDraft.calendar = calendarInput.checked;
  if (recurrenceCountInput) workTaskDraft.recurrenceCount = Math.max(1, Math.min(10, Number(recurrenceCountInput.value) || 1));
}

function resetWorkTaskDraft(work) {
  const today = dateKey(new Date());
  workTaskDraft = {
    title: "",
    detail: "",
    type: "",
    owners: [],
    dueDate: today,
    noDueDate: false,
    allDay: true,
    startTime: "09:00",
    endTime: "10:00",
    calendar: false,
    ...defaultWorkTaskRecurrenceDraft(today),
    editingTaskId: null
  };
  workTaskDetailOpen = false;
  workTaskRecurrenceOpen = false;
}

function renderWorkTaskRecurrenceForm(draft, editable, editing, scope = "work") {
  const recurring = draft.recurrenceType !== "none";
  const singleOccurrenceEdit = Boolean(editing?.isRecurring && draft.editingScope === "single");
  const recurrenceEditable = editable && !singleOccurrenceEdit;
  const customWeekly = recurring && draft.recurrenceType === "custom" && draft.recurrenceCustomFrequency === "weekly";
  const customMonthly = recurring && draft.recurrenceType === "custom" && draft.recurrenceCustomFrequency === "monthly";
  const recurrenceOptions = WORK_TASK_RECURRENCE_OPTIONS.filter(([value]) => value !== "none");
  const projectScope = scope === "project";
  const countId = projectScope ? "projectTaskRecurrenceCount" : "workTaskRecurrenceCount";
  const ordinalId = projectScope ? "projectTaskRecurrenceOrdinalDropdown" : "workTaskRecurrenceOrdinalDropdown";
  const monthlyWeekdayId = projectScope ? "projectTaskRecurrenceMonthlyWeekdayDropdown" : "workTaskRecurrenceMonthlyWeekdayDropdown";
  const typeAttribute = projectScope ? "data-project-task-recurrence-type-chip" : "data-work-task-recurrence-type-chip";
  const customFrequencyAttribute = projectScope ? "data-project-task-custom-frequency" : "data-work-task-custom-frequency";
  const weekdayAttribute = projectScope ? "data-project-task-weekday" : "data-work-task-weekday";
  const monthModeAttribute = projectScope ? "data-project-task-month-mode" : "data-work-task-month-mode";
  const monthDayAttribute = projectScope ? "data-project-task-month-day" : "data-work-task-month-day";
  return `
    <section class="work-task-recurrence ${recurring ? "is-active" : ""}">
      <span class="work-task-recurrence-label">반복</span>
      <div class="work-task-recurrence-quick-row">
        <div class="work-task-recurrence-type-options" role="group" aria-label="반복 방식">
          ${recurrenceOptions.map(([value, label]) => `<button class="${draft.recurrenceType === value ? "is-selected" : ""}" ${typeAttribute}="${value}" type="button" aria-pressed="${draft.recurrenceType === value}" ${recurrenceEditable ? "" : "disabled"}>${label}</button>`).join("")}
        </div>
        ${recurring ? `
          <label class="work-task-count-inline">
            <strong>반복 횟수</strong>
            <input id="${countId}" type="number" min="1" max="10" value="${Math.max(1, Math.min(10, Number(draft.recurrenceCount) || 10))}" aria-label="반복 횟수" ${recurrenceEditable ? "" : "disabled"} />
            <b>회</b>
          </label>
        ` : ""}
      </div>
      ${singleOccurrenceEdit ? `<p class="work-task-recurrence-note">이 회차만 수정합니다. 반복 규칙은 유지됩니다.</p>` : ""}
      ${recurring && !singleOccurrenceEdit && draft.recurrenceType === "custom" ? `
        <div class="work-task-custom-panel">
          <strong>사용자화 반복</strong>
          <div class="work-task-custom-frequency" role="group" aria-label="사용자화 반복 주기">
            <button class="${customWeekly ? "is-selected" : ""}" ${customFrequencyAttribute}="weekly" type="button" aria-pressed="${customWeekly}">매주</button>
            <button class="${customMonthly ? "is-selected" : ""}" ${customFrequencyAttribute}="monthly" type="button" aria-pressed="${customMonthly}">매월</button>
          </div>
          ${customWeekly ? `
            <div class="work-task-weekdays" role="group" aria-label="반복 요일">
              <span>요일 선택 <b>*</b></span>
              <div>${WORK_TASK_WEEKDAY_LABELS.map((label, day) => `<button class="${draft.recurrenceWeekdays?.includes(day) ? "is-selected" : ""}" ${weekdayAttribute}="${day}" type="button" ${recurrenceEditable ? "" : "disabled"}>${label}</button>`).join("")}</div>
            </div>
          ` : ""}
          ${customMonthly ? `
            <div class="work-task-month-mode" role="group" aria-label="월간 반복 방식">
              <button class="${draft.recurrenceMonthlyMode === "day" ? "is-selected" : ""}" ${monthModeAttribute}="day" type="button">날짜 지정</button>
              <button class="${draft.recurrenceMonthlyMode === "ordinal" ? "is-selected" : ""}" ${monthModeAttribute}="ordinal" type="button">조건 지정</button>
            </div>
          ` : ""}
          ${customMonthly && draft.recurrenceMonthlyMode === "day" ? `
            <div class="work-task-month-days" role="group" aria-label="반복 날짜">
              <span>반복 날짜</span>
              <div>${Array.from({ length: 31 }, (_, index) => index + 1).map((day) => `<button class="${Number(draft.recurrenceMonthlyDay) === day ? "is-selected" : ""}" ${monthDayAttribute}="${day}" type="button" ${recurrenceEditable ? "" : "disabled"}>${day}</button>`).join("")}</div>
            </div>
          ` : ""}
          ${customMonthly && draft.recurrenceMonthlyMode === "ordinal" ? `
            <div class="work-task-recurrence-row">
              <label class="task-field"><span>순서</span><div id="${ordinalId}"></div></label>
              <label class="task-field"><span>요일</span><div id="${monthlyWeekdayId}"></div></label>
            </div>
          ` : ""}
        </div>
      ` : ""}
      ${recurring ? `
        <p class="work-task-recurrence-summary"><span>현재 설정</span><strong>${esc(workTaskRecurrenceSummary(draft))}</strong></p>
      ` : ""}
    </section>
  `;
}

function renderWorkTasks(work) {
  const editable = canEditWork(work);
  if (!Array.isArray(workTaskDraft.owners)) workTaskDraft.owners = [workTaskDraft.owner].filter(Boolean);
  if (!workTaskDraft.noDueDate && !workTaskDraft.dueDate) workTaskDraft.dueDate = dateKey(new Date());
  if (!workTaskDraft.startTime) workTaskDraft.startTime = "09:00";
  if (!workTaskDraft.endTime) workTaskDraft.endTime = "10:00";
  if (workTaskDraft.recurrenceType !== "none" && workTaskDraft.recurrenceEndType !== "count") {
    workTaskDraft.recurrenceEndType = "count";
    workTaskDraft.recurrenceCount = Math.max(1, Math.min(10, Number(workTaskDraft.recurrenceCount) || 10));
  }
  work.tasks = Array.isArray(work.tasks) ? work.tasks : [];
  if (ensureWorkRecurringTaskHorizon(work)) saveState();
  const tasks = work.tasks.filter((task) => !(workTaskHideDone && task.done)).sort((a, b) => {
    if (workTaskSort === "due") return String(a.dueDate || "").localeCompare(String(b.dueDate || ""));
    return String(a.createdAt || a.id || "").localeCompare(String(b.createdAt || b.id || ""));
  });
  const editing = work.tasks.find((task) => task.id === workTaskDraft.editingTaskId);
  const composerOpen = workTaskComposerOpen || Boolean(editing);
  if (editing?.detail) workTaskDetailOpen = true;
  if (editing?.isRecurring || workTaskDraft.recurrenceType !== "none") workTaskRecurrenceOpen = true;

  $("#workTaskPanel").innerHTML = `
    <div class="record-composer task-add-card ${composerOpen ? "is-expanded" : "is-collapsed"}">
      <div class="task-add-head" data-work-task-composer-toggle>
        <div class="task-add-title">
          <span class="task-add-icon">${composerOpen ? "−" : "+"}</span>
          <div>
            <h3>${editing ? "할 일 수정" : "할 일 추가"}</h3>
            <small>${editing ? "할 일 내용을 수정하세요." : "새로운 할 일을 등록하세요."}</small>
          </div>
        </div>
        <span class="task-add-chevron" aria-hidden="true">${composerOpen ? "⌃" : "⌄"}</span>
      </div>
      <div class="project-task-composer task-composer-expanded">
        <div class="work-task-primary-grid">
          <label class="task-field task-title-field">
            <span>할 일 제목 <b>*</b></span>
            <input id="workTaskTitle" class="task-title-input" value="${esc(workTaskDraft.title || "")}" placeholder="할 일 제목을 입력하세요" ${editable ? "" : "disabled"} />
          </label>
          <label class="task-field task-owner-field">
            <span>담당자 <b>*</b></span>
            <div id="workTaskOwnerDropdown"></div>
          </label>
        </div>
        <div class="work-task-schedule-grid">
          <label class="task-field task-type-field">
            <span>업무 분류 <b>*</b></span>
            <div id="workTaskTypeDropdown"></div>
          </label>
          <div class="work-task-date-stack">
            <label class="task-field task-due-field ${workTaskDraft.noDueDate ? "is-disabled" : ""}">
              <span>날짜 <b>*</b></span>
              <div id="workTaskDueDatePicker"></div>
            </label>
            <div class="task-option-row">
              <label class="calendar-toggle task-calendar-toggle">
                <input id="workTaskCalendar" type="checkbox" ${workTaskDraft.calendar ? "checked" : ""} ${workTaskDraft.noDueDate || !editable ? "disabled" : ""} />
                <span>캘린더 등록</span>
              </label>
              <label class="calendar-toggle task-all-day">
                <input id="workTaskAllDay" type="checkbox" ${workTaskDraft.allDay !== false ? "checked" : ""} ${editable ? "" : "disabled"} />
                <span>종일</span>
              </label>
              <label class="calendar-toggle task-no-due">
                <input id="workTaskNoDueDate" type="checkbox" ${workTaskDraft.noDueDate ? "checked" : ""} ${editable ? "" : "disabled"} />
                <span>마감일 없음</span>
              </label>
            </div>
          </div>
          <div class="task-field task-time-field ${workTaskDraft.noDueDate || workTaskDraft.allDay !== false ? "is-disabled" : ""}">
            <span>시간</span>
            <div class="task-time-range">
              <div id="workTaskStartTime"></div>
              <span>~</span>
              <div id="workTaskEndTime"></div>
            </div>
          </div>
        </div>
        <button class="task-detail-toggle" data-work-task-detail-toggle type="button">${workTaskDetailOpen ? "− 세부내용 접기" : "+ 세부내용 추가"}</button>
        <label class="task-field task-detail-field ${workTaskDetailOpen ? "is-open" : ""}">
          <textarea id="workTaskDetail" placeholder="세부내용을 입력하세요" ${editable ? "" : "disabled"}>${esc(workTaskDraft.detail || "")}</textarea>
        </label>
        <button class="work-task-recurrence-toggle" data-work-task-recurrence-toggle type="button">
          ${workTaskRecurrenceOpen ? "− 반복 설정 접기" : "+ 반복 설정 추가"}
        </button>
        ${workTaskRecurrenceOpen ? renderWorkTaskRecurrenceForm(workTaskDraft, editable, editing) : ""}
        <div class="task-form-footer">
          <button id="cancelWorkTaskBtn" class="pill ghost" type="button">취소</button>
          <button id="addWorkTaskBtn" class="pill primary" type="button" ${editable ? "" : "disabled"}>${editing ? "수정 완료" : "등록"}</button>
        </div>
      </div>
    </div>
    <div class="record-tools task-sort-tools">
      <span>정렬</span>
      <button class="record-control ${workTaskSort === "created" ? "active" : ""}" data-work-task-sort="created" type="button">등록순</button>
      <button class="record-control ${workTaskSort === "due" ? "active" : ""}" data-work-task-sort="due" type="button">완료일 순</button>
      <label class="calendar-toggle overview-hide-done work-task-hide-done">
        <input id="workTaskHideDone" type="checkbox" ${workTaskHideDone ? "checked" : ""} />
        <span>완료된 항목 숨기기</span>
      </label>
    </div>
    <div class="task-list">
      ${
        tasks.length
          ? tasks
              .map((task) => `
                <article class="task-row ${highlightedWorkTaskId === task.id ? "is-highlighted" : ""}" data-notification-work-task="${esc(task.id)}">
                  <label class="task-main">
                    <input type="checkbox" data-work-task-check="${esc(task.id)}" ${task.done ? "checked" : ""} ${canManageWorkTask(work, task) ? "" : "disabled"} />
                    <span>
                      <h3>${task.type ? `<span class="task-type-badge ${taskTypeClass(task.type)} ${optionColorClass("workTaskTypes", task.type)}"${optionColorAttributes("workTaskTypes", task.type)}>${esc(task.type)}</span>` : ""}${esc(task.text)}</h3>
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
          : `<div class="empty">${workTaskHideDone && work.tasks.some((task) => task.done) ? "완료된 항목 숨기기를 해제하면 완료된 할 일을 볼 수 있습니다." : "이 업무에 등록된 할 일이 없습니다."}</div>`
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
  renderDropdown({
    target: $("#workTaskTypeDropdown"),
    value: workTaskDraft.type,
    options: workTaskTypeOptions(),
    placeholder: "업무 분류",
    colorGroup: "workTaskTypes",
    disabled: !editable,
    onSelect: (type) => {
      syncWorkTaskDraftInputs();
      workTaskDraft.type = type;
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
      const selectedDate = workTaskDateObject(workTaskDraft.dueDate) || dateOnly(new Date());
      if (["weekly", "biweekly"].includes(workTaskDraft.recurrenceType)) workTaskDraft.recurrenceWeekdays = [selectedDate.getDay()];
      if (workTaskDraft.recurrenceType === "monthly") workTaskDraft.recurrenceMonthlyDay = selectedDate.getDate();
      if (!workTaskDraft.recurrenceEndDate || workTaskDraft.recurrenceEndDate < workTaskDraft.dueDate) {
        workTaskDraft.recurrenceEndDate = dateKey(workTaskAddMonths(selectedDate, 1));
      }
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

  const singleOccurrenceEdit = Boolean(editing?.isRecurring && workTaskDraft.editingScope === "single");
  const recurrenceEditable = editable && !singleOccurrenceEdit;
  $$('[data-work-task-recurrence-type-chip]', $("#workTaskPanel")).forEach((button) => {
    button.addEventListener("click", () => {
      syncWorkTaskDraftInputs();
      const recurrenceType = button.dataset.workTaskRecurrenceTypeChip;
      workTaskDraft.recurrenceType = workTaskDraft.recurrenceType === recurrenceType ? "none" : recurrenceType;
      if (workTaskDraft.recurrenceType !== "none") {
        workTaskDraft.noDueDate = false;
        workTaskDraft.recurrenceEndType = "count";
        workTaskDraft.recurrenceCount = Math.max(1, Math.min(10, Number(workTaskDraft.recurrenceCount) || 10));
        const start = workTaskDateObject(workTaskDraft.dueDate) || dateOnly(new Date());
        workTaskDraft.recurrenceWeekdays = [start.getDay()];
        workTaskDraft.recurrenceMonthlyDay = start.getDate();
        workTaskDraft.recurrenceMonthlyWeekday = start.getDay();
      }
      renderWorkTasks(work);
    });
  });
  $$('[data-work-task-custom-frequency]', $("#workTaskPanel")).forEach((button) => {
    button.addEventListener("click", () => {
      syncWorkTaskDraftInputs();
      workTaskDraft.recurrenceCustomFrequency = button.dataset.workTaskCustomFrequency;
      renderWorkTasks(work);
    });
  });
  $$('[data-work-task-month-mode]', $("#workTaskPanel")).forEach((button) => {
    button.addEventListener("click", () => {
      syncWorkTaskDraftInputs();
      workTaskDraft.recurrenceMonthlyMode = button.dataset.workTaskMonthMode;
      renderWorkTasks(work);
    });
  });
  renderDropdown({
    target: $("#workTaskRecurrenceOrdinalDropdown"),
    value: String(workTaskDraft.recurrenceMonthlyOrdinal || 1),
    options: WORK_TASK_ORDINAL_OPTIONS.map(([value]) => value),
    formatOptionLabel: (value) => new Map(WORK_TASK_ORDINAL_OPTIONS).get(String(value)) || value,
    disabled: !recurrenceEditable,
    onSelect: (recurrenceMonthlyOrdinal) => {
      syncWorkTaskDraftInputs();
      workTaskDraft.recurrenceMonthlyOrdinal = Number(recurrenceMonthlyOrdinal);
      renderWorkTasks(work);
    }
  });
  renderDropdown({
    target: $("#workTaskRecurrenceMonthlyWeekdayDropdown"),
    value: String(workTaskDraft.recurrenceMonthlyWeekday ?? 0),
    options: WORK_TASK_WEEKDAY_LABELS.map((label, day) => String(day)),
    formatOptionLabel: (value) => `${WORK_TASK_WEEKDAY_LABELS[Number(value)]}요일`,
    disabled: !recurrenceEditable,
    onSelect: (recurrenceMonthlyWeekday) => {
      syncWorkTaskDraftInputs();
      workTaskDraft.recurrenceMonthlyWeekday = Number(recurrenceMonthlyWeekday);
      renderWorkTasks(work);
    }
  });
  $$("[data-work-task-weekday]", $("#workTaskPanel")).forEach((button) => {
    button.addEventListener("click", () => {
      syncWorkTaskDraftInputs();
      const day = Number(button.dataset.workTaskWeekday);
      const selected = new Set(workTaskDraft.recurrenceWeekdays || []);
      if (selected.has(day) && selected.size === 1) {
        showToast("반복 요일을 1개 이상 선택하세요.");
        return;
      }
      if (selected.has(day)) selected.delete(day); else selected.add(day);
      workTaskDraft.recurrenceWeekdays = [...selected].sort((a, b) => a - b);
      renderWorkTasks(work);
    });
  });
  $$("[data-work-task-month-day]", $("#workTaskPanel")).forEach((button) => {
    button.addEventListener("click", () => {
      syncWorkTaskDraftInputs();
      workTaskDraft.recurrenceMonthlyDay = Number(button.dataset.workTaskMonthDay);
      renderWorkTasks(work);
    });
  });
  $("#workTaskRecurrenceCount")?.addEventListener("input", (event) => {
    workTaskDraft.recurrenceCount = Math.max(1, Math.min(10, Number(event.target.value) || 1));
    event.target.value = String(workTaskDraft.recurrenceCount);
    const summary = $("#workTaskPanel .work-task-recurrence-summary strong");
    if (summary) summary.textContent = workTaskRecurrenceSummary(workTaskDraft);
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
    if (workTaskDraft.noDueDate) {
      workTaskDraft.allDay = true;
      workTaskDraft.calendar = false;
      workTaskDraft.recurrenceType = "none";
    } else if (!workTaskDraft.dueDate) {
      workTaskDraft.dueDate = dateKey(new Date());
    }
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
      return `${author || ""} ${record.author || ""} ${managementRecordThemeLabel(record.theme)} ${record.body || ""}`.toLowerCase().includes(query);
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const editingRecord = work.records.find((record) => record.id === editingWorkRecordId);
  $("#workManagementRecords").innerHTML = `
    <div class="record-composer">
      ${managementRecordThemePicker({ selectedTheme: selectedWorkRecordTheme, editable, scope: "work" })}
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
      <button class="record-control ${workRecordFilterMode === "all" ? "active" : ""}" data-work-record-filter="all" type="button">전체</button>
      <button class="record-control ${workRecordFilterMode === "mine" ? "active" : ""}" data-work-record-filter="mine" type="button">내 기록</button>
    </div>
    <div class="record-list">
      ${
        records.length
          ? records
              .map((record) => `
                <article class="record-card" data-notification-work-record="${esc(record.id)}">
                  <div class="record-meta">
                    <strong>${esc(recordAuthorDisplayName(record.author))}</strong>
                    <span class="record-theme-badge theme-${esc(normalizeManagementRecordTheme(record.theme))}">${esc(managementRecordThemeLabel(record.theme))}</span>
                    <time>${esc(formatRecordTime(record.createdAt))}</time>
                    ${canManageRecord(record) ? `<button class="record-control" data-edit-work-record="${esc(record.id)}" type="button">수정</button>` : ""}
                    ${canManageRecord(record) ? `<button class="record-control danger" data-delete-work-record="${esc(record.id)}" type="button">삭제</button>` : ""}
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

function nonRecurringWorkTaskFields() {
  return {
    isRecurring: false,
    recurrenceGroupId: "",
    recurrenceType: "none",
    recurrenceInterval: 1,
    recurrenceStartDate: "",
    recurrenceEndType: "none",
    recurrenceEndDate: "",
    recurrenceCount: 0,
    recurrenceCustomFrequency: "weekly",
    recurrenceWeekdays: [],
    recurrenceMonthlyMode: "day",
    recurrenceMonthlyDay: 1,
    recurrenceMonthlyOrdinal: 1,
    recurrenceMonthlyWeekday: 0,
    recurrenceOccurrenceNumber: 1,
    recurrenceOriginId: "",
    recurrenceBaseTitle: "",
    recurrenceDate: "",
    recurrenceDetached: false,
    recurrenceExcludedDates: []
  };
}

function previousWorkTaskDate(value) {
  const date = workTaskDateObject(value);
  return date ? dateKey(workTaskAddDays(date, -1)) : "";
}

function addWorkTask() {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work || !canEditWork(work)) return;
  syncWorkTaskDraftInputs();
  normalizeTaskTimeRange(workTaskDraft);
  const text = String(workTaskDraft.title || "").trim();
  if (!text) return;
  work.tasks = Array.isArray(work.tasks) ? work.tasks : [];
  const editingTarget = work.tasks.find((item) => item.id === workTaskDraft.editingTaskId);
  if (!(editingTarget?.isRecurring && workTaskDraft.editingScope === "single") && !validateWorkTaskRecurrenceDraft(workTaskDraft)) return;
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
    const previous = JSON.stringify(task);
    const previousOwners = taskOwners(task);
    if (!task.isRecurring) {
      Object.assign(task, taskPayload, nonRecurringWorkTaskFields());
    } else if (workTaskDraft.editingScope === "single") {
      const duplicate = work.tasks.some((item) => item.id !== task.id && item.recurrenceGroupId === task.recurrenceGroupId && (item.recurrenceDate || item.dueDate) === taskPayload.dueDate);
      if (duplicate) {
        showToast("같은 반복 그룹에 해당 날짜의 할 일이 이미 있습니다.");
        return;
      }
      const baseTitle = stripWorkTaskOccurrenceTitle(text);
      Object.assign(task, taskPayload, {
        text: workTaskOccurrenceTitle(baseTitle, task.recurrenceOccurrenceNumber || 1),
        recurrenceBaseTitle: baseTitle,
        recurrenceDate: taskPayload.dueDate,
        recurrenceDetached: true
      });
    } else {
      const groupId = task.recurrenceGroupId;
      const groupTasks = work.tasks
        .filter((item) => item.recurrenceGroupId === groupId)
        .sort((a, b) => String(a.recurrenceDate || a.dueDate).localeCompare(String(b.recurrenceDate || b.dueDate)));
      const selectedDate = task.recurrenceDate || task.dueDate;
      const replacing = workTaskDraft.editingScope === "all"
        ? groupTasks
        : groupTasks.filter((item) => String(item.recurrenceDate || item.dueDate) >= selectedDate);
      const kept = workTaskDraft.editingScope === "all"
        ? work.tasks.filter((item) => item.recurrenceGroupId !== groupId)
        : work.tasks.filter((item) => item.recurrenceGroupId !== groupId || String(item.recurrenceDate || item.dueDate) < selectedDate);
      if (workTaskDraft.editingScope === "future") {
        kept.filter((item) => item.recurrenceGroupId === groupId).forEach((item) => {
          item.recurrenceEndType = "date";
          item.recurrenceEndDate = previousWorkTaskDate(selectedDate);
          item.recurrenceCount = 0;
        });
      }
      if (workTaskDraft.recurrenceType === "none") {
        work.tasks = [...kept, {
          ...task,
          ...taskPayload,
          text,
          ...nonRecurringWorkTaskFields()
        }];
      } else {
        const nextGroupId = workTaskDraft.editingScope === "all" ? groupId : makeId();
        const startNumber = workTaskDraft.editingScope === "all" ? 1 : Math.max(1, Number(task.recurrenceOccurrenceNumber) || 1);
        const generated = buildWorkTaskRecurrenceTasks(taskPayload, workTaskDraft, {
          groupId: nextGroupId,
          originId: workTaskDraft.editingScope === "all" ? (task.recurrenceOriginId || groupTasks[0]?.id) : task.id,
          startNumber,
          reusableTasks: replacing
        });
        work.tasks = [...kept, ...generated];
      }
    }
    if (previous !== JSON.stringify(task) || task.isRecurring) {
      notifyOwners(uniqueValues([...workOwners(work), ...previousOwners, ...taskPayload.owners]), `${notificationActor().name}님이 ‘${work.title}’의 할 일 ‘${text}’을 수정했습니다.`, { type: "work-task", workId: work.id, taskId: task.id, actionType: "work_task_updated", title: "할 일 수정", targetTab: "tasks" });
    }
    showToast("할 일이 수정되었습니다.");
  } else {
    const newTask = {
      id: makeId(),
      createdAt: new Date().toISOString(),
      done: false,
      ...taskPayload,
      ...nonRecurringWorkTaskFields()
    };
    if (workTaskDraft.recurrenceType === "none") {
      work.tasks.push(newTask);
    } else {
      const generated = buildWorkTaskRecurrenceTasks(taskPayload, workTaskDraft, {
        groupId: makeId(),
        originId: newTask.id,
        reusableTasks: [newTask]
      });
      work.tasks.push(...generated);
    }
    notifyOwners(uniqueValues([...workOwners(work), ...taskPayload.owners]), `${notificationActor().name}님이 ‘${work.title}’에 할 일 ‘${text}’을 추가했습니다.`, { type: "work-task", workId: work.id, taskId: newTask.id, actionType: "work_task_added", title: "할 일 추가", targetTab: "tasks" });
    showToast(workTaskDraft.recurrenceType === "none" ? "할 일이 등록되었습니다." : "반복 할 일이 등록되었습니다.");
  }
  resetWorkTaskDraft(work);
  workTaskComposerOpen = false;
  saveState();
  queueRemoteSave();
  renderAll();
  renderWorkDetail();
}

function editWorkTask(taskId, scope = "single") {
  const work = state.works.find((item) => item.id === activeWorkId);
  const task = work?.tasks?.find((item) => item.id === taskId);
  if (!work || !task || !canManageWorkTask(work, task)) {
    showToast("담당자 또는 관리자만 수정할 수 있습니다.");
    return;
  }
  workTaskDraft = {
    title: task.isRecurring ? (task.recurrenceBaseTitle || stripWorkTaskOccurrenceTitle(task.text)) : (task.text || ""),
    detail: task.detail || "",
    type: task.type || "",
    owners: taskOwners(task),
    dueDate: task.noDueDate ? "" : (scope === "all" && task.isRecurring ? (task.recurrenceStartDate || task.dueDate) : (task.dueDate || dateKey(new Date()))),
    noDueDate: Boolean(task.noDueDate || !task.dueDate),
    allDay: task.allDay !== false,
    startTime: task.startTime || "09:00",
    endTime: task.endTime || "10:00",
    calendar: Boolean(task.calendar),
    recurrenceType: task.isRecurring ? task.recurrenceType : "none",
    recurrenceInterval: task.recurrenceInterval || 1,
    recurrenceCustomFrequency: task.recurrenceCustomFrequency || "weekly",
    recurrenceWeekdays: [...(task.recurrenceWeekdays || [])],
    recurrenceMonthlyMode: task.recurrenceMonthlyMode || "day",
    recurrenceMonthlyDay: task.recurrenceMonthlyDay || workTaskDateObject(task.dueDate)?.getDate() || 1,
    recurrenceMonthlyOrdinal: task.recurrenceMonthlyOrdinal || 1,
    recurrenceMonthlyWeekday: task.recurrenceMonthlyWeekday ?? workTaskDateObject(task.dueDate)?.getDay() ?? 0,
    recurrenceEndType: task.isRecurring ? task.recurrenceEndType : "none",
    recurrenceEndDate: task.recurrenceEndDate || dateKey(workTaskAddMonths(workTaskDateObject(task.dueDate) || dateOnly(new Date()), 1)),
    recurrenceCount: scope === "future" && task.recurrenceEndType === "count"
      ? Math.max(1, Number(task.recurrenceCount || 1) - Number(task.recurrenceOccurrenceNumber || 1) + 1)
      : (task.recurrenceCount || 10),
    recurrenceExcludedDates: [...(task.recurrenceExcludedDates || [])],
    editingTaskId: task.id,
    editingScope: scope
  };
  workTaskDetailOpen = Boolean(task.detail);
  workTaskRecurrenceOpen = Boolean(task.isRecurring);
  workTaskComposerOpen = true;
  renderWorkTasks(work);
}

function openTaskScopeModal(entity, action, taskId) {
  const work = entity === "work" ? state.works.find((item) => item.id === activeWorkId) : null;
  const task = entity === "work" ? work?.tasks?.find((item) => item.id === taskId) : state.tasks.find((item) => item.id === taskId);
  if (!task?.isRecurring) {
    if (action === "edit") entity === "work" ? editWorkTask(taskId) : editProjectTask(taskId);
    return;
  }
  pendingWorkTaskScopeAction = { entity, action, taskId };
  const label = action === "delete" ? "삭제" : "수정";
  $("#workTaskScopeTitle").textContent = `반복 할 일 ${label}`;
  $("#workTaskScopeDescription").textContent = `${label}할 반복 범위를 선택하세요.`;
  $$("[data-work-task-scope]").forEach((button) => {
    const scope = button.dataset.workTaskScope;
    button.textContent = scope === "single" ? `이 할 일만 ${label}` : scope === "future" ? `이 할 일 및 이후 할 일 ${label}` : `전체 반복 할 일 ${label}`;
    button.classList.toggle("danger-pill", action === "delete" && scope === "all");
    button.classList.toggle("primary", action !== "delete" && scope === "all");
  });
  const modal = $("#workTaskScopeModal");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  $("#workTaskScopeCancelBtn")?.focus();
}

function openWorkTaskScopeModal(action, taskId) {
  openTaskScopeModal("work", action, taskId);
}

function openProjectTaskScopeModal(action, taskId) {
  openTaskScopeModal("project", action, taskId);
}

function closeWorkTaskScopeModal() {
  pendingWorkTaskScopeAction = null;
  const modal = $("#workTaskScopeModal");
  modal?.classList.remove("open");
  modal?.setAttribute("aria-hidden", "true");
}

function deleteWorkTaskByScope(taskId, scope) {
  const work = state.works.find((item) => item.id === activeWorkId);
  const task = work?.tasks?.find((item) => item.id === taskId);
  if (!work || !task || !canManageWorkTask(work, task)) return;
  if (!task.isRecurring || !task.recurrenceGroupId) {
    notifyTaskDeletion("work", task);
    work.tasks = work.tasks.filter((item) => item.id !== taskId);
  } else {
    const groupId = task.recurrenceGroupId;
    const selectedDate = task.recurrenceDate || task.dueDate;
    if (scope === "all") {
      work.tasks = work.tasks.filter((item) => item.recurrenceGroupId !== groupId);
    } else if (scope === "future") {
      work.tasks = work.tasks.filter((item) => item.recurrenceGroupId !== groupId || String(item.recurrenceDate || item.dueDate) < selectedDate);
      work.tasks.filter((item) => item.recurrenceGroupId === groupId).forEach((item) => {
        item.recurrenceEndType = "date";
        item.recurrenceEndDate = previousWorkTaskDate(selectedDate);
        item.recurrenceCount = 0;
      });
    } else {
      work.tasks = work.tasks.filter((item) => item.id !== taskId);
      work.tasks.filter((item) => item.recurrenceGroupId === groupId).forEach((item) => {
        item.recurrenceExcludedDates = [...new Set([...(item.recurrenceExcludedDates || []), selectedDate])].sort();
      });
    }
    notifyTaskDeletion("work", task);
  }
  saveState();
  renderAll();
  renderWorkDetail();
  showToast(scope === "all" ? "전체 반복 할 일을 삭제했습니다." : scope === "future" ? "선택한 할 일과 이후 할 일을 삭제했습니다." : "할 일을 삭제했습니다.");
}

function deleteProjectTaskByScope(taskId, scope) {
  const project = state.projects.find((item) => item.id === activeProjectId);
  const task = state.tasks.find((item) => item.id === taskId && item.projectId === project?.id);
  if (!project || !task || !canManageTask(task)) return;
  if (!task.isRecurring || !task.recurrenceGroupId) {
    notifyTaskDeletion("project", task);
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
  } else {
    const groupId = task.recurrenceGroupId;
    const selectedDate = task.recurrenceDate || task.dueDate;
    if (scope === "all") {
      state.tasks = state.tasks.filter((item) => item.projectId !== project.id || item.recurrenceGroupId !== groupId);
    } else if (scope === "future") {
      state.tasks = state.tasks.filter((item) => item.projectId !== project.id || item.recurrenceGroupId !== groupId || String(item.recurrenceDate || item.dueDate) < selectedDate);
      state.tasks.filter((item) => item.projectId === project.id && item.recurrenceGroupId === groupId).forEach((item) => {
        item.recurrenceEndType = "date";
        item.recurrenceEndDate = previousWorkTaskDate(selectedDate);
        item.recurrenceCount = 0;
      });
    } else {
      state.tasks = state.tasks.filter((item) => item.id !== taskId);
      state.tasks.filter((item) => item.projectId === project.id && item.recurrenceGroupId === groupId).forEach((item) => {
        item.recurrenceExcludedDates = [...new Set([...(item.recurrenceExcludedDates || []), selectedDate])].sort();
      });
    }
    notifyTaskDeletion("project", task);
  }
  saveState();
  renderAll();
  renderProjectDetail();
  showToast(scope === "all" ? "전체 반복 할 일을 삭제했습니다." : scope === "future" ? "선택한 할 일과 이후 할 일을 삭제했습니다." : "할 일을 삭제했습니다.");
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
  const theme = normalizeManagementRecordTheme(selectedWorkRecordTheme);
  work.records = Array.isArray(work.records) ? work.records : [];
  const user = currentUser();
  const authorName = currentRecordAuthorName(workOwners(work));
  if (editingWorkRecordId) {
    const editedRecordId = editingWorkRecordId;
    const record = work.records.find((item) => item.id === editingWorkRecordId);
    if (!canManageRecord(record)) {
      showToast("작성자 본인만 관리기록을 수정할 수 있습니다.");
      editingWorkRecordId = null;
      selectedWorkRecordTheme = "work_content";
      renderWorkDetail();
      return;
    }
    const changed = Boolean(record && (record.body !== body || normalizeManagementRecordTheme(record.theme) !== theme));
    if (record) {
      record.body = body;
      record.theme = theme;
      record.updatedAt = new Date().toISOString();
    }
    editingWorkRecordId = null;
    selectedWorkRecordTheme = "work_content";
    if (changed) notifyOwners(workOwners(work), `${notificationActor().name}님이 ‘${work.title}’의 관리기록을 수정했습니다.`, { type: "work-record", workId: work.id, recordId: editedRecordId, actionType: "work_record_updated", title: "관리기록 수정", targetTab: "records" });
    saveState();
    renderWorkDetail();
    showToast("관리기록이 수정되었습니다.");
    return;
  }
  const newRecord = {
    id: makeId(),
    author: authorName,
    authorUserId: user?.id || "",
    theme,
    body,
    createdAt: new Date().toISOString()
  };
  work.records.push(newRecord);
  recordProgressActivity({ entityType: "work", entity: work, activityType: "management_record_created", managementRecordTheme: theme });
  notifyOwners(workOwners(work), `${notificationActor().name}님이 ‘${work.title}’에 관리기록을 추가했습니다.`, { type: "work-record", workId: work.id, recordId: newRecord.id, actionType: "work_record_added", title: "관리기록 추가", targetTab: "records" });
  selectedWorkRecordTheme = "work_content";
  saveState();
  renderWorkDetail();
  showToast("관리기록이 등록되었습니다.");
}

function deleteWorkManagementRecord(recordId) {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work) return;
  const record = work.records?.find((item) => item.id === recordId);
  if (!canManageRecord(record)) {
    showToast("작성자 본인만 관리기록을 삭제할 수 있습니다.");
    return;
  }
  notifyOwners(workOwners(work), `${notificationActor().name}님이 ‘${work.title}’의 관리기록을 삭제했습니다.`, { type: "work-record", workId: work.id, recordId, actionType: "work_record_deleted", title: "관리기록 삭제", targetTab: "records" });
  work.records = (work.records || []).filter((record) => record.id !== recordId);
  if (editingWorkRecordId === recordId) editingWorkRecordId = null;
  selectedWorkRecordTheme = "work_content";
  saveState();
  renderWorkDetail();
  showToast("관리기록이 삭제되었습니다.");
}

function performOpenWorkDetail(workId, initialTab = "basic") {
  const openingWork = state.works.find((work) => work.id === workId);
  if (!openingWork) return;
  activeWorkId = workId;
  workChangeBuffer.clear();
  if (!workBasicDraft || workBasicDraft.workId !== workId) workBasicDraft = createWorkBasicDraft(openingWork);
  editingWorkRecordId = null;
  selectedWorkRecordTheme = "work_content";
  workTaskComposerOpen = false;
  resetWorkTaskDraft();
  workStudioMemoOpen = Boolean(openingWork.studioReservation?.memo);
  activeWorkDetailTab = initialTab;
  renderWorkDetail();
  $("#workDetail").classList.add("open");
  $("#workDetail").setAttribute("aria-hidden", "false");
}

function openWorkDetail(workId, initialTab = "basic", afterOpen) {
  const open = () => {
    performOpenWorkDetail(workId, initialTab);
    afterOpen?.();
  };
  if ($("#projectDetail")?.classList.contains("open") && projectBasicIsDirty()) return requestBasicLeave("project", open);
  if ($("#workDetail")?.classList.contains("open") && activeWorkId !== workId && workBasicIsDirty()) return requestBasicLeave("work", open);
  open();
}

function performCloseWorkDetail() {
  closeDatePicker();
  closeTimePicker();
  workTaskComposerOpen = false;
  resetWorkTaskDraft();
  $("#workDetail").classList.remove("open");
  $("#workDetail").setAttribute("aria-hidden", "true");
  activeWorkId = null;
  workBasicDraft = null;
  workChangeBuffer.clear();
  renderAll();
}

function closeWorkDetail() {
  if (isSharedGuestItem("work", activeWorkId)) return;
  requestBasicLeave("work", performCloseWorkDetail);
}

function updateActiveWork(field, value, rerender = true) {
  const work = state.works.find((item) => item.id === activeWorkId);
  if (!work) return;
  if (!canEditWork(work)) {
    showToast("담당자 또는 관리자만 수정할 수 있습니다.");
    renderWorkDetail();
    return;
  }
  if (field === "status" || field === "memo") {
    const draft = ensureWorkBasicDraft(work);
    draft[field] = value;
    if (rerender && field === "status") renderWorkDetail();
    else syncBasicSaveButton("work", true);
    return;
  }
  const previousOwners = field === "owners" ? workOwners(work) : [];
  const previousValue = Array.isArray(work[field]) ? [...work[field]] : work[field];
  const changed = JSON.stringify(previousValue ?? "") !== JSON.stringify(value ?? "");
  if (!changed && !workChangeBuffer.has(field)) return;
  work[field] = value;
  if (field === "owners") {
    notifyOwnerAssignmentChanges({ entityType: "work", entity: work, previousOwners, nextOwners: Array.isArray(value) ? value : [] });
  } else if (rerender || workChangeBuffer.has(field)) {
    notifyEntityFieldChanges({ entityType: "work", entity: work, ownerIds: workOwners(work), fields: [field] });
  }
  if (!rerender) workChangeBuffer.add(field);
  else workChangeBuffer.delete(field);
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
  notifyOwners(workOwners(work), `${notificationActor().name}님이 ‘${work.title}’ 업무를 삭제했습니다.`, {
    type: "work",
    workId: work.id,
    actionType: "work_deleted",
    title: "업무 삭제",
    targetTab: "basic"
  });
  if (work?.studioReservationId) state.staffEvents = state.staffEvents.filter((event) => event.id !== work.studioReservationId);
  state.works = state.works.filter((item) => item.id !== workId);
  workBasicDraft = null;
  saveState();
  performCloseWorkDetail();
}

function taskOverviewItems() {
  const projectItems = state.tasks.map((task) => {
    const project = state.projects.find((item) => item.id === task.projectId);
    return {
      id: task.id,
      source: "project",
      sourceLabel: "영상",
      sourceId: task.projectId,
      sourceTitle: project?.title || "삭제된 프로젝트",
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

function notifyTaskCompletion(source, task, done) {
  if (!task) return;
  const isWork = source === "work";
  const parent = isWork
    ? state.works.find((item) => item.id === task.workId || item.tasks?.some((entry) => entry.id === task.id))
    : state.projects.find((item) => item.id === task.projectId);
  if (!parent) return;
  const parentOwners = isWork ? workOwners(parent) : projectOwners(parent);
  const ownerIds = uniqueValues([...parentOwners, ...taskOwners(task)]);
  const parentLabel = isWork ? "업무" : "프로젝트";
  const taskLabel = task.title || task.text || "할 일";
  recordProgressActivity({
    entityType: isWork ? "work" : "project",
    entity: parent,
    activityType: "task_check",
    taskId: task.id,
    taskChecked: done
  });
  notifyOwners(ownerIds, `${notificationActor().name}님이 ‘${parent.title}’ ${parentLabel}의 할 일 ‘${taskLabel}’을 ${done ? "완료" : "완료 취소"} 처리했습니다.`, {
    type: isWork ? "work-task" : "project-task",
    workId: isWork ? parent.id : undefined,
    projectId: isWork ? undefined : parent.id,
    taskId: task.id,
    actionType: isWork
      ? (done ? "work_task_completed" : "work_task_reopened")
      : (done ? "project_task_completed" : "project_task_reopened"),
    title: done ? "할 일 완료" : "할 일 완료 취소",
    targetTab: "tasks"
  });
}

function setTaskCompletionState(task, done) {
  if (!task) return;
  task.done = Boolean(done);
  task.completedAt = task.done ? new Date().toISOString() : "";
}

function notifyTaskDeletion(source, task) {
  if (!task) return;
  const isWork = source === "work";
  const parent = isWork
    ? state.works.find((item) => item.id === task.workId || item.tasks?.some((entry) => entry.id === task.id))
    : state.projects.find((item) => item.id === task.projectId);
  if (!parent) return;
  const parentOwners = isWork ? workOwners(parent) : projectOwners(parent);
  const taskLabel = task.title || task.text || "할 일";
  notifyOwners(uniqueValues([...parentOwners, ...taskOwners(task)]), `${notificationActor().name}님이 ‘${parent.title}’의 할 일 ‘${taskLabel}’을 삭제했습니다.`, {
    type: isWork ? "work-task" : "project-task",
    workId: isWork ? parent.id : undefined,
    projectId: isWork ? undefined : parent.id,
    taskId: task.id,
    actionType: isWork ? "work_task_deleted" : "project_task_deleted",
    title: "할 일 삭제",
    targetTab: "tasks"
  });
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
  ["createdDesc", "등록일 최신 순"],
  ["createdAsc", "등록일 오래된 순"]
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
  if (diff < 0) return { label: "지연", className: "overdue" };
  if (diff === 0) return { label: "오늘", className: "today" };
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
    return [...new Set(items.flatMap((item) => taskOwners(item.task)).filter(Boolean))].map((value) => ({ value, label: ownerOptionLabel(value) }));
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
  if (kind === "owner") return ownerOptionLabel(value);
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
    renderDropdown({
      target: sortSelect,
      value: taskOverviewSort,
      options: taskSortOptions.map(([value]) => value),
      placeholder: "정렬 기준 선택",
      formatOptionLabel: (value) => `정렬: ${taskSortOptions.find(([option]) => option === value)?.[1] || value}`,
      onSelect: (value) => {
        taskOverviewSort = normalizeTaskSort(value);
        saveViewPrefs({ taskOverviewSort });
        renderTasks();
      },
    });
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

const UNASSIGNED_FILTER_KEY = "__unassigned__";

function ownerFilterKeys() {
  return [...ownerOptions(), UNASSIGNED_FILTER_KEY];
}

function ownerFilterEnabled(filters, ownerId) {
  const key = ownerId || UNASSIGNED_FILTER_KEY;
  return !(key in filters) || Boolean(filters[key]);
}

function eventMatchesOwnerFilter(owners, filters) {
  const ids = Array.isArray(owners) ? owners.filter(Boolean) : [];
  if (!ids.length) return ownerFilterEnabled(filters, UNASSIGNED_FILTER_KEY);
  return ids.some((ownerId) => ownerFilterEnabled(filters, ownerId));
}

function ownerFilterLabel(ownerId) {
  return ownerId === UNASSIGNED_FILTER_KEY ? "미배정" : ownerOptionLabel(ownerId);
}

function renderOwnerFilterChecks(target, filters, dataAttribute) {
  if (!target) return;
  const keys = ownerFilterKeys();
  const allChecked = keys.every((ownerId) => ownerFilterEnabled(filters, ownerId));
  target.innerHTML = `
    <label><input type="checkbox" ${dataAttribute}="all" ${allChecked ? "checked" : ""} /><span>전체</span></label>
    ${keys.map((ownerId) => `<label><input type="checkbox" ${dataAttribute}="${esc(ownerId)}" ${ownerFilterEnabled(filters, ownerId) ? "checked" : ""} /><span>${esc(ownerFilterLabel(ownerId))}</span></label>`).join("")}
  `;
}

function allCalendarEventsForDate(key) {
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
        allDay: true,
        owners: projectOwners(project),
        category: project.type || label,
        parentTitle: project.title,
        memo: project.memo || "",
        completed: project.status === "납품 완료",
        createdAt: project.createdAt || project.id
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
            allDay: field === "finalDate" ? work.allDay !== false : true,
            startTime: field === "finalDate" ? work.startTime || "09:00" : "09:00",
            endTime: field === "finalDate" ? work.endTime || "10:00" : "10:00",
            owners: workOwners(work),
            category: work.type || label,
            parentTitle: work.title,
            memo: work.memo || "",
            completed: work.status === "완료",
            createdAt: work.createdAt || work.id
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
      endTime: task.endTime || "10:00",
      owners: taskOwners(task),
      category: task.type || "할 일",
      parentTitle: projectName(task.projectId),
      memo: task.detail || "",
      completed: Boolean(task.done),
      createdAt: task.createdAt || task.id
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
        endTime: task.endTime || "10:00",
        owners: taskOwners(task),
        category: task.type || "할 일",
        parentTitle: work.title,
        memo: task.detail || "",
        completed: Boolean(task.done),
        createdAt: task.createdAt || task.id
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
      endTime: schedule.endTime || "10:00",
      owners: Array.isArray(schedule.owners) ? schedule.owners : [],
      category: schedule.type || "일반 일정",
      parentTitle: schedule.projectId ? projectName(schedule.projectId) : "",
      location: schedule.location || "",
      memo: schedule.memo || "",
      completed: Boolean(schedule.done),
      createdAt: schedule.createdAt || schedule.id
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
      endTime: event.endTime || "10:00",
      owners: Array.isArray(event.owners) ? event.owners : [event.owner].filter(Boolean),
      seriesId: event.seriesId || "",
      category: event.trainingType || event.type || "방송실",
      parentTitle: event.workTitle || "",
      location: event.room || "",
      memo: event.memo || "",
      completed: Boolean(event.done),
      createdAt: event.createdAt || event.id
    }));
  return [...milestones, ...workMilestones, ...projectTaskEvents, ...workTaskEvents, ...schedules, ...staffEvents];
}

function sortCalendarEvents(events) {
  return [...events].sort((a, b) => {
    if ((a.allDay !== false) !== (b.allDay !== false)) return a.allDay === false ? 1 : -1;
    const timeCompare = (a.startTime || "99:99").localeCompare(b.startTime || "99:99");
    if (timeCompare) return timeCompare;
    return String(a.createdAt || a.label || "").localeCompare(String(b.createdAt || b.label || ""), "ko");
  });
}

function projectEventsForDate(key) {
  const allEvents = allCalendarEventsForDate(key);
  const milestones = allEvents.filter((event) => event.source === "project");
  const workMilestones = allEvents.filter((event) => event.source === "work");
  const projectTaskEvents = allEvents.filter((event) => event.source === "projectTask");
  const workTaskEvents = allEvents.filter((event) => event.source === "workTask");
  const schedules = allEvents.filter((event) => event.source === "schedule");
  const staffEvents = allEvents.filter((event) => event.source === "staff");
  const videoEvents = [...milestones, ...projectTaskEvents];
  const workEvents = [...workMilestones, ...workTaskEvents];
  const projectEvents = [
    ...(calendarFilters.video ? videoEvents : []),
    ...(calendarFilters.work ? workEvents : []),
    ...(calendarFilters.schedule ? schedules : [])
  ];
  return sortCalendarEvents([...projectEvents, ...(calendarFilters.staff ? staffEvents : [])]
    .filter((event) => eventMatchesOwnerFilter(event.owners, calendarOwnerFilters))
    .filter((event) => !(calendarHideRecurring && event.seriesId)));
}

function renderCalendar() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const start = new Date(year, month, 1 - firstDay.getDay());
  const todayKey = dateKey(new Date());

  $("#calendarTitle").textContent = `${year}년 ${month + 1}월 일정`;
  $("#calendarBoard")?.classList.remove("is-staff-mode");
  const allChecked = calendarFilters.video && calendarFilters.work && calendarFilters.staff && calendarFilters.schedule;
  $$("[data-calendar-filter]").forEach((input) => {
    const key = input.dataset.calendarFilter;
    input.checked = key === "all" ? allChecked : Boolean(calendarFilters[key]);
  });
  renderOwnerFilterChecks($("#calendarOwnerFilters"), calendarOwnerFilters, "data-calendar-owner-filter");
  if ($("#calendarHideRecurring")) $("#calendarHideRecurring").checked = calendarHideRecurring;
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

function showToast(message, { type = "default", duration = 2200 } = {}) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 240);
  }, duration);
}

function propertyRow(icon, label, content, className = "") {
  return `
    <div class="property-row ${className}">
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
  const sharedGuest = isSharedGuestItem("project", project.id);
  const basicDraft = ensureProjectBasicDraft(project);

  $("#projectDetail .detail-page").classList.toggle("readonly", !editable);
  $("#projectShareBanner").hidden = !sharedGuest;
  $("#projectDetail .detail-actions").hidden = sharedGuest;
  $("#shareProjectBtn").hidden = !editable;
  $("#deleteDetailBtn").disabled = !editable;
  $("#deleteDetailBtn").title = editable ? "" : "담당자 또는 관리자만 삭제할 수 있습니다.";
  $("#detailTitle").value = project.title;
  $("#detailTitle").disabled = !editable;
  $("#detailProperties").innerHTML = `
    ${!editable ? `<div class="readonly-notice">${sharedGuest ? "공유 링크에서는 내용을 볼 수만 있습니다. 로그인하면 수정할 수 있습니다." : "이 영상의 담당자 또는 관리자만 수정할 수 있습니다."}</div>` : ""}
    ${propertyRow("☷", "업무분류", '<div id="detailType"></div>')}
    ${propertyRow("▾", "담당자", '<div id="detailOwners"></div>')}
    ${propertyRow("▾", "발주 부서", '<div id="detailClient"></div>')}
    ${propertyRow("▾", "진행", `<div class="project-status-with-broadcast"><div id="detailStatus"></div><label class="project-broadcast-toggle project-broadcast-desktop"><input type="checkbox" data-project-broadcast-complete /><span>방영완료</span></label></div>`)}
    <div class="property-break"></div>
    ${propertyRow("↦", "시작일", dateFieldControl("kickoffDate"))}
    ${propertyRow("✓", "완료일", dateFieldControl("finalDate"))}
    <div class="property-row project-broadcast-mobile-row">
      <div class="property-label"><span>✓</span>방영완료</div>
      <div class="property-value"><label class="project-broadcast-toggle icon-only"><input type="checkbox" data-project-broadcast-complete /><span>방영완료</span></label></div>
    </div>
  `;
  setRichMemoContent("detailMemo", basicDraft.memo, editable);

  [
    ["#detailType", "type", "types"],
    ["#detailClient", "client", "clients"],
    ["#detailStatus", "status", "statuses"]
  ].forEach(([target, field, optionKey]) => {
    renderDropdown({
      target: $(target),
      value: field === "status" ? basicDraft.status : project[field],
      options: state.options[optionKey],
      placeholder: "선택",
      colorGroup: optionKey,
      compact: true,
      className: field === "status" && basicDraft.status ? statusClass(basicDraft.status) : "outline-cell",
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

  $("#detailProperties").querySelectorAll("[data-project-broadcast-complete]").forEach((checkbox) => {
    checkbox.checked = Boolean(project.broadcastCompleted);
    checkbox.disabled = !editable;
    checkbox.addEventListener("change", () => {
      setProjectBroadcastCompleted(project, checkbox.checked);
      renderAll();
      if ($("#projectDetail")?.classList.contains("open")) renderProjectDetail();
    });
  });

  renderManagementRecords(project);
  renderProjectTasks(project);
  renderDetailTabs();
  syncBasicSaveButton("project", editable);
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
    onChange: (owners) => updateActiveProject("owners", owners)
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
      return `${author || ""} ${record.author || ""} ${managementRecordThemeLabel(record.theme)} ${record.body || ""}`.toLowerCase().includes(query);
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const editingRecord = project.records?.find((record) => record.id === editingRecordId);
  $("#managementRecords").innerHTML = `
    <div class="record-composer">
      ${managementRecordThemePicker({ selectedTheme: selectedRecordTheme, editable, scope: "project" })}
      <textarea id="recordBody" class="record-input" placeholder="새로운 관리 기록을 입력하세요&#10;Enter로 줄바꿈, 버튼으로 등록" ${editable ? "" : "disabled"}>${esc(editingRecord?.body || "")}</textarea>
      <div class="record-actions">
        <span>${editable ? (editingRecord ? "기록 수정 중" : "프로젝트별 관리 메모") : "담당자 또는 관리자만 기록을 추가할 수 있습니다."}</span>
        <div>
          ${editingRecord ? '<button id="cancelRecordEditBtn" class="pill ghost" type="button">취소</button>' : ""}
          <button id="addRecordBtn" class="pill primary" type="button" ${editable ? "" : "disabled"}>${editingRecord ? "수정 저장" : "+ 등록"}</button>
        </div>
      </div>
    </div>
    <div class="record-tools">
      <button class="record-control ${recordFilterMode === "all" ? "active" : ""}" data-record-filter="all" type="button">전체</button>
      <button class="record-control ${recordFilterMode === "mine" ? "active" : ""}" data-record-filter="mine" type="button">내 기록</button>
    </div>
    <div class="record-list">
      ${
        records.length
          ? records
              .map((record) => `
                <article class="record-card" data-notification-project-record="${esc(record.id)}">
                  <div class="record-meta">
                    <strong>${esc(recordAuthorDisplayName(record.author))}</strong>
                    <span class="record-theme-badge theme-${esc(normalizeManagementRecordTheme(record.theme))}">${esc(managementRecordThemeLabel(record.theme))}</span>
                    <time>${esc(formatRecordTime(record.createdAt))}</time>
                    ${canManageRecord(record) ? `<button class="record-control" data-edit-record="${esc(record.id)}" type="button">수정</button>` : ""}
                    ${canManageRecord(record) ? `<button class="record-control danger" data-delete-record="${esc(record.id)}" type="button">삭제</button>` : ""}
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
  const recurrenceCountInput = $("#projectTaskRecurrenceCount");
  if (titleInput) detailTaskDraft.title = titleInput.value;
  if (detailInput) detailTaskDraft.detail = detailInput.value;
  if (typeInput) detailTaskDraft.type = typeInput.value;
  if (noDueDateInput) detailTaskDraft.noDueDate = noDueDateInput.checked;
  if (allDayInput) detailTaskDraft.allDay = allDayInput.checked;
  if (startInput) detailTaskDraft.startTime = startInput.value || "09:00";
  if (endInput) detailTaskDraft.endTime = endInput.value || "10:00";
  if (calendarInput) detailTaskDraft.calendar = calendarInput.checked;
  if (recurrenceCountInput) detailTaskDraft.recurrenceCount = Math.max(1, Math.min(10, Number(recurrenceCountInput.value) || 1));
}

function resetProjectTaskDraft(project) {
  const today = dateKey(new Date());
  detailTaskDraft = {
    title: "",
    detail: "",
    type: "",
    owners: [],
    dueDate: today,
    noDueDate: false,
    allDay: true,
    startTime: "09:00",
    endTime: "10:00",
    calendar: false,
    ...defaultWorkTaskRecurrenceDraft(today),
    editingTaskId: null
  };
  detailTaskDetailOpen = false;
  detailTaskRecurrenceOpen = false;
}

function renderProjectTasks(project) {
  const editable = canEditProject(project);
  if (!Array.isArray(detailTaskDraft.owners)) detailTaskDraft.owners = [detailTaskDraft.owner].filter(Boolean);
  if (!detailTaskDraft.noDueDate && !detailTaskDraft.dueDate) detailTaskDraft.dueDate = dateKey(new Date());
  if (!detailTaskDraft.startTime) detailTaskDraft.startTime = "09:00";
  if (!detailTaskDraft.endTime) detailTaskDraft.endTime = "10:00";
  if (detailTaskDraft.recurrenceType !== "none" && detailTaskDraft.recurrenceEndType !== "count") {
    detailTaskDraft.recurrenceEndType = "count";
    detailTaskDraft.recurrenceCount = Math.max(1, Math.min(10, Number(detailTaskDraft.recurrenceCount) || 10));
  }

  const projectTasks = state.tasks.filter((task) => task.projectId === project.id);
  const tasks = projectTasks
    .filter((task) => !(detailTaskHideDone && task.done))
    .sort((a, b) => {
      if (detailTaskSort === "due") return String(a.dueDate || "").localeCompare(String(b.dueDate || ""));
      return String(a.createdAt || a.id || "").localeCompare(String(b.createdAt || b.id || ""));
  });
  const editing = state.tasks.find((task) => task.id === detailTaskDraft.editingTaskId);
  const composerOpen = detailTaskComposerOpen || Boolean(editing);
  if (editing?.detail) detailTaskDetailOpen = true;
  if (editing?.isRecurring || detailTaskDraft.recurrenceType !== "none") detailTaskRecurrenceOpen = true;

  $("#projectTaskPanel").innerHTML = `
    <div class="record-composer task-add-card ${composerOpen ? "is-expanded" : "is-collapsed"}">
      <div class="task-add-head" data-project-task-composer-toggle>
        <div class="task-add-title">
          <span class="task-add-icon">${composerOpen ? "−" : "+"}</span>
          <div>
            <h3>${editing ? "할 일 수정" : "할 일 추가"}</h3>
            <small>${editing ? "할 일 내용을 수정하세요." : "새로운 할 일을 등록하세요."}</small>
          </div>
        </div>
        <span class="task-add-chevron" aria-hidden="true">${composerOpen ? "⌃" : "⌄"}</span>
      </div>
      <div class="project-task-composer task-composer-expanded">
        <div class="project-task-primary-grid">
          <label class="task-field task-title-field">
            <span>할 일 제목 <b>*</b></span>
            <input id="projectTaskTitle" class="task-title-input" value="${esc(detailTaskDraft.title || "")}" placeholder="할 일 제목을 입력하세요" ${editable ? "" : "disabled"} />
          </label>
          <label class="task-field task-owner-field">
            <span>담당자 <b>*</b></span>
            <div id="projectTaskOwnerDropdown"></div>
          </label>
        </div>
        <div class="project-task-schedule-grid">
          <label class="task-field task-type-field">
            <span>업무 분류 <b>*</b></span>
            <div id="projectTaskTypeDropdown"></div>
          </label>
          <div class="project-task-date-stack">
            <label class="task-field task-due-field ${detailTaskDraft.noDueDate ? "is-disabled" : ""}">
              <span>날짜 <b>*</b></span>
              <div id="projectTaskDueDatePicker"></div>
            </label>
            <div class="task-option-row">
              <label class="calendar-toggle task-calendar-toggle">
                <input id="projectTaskCalendar" type="checkbox" ${detailTaskDraft.calendar ? "checked" : ""} ${detailTaskDraft.noDueDate || !editable ? "disabled" : ""} />
                <span>캘린더 등록</span>
              </label>
              <label class="calendar-toggle task-all-day">
                <input id="projectTaskAllDay" type="checkbox" ${detailTaskDraft.allDay !== false ? "checked" : ""} ${editable ? "" : "disabled"} />
                <span>종일</span>
              </label>
              <label class="calendar-toggle task-no-due">
                <input id="projectTaskNoDueDate" type="checkbox" ${detailTaskDraft.noDueDate ? "checked" : ""} ${editable ? "" : "disabled"} />
                <span>마감일 없음</span>
              </label>
            </div>
          </div>
          <div class="task-field task-time-field ${detailTaskDraft.noDueDate || detailTaskDraft.allDay !== false ? "is-disabled" : ""}">
            <span>시간</span>
            <div class="task-time-range">
              <div id="projectTaskStartTime"></div>
              <span>~</span>
              <div id="projectTaskEndTime"></div>
            </div>
          </div>
        </div>
        <button class="task-detail-toggle" data-project-task-detail-toggle type="button">${detailTaskDetailOpen ? "− 세부내용 접기" : "+ 세부내용 추가"}</button>
        <label class="task-field task-detail-field ${detailTaskDetailOpen ? "is-open" : ""}">
          <textarea id="projectTaskDetail" placeholder="세부내용을 입력하세요" ${editable ? "" : "disabled"}>${esc(detailTaskDraft.detail || "")}</textarea>
        </label>
        <button class="work-task-recurrence-toggle" data-project-task-recurrence-toggle type="button">
          ${detailTaskRecurrenceOpen ? "− 반복 설정 접기" : "+ 반복 설정 추가"}
        </button>
        ${detailTaskRecurrenceOpen ? renderWorkTaskRecurrenceForm(detailTaskDraft, editable, editing, "project") : ""}
        <div class="task-form-footer">
          <button id="cancelProjectTaskBtn" class="pill ghost" type="button">취소</button>
          <button id="addProjectTaskBtn" class="pill primary" type="button" ${editable ? "" : "disabled"}>${editing ? "수정 완료" : "등록"}</button>
        </div>
      </div>
    </div>
    <div class="record-tools task-sort-tools">
      <span>정렬</span>
      <button class="record-control ${detailTaskSort === "created" ? "active" : ""}" data-project-task-sort="created" type="button">등록순</button>
      <button class="record-control ${detailTaskSort === "due" ? "active" : ""}" data-project-task-sort="due" type="button">완료일 순</button>
      <label class="calendar-toggle overview-hide-done project-task-hide-done">
        <input id="projectTaskHideDone" type="checkbox" ${detailTaskHideDone ? "checked" : ""} />
        <span>완료된 항목 숨기기</span>
      </label>
    </div>
    <div class="task-list">
      ${
        tasks.length
          ? tasks
              .map((task) => `
                <article class="task-row ${highlightedProjectTaskId === task.id ? "is-highlighted" : ""}" data-notification-project-task="${esc(task.id)}">
                  <label class="task-main">
                    <input type="checkbox" data-project-task-check="${esc(task.id)}" ${task.done ? "checked" : ""} ${canManageTask(task) ? "" : "disabled"} />
                    <span>
                      <h3>${task.type ? `<span class="task-type-badge ${taskTypeClass(task.type)} ${optionColorClass("projectTaskTypes", task.type)}"${optionColorAttributes("projectTaskTypes", task.type)}>${esc(task.type)}</span>` : ""}${esc(task.text)}</h3>
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
          : `<div class="empty">${detailTaskHideDone && projectTasks.some((task) => task.done) ? "완료된 항목 숨기기를 해제하면 완료된 할 일을 볼 수 있습니다." : "이 프로젝트에 등록된 할 일이 없습니다."}</div>`
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
  renderDropdown({
    target: $("#projectTaskTypeDropdown"),
    value: detailTaskDraft.type,
    options: projectTaskTypeOptions(),
    placeholder: "업무 분류",
    colorGroup: "projectTaskTypes",
    disabled: !editable,
    onSelect: (type) => {
      syncProjectTaskDraftInputs();
      detailTaskDraft.type = type;
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
      const selectedDate = workTaskDateObject(detailTaskDraft.dueDate) || dateOnly(new Date());
      if (["weekly", "biweekly"].includes(detailTaskDraft.recurrenceType)) detailTaskDraft.recurrenceWeekdays = [selectedDate.getDay()];
      if (detailTaskDraft.recurrenceType === "monthly") detailTaskDraft.recurrenceMonthlyDay = selectedDate.getDate();
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

  const singleOccurrenceEdit = Boolean(editing?.isRecurring && detailTaskDraft.editingScope === "single");
  const recurrenceEditable = editable && !singleOccurrenceEdit;
  $$('[data-project-task-recurrence-type-chip]', $("#projectTaskPanel")).forEach((button) => {
    button.addEventListener("click", () => {
      syncProjectTaskDraftInputs();
      const recurrenceType = button.dataset.projectTaskRecurrenceTypeChip;
      detailTaskDraft.recurrenceType = detailTaskDraft.recurrenceType === recurrenceType ? "none" : recurrenceType;
      if (detailTaskDraft.recurrenceType !== "none") {
        detailTaskDraft.noDueDate = false;
        detailTaskDraft.recurrenceEndType = "count";
        detailTaskDraft.recurrenceCount = Math.max(1, Math.min(10, Number(detailTaskDraft.recurrenceCount) || 10));
        const start = workTaskDateObject(detailTaskDraft.dueDate) || dateOnly(new Date());
        detailTaskDraft.recurrenceWeekdays = [start.getDay()];
        detailTaskDraft.recurrenceMonthlyDay = start.getDate();
        detailTaskDraft.recurrenceMonthlyWeekday = start.getDay();
      }
      renderProjectTasks(project);
    });
  });
  $$('[data-project-task-custom-frequency]', $("#projectTaskPanel")).forEach((button) => {
    button.addEventListener("click", () => {
      syncProjectTaskDraftInputs();
      detailTaskDraft.recurrenceCustomFrequency = button.dataset.projectTaskCustomFrequency;
      renderProjectTasks(project);
    });
  });
  $$('[data-project-task-month-mode]', $("#projectTaskPanel")).forEach((button) => {
    button.addEventListener("click", () => {
      syncProjectTaskDraftInputs();
      detailTaskDraft.recurrenceMonthlyMode = button.dataset.projectTaskMonthMode;
      renderProjectTasks(project);
    });
  });
  $$('[data-project-task-weekday]', $("#projectTaskPanel")).forEach((button) => {
    button.addEventListener("click", () => {
      syncProjectTaskDraftInputs();
      const day = Number(button.dataset.projectTaskWeekday);
      const selected = new Set(detailTaskDraft.recurrenceWeekdays || []);
      if (selected.has(day) && selected.size === 1) {
        showToast("반복 요일을 1개 이상 선택하세요.");
        return;
      }
      if (selected.has(day)) selected.delete(day); else selected.add(day);
      detailTaskDraft.recurrenceWeekdays = [...selected].sort((a, b) => a - b);
      renderProjectTasks(project);
    });
  });
  $$('[data-project-task-month-day]', $("#projectTaskPanel")).forEach((button) => {
    button.addEventListener("click", () => {
      syncProjectTaskDraftInputs();
      detailTaskDraft.recurrenceMonthlyDay = Number(button.dataset.projectTaskMonthDay);
      renderProjectTasks(project);
    });
  });
  $("#projectTaskRecurrenceCount")?.addEventListener("input", (event) => {
    detailTaskDraft.recurrenceCount = Math.max(1, Math.min(10, Number(event.target.value) || 1));
    event.target.value = String(detailTaskDraft.recurrenceCount);
    const summary = $("#projectTaskPanel .work-task-recurrence-summary strong");
    if (summary) summary.textContent = workTaskRecurrenceSummary(detailTaskDraft);
  });
  renderDropdown({
    target: $("#projectTaskRecurrenceOrdinalDropdown"),
    value: String(detailTaskDraft.recurrenceMonthlyOrdinal || 1),
    options: WORK_TASK_ORDINAL_OPTIONS.map(([value]) => value),
    formatOptionLabel: (value) => new Map(WORK_TASK_ORDINAL_OPTIONS).get(String(value)) || value,
    disabled: !recurrenceEditable,
    onSelect: (value) => {
      syncProjectTaskDraftInputs();
      detailTaskDraft.recurrenceMonthlyOrdinal = Number(value);
      renderProjectTasks(project);
    }
  });
  renderDropdown({
    target: $("#projectTaskRecurrenceMonthlyWeekdayDropdown"),
    value: String(detailTaskDraft.recurrenceMonthlyWeekday ?? 0),
    options: WORK_TASK_WEEKDAY_LABELS.map((label, day) => String(day)),
    formatOptionLabel: (value) => `${WORK_TASK_WEEKDAY_LABELS[Number(value)]}요일`,
    disabled: !recurrenceEditable,
    onSelect: (value) => {
      syncProjectTaskDraftInputs();
      detailTaskDraft.recurrenceMonthlyWeekday = Number(value);
      renderProjectTasks(project);
    }
  });

  $("#projectTaskNoDueDate")?.addEventListener("change", () => {
    syncProjectTaskDraftInputs();
    if (detailTaskDraft.noDueDate) {
      detailTaskDraft.allDay = true;
      detailTaskDraft.calendar = false;
      detailTaskDraft.recurrenceType = "none";
    } else if (!detailTaskDraft.dueDate) {
      detailTaskDraft.dueDate = dateKey(new Date());
    }
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
  const editingTarget = state.tasks.find((item) => item.id === detailTaskDraft.editingTaskId);
  if (!(editingTarget?.isRecurring && detailTaskDraft.editingScope === "single") && !validateWorkTaskRecurrenceDraft(detailTaskDraft)) return;
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
    const previous = JSON.stringify(task);
    const previousOwners = taskOwners(task);
    if (!task.isRecurring) {
      Object.assign(task, taskPayload, nonRecurringWorkTaskFields());
    } else if (detailTaskDraft.editingScope === "single") {
      const duplicate = state.tasks.some((item) => item.id !== task.id && item.projectId === project.id && item.recurrenceGroupId === task.recurrenceGroupId && (item.recurrenceDate || item.dueDate) === taskPayload.dueDate);
      if (duplicate) {
        showToast("같은 반복 그룹에 해당 날짜의 할 일이 이미 있습니다.");
        return;
      }
      const baseTitle = stripWorkTaskOccurrenceTitle(text);
      Object.assign(task, taskPayload, {
        text: workTaskOccurrenceTitle(baseTitle, task.recurrenceOccurrenceNumber || 1),
        recurrenceBaseTitle: baseTitle,
        recurrenceDate: taskPayload.dueDate,
        recurrenceDetached: true
      });
    } else {
      const groupId = task.recurrenceGroupId;
      const groupTasks = state.tasks
        .filter((item) => item.projectId === project.id && item.recurrenceGroupId === groupId)
        .sort((a, b) => String(a.recurrenceDate || a.dueDate).localeCompare(String(b.recurrenceDate || b.dueDate)));
      const selectedDate = task.recurrenceDate || task.dueDate;
      const replacing = detailTaskDraft.editingScope === "all"
        ? groupTasks
        : groupTasks.filter((item) => String(item.recurrenceDate || item.dueDate) >= selectedDate);
      const kept = detailTaskDraft.editingScope === "all"
        ? state.tasks.filter((item) => item.projectId !== project.id || item.recurrenceGroupId !== groupId)
        : state.tasks.filter((item) => item.projectId !== project.id || item.recurrenceGroupId !== groupId || String(item.recurrenceDate || item.dueDate) < selectedDate);
      if (detailTaskDraft.editingScope === "future") {
        kept.filter((item) => item.projectId === project.id && item.recurrenceGroupId === groupId).forEach((item) => {
          item.recurrenceEndType = "date";
          item.recurrenceEndDate = previousWorkTaskDate(selectedDate);
          item.recurrenceCount = 0;
        });
      }
      if (detailTaskDraft.recurrenceType === "none") {
        state.tasks = [...kept, { ...task, ...taskPayload, text, ...nonRecurringWorkTaskFields() }];
      } else {
        const nextGroupId = detailTaskDraft.editingScope === "all" ? groupId : makeId();
        const startNumber = detailTaskDraft.editingScope === "all" ? 1 : Math.max(1, Number(task.recurrenceOccurrenceNumber) || 1);
        const generated = buildWorkTaskRecurrenceTasks({ ...taskPayload, projectId: project.id }, detailTaskDraft, {
          groupId: nextGroupId,
          originId: detailTaskDraft.editingScope === "all" ? (task.recurrenceOriginId || groupTasks[0]?.id) : task.id,
          startNumber,
          reusableTasks: replacing
        });
        state.tasks = [...kept, ...generated];
      }
    }
    if (previous !== JSON.stringify(task) || task.isRecurring) {
      notifyOwners(uniqueValues([...projectOwners(project), ...previousOwners, ...taskPayload.owners]), `${notificationActor().name}님이 ‘${project.title}’의 할 일 ‘${text}’을 수정했습니다.`, { type: "project-task", projectId: project.id, taskId: task.id, actionType: "project_task_updated", title: "할 일 수정", targetTab: "tasks" });
    }
    showToast("할 일이 수정되었습니다.");
  } else {
    const newTask = {
      id: makeId(),
      createdAt: new Date().toISOString(),
      done: false,
      ...taskPayload,
      ...nonRecurringWorkTaskFields()
    };
    if (detailTaskDraft.recurrenceType === "none") {
      state.tasks.push(newTask);
    } else {
      const generated = buildWorkTaskRecurrenceTasks({ ...taskPayload, projectId: project.id }, detailTaskDraft, {
        groupId: makeId(),
        originId: newTask.id,
        reusableTasks: [newTask]
      });
      state.tasks.push(...generated);
    }
    notifyOwners(uniqueValues([...projectOwners(project), ...taskPayload.owners]), `${notificationActor().name}님이 ‘${project.title}’에 할 일 ‘${text}’을 추가했습니다.`, { type: "project-task", projectId: project.id, taskId: newTask.id, actionType: "project_task_added", title: "할 일 추가", targetTab: "tasks" });
    showToast(detailTaskDraft.recurrenceType === "none" ? "할 일이 추가되었습니다." : "반복 할 일이 추가되었습니다.");
  }
  resetProjectTaskDraft(project);
  detailTaskComposerOpen = false;
  saveState();
  renderAll();
  renderProjectDetail();
}

function editProjectTask(taskId, scope = "single") {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || !canManageTask(task)) {
    showToast("담당자 또는 관리자만 수정할 수 있습니다.");
    return;
  }
  detailTaskDraft = {
    title: task.isRecurring ? (task.recurrenceBaseTitle || stripWorkTaskOccurrenceTitle(task.text)) : (task.text || ""),
    detail: task.detail || "",
    type: task.type || "",
    owners: taskOwners(task),
    dueDate: task.noDueDate ? "" : (scope === "all" && task.isRecurring ? (task.recurrenceStartDate || task.dueDate) : (task.dueDate || dateKey(new Date()))),
    noDueDate: Boolean(task.noDueDate || !task.dueDate),
    allDay: task.allDay !== false,
    startTime: task.startTime || "09:00",
    endTime: task.endTime || "10:00",
    calendar: Boolean(task.calendar),
    recurrenceType: task.isRecurring ? task.recurrenceType : "none",
    recurrenceInterval: task.recurrenceInterval || 1,
    recurrenceCustomFrequency: task.recurrenceCustomFrequency || "weekly",
    recurrenceWeekdays: [...(task.recurrenceWeekdays || [])],
    recurrenceMonthlyMode: task.recurrenceMonthlyMode || "day",
    recurrenceMonthlyDay: task.recurrenceMonthlyDay || workTaskDateObject(task.dueDate)?.getDate() || 1,
    recurrenceMonthlyOrdinal: task.recurrenceMonthlyOrdinal || 1,
    recurrenceMonthlyWeekday: task.recurrenceMonthlyWeekday ?? workTaskDateObject(task.dueDate)?.getDay() ?? 0,
    recurrenceEndType: task.isRecurring ? task.recurrenceEndType : "none",
    recurrenceEndDate: task.recurrenceEndDate || "",
    recurrenceCount: scope === "future" && task.recurrenceEndType === "count"
      ? Math.max(1, Number(task.recurrenceCount || 1) - Number(task.recurrenceOccurrenceNumber || 1) + 1)
      : (task.recurrenceCount || 10),
    recurrenceExcludedDates: [...(task.recurrenceExcludedDates || [])],
    editingTaskId: task.id,
    editingScope: scope
  };
  detailTaskDetailOpen = Boolean(task.detail);
  detailTaskRecurrenceOpen = Boolean(task.isRecurring);
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
  const theme = normalizeManagementRecordTheme(selectedRecordTheme);
  project.records = Array.isArray(project.records) ? project.records : [];
  const user = currentUser();
  const authorName = currentRecordAuthorName(projectOwners(project));
  if (editingRecordId) {
    const editedRecordId = editingRecordId;
    const record = project.records.find((item) => item.id === editingRecordId);
    if (!canManageRecord(record)) {
      showToast("작성자 본인만 관리기록을 수정할 수 있습니다.");
      editingRecordId = null;
      selectedRecordTheme = "work_content";
      renderProjectDetail();
      return;
    }
    const changed = Boolean(record && (record.body !== body || normalizeManagementRecordTheme(record.theme) !== theme));
    if (record) {
      record.body = body;
      record.theme = theme;
      record.updatedAt = new Date().toISOString();
    }
    editingRecordId = null;
    selectedRecordTheme = "work_content";
    if (changed) notifyOwners(projectOwners(project), `${notificationActor().name}님이 ‘${project.title}’의 관리기록을 수정했습니다.`, { type: "project-record", projectId: project.id, recordId: editedRecordId, actionType: "project_record_updated", title: "관리기록 수정", targetTab: "records" });
    saveState();
    renderProjectDetail();
    showToast("관리기록이 수정되었습니다.");
    return;
  }
  const newRecord = {
    id: makeId(),
    author: authorName,
    authorUserId: user?.id || "",
    theme,
    body,
    createdAt: new Date().toISOString()
  };
  project.records.push(newRecord);
  recordProgressActivity({ entityType: "project", entity: project, activityType: "management_record_created", managementRecordTheme: theme });
  notifyOwners(projectOwners(project), `${notificationActor().name}님이 ‘${project.title}’에 관리기록을 추가했습니다.`, { type: "project-record", projectId: project.id, recordId: newRecord.id, actionType: "project_record_added", title: "관리기록 추가", targetTab: "records" });
  selectedRecordTheme = "work_content";
  saveState();
  renderProjectDetail();
  showToast("관리기록이 등록되었습니다.");
}

function deleteManagementRecord(recordId) {
  const project = state.projects.find((item) => item.id === activeProjectId);
  if (!project) return;
  const record = project.records?.find((item) => item.id === recordId);
  if (!canManageRecord(record)) {
    showToast("작성자 본인만 관리기록을 삭제할 수 있습니다.");
    return;
  }
  notifyOwners(projectOwners(project), `${notificationActor().name}님이 ‘${project.title}’의 관리기록을 삭제했습니다.`, { type: "project-record", projectId: project.id, recordId, actionType: "project_record_deleted", title: "관리기록 삭제", targetTab: "records" });
  project.records = (project.records || []).filter((record) => record.id !== recordId);
  if (editingRecordId === recordId) editingRecordId = null;
  selectedRecordTheme = "work_content";
  saveState();
  renderProjectDetail();
  showToast("관리기록이 삭제되었습니다.");
}

function performOpenProjectDetail(projectId, initialTab = "basic") {
  const openingProject = state.projects.find((project) => project.id === projectId);
  if (!openingProject) return;
  activeProjectId = projectId;
  projectChangeBuffer.clear();
  if (!projectBasicDraft || projectBasicDraft.projectId !== projectId) projectBasicDraft = createProjectBasicDraft(openingProject);
  editingRecordId = null;
  selectedRecordTheme = "work_content";
  detailTaskComposerOpen = false;
  activeDetailTab = initialTab;
  renderProjectDetail();
  $("#projectDetail").classList.add("open");
  $("#projectDetail").setAttribute("aria-hidden", "false");
}

function openProjectDetail(projectId, initialTab = "basic", afterOpen) {
  const open = () => {
    performOpenProjectDetail(projectId, initialTab);
    afterOpen?.();
  };
  if ($("#workDetail")?.classList.contains("open") && workBasicIsDirty()) return requestBasicLeave("work", open);
  if ($("#projectDetail")?.classList.contains("open") && activeProjectId !== projectId && projectBasicIsDirty()) return requestBasicLeave("project", open);
  open();
}

function performCloseProjectDetail() {
  $("#projectDetail").classList.remove("open");
  $("#projectDetail").setAttribute("aria-hidden", "true");
  activeProjectId = null;
  projectBasicDraft = null;
  projectChangeBuffer.clear();
  renderAll();
}

function closeProjectDetail() {
  if (isSharedGuestItem("project", activeProjectId)) return;
  requestBasicLeave("project", performCloseProjectDetail);
}

function updateActiveProject(field, value, rerender = true) {
  const project = state.projects.find((item) => item.id === activeProjectId);
  if (!project) return;
  if (!canEditProject(project)) {
    showToast("담당자 또는 관리자만 수정할 수 있습니다.");
    renderProjectDetail();
    return;
  }
  if (field === "status" || field === "memo") {
    const draft = ensureProjectBasicDraft(project);
    draft[field] = value;
    if (rerender && field === "status") renderProjectDetail();
    else syncBasicSaveButton("project", true);
    return;
  }
  const previousOwners = field === "owners" ? projectOwners(project) : [];
  const previousValue = Array.isArray(project[field]) ? [...project[field]] : project[field];
  const changed = JSON.stringify(previousValue ?? "") !== JSON.stringify(value ?? "");
  if (!changed && !projectChangeBuffer.has(field)) return;
  project[field] = ["budget", "spent", "progress"].includes(field) ? Number(value || 0) : value;
  if (field === "owners") {
    notifyOwnerAssignmentChanges({ entityType: "project", entity: project, previousOwners, nextOwners: Array.isArray(value) ? value : [] });
  } else if (rerender || projectChangeBuffer.has(field)) {
    notifyEntityFieldChanges({ entityType: "project", entity: project, ownerIds: projectOwners(project), fields: [field] });
  }
  if (!rerender) projectChangeBuffer.add(field);
  else projectChangeBuffer.delete(field);
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
    title: "새 프로젝트",
    method: "",
    type: "",
    owners: [],
    client: "",
    note: "",
    status: "",
    broadcastCompleted: false,
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
  notifyOwners(projectOwners(project), `${notificationActor().name}님이 ‘${project.title}’ 프로젝트를 삭제했습니다.`, {
    type: "project",
    projectId: project.id,
    actionType: "project_deleted",
    title: "프로젝트 삭제",
    targetTab: "basic"
  });
  state.projects = state.projects.filter((project) => project.id !== projectId);
  state.tasks = state.tasks.filter((task) => task.projectId !== projectId);
  state.schedules = state.schedules.filter((schedule) => schedule.projectId !== projectId);
  projectBasicDraft = null;
  saveState();
  performCloseProjectDetail();
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
  $("#scheduleEyebrow").textContent = "NEW SCHEDULE";
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
  $("#scheduleEyebrow").textContent = "EDIT SCHEDULE";
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
  $("#staffScheduleForm button[type='submit']").textContent = "일정 등록";
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
  $("#staffScheduleForm button[type='submit']").textContent = "예약 수정";
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
      colorGroup: "staffTypes",
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
    colorGroup: "studioRooms",
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
    colorGroup: "trainingTypes",
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
    if (schedule) {
      const previous = JSON.stringify(schedule);
      const previousOwners = schedule.owners || [];
      Object.assign(schedule, scheduleData);
      if (previous !== JSON.stringify(schedule)) {
        notifyOwners(uniqueValues([...previousOwners, ...schedule.owners]), `${notificationActor().name}님이 ‘${schedule.title}’ 일정을 수정했습니다.`, {
          type: "schedule",
          scheduleId: schedule.id,
          actionType: "schedule_updated",
          title: "일정 수정",
          eventDate: schedule.date,
          targetView: "calendar"
        });
      }
    }
  } else {
    const schedule = { id: makeId(), ...scheduleData };
    state.schedules.push(schedule);
    notifyOwners(schedule.owners, `${notificationActor().name}님이 ‘${schedule.title}’ 일정을 생성했습니다.`, {
      type: "schedule",
      scheduleId: schedule.id,
      actionType: "schedule_created",
      title: "일정 생성",
      eventDate: schedule.date,
      targetView: "calendar"
    });
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
  $("#staffEventDetailEyebrow").textContent = "SCHEDULE DETAIL";
  $("#staffEventDetailTitle").textContent = "일정 상세";
  $("#editScheduleEventBtn").hidden = false;
  $("#sendStaffEventTelegramBtn").hidden = true;
  $("#deleteStaffEventBtn").textContent = "일정 삭제";
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
  const title = $("#staffScheduleTitle").value.trim() || staffScheduleDraft.trainingType || "방송실 일정";
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
    if (event) {
      const previous = JSON.stringify(event);
      const previousOwners = event.owners || [];
      Object.assign(event, eventData, { date: staffScheduleDraft.date || event.date });
      if (previous !== JSON.stringify(event)) {
        notifyOwners(uniqueValues([...previousOwners, ...event.owners]), `${notificationActor().name}님이 ‘${event.title}’ 방송실 일정을 수정했습니다.`, {
          type: "staff",
          staffEventId: event.id,
          actionType: "studio_reservation_updated",
          title: "방송실 일정 수정",
          eventDate: event.date,
          targetView: "studio"
        });
      }
    }
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
  let firstEventId = "";
  dates.forEach((nextDate) => {
    const id = makeId();
    if (!firstEventId) firstEventId = id;
    state.staffEvents.push({
      id,
      ...eventData,
      seriesId,
      date: dateKey(nextDate),
    });
  });
  notifyOwners(owners, `${notificationActor().name}님이 ‘${title}’ 방송실 일정${staffScheduleDraft.repeatEnabled ? " 반복 일정" : ""}을 생성했습니다.`, {
    type: "staff",
    staffEventId: firstEventId,
    actionType: staffScheduleDraft.repeatEnabled ? "recurring_schedule_created" : "studio_reservation_created",
    title: staffScheduleDraft.repeatEnabled ? "반복 일정 생성" : "방송실 일정 생성",
    eventDate: staffScheduleDraft.date,
    targetView: "studio"
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
      colorGroup: "staffTypes",
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
  const fixedNotice = studioGlobalFixedNotice();
  activeStaffEventId = staffEventId;
  activeScheduleEventId = null;
  $("#staffEventDetailEyebrow").textContent = "STUDIO SCHEDULE";
  $("#staffEventDetailTitle").textContent = "방송실 일정 상세";
  $("#editScheduleEventBtn").hidden = false;
  $("#sendStaffEventTelegramBtn").hidden = !isAdminUser();
  $("#deleteStaffEventBtn").textContent = "일정 삭제";
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
    ${isAdminUser() ? `<section class="studio-event-telegram">
      <div class="studio-event-telegram-head">
        <span class="studio-event-telegram-copy">
          <strong>텔레그램 공지 설정</strong>
          <small>이 일정만 바로 보낼 때 적용됩니다.</small>
        </span>
        <label class="studio-inline-calltime" title="일정 시작 전 도착 시간을 선택합니다.">
          <span>콜타임</span>
          <select data-studio-event-call-time-offset aria-label="콜타임 선택">${studioCallTimeOffsetOptions(event.telegramCallTimeOffsetMinutes)}</select>
        </label>
      </div>
      ${fixedNotice ? `<div class="studio-auto-fixed-notice"><span>자동 적용 고정 특이사항</span><p>${esc(fixedNotice)}</p><small>공지 관리에 저장된 내용이 전송할 때 자동으로 포함됩니다.</small></div>` : ""}
      <label>
        ${fixedNotice ? "이 일정 추가 특이사항" : "특이사항"}
        <textarea data-studio-event-telegram-note maxlength="1000" placeholder="공지에 함께 보낼 준비물, 출입 안내 등을 입력하세요.">${esc(event.telegramNote || "")}</textarea>
      </label>
      <small class="studio-event-telegram-message" data-studio-event-telegram-message></small>
    </section>` : ""}
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

function openStudioTelegramPreview({ message = "", mode = "view", eventId = "", title = "텔레그램 공지 미리보기", description = "실제 전송될 내용을 확인하세요." } = {}) {
  studioTelegramPreviewContext = { mode, eventId };
  $("#studioTelegramPreviewTitle").textContent = title;
  $("#studioTelegramPreviewDescription").textContent = description;
  $("#studioTelegramPreviewContent").textContent = message;
  $("#studioTelegramPreviewMessage").textContent = "";
  $("#cancelStudioTelegramPreviewBtn").textContent = mode === "send" ? "취소" : "닫기";
  $("#confirmStudioTelegramSendBtn").hidden = mode !== "send";
  $("#studioTelegramPreviewModal").classList.add("open");
  $("#studioTelegramPreviewModal").setAttribute("aria-hidden", "false");
}

function closeStudioTelegramPreview() {
  studioTelegramPreviewContext = null;
  $("#studioTelegramPreviewModal").classList.remove("open");
  $("#studioTelegramPreviewModal").setAttribute("aria-hidden", "true");
}

async function sendStudioEventTelegram(eventId, button) {
  const event = state.staffEvents.find((item) => item.id === eventId);
  if (!event || !button) return;
  const originalText = button.textContent;
  const messageTarget = $("[data-studio-event-telegram-message]");
  button.disabled = true;
  button.textContent = "미리보기 생성 중…";
  if (messageTarget) messageTarget.textContent = "";
  try {
    saveState();
    const remoteSaved = SUPABASE_ENABLED ? await saveRemoteDashboardState() : false;
    if (SUPABASE_ENABLED && !remoteSaved) throw new Error("최신 일정 내용을 서버에 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    const result = await telegramDigestApi("studio-preview", { eventId });
    openStudioTelegramPreview({
      message: result.message,
      mode: "send",
      eventId,
      description: "아래 내용 그대로 텔레그램에 전송할까요?"
    });
  } catch (error) {
    if (messageTarget) messageTarget.textContent = error.message || "전송하지 못했습니다.";
    showToast(error.message || "텔레그램 미리보기를 만들지 못했습니다.");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function confirmStudioTelegramSend() {
  const eventId = studioTelegramPreviewContext?.mode === "send" ? studioTelegramPreviewContext.eventId : "";
  if (!eventId) return;
  const button = $("#confirmStudioTelegramSendBtn");
  const messageTarget = $("#studioTelegramPreviewMessage");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "전송 중…";
  if (messageTarget) messageTarget.textContent = "";
  try {
    await telegramDigestApi("studio-send", { eventId });
    closeStudioTelegramPreview();
    const detailMessage = $("[data-studio-event-telegram-message]");
    if (detailMessage) detailMessage.textContent = "텔레그램 그룹으로 전송했습니다.";
    showToast("방송실 일정을 텔레그램으로 전송했습니다.");
  } catch (error) {
    if (messageTarget) messageTarget.textContent = error.message || "전송하지 못했습니다.";
    showToast(error.message || "텔레그램 전송에 실패했습니다.");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function deleteScheduleEvent(scheduleId) {
  const schedule = state.schedules.find((item) => item.id === scheduleId);
  if (schedule) {
    notifyOwners(schedule.owners || [], `${notificationActor().name}님이 ‘${schedule.title}’ 일정을 삭제했습니다.`, {
      type: "schedule",
      scheduleId: schedule.id,
      actionType: "schedule_deleted",
      title: "일정 삭제",
      eventDate: schedule.date,
      targetView: "calendar"
    });
  }
  state.schedules = state.schedules.filter((schedule) => schedule.id !== scheduleId);
  saveState();
  closeStaffEventDetail();
  renderAll();
}

function deleteStaffEvent(staffEventId) {
  const event = state.staffEvents.find((item) => item.id === staffEventId);
  if (event) {
    notifyOwners(event.owners || [event.owner], `${notificationActor().name}님이 ‘${event.title}’ 방송실 일정을 삭제했습니다.`, {
      type: "staff",
      staffEventId: event.id,
      actionType: "studio_reservation_deleted",
      title: "방송실 일정 삭제",
      eventDate: event.date,
      targetView: "studio"
    });
  }
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
  const seriesEvents = state.staffEvents.filter((item) => item.seriesId === event.seriesId);
  const owners = uniqueValues(seriesEvents.flatMap((item) => item.owners || [item.owner]).filter(Boolean));
  notifyOwners(owners, `${notificationActor().name}님이 ‘${event.title}’ 반복 방송실 일정을 삭제했습니다.`, {
    type: "staff",
    staffEventId: event.id,
    actionType: "recurring_schedule_deleted",
    title: "반복 일정 삭제",
    eventDate: event.date,
    targetView: "studio"
  });
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
    colorGroup: "studioRooms",
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
    colorGroup: "staffTypes",
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
    colorGroup: "trainingTypes",
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
  const configuredGroup = ["trainingTypes", "staffTypes"].find((group) => optionColorKey(group, type) !== "default");
  if (configuredGroup) return OPTION_COLOR_PALETTE[optionColorKey(configuredGroup, type)].color;
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
  const owners = Array.isArray(event.owners) ? event.owners : [event.owner].filter(Boolean);
  return studioTrainingFilterEnabled(staffEventTitle(event))
    && eventMatchesOwnerFilter(owners, studioOwnerFilters)
    && !(studioHideRecurring && event.seriesId);
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

function renderStudioOwnerFilters() {
  renderOwnerFilterChecks($("#studioOwnerFilters"), studioOwnerFilters, "data-studio-owner-filter");
  if ($("#studioHideRecurring")) $("#studioHideRecurring").checked = studioHideRecurring;
}

function renderStudioUnassignedNotice() {
  const target = $("#studioUnassignedNotice");
  if (!target) return;
  const count = state.staffEvents.filter(needsStudioStaffAssignment).length;
  target.innerHTML = count
    ? `<div class="studio-unassigned-alert"><span>스탭 배정이 안된 방송실 일정이 있습니다! <b>${count}건</b></span><button type="button" data-open-nearest-unassigned>가까운 날짜 배정하기</button></div>`
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
  const telegramButton = $("#studioTelegramManageBtn");
  if (telegramButton) telegramButton.hidden = !isAdminUser();
  $$("[data-studio-view-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.studioViewMode === studioViewMode);
  });
  renderStudioLegend();
  renderStudioUnassignedNotice();
  renderStudioTrainingTypeFilters();
  renderStudioOwnerFilters();
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
  showToast("방송실 일정 시간이 변경되었습니다.");
}

function moveStudioEventToDate(eventId, date) {
  const event = state.staffEvents.find((item) => item.id === eventId);
  if (!event || !date) return;
  event.date = date;
  saveState();
  renderAll();
  showToast("방송실 일정 날짜가 변경되었습니다.");
}

function boardPrefixes() {
  return state.options.boardPrefixes?.length ? state.options.boardPrefixes : ["일반"];
}

function boardPrefixValue(value) {
  return value || boardPrefixes()[0] || "일반";
}

function boardCommentsForPost(postId) {
  return (state.boardComments || []).filter((comment) => comment.postId === postId && !comment.deletedAt);
}

function isActiveNotice(post) {
  if (!post?.isNotice || post.deletedAt) return false;
  if (!post.noticeUntil) return true;
  return dateKey(new Date()) <= post.noticeUntil;
}

function getNoticeUntil(periodType, customDate) {
  if (periodType === "forever") return null;
  if (periodType === "custom") return customDate || null;
  const date = new Date();
  if (periodType === "month") date.setMonth(date.getMonth() + 1);
  else date.setDate(date.getDate() + 7);
  return dateKey(date);
}

function boardNoticePeriodLabel(post) {
  if (!post?.isNotice) return "일반글";
  if (!post.noticeUntil) return "무기한";
  return `${formatDate(post.noticeUntil)}까지`;
}

function stripHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";
  return template.content.textContent || "";
}

function sanitizeBoardHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";
  const allowed = new Set(["P", "BR", "H1", "H2", "H3", "H4", "STRONG", "B", "EM", "I", "U", "S", "STRIKE", "DEL", "DIV", "SPAN"]);
  template.content.querySelectorAll("*").forEach((node) => {
    if (!allowed.has(node.tagName)) {
      node.replaceWith(...Array.from(node.childNodes));
      return;
    }
    [...node.attributes].forEach((attr) => {
      if (attr.name.startsWith("on") || ["style", "src", "href"].includes(attr.name)) node.removeAttribute(attr.name);
    });
  });
  return template.innerHTML;
}

function boardDateText(value, compact = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  const sameDay = dateKey(date) === dateKey(now);
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (compact && sameDay) return hhmm;
  if (compact) return `${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")} ${hhmm}`;
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function boardAuthor() {
  const user = currentUser();
  return {
    id: user?.id || "",
    name: user?.name || user?.username || "사용자"
  };
}

function canManageBoardPost(post) {
  return Boolean(post && currentUser() && (isAdminUser() || post.authorUserId === currentUser()?.id));
}

function canManageBoardComment(comment) {
  return Boolean(comment && currentUser() && (isAdminUser() || comment.authorUserId === currentUser()?.id));
}

function notifyBoardNotice(post) {
  if (!post?.isNotice || post.notifyOff) return;
  const users = state.users || [];
  users.forEach((user) => {
    if (!user?.id || user.id === post.authorUserId || user.status === "inactive" || user.approved === false || user.status === "pending") return;
    state.notifications.push({
      id: makeId(),
      userId: user.id,
      title: "새 공지",
      body: `새 공지가 등록되었습니다: ${post.title}`,
      message: `새 공지가 등록되었습니다: ${post.title}`,
      source: { type: "board", postId: post.id, action: "notice" },
      read: false,
      createdAt: new Date().toISOString()
    });
  });
}

function notifyBoardComment(post, comment) {
  if (!post || !comment || !post.authorUserId || post.authorUserId === comment.authorUserId) return;
  state.notifications.push({
    id: makeId(),
    userId: post.authorUserId,
    title: "게시판 댓글",
    body: `내 게시글에 댓글이 달렸습니다: ${post.title}`,
    message: `내 게시글에 댓글이 달렸습니다: ${post.title}`,
    source: { type: "board", postId: post.id, commentId: comment.id, action: "comment" },
    read: false,
    createdAt: new Date().toISOString()
  });
}

function notifyBoardReply(post, parent, reply) {
  if (!post || !parent || !reply || !parent.authorUserId || parent.authorUserId === reply.authorUserId || parent.authorUserId === post.authorUserId) return;
  state.notifications.push({
    id: makeId(),
    userId: parent.authorUserId,
    title: "게시판 답글",
    body: `내 댓글에 답글이 달렸습니다: ${post.title}`,
    message: `내 댓글에 답글이 달렸습니다: ${post.title}`,
    source: { type: "board", postId: post.id, commentId: reply.id, action: "reply" },
    read: false,
    createdAt: new Date().toISOString()
  });
}

function sortBoardPosts(posts) {
  return [...posts].sort((a, b) => {
    const aNotice = isActiveNotice(a);
    const bNotice = isActiveNotice(b);
    if (aNotice !== bNotice) return aNotice ? -1 : 1;
    if (aNotice && bNotice) return new Date(b.createdAt) - new Date(a.createdAt);
    return Number(b.number || 0) - Number(a.number || 0);
  });
}

function filteredBoardPosts() {
  const query = boardSearchQuery.trim().toLowerCase();
  return sortBoardPosts((state.boardPosts || []).filter((post) => {
    if (post.deletedAt) return false;
    const activeNotice = isActiveNotice(post);
    if (boardActiveTab === "notice" && !activeNotice) return false;
    if (boardActiveTab === "mine" && post.authorUserId !== currentUser()?.id) return false;
    if (boardPostFilter === "notice" && !activeNotice) return false;
    if (boardPostFilter === "mine" && post.authorUserId !== currentUser()?.id) return false;
    if (boardPrefixFilter && post.prefix !== boardPrefixFilter) return false;
    if (!query) return true;
    const title = (post.title || "").toLowerCase();
    const body = stripHtml(post.contentHtml).toLowerCase();
    const author = (post.authorName || "").toLowerCase();
    if (boardSearchScope === "title") return title.includes(query);
    if (boardSearchScope === "content") return body.includes(query);
    return `${title} ${body} ${author}`.includes(query);
  }));
}

function trackBoardPostView(postId) {
  const post = state.boardPosts.find((item) => item.id === postId);
  const user = currentUser();
  if (!post || !user?.id) return;
  post.viewUserIds = Array.isArray(post.viewUserIds) ? post.viewUserIds : [];
  post.viewLogs = Array.isArray(post.viewLogs) ? post.viewLogs : [];
  const log = post.viewLogs.find((item) => item.userId === user.id);
  if (log) return;
  if (!post.viewUserIds.includes(user.id)) post.viewUserIds.push(user.id);
  post.viewLogs.push({ userId: user.id, name: user.name || user.username || "사용자", viewedAt: new Date().toISOString() });
  saveState();
}

function openBoardDetail(postId) {
  activeBoardPostId = postId;
  boardEditorPostId = null;
  replyingBoardCommentId = null;
  trackBoardPostView(postId);
  renderBoard();
  if (mobileActiveSection === "board") renderMobileDashboard();
}

function closeBoardDetail() {
  activeBoardPostId = null;
  boardViewerPostId = null;
  replyingBoardCommentId = null;
  renderBoard();
  if (mobileActiveSection === "board") renderMobileDashboard();
}

function openBoardEditor(postId = null) {
  if (postId) {
    const post = state.boardPosts.find((item) => item.id === postId && !item.deletedAt);
    if (!canManageBoardPost(post)) {
      showToast("작성자 본인만 게시글을 수정할 수 있습니다.");
      return;
    }
  }
  boardEditorPostId = postId || "";
  activeBoardPostId = null;
  renderBoard();
  if (mobileActiveSection === "board") renderMobileDashboard();
  requestAnimationFrame(() => $("#boardTitleInput")?.focus());
}

function closeBoardEditor() {
  boardEditorPostId = null;
  renderBoard();
  if (mobileActiveSection === "board") renderMobileDashboard();
}

function nextBoardNumber() {
  return Math.max(0, ...(state.boardPosts || []).map((post) => Number(post.number || 0))) + 1;
}

function readBoardEditorForm(form) {
  const isAdmin = isAdminUser();
  const isNotice = isAdmin && form.querySelector("[name='isNotice']")?.checked;
  const periodType = isNotice ? (form.querySelector("[name='noticePeriodType']")?.value || "week") : null;
  return {
    title: form.querySelector("[name='title']")?.value.trim() || "",
    prefix: boardPrefixValue(form.querySelector("[name='prefix']")?.value),
    contentHtml: sanitizeBoardHtml(form.querySelector("[data-board-editor-content]")?.innerHTML || ""),
    isNotice: Boolean(isNotice),
    notifyOff: Boolean(isNotice && form.querySelector("[name='notifyOff']")?.checked),
    noticePeriodType: isNotice ? periodType : null,
    noticeUntil: isNotice ? getNoticeUntil(periodType, form.querySelector("[name='noticeCustomDate']")?.value) : null
  };
}

function createBoardPost(form) {
  const data = readBoardEditorForm(form);
  if (!data.title) {
    showToast("제목을 입력해주세요.");
    return;
  }
  const author = boardAuthor();
  const post = {
    id: makeId(),
    number: nextBoardNumber(),
    ...data,
    authorUserId: author.id,
    authorName: author.name,
    viewUserIds: [],
    viewLogs: [],
    createdAt: new Date().toISOString(),
    updatedAt: null,
    deletedAt: null
  };
  state.boardPosts.push(post);
  if (post.isNotice) notifyBoardNotice(post);
  saveState();
  boardEditorPostId = null;
  renderAll();
  showToast("게시글이 등록되었습니다.");
}

function updateBoardPost(postId, form) {
  const post = state.boardPosts.find((item) => item.id === postId);
  if (!post) return;
  if (!canManageBoardPost(post)) return showToast("작성자 본인만 게시글을 수정할 수 있습니다.");
  const wasNotice = Boolean(post.isNotice);
  const data = readBoardEditorForm(form);
  if (!data.title) {
    showToast("제목을 입력해주세요.");
    return;
  }
  Object.assign(post, data, { updatedAt: new Date().toISOString() });
  if (!wasNotice && post.isNotice) notifyBoardNotice(post);
  saveState();
  boardEditorPostId = null;
  activeBoardPostId = post.id;
  renderAll();
  showToast("게시글이 수정되었습니다.");
}

function deleteBoardPost(postId) {
  const post = state.boardPosts.find((item) => item.id === postId);
  if (!post) return;
  if (!canManageBoardPost(post)) return showToast("작성자 본인만 게시글을 삭제할 수 있습니다.");
  post.deletedAt = new Date().toISOString();
  saveState();
  activeBoardPostId = null;
  renderAll();
  showToast("게시글이 삭제되었습니다.");
}

function addBoardComment(postId, body, parentCommentId = null) {
  const post = state.boardPosts.find((item) => item.id === postId && !item.deletedAt);
  const cleanBody = String(body || "").trim();
  if (!post || !cleanBody) return;
  const parent = parentCommentId
    ? state.boardComments.find((item) => item.id === parentCommentId && item.postId === postId && !item.deletedAt)
    : null;
  const author = boardAuthor();
  const comment = {
    id: makeId(),
    postId,
    parentCommentId: parent ? (parent.parentCommentId || parent.id) : null,
    body: cleanBody,
    authorUserId: author.id,
    authorName: author.name,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    deletedAt: null
  };
  state.boardComments.push(comment);
  notifyBoardComment(post, comment);
  if (parent) notifyBoardReply(post, parent, comment);
  saveState();
  rerenderBoardSurfaces();
}

function updateBoardComment(commentId, body) {
  const comment = state.boardComments.find((item) => item.id === commentId && !item.deletedAt);
  const cleanBody = String(body || "").trim();
  if (!comment || !cleanBody) return;
  if (!canManageBoardComment(comment)) return showToast("작성자 본인만 댓글을 수정할 수 있습니다.");
  comment.body = cleanBody;
  comment.updatedAt = new Date().toISOString();
  saveState();
  rerenderBoardSurfaces();
}

function deleteBoardComment(commentId) {
  const comment = state.boardComments.find((item) => item.id === commentId);
  if (!comment) return;
  if (!canManageBoardComment(comment)) return showToast("작성자 본인만 댓글을 삭제할 수 있습니다.");
  const deletedAt = new Date().toISOString();
  comment.deletedAt = deletedAt;
  state.boardComments.forEach((item) => {
    if (item.parentCommentId === comment.id && !item.deletedAt) item.deletedAt = deletedAt;
  });
  saveState();
  rerenderBoardSurfaces();
}

function openBoardViewers(postId) {
  boardViewerPostId = postId;
  rerenderBoardSurfaces();
}

function renderBoardPrefixOptions(value = "") {
  const current = boardPrefixValue(value);
  const options = boardPrefixes().includes(current) ? boardPrefixes() : [current, ...boardPrefixes()];
  return options.map((prefix) => `<option value="${esc(prefix)}" ${prefix === current ? "selected" : ""}>${esc(prefix)}</option>`).join("");
}

function boardNoticeChip(post) {
  return post.isNotice ? `<span class="board-notice-chip">공지</span>` : "";
}

function renderBoardRow(post, mobile = false) {
  const comments = boardCommentsForPost(post.id).length;
  const views = post.viewUserIds?.length || 0;
  const notice = isActiveNotice(post);
  if (mobile) {
    return `
      <button class="mobile-board-row ${notice ? "notice" : ""}" data-board-open="${esc(post.id)}" type="button">
        <span class="mobile-board-row-main">
          ${post.isNotice ? `<span class="board-notice-chip">공지</span>` : `<span class="board-prefix-chip ${optionColorClass("boardPrefixes", post.prefix)}"${optionColorAttributes("boardPrefixes", post.prefix)}>${esc(post.prefix || "일반")}</span>`}
          <strong>${esc(post.title || "제목 없음")}</strong>
          <i aria-hidden="true">›</i>
        </span>
        <span class="mobile-board-row-meta">${esc(post.authorName || "사용자")} · ${esc(boardDateText(post.createdAt, true))} · 조회 ${views} · 댓글 ${comments}</span>
      </button>
    `;
  }
  return `
    <button class="board-table-row ${notice ? "notice" : ""}" data-board-open="${esc(post.id)}" type="button">
      <span>${notice ? "공지" : esc(post.number)}</span>
      <span><i class="board-prefix-chip ${optionColorClass("boardPrefixes", post.prefix)}"${optionColorAttributes("boardPrefixes", post.prefix)}>${esc(post.prefix || "일반")}</i></span>
      <strong>${boardNoticeChip(post)}${esc(post.title || "제목 없음")}${post.updatedAt ? `<em>수정됨</em>` : ""}</strong>
      <span>${esc(post.authorName || "사용자")}</span>
      <span>${esc(boardDateText(post.createdAt))}</span>
      <span>${views}</span>
      <span>${comments}</span>
    </button>
  `;
}

function renderBoardList() {
  const posts = filteredBoardPosts();
  const prefixOptions = [`<option value="">전체</option>`, ...boardPrefixes().map((prefix) => `<option value="${esc(prefix)}" ${boardPrefixFilter === prefix ? "selected" : ""}>${esc(prefix)}</option>`)].join("");
  return `
    <div class="board-page">
      <div class="board-head board-head-compact">
        <div class="board-head-copy">
          <p class="eyebrow">COMMUNITY BOARD</p>
          <p>공지와 제작 관련 내용을 공유하고 댓글로 의견을 나눕니다.</p>
        </div>
        <button class="pill primary" type="button" data-board-write>+ 글쓰기</button>
      </div>
      <div class="board-toolbar">
        <input id="boardSearchInput" placeholder="검색어를 입력하세요." value="${esc(boardSearchQuery)}" />
        <select id="boardSearchScope">
          <option value="title" ${boardSearchScope === "title" ? "selected" : ""}>제목</option>
          <option value="content" ${boardSearchScope === "content" ? "selected" : ""}>내용</option>
          <option value="titleContent" ${boardSearchScope === "titleContent" ? "selected" : ""}>제목+내용</option>
        </select>
        <select id="boardPrefixFilter">${prefixOptions}</select>
        <select id="boardPostFilter">
          <option value="all" ${boardPostFilter === "all" ? "selected" : ""}>전체</option>
          <option value="notice" ${boardPostFilter === "notice" ? "selected" : ""}>공지</option>
          <option value="mine" ${boardPostFilter === "mine" ? "selected" : ""}>내 글</option>
        </select>
      </div>
      <div class="board-tabs">
        ${[["all", "전체"], ["notice", "공지"], ["mine", "내 글"]].map(([key, label]) => `<button class="${boardActiveTab === key ? "active" : ""}" data-board-tab="${key}" type="button">${label}</button>`).join("")}
      </div>
      <div class="board-table">
        <div class="board-table-head"><span>번호</span><span>말머리</span><span>제목</span><span>작성자</span><span>작성일</span><span>조회</span><span>댓글</span></div>
        ${posts.length ? posts.map((post) => renderBoardRow(post)).join("") : `<div class="empty">게시글이 없습니다.</div>`}
      </div>
    </div>
  `;
}

function renderBoardEditor(postId = null) {
  const post = postId ? state.boardPosts.find((item) => item.id === postId) : null;
  const isAdmin = isAdminUser();
  const periodType = post?.noticePeriodType || "week";
  const today = dateKey(new Date());
  const customDate = post?.noticeUntil || today;
  return `
    <div class="board-editor-shell">
      <form id="boardEditorForm" class="board-editor-card" data-board-editor-post="${esc(post?.id || "")}">
        <header class="board-editor-heading">
          <p class="eyebrow">${post ? "EDIT POST" : "NEW POST"}</p>
          <h2>${post ? "게시글 수정" : "게시글 작성"}</h2>
          <p>제목과 내용을 입력하고 필요한 경우 공지로 등록합니다.</p>
        </header>
        <div class="board-editor-meta">
          <label class="board-prefix-field"><span>말머리</span><select name="prefix">${renderBoardPrefixOptions(post?.prefix)}</select></label>
          <div class="board-title-line">
            <label class="board-title-field"><span>제목</span><input id="boardTitleInput" name="title" maxlength="100" placeholder="제목을 입력해주세요." value="${esc(post?.title || "")}" /></label>
            ${isAdmin ? `
              <section class="board-notice-options ${post?.isNotice ? "open" : ""}">
                <div class="board-admin-summary">
                  <label class="board-check"><input name="isNotice" type="checkbox" ${post?.isNotice ? "checked" : ""} data-board-notice-toggle /><span></span>공지</label>
                </div>
                <div class="board-notice-extra">
                  <label class="board-check"><input name="notifyOff" type="checkbox" ${post?.notifyOff ? "checked" : ""} /><span></span>알림 끄기</label>
                  <label><span>노출 기간</span>
                    <select name="noticePeriodType">
                      <option value="week" ${periodType === "week" ? "selected" : ""}>1주일</option>
                      <option value="month" ${periodType === "month" ? "selected" : ""}>한 달</option>
                      <option value="forever" ${periodType === "forever" ? "selected" : ""}>무기한</option>
                      <option value="custom" ${periodType === "custom" ? "selected" : ""}>직접 지정</option>
                    </select>
                  </label>
                  <label class="board-custom-date ${periodType === "custom" ? "open" : ""}">
                    <span>직접 지정</span>
                    <input name="noticeCustomDate" type="hidden" value="${esc(customDate)}" />
                    <button class="date-button compact board-notice-date-button" data-board-notice-date type="button"><span>${esc(formatDate(customDate))}</span><i>⌄</i></button>
                  </label>
                </div>
              </section>
            ` : ""}
          </div>
        </div>
        <section class="board-rich-editor">
          <div class="board-rich-toolbar">
            ${[["P", "본문"], ["H1", "H1"]].map(([tag, label]) => `<button type="button" data-board-format="${tag}">${label}</button>`).join("")}
            <button type="button" data-board-format="bold">B</button>
            <button type="button" data-board-format="italic"><i>I</i></button>
            <button type="button" data-board-format="underline"><u>U</u></button>
            <button type="button" data-board-format="strikeThrough" aria-label="취소선"><s>S</s></button>
            <button type="button" data-board-format="removeFormat">Tx</button>
          </div>
          <div class="board-content-editor" data-board-editor-content contenteditable="true">${sanitizeBoardHtml(post?.contentHtml || "")}</div>
        </section>
        <footer class="board-editor-top board-editor-footer">
          <div>
            <button class="pill ghost board-list-back" type="button" data-board-close-editor>목록으로</button>
            <button class="pill ghost" type="button" data-board-close-editor>취소</button>
            <button class="pill primary" type="submit">${post ? "수정" : "등록"}</button>
          </div>
        </footer>
      </form>
    </div>
  `;
}

function renderBoardViewers(post) {
  if (!boardViewerPostId || !post || boardViewerPostId !== post.id) return "";
  const logs = [...new Map((post.viewLogs || []).map((log) => [log.userId, log])).values()];
  return `
    <div class="modal-shell open board-viewer-modal" aria-hidden="false">
      <div class="modal-card board-viewer-card" role="dialog" aria-modal="true" aria-labelledby="boardViewerTitle">
        <div class="section-head board-viewer-heading">
          <div>
            <p class="eyebrow">VIEWERS</p>
            <h3 id="boardViewerTitle">조회한 사람</h3>
            <p class="board-viewer-count">총 ${logs.length}명</p>
          </div>
          <button class="record-control" type="button" data-board-close-viewers aria-label="조회자 목록 닫기">닫기</button>
        </div>
        <div class="board-viewer-list">${logs.length ? logs.map((log) => `<span><strong>${esc(log.name || "사용자")}</strong><small>최초 확인 ${esc(boardDateText(log.viewedAt, true))}</small></span>`).join("") : '<div class="empty">아직 확인한 사람이 없습니다.</div>'}</div>
      </div>
    </div>
  `;
}

function renderBoardCommentItem(comment, post, replies = [], isReply = false) {
  const canManage = canManageBoardComment(comment);
  const editing = editingBoardCommentId === comment.id;
  const replying = !isReply && replyingBoardCommentId === comment.id;
  return `
    <article class="board-comment-item ${isReply ? "board-comment-reply" : ""}">
      <div class="board-comment-head">
        <span class="board-comment-identity"><strong>${esc(comment.authorName || "사용자")}</strong><small>${esc(boardDateText(comment.createdAt, true))}${comment.updatedAt ? " · 수정됨" : ""}</small></span>
        <span class="board-comment-actions">
          ${!isReply ? `<button type="button" data-board-reply-comment="${esc(comment.id)}">답글</button>` : ""}
          ${canManage ? `<button type="button" data-board-edit-comment="${esc(comment.id)}">수정</button><button type="button" data-board-delete-comment="${esc(comment.id)}">삭제</button>` : ""}
        </span>
      </div>
      ${editing ? `<form class="board-comment-edit-form" data-board-comment-edit-form="${esc(comment.id)}"><input name="body" value="${esc(comment.body)}" /><button class="pill primary" type="submit">저장</button><button class="record-control" data-board-cancel-comment-edit type="button">취소</button></form>` : `<p>${esc(comment.body)}</p>`}
      ${replying ? `<form class="board-reply-form" data-board-reply-form="${esc(comment.id)}" data-board-reply-post="${esc(post.id)}"><input name="body" placeholder="${esc(comment.authorName || "사용자")}님에게 답글을 입력하세요." /><button class="pill primary" type="submit">답글 등록</button><button class="record-control" data-board-cancel-reply type="button">취소</button></form>` : ""}
      ${replies.length ? `<div class="board-reply-list">${replies.map((reply) => renderBoardCommentItem(reply, post, [], true)).join("")}</div>` : ""}
    </article>
  `;
}

function renderBoardDetail(postId) {
  const post = state.boardPosts.find((item) => item.id === postId && !item.deletedAt);
  if (!post) return "";
  const comments = boardCommentsForPost(post.id);
  const rootComments = comments.filter((comment) => !comment.parentCommentId || !comments.some((item) => item.id === comment.parentCommentId));
  const canEdit = canManageBoardPost(post);
  const viewCount = post.viewUserIds?.length || 0;
  return `
    <div class="board-detail-shell">
      <article class="board-detail-card">
        <div class="board-detail-top">
          <button class="pill ghost board-list-back" type="button" data-board-close-detail>목록으로</button>
          <div class="board-detail-actions">
            ${canEdit ? `<button class="record-control" type="button" data-board-edit="${esc(post.id)}">수정</button><button class="delete-btn" type="button" data-board-delete="${esc(post.id)}">삭제</button>` : ""}
          </div>
        </div>
        <header>
          <div class="board-detail-category">${post.isNotice ? boardNoticeChip(post) : `<span class="${optionColorClass("boardPrefixes", post.prefix)}"${optionColorAttributes("boardPrefixes", post.prefix)}>${esc(post.prefix || "일반")}</span>`}</div>
          <h2>${esc(post.title || "제목 없음")}</h2>
          <p class="board-detail-meta">
            <span>${esc(post.authorName || "사용자")}</span>
            <span>${esc(boardDateText(post.createdAt))}${post.updatedAt ? " · 수정됨" : ""}</span>
            <button type="button" data-board-viewers="${esc(post.id)}" aria-label="조회한 사람 ${viewCount}명 보기"><i aria-hidden="true">◎</i> 조회 ${viewCount}</button>
            <span>댓글 ${comments.length}</span>
          </p>
          ${post.isNotice ? `<small>공지 노출: ${esc(boardNoticePeriodLabel(post))}</small>` : ""}
        </header>
        <div class="board-detail-content">${sanitizeBoardHtml(post.contentHtml || "<p>내용이 없습니다.</p>")}</div>
        <section class="board-comments">
          <div class="board-comments-heading"><h3>댓글</h3><span>${comments.length}</span></div>
          ${rootComments.map((comment) => renderBoardCommentItem(comment, post, comments.filter((reply) => reply.parentCommentId === comment.id), false)).join("") || '<div class="empty board-comment-empty">아직 등록된 댓글이 없습니다.</div>'}
          <form class="board-comment-form" data-board-comment-form="${esc(post.id)}">
            <input name="body" placeholder="댓글을 입력하세요." />
            <button class="pill primary" type="submit">댓글 등록</button>
          </form>
        </section>
      </article>
      ${renderBoardViewers(post)}
    </div>
  `;
}

function renderBoard() {
  const root = $("#boardRoot");
  if (!root) return;
  root.innerHTML = boardEditorPostId !== null
    ? renderBoardEditor(boardEditorPostId || null)
    : activeBoardPostId
      ? renderBoardDetail(activeBoardPostId)
      : renderBoardList();
}

function renderMobileBoard() {
  if (boardEditorPostId !== null) return `<div class="mobile-board-full">${renderBoardEditor(boardEditorPostId || null)}</div>`;
  if (activeBoardPostId) return `<div class="mobile-board-full">${renderBoardDetail(activeBoardPostId)}</div>`;
  const posts = filteredBoardPosts();
  const prefixButtons = [`<button class="${!boardPrefixFilter ? "active" : ""}" data-board-prefix-filter="" type="button">전체</button>`, ...boardPrefixes().map((prefix) => `<button class="${boardPrefixFilter === prefix ? "active" : ""}" data-board-prefix-filter="${esc(prefix)}" type="button">${esc(prefix)}</button>`)].join("");
  return `
    <div class="mobile-board-page">
      <div class="mobile-board-actions"><span>게시글 ${posts.length}개</span><button class="pill primary" type="button" data-board-write>+ 글쓰기</button></div>
      <div class="mobile-board-search">
        <input id="mobileBoardSearchInput" placeholder="제목, 내용, 작성자 검색" value="${esc(boardSearchQuery)}" />
        <button class="${mobileBoardFilterOpen ? "active" : ""}" type="button" data-mobile-board-filter>필터</button>
      </div>
      ${mobileBoardFilterOpen ? `
        <div class="mobile-board-filter-panel">
          <p>검색 범위</p>
          <div>
            ${[["titleContent", "제목+내용"], ["title", "제목"], ["content", "내용"]].map(([key, label]) => `<button class="${boardSearchScope === key ? "active" : ""}" data-board-search-scope="${key}" type="button">${label}</button>`).join("")}
          </div>
          <p>말머리</p>
          <div>${prefixButtons}</div>
          <p>게시글</p>
          <div>
            ${[["all", "전체"], ["notice", "공지"], ["mine", "내 글"]].map(([key, label]) => `<button class="${boardPostFilter === key ? "active" : ""}" data-board-post-filter="${key}" type="button">${label}</button>`).join("")}
          </div>
        </div>
      ` : ""}
      <div class="board-tabs">
        ${[["all", "전체"], ["notice", "공지"], ["mine", "내 글"]].map(([key, label]) => `<button class="${boardActiveTab === key ? "active" : ""}" data-board-tab="${key}" type="button">${label}</button>`).join("")}
      </div>
      <div class="mobile-board-list">${posts.length ? posts.map((post) => renderBoardRow(post, true)).join("") : '<div class="empty">게시글이 없습니다.</div>'}</div>
    </div>
  `;
}

function rerenderBoardSurfaces() {
  renderBoard();
  if (mobileActiveSection === "board") renderMobileDashboard();
}

function formatBoardSelection(format) {
  const editor = document.querySelector("[data-board-editor-content]");
  if (!editor) return;
  editor.focus();
  if (["P", "H1", "H2", "H3", "H4"].includes(format)) {
    document.execCommand("formatBlock", false, format === "P" ? "p" : format.toLowerCase());
    return;
  }
  document.execCommand(format, false, null);
}

function handleBoardClick(event) {
  const mobileFilter = event.target.closest("[data-mobile-board-filter]");
  if (mobileFilter) {
    mobileBoardFilterOpen = !mobileBoardFilterOpen;
    rerenderBoardSurfaces();
    return true;
  }
  const scope = event.target.closest("[data-board-search-scope]")?.dataset.boardSearchScope;
  if (scope) {
    boardSearchScope = scope;
    saveViewPrefs({ boardSearchScope });
    rerenderBoardSurfaces();
    return true;
  }
  const prefixButton = event.target.closest("[data-board-prefix-filter]");
  if (prefixButton) {
    boardPrefixFilter = prefixButton.dataset.boardPrefixFilter || "";
    saveViewPrefs({ boardPrefixFilter });
    rerenderBoardSurfaces();
    return true;
  }
  const postFilterButton = event.target.closest("[data-board-post-filter]");
  if (postFilterButton) {
    boardPostFilter = postFilterButton.dataset.boardPostFilter || "all";
    saveViewPrefs({ boardPostFilter });
    rerenderBoardSurfaces();
    return true;
  }
  const tab = event.target.closest("[data-board-tab]")?.dataset.boardTab;
  if (tab) {
    boardActiveTab = tab;
    saveViewPrefs({ boardActiveTab });
    rerenderBoardSurfaces();
    return true;
  }
  if (event.target.closest("[data-board-write]")) {
    openBoardEditor();
    return true;
  }
  if (event.target.closest("[data-board-close-editor]")) {
    closeBoardEditor();
    return true;
  }
  if (event.target.closest("[data-board-close-detail]")) {
    closeBoardDetail();
    return true;
  }
  const openId = event.target.closest("[data-board-open]")?.dataset.boardOpen;
  if (openId) {
    openBoardDetail(openId);
    return true;
  }
  const editId = event.target.closest("[data-board-edit]")?.dataset.boardEdit;
  if (editId) {
    openBoardEditor(editId);
    return true;
  }
  const deleteId = event.target.closest("[data-board-delete]")?.dataset.boardDelete;
  if (deleteId) {
    confirmDelete(() => deleteBoardPost(deleteId));
    return true;
  }
  const format = event.target.closest("[data-board-format]")?.dataset.boardFormat;
  if (format) {
    formatBoardSelection(format);
    return true;
  }
  const noticeDateButton = event.target.closest("[data-board-notice-date]");
  if (noticeDateButton) {
    event.stopImmediatePropagation();
    const dateInput = noticeDateButton.closest(".board-custom-date")?.querySelector("[name='noticeCustomDate']");
    openDatePicker(noticeDateButton, dateInput?.value || dateKey(new Date()), (value) => {
      const nextValue = value || dateKey(new Date());
      if (dateInput) dateInput.value = nextValue;
      const label = noticeDateButton.querySelector("span");
      if (label) label.textContent = formatDate(nextValue);
    });
    return true;
  }
  const noticeToggle = event.target.closest("[data-board-notice-toggle]");
  if (noticeToggle) {
    noticeToggle.closest(".board-notice-options")?.classList.toggle("open", noticeToggle.checked);
    return false;
  }
  const viewersId = event.target.closest("[data-board-viewers]")?.dataset.boardViewers;
  if (viewersId) {
    openBoardViewers(viewersId);
    return true;
  }
  if (event.target.closest("[data-board-close-viewers]")) {
    boardViewerPostId = null;
    rerenderBoardSurfaces();
    return true;
  }
  const commentId = event.target.closest("[data-board-delete-comment]")?.dataset.boardDeleteComment;
  if (commentId) {
    confirmDelete(() => deleteBoardComment(commentId));
    return true;
  }
  const replyCommentId = event.target.closest("[data-board-reply-comment]")?.dataset.boardReplyComment;
  if (replyCommentId) {
    replyingBoardCommentId = replyingBoardCommentId === replyCommentId ? null : replyCommentId;
    editingBoardCommentId = null;
    rerenderBoardSurfaces();
    requestAnimationFrame(() => $("[data-board-reply-form] input")?.focus());
    return true;
  }
  if (event.target.closest("[data-board-cancel-reply]")) {
    replyingBoardCommentId = null;
    rerenderBoardSurfaces();
    return true;
  }
  const editCommentId = event.target.closest("[data-board-edit-comment]")?.dataset.boardEditComment;
  if (editCommentId) {
    const comment = state.boardComments.find((item) => item.id === editCommentId && !item.deletedAt);
    if (!canManageBoardComment(comment)) return true;
    editingBoardCommentId = editCommentId;
    replyingBoardCommentId = null;
    rerenderBoardSurfaces();
    requestAnimationFrame(() => $("[data-board-comment-edit-form] input")?.focus());
    return true;
  }
  if (event.target.closest("[data-board-cancel-comment-edit]")) {
    editingBoardCommentId = null;
    rerenderBoardSurfaces();
    return true;
  }
  return false;
}

function handleBoardInput(event) {
  const search = event.target.closest("#boardSearchInput, #mobileBoardSearchInput");
  if (!search) return false;
  boardSearchQuery = search.value;
  saveViewPrefs({ boardSearchQuery });
  rerenderBoardSurfaces();
  requestAnimationFrame(() => {
    const next = document.getElementById(search.id);
    if (!next) return;
    next.focus();
    next.setSelectionRange(next.value.length, next.value.length);
  });
  return true;
}

function handleBoardChange(event) {
  if (event.target.id === "boardSearchScope") {
    boardSearchScope = event.target.value;
    saveViewPrefs({ boardSearchScope });
    renderBoard();
    return true;
  }
  if (event.target.id === "boardPrefixFilter") {
    boardPrefixFilter = event.target.value;
    saveViewPrefs({ boardPrefixFilter });
    renderBoard();
    return true;
  }
  if (event.target.id === "boardPostFilter") {
    boardPostFilter = event.target.value;
    saveViewPrefs({ boardPostFilter });
    renderBoard();
    return true;
  }
  if (event.target.name === "noticePeriodType") {
    const customField = event.target.closest(".board-notice-extra")?.querySelector(".board-custom-date");
    const isCustom = event.target.value === "custom";
    customField?.classList.toggle("open", isCustom);
    if (isCustom) {
      const dateButton = customField?.querySelector("[data-board-notice-date]");
      const dateInput = customField?.querySelector("[name='noticeCustomDate']");
      requestAnimationFrame(() => {
        if (!dateButton) return;
        openDatePicker(dateButton, dateInput?.value || dateKey(new Date()), (value) => {
          const nextValue = value || dateKey(new Date());
          if (dateInput) dateInput.value = nextValue;
          const label = dateButton.querySelector("span");
          if (label) label.textContent = formatDate(nextValue);
        });
      });
    }
    return true;
  }
  return false;
}

function handleBoardSubmit(event) {
  const editorForm = event.target.closest("#boardEditorForm");
  if (editorForm) {
    event.preventDefault();
    const postId = editorForm.dataset.boardEditorPost;
    if (postId) updateBoardPost(postId, editorForm);
    else createBoardPost(editorForm);
    return true;
  }
  const replyForm = event.target.closest("[data-board-reply-form]");
  if (replyForm) {
    event.preventDefault();
    const parentCommentId = replyForm.dataset.boardReplyForm;
    const postId = replyForm.dataset.boardReplyPost;
    const body = replyForm.elements.body?.value || "";
    if (!body.trim()) return true;
    replyingBoardCommentId = null;
    addBoardComment(postId, body, parentCommentId);
    return true;
  }
  const commentForm = event.target.closest("[data-board-comment-form]");
  if (commentForm) {
    event.preventDefault();
    addBoardComment(commentForm.dataset.boardCommentForm, commentForm.elements.body?.value || "");
    commentForm.reset();
    return true;
  }
  const commentEditForm = event.target.closest("[data-board-comment-edit-form]");
  if (commentEditForm) {
    event.preventDefault();
    updateBoardComment(commentEditForm.dataset.boardCommentEditForm, commentEditForm.elements.body?.value || "");
    editingBoardCommentId = null;
    rerenderBoardSurfaces();
    return true;
  }
  return false;
}

const telegramDigestCategoryLabels = {
  tasksToday: ["오늘 할 일", "오늘 마감인 미완료 할 일"],
  tasksThreeDays: ["3일 이내 할 일", "내일부터 3일 뒤까지의 할 일"],
  tasksWeek: ["1주일 이내 할 일", "4일 뒤부터 7일 뒤까지의 할 일"],
  projectsToday: ["오늘 마감 · 영상", "오늘 최종 출고 예정인 영상"],
  projectsSoon: ["마감 임박 · 영상", "3일 안에 최종 출고 예정인 영상"],
  worksToday: ["오늘 마감 · 업무", "오늘 완료 예정인 업무"],
  worksSoon: ["마감 임박 · 업무", "3일 안에 완료 예정인 업무"]
};

function telegramDigestSettings() {
  return normalizeTelegramDigestSettings(state.telegramDigest || {});
}

function isTelegramDigestCompleted(value) {
  return /완료|납품|종료/.test(String(value || ""));
}

function telegramDigestCategoryCount(key) {
  const tasks = taskOverviewItems().filter((item) => !item.task.done && !item.task.noDueDate && item.task.dueDate);
  if (key === "tasksToday") return tasks.filter((item) => taskOverviewDayDiff(item) === 0).length;
  if (key === "tasksThreeDays") return tasks.filter((item) => {
    const diff = taskOverviewDayDiff(item);
    return diff >= 1 && diff <= 3;
  }).length;
  if (key === "tasksWeek") return tasks.filter((item) => {
    const diff = taskOverviewDayDiff(item);
    return diff >= 4 && diff <= 7;
  }).length;
  const items = key.startsWith("projects")
    ? state.projects.filter((item) => item.finalDate && !isTelegramDigestCompleted(item.status))
    : state.works.filter((item) => item.finalDate && !item.noSchedule && !isTelegramDigestCompleted(item.status));
  if (key.endsWith("Today")) return items.filter((item) => daysUntil(item.finalDate) === 0).length;
  return items.filter((item) => {
    const diff = daysUntil(item.finalDate);
    return diff >= 1 && diff <= 3;
  }).length;
}

function telegramDigestStatusMarkup() {
  if (telegramDigestStatusLoading) return '<span class="telegram-connection checking"><i></i>연결 확인 중</span>';
  if (!telegramDigestRuntimeStatus) return '<span class="telegram-connection unknown"><i></i>연결 상태 미확인</span>';
  if (!telegramDigestRuntimeStatus.configured) return '<span class="telegram-connection error"><i></i>봇 환경변수 확인 필요</span>';
  if (telegramDigestSettings().deliveryMode === "daily" && !telegramDigestRuntimeStatus.schedulerConfigured) {
    return '<span class="telegram-connection warning"><i></i>예약 환경변수 확인 필요</span>';
  }
  return '<span class="telegram-connection connected"><i></i>텔레그램 봇 연결됨</span>';
}

function telegramDigestLastRunMarkup() {
  const status = telegramDigestRuntimeStatus?.status;
  if (!status) return "아직 전송 기록이 없습니다.";
  const date = new Date(status.sentAt || status.failedAt || 0);
  const dateLabel = Number.isNaN(date.getTime()) ? "시간 미상" : new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
  if (status.status === "failed") return `최근 예약 전송 실패 · ${dateLabel}`;
  return `최근 ${status.type === "scheduled" ? "예약" : "직접"} 전송 · ${dateLabel}`;
}

function renderTelegramDigestManager() {
  const settings = telegramDigestSettings();
  const hourOptions = Array.from({ length: 24 }, (_, hour) => {
    const value = `${String(hour).padStart(2, "0")}:00`;
    return `<option value="${value}" ${settings.deliveryTime === value ? "selected" : ""}>${String(hour).padStart(2, "0")}시대</option>`;
  }).join("");
  return `
    <form class="telegram-digest-manager" data-telegram-digest-form>
      <section class="telegram-manager-hero">
        <div>
          <span class="telegram-logo" aria-hidden="true">➤</span>
          <div><p class="eyebrow">TELEGRAM BOT</p><h3>데일리 업무 브리핑</h3><small>선택한 할 일과 마감 일정을 한 번에 정리해 전송합니다.</small></div>
        </div>
        <div class="telegram-runtime-status" data-telegram-runtime-status>${telegramDigestStatusMarkup()}<small>${esc(telegramDigestLastRunMarkup())}</small></div>
      </section>

      <div class="telegram-manager-grid">
        <section class="telegram-setting-card">
          <header><span>1</span><div><h4>전송 방식</h4><small>직접 보내거나 매일 자동으로 전송합니다.</small></div></header>
          <div class="telegram-delivery-modes">
            <label class="${settings.deliveryMode === "manual" ? "active" : ""}"><input type="radio" name="deliveryMode" value="manual" ${settings.deliveryMode === "manual" ? "checked" : ""} /><span><b>직접 푸시</b><small>필요할 때 관리자가 바로 전송</small></span></label>
            <label class="${settings.deliveryMode === "daily" ? "active" : ""}"><input type="radio" name="deliveryMode" value="daily" ${settings.deliveryMode === "daily" ? "checked" : ""} /><span><b>매일 예약 푸시</b><small>선택한 시간대에 하루 한 번 전송</small></span></label>
          </div>
          <label class="telegram-time-field ${settings.deliveryMode === "daily" ? "enabled" : ""}">
            <span>예약 시간대</span>
            <select name="deliveryTime" ${settings.deliveryMode === "daily" ? "" : "disabled"}>${hourOptions}</select>
            <small>한국 시간 기준 · Hobby 요금제에서는 선택한 시간대 안에 전송됩니다.</small>
          </label>
        </section>

        <section class="telegram-setting-card telegram-category-card">
          <header><span>2</span><div><h4>알림에 포함할 항목</h4><small>체크한 항목만 메시지에 표시합니다.</small></div></header>
          <div class="telegram-category-list">
            ${Object.entries(telegramDigestCategoryLabels).map(([key, [label, description]]) => `
              <label>
                <input type="checkbox" name="include-${key}" ${settings.include[key] ? "checked" : ""} />
                <i></i>
                <span><b>${esc(label)}</b><small>${esc(description)}</small></span>
                <em>${telegramDigestCategoryCount(key)}</em>
              </label>
            `).join("")}
          </div>
        </section>

        <section class="telegram-setting-card telegram-message-card">
          <header><span>3</span><div><h4>추가 메시지</h4><small>입력한 내용이 별도 제목 없이 그대로 표시됩니다.</small></div></header>
          <textarea name="additionalMessage" maxlength="1000" rows="7" placeholder="예: 오늘 14시 전체 회의가 있습니다. 촬영 장비 반납 일정을 확인해 주세요.">${esc(settings.additionalMessage)}</textarea>
          <small>선택 사항 · 최대 1,000자</small>
        </section>

        <section class="telegram-setting-card telegram-preview-card">
          <header><span>4</span><div><h4>미리보기 및 전송</h4><small>저장 후 실제 메시지를 확인하거나 바로 보냅니다.</small></div></header>
          <div class="telegram-preview-empty" data-telegram-preview-output><span>✈</span><b>메시지 미리보기</b><small>미리보기를 누르면 실제 전송 형태가 표시됩니다.</small></div>
          <div class="telegram-form-message" data-telegram-form-message aria-live="polite"></div>
        </section>
      </div>

      <footer class="telegram-manager-actions">
        <span>설정을 저장하면 모든 관리자에게 동일하게 적용됩니다.</span>
        <div>
          <button class="pill ghost" data-telegram-preview type="button">메시지 미리보기</button>
          <button class="pill ghost" type="submit">설정 저장</button>
          <button class="pill primary" data-telegram-send type="button">지금 텔레그램 전송</button>
        </div>
      </footer>
    </form>
  `;
}

function telegramDigestSettingsFromForm(form) {
  const data = new FormData(form);
  return normalizeTelegramDigestSettings({
    deliveryMode: data.get("deliveryMode"),
    deliveryTime: data.get("deliveryTime") || form.elements.deliveryTime?.value || "09:00",
    include: Object.fromEntries(Object.keys(defaultTelegramDigestSettings.include).map((key) => [key, Boolean(form.elements[`include-${key}`]?.checked)])),
    additionalMessage: data.get("additionalMessage") || ""
  });
}

async function saveTelegramDigestSettings(form, { notify = true } = {}) {
  if (!form) return false;
  state.telegramDigest = telegramDigestSettingsFromForm(form);
  saveState();
  const remoteSaved = SUPABASE_ENABLED ? await saveRemoteDashboardState() : false;
  if (notify) showToast(SUPABASE_ENABLED && !remoteSaved ? "설정은 기기에 저장됐지만 서버 저장을 확인하지 못했습니다." : "텔레그램 알림 설정을 저장했습니다.");
  return !SUPABASE_ENABLED || remoteSaved;
}

async function telegramDigestApi(action = "status", payload = {}) {
  const client = getSupabaseClient();
  if (!client) throw new Error("배포된 대시보드에서 로그인한 뒤 사용할 수 있습니다.");
  const { data } = await client.auth.getSession();
  const accessToken = data?.session?.access_token;
  if (!accessToken) throw new Error("로그인 세션을 확인할 수 없습니다. 다시 로그인해 주세요.");
  const response = await fetch("/api/telegram-digest", {
    method: action === "status" ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(action === "status" ? {} : { "Content-Type": "application/json" })
    },
    ...(action === "status" ? {} : { body: JSON.stringify({ action, ...payload }) })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "텔레그램 요청을 처리하지 못했습니다.");
  return result;
}

function updateTelegramDigestStatusSurface() {
  const target = $("[data-telegram-runtime-status]");
  if (target) target.innerHTML = `${telegramDigestStatusMarkup()}<small>${esc(telegramDigestLastRunMarkup())}</small>`;
}

async function refreshTelegramDigestStatus() {
  if (telegramDigestStatusLoading || !SUPABASE_ENABLED) return;
  telegramDigestStatusLoading = true;
  updateTelegramDigestStatusSurface();
  try {
    telegramDigestRuntimeStatus = await telegramDigestApi("status");
  } catch (error) {
    telegramDigestRuntimeStatus = { configured: false, schedulerConfigured: false, status: null, error: error.message };
  } finally {
    telegramDigestStatusLoading = false;
    updateTelegramDigestStatusSurface();
  }
}

function toggleTelegramDigestScheduleFields(form) {
  if (!form) return;
  const daily = form.elements.deliveryMode?.value === "daily";
  const timeField = form.querySelector(".telegram-time-field");
  const select = form.elements.deliveryTime;
  if (select) select.disabled = !daily;
  timeField?.classList.toggle("enabled", daily);
  form.querySelectorAll(".telegram-delivery-modes > label").forEach((label) => label.classList.toggle("active", Boolean(label.querySelector("input")?.checked)));
}

async function runTelegramDigestAction(action, button) {
  const form = button?.closest("[data-telegram-digest-form]");
  if (!form) return;
  const messageTarget = form.querySelector("[data-telegram-form-message]");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = action === "preview" ? "미리보기 생성 중…" : "전송 중…";
  if (messageTarget) messageTarget.textContent = "";
  try {
    const saved = await saveTelegramDigestSettings(form, { notify: false });
    if (!saved && SUPABASE_ENABLED) throw new Error("최신 설정을 서버에 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    const result = await telegramDigestApi(action);
    if (action === "preview") {
      const preview = form.querySelector("[data-telegram-preview-output]");
      if (preview) preview.innerHTML = `<pre>${esc(result.message || "")}</pre>`;
      if (messageTarget) messageTarget.textContent = "실제 전송될 메시지를 불러왔습니다.";
    } else {
      telegramDigestRuntimeStatus = { ...(telegramDigestRuntimeStatus || {}), configured: true, status: result.status };
      updateTelegramDigestStatusSurface();
      if (messageTarget) messageTarget.textContent = "텔레그램 그룹으로 전송했습니다.";
      showToast("텔레그램 알림을 전송했습니다.");
    }
  } catch (error) {
    if (messageTarget) messageTarget.textContent = error.message || "요청을 처리하지 못했습니다.";
    showToast(error.message || "텔레그램 요청을 처리하지 못했습니다.");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function createStudioTelegramRule(index = 0) {
  return {
    id: `studio-rule-${makeId()}`,
    name: `방송실 공지 ${index + 1}`,
    enabled: true,
    trainingType: "all",
    mode: "previous-day",
    weekday: 0,
    deliveryTime: "09:00",
    includeCallTime: true,
    callTimeOffsetMinutes: 60,
    notice: ""
  };
}

function studioTelegramStatusText() {
  const status = telegramDigestRuntimeStatus?.studioStatus;
  if (!status) return "아직 전송 기록이 없습니다.";
  const time = status.sentAt ? new Date(status.sentAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "시간 미확인";
  if (status.status === "failed") return `최근 예약 전송 실패 · ${status.error || time}`;
  return `최근 ${status.type === "scheduled" ? "예약" : "수동"} 전송 · ${time}${status.ruleName ? ` · ${status.ruleName}` : ""}`;
}

function renderStudioTelegramEditorDropdowns(editor, types, weekdays, hours) {
  if (!editor || !studioTelegramRuleEditor) return;
  const typeLabels = new Map(types.map(([value, label]) => [String(value), label]));
  const weekdayLabels = new Map(weekdays.map(([value, label]) => [String(value), label]));
  const renderField = ({ field, value, options, formatOptionLabel, numeric = false }) => {
    renderDropdown({
      target: document.querySelector(`[data-studio-rule-editor-dropdown="${field}"]`),
      value: String(value),
      options: options.map(String),
      placeholder: "선택",
      className: "studio-telegram-select",
      formatOptionLabel,
      onSelect: (selected) => {
        if (!studioTelegramRuleEditor) return;
        studioTelegramRuleEditor.rule[field] = numeric ? Number(selected) : selected;
        renderStudioTelegramRules();
      }
    });
  };
  renderField({
    field: "trainingType",
    value: editor.trainingType,
    options: types.map(([value]) => value),
    formatOptionLabel: (value) => typeLabels.get(String(value)) || value
  });
  renderField({
    field: "mode",
    value: editor.mode,
    options: ["previous-day", "weekly"],
    formatOptionLabel: (value) => value === "weekly" ? "1주일치 공지" : "전날 공지"
  });
  renderField({
    field: "weekday",
    value: editor.weekday,
    options: weekdays.map(([value]) => value),
    numeric: true,
    formatOptionLabel: (value) => {
      const day = Number(value);
      const label = weekdayLabels.get(String(day)) || "일요일";
      if (editor.mode !== "previous-day") return label;
      const nextDayLabel = weekdayLabels.get(String((day + 1) % 7)) || "다음 날";
      return `${label} (${nextDayLabel} 일정)`;
    }
  });
  renderField({
    field: "deliveryTime",
    value: editor.deliveryTime,
    options: hours,
    formatOptionLabel: (value) => value
  });
  renderField({
    field: "callTimeOffsetMinutes",
    value: editor.callTimeOffsetMinutes,
    options: STUDIO_CALL_TIME_OPTIONS,
    numeric: true,
    formatOptionLabel: (value) => studioCallTimeOffsetLabel(Number(value))
  });
}

function renderStudioTelegramRules() {
  const target = $("#studioTelegramRules");
  if (!target || !studioTelegramDraft) return;
  const types = [["all", "전체 유형"], ...trainingTypeOptions().map((type) => [type, type])];
  const weekdays = [[0, "일요일"], [1, "월요일"], [2, "화요일"], [3, "수요일"], [4, "목요일"], [5, "금요일"], [6, "토요일"]];
  const hours = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
  const summaryRows = studioTelegramDraft.rules.map((rule, index) => {
    const typeLabel = rule.trainingType === "all" ? "전체 유형" : rule.trainingType;
    const weekdayLabel = weekdays.find(([value]) => value === Number(rule.weekday))?.[1] || "일요일";
    const scheduleLabel = rule.mode === "weekly"
      ? `${weekdayLabel} · 1주일치 · ${rule.deliveryTime}`
      : `${weekdayLabel} 전송 · 다음 날 일정 · ${rule.deliveryTime}`;
    return `
      <article class="studio-rule-summary ${rule.enabled === false ? "is-disabled" : ""}" data-studio-telegram-rule="${esc(rule.id)}">
        <label class="studio-switch studio-summary-switch" title="예약 사용 여부">
          <input data-studio-rule-enabled="${esc(rule.id)}" type="checkbox" ${rule.enabled !== false ? "checked" : ""} />
          <span aria-hidden="true"></span>
        </label>
        <div class="studio-rule-summary-main">
          <strong>${esc(rule.name || `방송실 공지 ${index + 1}`)}</strong>
          <span>${esc(typeLabel)}</span>
          <span>${esc(scheduleLabel)}</span>
          <span>콜타임 ${studioCallTimeOffsetLabel(rule.callTimeOffsetMinutes)}</span>
          ${rule.notice ? `<span>특이사항 있음</span>` : ""}
        </div>
        <div class="studio-rule-summary-actions">
          <button data-preview-studio-rule="${esc(rule.id)}" type="button">미리보기</button>
          <button data-edit-studio-rule="${esc(rule.id)}" type="button">수정</button>
          <button class="danger" data-delete-studio-rule="${esc(rule.id)}" type="button">삭제</button>
        </div>
      </article>
    `;
  }).join("");
  const editor = studioTelegramRuleEditor?.rule;
  const editorMarkup = editor ? `
    <article class="studio-rule-editor" data-studio-telegram-editor>
      <header>
        <div><span>${studioTelegramRuleEditor.isNew ? "새 예약 규칙" : "예약 규칙 수정"}</span><strong>${esc(editor.name || "방송실 공지")}</strong></div>
        <button data-cancel-studio-rule type="button" aria-label="편집 취소">×</button>
      </header>
      <div class="studio-rule-grid">
        <label class="studio-rule-name">공지 제목
          <input data-studio-rule-editor-field="name" maxlength="80" value="${esc(editor.name)}" placeholder="예: 예배 전날 공지" />
        </label>
        <label>일정 유형
          <div class="studio-telegram-dropdown" data-studio-rule-editor-dropdown="trainingType"></div>
        </label>
        <label>공지 방식
          <div class="studio-telegram-dropdown" data-studio-rule-editor-dropdown="mode"></div>
        </label>
        <label>전송 요일
          <div class="studio-telegram-dropdown" data-studio-rule-editor-dropdown="weekday"></div>
        </label>
        <label>전송 시간
          <div class="studio-telegram-dropdown" data-studio-rule-editor-dropdown="deliveryTime"></div>
        </label>
      </div>
      <div class="studio-rule-editor-options">
        <label class="studio-calltime-option">
          <span><strong>콜타임</strong><small>일정 시작 전 도착 시간을 선택합니다.</small></span>
          <div class="studio-telegram-dropdown" data-studio-rule-editor-dropdown="callTimeOffsetMinutes"></div>
        </label>
        <label class="studio-rule-notice">특이사항
          <textarea data-studio-rule-editor-field="notice" maxlength="1500" placeholder="이 예약 규칙으로 보내는 공지에만 추가할 내용을 입력하세요.">${esc(editor.notice || "")}</textarea>
          <small data-studio-rule-notice-count>${String(editor.notice || "").length} / 1500</small>
        </label>
      </div>
      <footer>
        <button data-cancel-studio-rule type="button">취소</button>
        <button class="primary" data-confirm-studio-rule type="button">확인</button>
      </footer>
    </article>
  ` : "";
  target.innerHTML = (summaryRows || editorMarkup) ? `${summaryRows}${editorMarkup}` : `
    <div class="studio-telegram-empty">
      <span>✈</span>
      <strong>등록된 예약 규칙이 없습니다.</strong>
      <small>예배 전날 공지, 교육 주간 공지처럼 필요한 규칙을 추가하세요.</small>
    </div>
  `;
  if (editor) renderStudioTelegramEditorDropdowns(editor, types, weekdays, hours);
  $("#studioTelegramAddRuleBtn").disabled = Boolean(studioTelegramRuleEditor);
  const message = $("#studioTelegramMessage");
  if (message && !message.textContent) message.textContent = studioTelegramStatusText();
}

function openStudioTelegramRuleEditor(ruleId = "") {
  if (!studioTelegramDraft) return;
  const rule = studioTelegramDraft.rules.find((item) => item.id === ruleId);
  studioTelegramRuleEditor = {
    isNew: !rule,
    rule: structuredClone(rule || createStudioTelegramRule(studioTelegramDraft.rules.length))
  };
  renderStudioTelegramRules();
  requestAnimationFrame(() => $("[data-studio-telegram-editor]")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}

function confirmStudioTelegramRuleEditor() {
  if (!studioTelegramDraft || !studioTelegramRuleEditor) return;
  if (!String(studioTelegramRuleEditor.rule.name || "").trim()) return showToast("공지 제목을 입력해 주세요.");
  const normalized = normalizeStudioTelegramSettings({ rules: [studioTelegramRuleEditor.rule] }).rules[0];
  if (!normalized) return;
  const index = studioTelegramDraft.rules.findIndex((rule) => rule.id === normalized.id);
  if (index >= 0) studioTelegramDraft.rules[index] = normalized;
  else studioTelegramDraft.rules.push(normalized);
  studioTelegramRuleEditor = null;
  renderStudioTelegramRules();
}

function openStudioTelegramModal() {
  if (!isAdminUser()) return showToast("관리자만 텔레그램 공지를 설정할 수 있습니다.");
  studioTelegramDraft = structuredClone(normalizeStudioTelegramSettings(state.studioTelegram || {}));
  studioTelegramRuleEditor = null;
  $("#studioTelegramMessage").textContent = "";
  $("#studioTelegramFixedNotice").value = studioTelegramDraft.fixedNotice || "";
  $("#studioTelegramFixedNoticeCount").textContent = `${String(studioTelegramDraft.fixedNotice || "").length} / 1500`;
  renderStudioTelegramRules();
  $("#studioTelegramModal").classList.add("open");
  $("#studioTelegramModal").setAttribute("aria-hidden", "false");
  refreshTelegramDigestStatus().then(() => {
    const message = $("#studioTelegramMessage");
    if (message) message.textContent = studioTelegramStatusText();
  });
}

function closeStudioTelegramModal() {
  studioTelegramDraft = null;
  studioTelegramRuleEditor = null;
  $("#studioTelegramModal").classList.remove("open");
  $("#studioTelegramModal").setAttribute("aria-hidden", "true");
}

async function previewStudioTelegramRule(ruleId, button) {
  const rule = studioTelegramDraft?.rules.find((item) => item.id === ruleId);
  if (!rule || !button) return;
  const originalText = button.textContent;
  const messageTarget = $("#studioTelegramMessage");
  button.disabled = true;
  button.textContent = "생성 중…";
  if (messageTarget) messageTarget.textContent = "";
  try {
    const result = await telegramDigestApi("studio-rule-preview", {
      rule,
      fixedNotice: studioTelegramDraft.fixedNotice
    });
    openStudioTelegramPreview({
      message: result.message,
      mode: "view",
      title: `${rule.name || "예약 공지"} 미리보기`,
      description: `가장 가까운 전송 대상 ${result.eventCount || 0}건을 기준으로 생성했습니다.`
    });
  } catch (error) {
    if (messageTarget) messageTarget.textContent = error.message || "미리보기를 만들지 못했습니다.";
    showToast(error.message || "예약 공지 미리보기를 만들지 못했습니다.");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function saveStudioTelegramSettings() {
  if (!studioTelegramDraft) return;
  const message = $("#studioTelegramMessage");
  if (studioTelegramRuleEditor) {
    if (message) message.textContent = "편집 중인 예약 규칙에서 먼저 확인을 눌러 주세요.";
    return;
  }
  state.studioTelegram = normalizeStudioTelegramSettings(studioTelegramDraft);
  saveState();
  const remoteSaved = SUPABASE_ENABLED ? await saveRemoteDashboardState() : false;
  if (SUPABASE_ENABLED && !remoteSaved) {
    if (message) message.textContent = "서버 저장을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    return;
  }
  showToast("방송실 텔레그램 예약 설정을 저장했습니다.");
  closeStudioTelegramModal();
}

function adminActivityEntityTitle(log) {
  const entity = log.entityType === "work"
    ? state.works.find((item) => item.id === log.entityId)
    : state.projects.find((item) => item.id === log.entityId);
  return entity?.title || log.entityTitle || (log.entityType === "work" ? "삭제된 업무" : "삭제된 영상");
}

function adminActivityDescription(log) {
  if (log.activityType === "status_change") return `${log.previousStatus || "미설정"} → ${log.nextStatus || "미설정"}`;
  if (log.activityType === "task_check") return log.taskChecked ? "할 일 완료 체크" : "할 일 완료 체크 해제";
  return `${managementRecordThemeLabel(log.managementRecordTheme)} · 관리기록 작성`;
}

function adminActivityTypeLabel(type) {
  return {
    status_change: "상태 변경",
    task_check: "할 일",
    management_record_created: "관리기록"
  }[type] || "업무 활동";
}

function adminActivityDateLabel(value) {
  const target = new Date(`${value}T00:00:00`);
  if (Number.isNaN(target.getTime())) return value;
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  return `${target.getMonth() + 1}월 ${target.getDate()}일 ${weekdays[target.getDay()]}요일`;
}

function adminActivityTimeLabel(value) {
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return "--:--";
  return `${String(target.getHours()).padStart(2, "0")}:${String(target.getMinutes()).padStart(2, "0")}`;
}

function filteredAdminActivityLogs() {
  const month = /^\d{4}-\d{2}$/.test(adminActivityMonth) ? adminActivityMonth : dateKey(new Date()).slice(0, 7);
  return (state.activityLogs || [])
    .filter((log) => String(log.activityDate || "").startsWith(month))
    .filter((log) => adminActivityEntityFilter === "all" || log.entityType === adminActivityEntityFilter)
    .filter((log) => adminActivityTypeFilter === "all" || log.activityType === adminActivityTypeFilter)
    .sort((a, b) => String(b.occurredAt || "").localeCompare(String(a.occurredAt || "")));
}

function updateAdminActivityFilter(field, value) {
  if (field === "month") adminActivityMonth = /^\d{4}-\d{2}$/.test(value) ? value : dateKey(new Date()).slice(0, 7);
  if (field === "entity") adminActivityEntityFilter = ["all", "project", "work"].includes(value) ? value : "all";
  if (field === "type") adminActivityTypeFilter = ["all", ...PROGRESS_ACTIVITY_TYPES].includes(value) ? value : "all";
  saveViewPrefs({ adminActivityMonth, adminActivityEntityFilter, adminActivityTypeFilter });
}

function renderAdminActivityManager({ mobile = false } = {}) {
  const logs = filteredAdminActivityLogs();
  const entityCount = new Set(logs.map((log) => `${log.entityType}:${log.entityId}`)).size;
  const progressDayCount = new Set(logs.map((log) => `${log.entityType}:${log.entityId}:${log.activityDate}`)).size;
  const statusCount = logs.filter((log) => log.activityType === "status_change").length;
  const checkedTaskCount = logs.filter((log) => log.activityType === "task_check" && log.taskChecked).length;
  const recordCount = logs.filter((log) => log.activityType === "management_record_created").length;
  const grouped = new Map();
  logs.forEach((log) => {
    const items = grouped.get(log.activityDate) || [];
    items.push(log);
    grouped.set(log.activityDate, items);
  });
  return `
    <div class="admin-activity-manager ${mobile ? "is-mobile" : ""}">
      <section class="admin-activity-filters" aria-label="업무 진행 이력 필터">
        <label><span>조회 월</span><input data-activity-log-filter="month" type="month" value="${esc(adminActivityMonth)}" /></label>
        <label><span>대상</span><select data-activity-log-filter="entity"><option value="all" ${adminActivityEntityFilter === "all" ? "selected" : ""}>영상 + 업무</option><option value="project" ${adminActivityEntityFilter === "project" ? "selected" : ""}>영상</option><option value="work" ${adminActivityEntityFilter === "work" ? "selected" : ""}>업무</option></select></label>
        <label><span>활동</span><select data-activity-log-filter="type"><option value="all" ${adminActivityTypeFilter === "all" ? "selected" : ""}>전체 활동</option><option value="status_change" ${adminActivityTypeFilter === "status_change" ? "selected" : ""}>상태 변경</option><option value="task_check" ${adminActivityTypeFilter === "task_check" ? "selected" : ""}>할 일 체크</option><option value="management_record_created" ${adminActivityTypeFilter === "management_record_created" ? "selected" : ""}>관리기록 작성</option></select></label>
      </section>
      <section class="admin-activity-summary" aria-label="업무 진행 이력 요약">
        <article><span>진행 항목</span><b>${entityCount}</b><small>영상·업무</small></article>
        <article><span>업무 진행일</span><b>${progressDayCount}</b><small>항목별 날짜</small></article>
        <article><span>상태 변경</span><b>${statusCount}</b><small>이전 → 변경</small></article>
        <article><span>완료 체크</span><b>${checkedTaskCount}</b><small>할 일 완료</small></article>
        <article><span>관리기록</span><b>${recordCount}</b><small>작성 여부</small></article>
      </section>
      <div class="admin-activity-days">
        ${logs.length ? [...grouped.entries()].map(([activityDate, items]) => `
          <section class="admin-activity-day">
            <header><div><strong>${esc(adminActivityDateLabel(activityDate))}</strong><span>${items.length}건</span></div><small>진행일 ${esc(activityDate)}</small></header>
            <div class="admin-activity-list">
              ${items.map((log) => `
                <article class="admin-activity-row" data-activity-type="${esc(log.activityType)}">
                  <time>${esc(adminActivityTimeLabel(log.occurredAt))}</time>
                  <span class="admin-activity-entity ${log.entityType === "work" ? "work" : "project"}">${log.entityType === "work" ? "업무" : "영상"}</span>
                  <div class="admin-activity-copy"><strong>${esc(adminActivityEntityTitle(log))}</strong><p><b>${esc(adminActivityTypeLabel(log.activityType))}</b><span>${esc(adminActivityDescription(log))}</span></p></div>
                  <div class="admin-activity-actor"><span>작업자</span><strong>${esc(log.actorName || "사용자")}</strong></div>
                </article>
              `).join("")}
            </div>
          </section>
        `).join("") : '<div class="admin-activity-empty"><strong>선택한 조건의 진행 이력이 없습니다.</strong><span>상태 변경, 할 일 체크, 관리기록 작성 시 이곳에 자동으로 표시됩니다.</span></div>'}
      </div>
    </div>
  `;
}

function monthlyReportWorkContentCategoryValue() {
  return MANAGEMENT_RECORD_THEMES.find((theme) => String(theme.label || "").replace(/\s+/g, "") === "업무내용")?.value || "";
}

function monthlyReportIncludedCount(sections) {
  return (window.MonthlyReportCore?.SECTION_KEYS || []).reduce(
    (total, section) => {
      const value = sections?.[section];
      if (typeof value === "string") return total + (value.trim() ? 1 : 0);
      return total + (value || []).filter((item) => item.included !== false && String(item.text || "").trim()).length;
    },
    0
  );
}

function monthlyReportStepAvailable(step) {
  if (step === 1) return true;
  return monthlyReportGeneratedByGpt;
}

function selectMonthlyReportStep(step) {
  const nextStep = Number(step);
  if (![1, 2, 3].includes(nextStep) || !monthlyReportStepAvailable(nextStep)) return;
  monthlyReportStep = nextStep;
  monthlyReportMonthPickerOpen = false;
  renderAdmin();
}

function invalidateMonthlyReportResult() {
  monthlyReportGeneratedByGpt = false;
  monthlyReportPreview = { activity: "", production: "", next: "" };
  monthlyReportMessage = "선택 항목이 변경되었습니다. 다음 단계에서 보고서를 다시 정리해 주세요.";
}

function collectMonthlyReportPreview() {
  const core = window.MonthlyReportCore;
  if (!core) {
    monthlyReportMessage = "보고서 데이터 모듈을 불러오지 못했습니다. 화면을 새로고침해 주세요.";
    return false;
  }
  try {
    monthlyReportSources = core.collectMonthlyReportSources(state, monthlyReportMonth, monthlyReportWorkContentCategoryValue());
    monthlyReportDraft = core.buildMonthlyReportPreview(monthlyReportSources, monthlyReportMonth);
    monthlyReportPreview = { activity: "", production: "", next: "" };
    monthlyReportLoadedMonth = monthlyReportMonth;
    monthlyReportGeneratedByGpt = false;
    monthlyReportStep = 1;
    const count = core.SECTION_KEYS.reduce((total, key) => total + monthlyReportDraft[key].length, 0);
    monthlyReportMessage = count ? `제목과 날짜 기준으로 ${count}개 항목을 수집했습니다.` : "선택한 달에 보고서로 정리할 데이터가 없습니다.";
    return true;
  } catch (error) {
    monthlyReportSources = [];
    monthlyReportDraft = { activity: [], production: [], next: [] };
    monthlyReportPreview = { activity: "", production: "", next: "" };
    monthlyReportLoadedMonth = monthlyReportMonth;
    monthlyReportStep = 1;
    monthlyReportMessage = error.message || "월말보고서 데이터를 수집하지 못했습니다.";
    return false;
  }
}

function ensureMonthlyReportPreview() {
  if (monthlyReportLoadedMonth !== monthlyReportMonth) collectMonthlyReportPreview();
}

function monthlyReportMonthPickerMarkup() {
  const [selectedYear, selectedMonth] = monthlyReportMonth.split("-").map(Number);
  const currentMonth = dateKey(new Date()).slice(0, 7);
  const label = `${selectedYear}년 ${selectedMonth}월`;
  return `
    <div class="monthly-report-month-control" data-monthly-report-month-control>
      <span>보고 월</span>
      <button class="monthly-report-month-trigger" data-monthly-report-month-trigger type="button" aria-haspopup="dialog" aria-expanded="${monthlyReportMonthPickerOpen}">
        <b>${esc(label)}</b>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v3m10-3v3M4.5 9h15M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>
      </button>
      ${monthlyReportMonthPickerOpen ? `
        <div class="monthly-report-month-popover" role="dialog" aria-label="보고 월 선택">
          <header>
            <button data-monthly-report-year-step="-1" type="button" aria-label="이전 연도">‹</button>
            <strong>${monthlyReportPickerYear}년</strong>
            <button data-monthly-report-year-step="1" type="button" aria-label="다음 연도">›</button>
          </header>
          <div class="monthly-report-month-grid">
            ${Array.from({ length: 12 }, (_, index) => {
              const value = `${monthlyReportPickerYear}-${String(index + 1).padStart(2, "0")}`;
              return `<button class="${value === monthlyReportMonth ? "selected" : ""} ${value === currentMonth ? "current" : ""}" data-monthly-report-month-value="${value}" type="button" aria-pressed="${value === monthlyReportMonth}">${index + 1}월</button>`;
            }).join("")}
          </div>
          <footer><button data-monthly-report-current-month type="button">이번 달</button></footer>
        </div>
      ` : ""}
    </div>
  `;
}

function selectMonthlyReportMonth(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""))) return;
  monthlyReportMonth = value;
  monthlyReportPickerYear = Number(value.slice(0, 4));
  monthlyReportMonthPickerOpen = false;
  saveViewPrefs({ monthlyReportMonth });
  collectMonthlyReportPreview();
  renderAdmin();
  if (isMobileViewport() && mobileActiveSection === "settings" && mobileMoreRoute === "admin-report") renderMobileDashboard();
}

function monthlyReportSectionMarkup(key, title, description, { sections = monthlyReportPreview, scope = "preview", editable = true } = {}) {
  const items = sections[key] || [];
  const itemMarkup = (item, extraClass = "") => `
    <label class="monthly-report-preview-item ${extraClass} ${editable ? "is-editable" : "is-draft"} ${item.included === false ? "is-excluded" : ""}" data-monthly-report-item="${esc(item.id)}" data-monthly-report-scope="${scope}">
      <input type="checkbox" data-monthly-report-include="${esc(item.id)}" data-monthly-report-scope="${scope}" ${item.included === false ? "" : "checked"} />
      <i aria-hidden="true"></i>
      ${editable
        ? `<input type="text" data-monthly-report-text="${esc(item.id)}" data-monthly-report-scope="${scope}" value="${esc(item.text)}" aria-label="보고서 항목 문구" />`
        : `<span>${esc(item.text)}</span>`}
      <aside class="monthly-report-item-badges">
        <b class="monthly-report-owner-badge">${item.ownerNames?.length ? `담당 ${esc(item.ownerLabel)}` : "담당자 미지정"}</b>
        ${item.isRecurring ? `<b class="monthly-report-recurrence-badge">↻ ${esc(item.recurrenceLabel || "반복 업무")}</b>` : ""}
      </aside>
    </label>
  `;
  const typeGroupMarkup = (groupKey, label, detail, groupItems, content) => {
    const allIncluded = groupItems.length > 0 && groupItems.every((item) => item.included !== false);
    return `
    <section class="monthly-report-type-group" data-report-group="${esc(groupKey)}">
      <header>
        <div><strong>${esc(label)}</strong><small>${esc(detail)}</small></div>
        <aside>
          <span>${groupItems.length}개</span>
          <label class="monthly-report-group-select">
            <input
              type="checkbox"
              data-monthly-report-group-include="${esc(groupKey)}"
              data-monthly-report-scope="${scope}"
              ${allIncluded ? "checked" : ""}
            />
            <i aria-hidden="true"></i>
            <b>${allIncluded ? "전체 해제" : "전체 선택"}</b>
          </label>
        </aside>
      </header>
      <div>${content}</div>
    </section>
  `;
  };
  const activityItemsMarkup = (activityItems) => {
    const groupKeyOf = (item) => item.parentSourceId || `${item.parentTitle || "연결 업무 없음"}\u0000${item.department || ""}`;
    const groups = new Map();
    activityItems.filter((item) => ["project", "task"].includes(item.itemType)).forEach((item) => {
      const groupKey = groupKeyOf(item);
      if (!groups.has(groupKey)) groups.set(groupKey, { parent: null, tasks: [] });
      if (item.itemType === "project") groups.get(groupKey).parent = item;
      else groups.get(groupKey).tasks.push(item);
    });
    const renderedGroups = new Set();
    return activityItems.map((item) => {
      if (!["project", "task"].includes(item.itemType)) return itemMarkup(item);
      const groupKey = groupKeyOf(item);
      if (renderedGroups.has(groupKey)) return "";
      renderedGroups.add(groupKey);
      const group = groups.get(groupKey) || { parent: null, tasks: [] };
      const parentText = group.parent?.text || `${item.parentTitle || "연결 업무 없음"} / ${item.department || "발주부서 미지정"} / 일정 미정 / 담당 ${item.ownerLabel || "담당자 미지정"}`;
      return `
        <article class="monthly-report-task-group">
          <div class="monthly-report-task-parent">
            <span>업무명 / 발주부서 / 업무한 날짜 / 담당자</span>
            ${group.parent ? itemMarkup(group.parent, "is-parent") : `<strong>${esc(parentText)}</strong>`}
          </div>
          ${group.tasks.length ? `
            <div class="monthly-report-task-columns" aria-hidden="true"><span>하위 할 일</span><span>날짜</span><span>담당자</span></div>
            <div class="monthly-report-task-children">${group.tasks.map((task) => itemMarkup(task)).join("")}</div>
          ` : ""}
        </article>
      `;
    }).join("");
  };
  const departmentGroupsMarkup = (groupKey, groupItems) => {
    if (!["work", "video"].includes(groupKey)) return activityItemsMarkup(groupItems);
    const departments = new Map();
    groupItems.forEach((item) => {
      const department = item.departmentGroupLabel || item.department || "발주부서 미지정";
      if (!departments.has(department)) departments.set(department, []);
      departments.get(department).push(item);
    });
    return [...departments.entries()]
      .sort(([departmentA], [departmentB]) => {
        if (departmentA === "발주부서 미지정") return 1;
        if (departmentB === "발주부서 미지정") return -1;
        return departmentA.localeCompare(departmentB, "ko");
      })
      .map(([department, departmentItems]) => `
        <section class="monthly-report-department-group" data-report-department="${esc(department)}">
          <header>
            <div><span>발주부서</span><strong>${esc(department)}</strong></div>
            <em>${departmentItems.length}개</em>
          </header>
          <div>${activityItemsMarkup(departmentItems)}</div>
        </section>
      `).join("");
  };
  let listMarkup = items.map((item) => itemMarkup(item)).join("");
  if (key === "activity") {
    const definitions = [
      ["work", "업무", "일반 업무와 연결된 하위 업무"],
      ["video", "영상", "영상 프로젝트와 연결된 하위 업무"],
      ["studio", "방송실 업무", "프로젝트에 연결되지 않은 방송실 일정"]
    ];
    listMarkup = definitions.map(([groupKey, label, detail]) => {
      const groupItems = items.filter((item) => (item.reportGroup || item.sourceKind || "work") === groupKey);
      return groupItems.length
        ? typeGroupMarkup(groupKey, label, detail, groupItems, departmentGroupsMarkup(groupKey, groupItems))
        : "";
    }).join("");
  } else if (key === "production" && items.length) {
    listMarkup = typeGroupMarkup(
      "production",
      "제작물",
      "선택한 달에 마감된 영상 제작물",
      items,
      items.map((item) => itemMarkup(item)).join("")
    );
  } else if (key === "next" && items.length) {
    listMarkup = typeGroupMarkup(
      "next",
      "차월 업무",
      "다음 달에 예정된 영상·일반 업무",
      items,
      items.map((item) => itemMarkup(item)).join("")
    );
  }
  return `
    <section class="monthly-report-preview-section" data-monthly-report-section="${key}">
      <header><div><h4>${esc(title)}</h4><small>${esc(description)}</small></div><span>${items.length}개</span></header>
      <div class="monthly-report-preview-list">
        ${items.length ? listMarkup : '<div class="monthly-report-empty">해당 항목이 없습니다.</div>'}
      </div>
    </section>
  `;
}

function monthlyReportStepperMarkup() {
  const steps = [
    [1, "자료 선택", "공용 프롬프트"],
    [2, "미리보기", "본문 편집"],
    [3, "Word 출력", "파일 생성"]
  ];
  return `
    <nav class="monthly-report-stepper" aria-label="월말보고서 작성 단계">
      ${steps.map(([step, label, description], index) => {
        const available = monthlyReportStepAvailable(step);
        const completed = step < monthlyReportStep;
        return `
          <button class="${step === monthlyReportStep ? "is-current" : ""} ${completed ? "is-complete" : ""}" data-monthly-report-step="${step}" type="button" ${available ? "" : "disabled"} aria-current="${step === monthlyReportStep ? "step" : "false"}">
            <i>${completed ? "✓" : step}</i>
            <span><strong>${label}</strong><small>${description}</small></span>
          </button>
          ${index < steps.length - 1 ? `<b class="${completed ? "is-complete" : ""}" aria-hidden="true"></b>` : ""}
        `;
      }).join("")}
    </nav>
  `;
}

function monthlyReportPromptCardMarkup() {
  const prompt = state.monthlyReport?.prompt || window.MonthlyReportCore?.DEFAULT_PROMPT || "";
  return `
    <details class="monthly-report-prompt-card" open>
      <summary><div><p class="eyebrow">SHARED GPT SETTINGS</p><h3>월말보고 작성 공용 프롬프트</h3></div><span aria-hidden="true"></span></summary>
      <div>
        <p>이 프롬프트는 계정별 설정이 아닙니다. 저장하면 월말보고서를 사용하는 모든 계정에 동일하게 적용됩니다.</p>
        <textarea data-monthly-report-prompt maxlength="12000" rows="15">${esc(prompt)}</textarea>
        <footer>
          <small>모든 계정 공용 · 체크된 보고서 전체에 한 번 적용</small>
          <button class="pill ghost" data-monthly-report-save-prompt type="button">공용 프롬프트 저장</button>
        </footer>
      </div>
    </details>
  `;
}

function monthlyReportSourceSummaryMarkup() {
  const sourceCounts = Object.fromEntries(["video_project", "work_project", "task", "management_record", "studio_schedule"].map((type) => [type, monthlyReportSources.filter((source) => source.sourceType === type).length]));
  return `
    <section class="monthly-report-source-summary" aria-label="수집 데이터 요약">
      <article><span>영상</span><b>${sourceCounts.video_project}</b></article>
      <article><span>업무</span><b>${sourceCounts.work_project}</b></article>
      <article><span>할 일</span><b>${sourceCounts.task}</b></article>
      <article><span>업무내용 기록</span><b>${sourceCounts.management_record}</b></article>
      <article><span>방송실 일정</span><b>${sourceCounts.studio_schedule}</b></article>
    </section>
  `;
}

function monthlyReportDraftStageMarkup() {
  const selectedCount = monthlyReportIncludedCount(monthlyReportDraft);
  return `
    <section class="monthly-report-stage">
      <div class="monthly-report-toolbar">
        <div>
          ${monthlyReportMonthPickerMarkup()}
          <button class="pill ghost" data-monthly-report-collect type="button">데이터 다시 수집</button>
        </div>
      </div>
      ${monthlyReportSourceSummaryMarkup()}
      <div class="monthly-report-notice" data-monthly-report-message aria-live="polite">
        <strong>보고서 초안</strong>
        <span>${esc(monthlyReportMessage)}</span>
      </div>
      ${monthlyReportPromptCardMarkup()}
      <section class="monthly-report-preview-card">
        <header class="monthly-report-card-head">
          <div><p class="eyebrow">STEP 1</p><h3>보고서에 포함할 자료를 선택해 주세요</h3></div>
          <small>선택한 항목과 위 공용 프롬프트로 바로 미리보기를 만듭니다. 상위 업무를 해제하면 연결된 하위 할 일도 함께 제외됩니다.</small>
        </header>
        ${monthlyReportSectionMarkup("activity", "활동내용", "업무와 하위 할 일", { sections: monthlyReportDraft, scope: "draft", editable: false })}
        ${monthlyReportSectionMarkup("production", "제작물 현황", "선택한 달에 마감일이 있는 영상", { sections: monthlyReportDraft, scope: "draft", editable: false })}
        ${monthlyReportSectionMarkup("next", "차월계획", "바로 다음 달에 예정된 업무", { sections: monthlyReportDraft, scope: "draft", editable: false })}
        <footer class="monthly-report-stage-actions">
          <span><b>${selectedCount}</b>개 항목 선택됨</span>
          <button class="pill primary" data-monthly-report-gpt type="button" ${selectedCount ? "" : "disabled"}>월말보고서 미리보기 만들기</button>
        </footer>
      </section>
    </section>
  `;
}

function monthlyReportTextSectionMarkup(key, title, description, rows) {
  const text = String(monthlyReportPreview[key] || "");
  const lineCount = text ? text.split(/\r?\n/).filter((line) => line.trim()).length : 0;
  return `
    <section class="monthly-report-document-editor" data-monthly-report-text-section="${key}">
      <header>
        <div><h4>${esc(title)}</h4><small>${esc(description)}</small></div>
        <span><b data-monthly-report-line-count="${key}">${lineCount}</b>줄</span>
      </header>
      <textarea
        data-monthly-report-section-text="${key}"
        maxlength="30000"
        rows="${rows}"
        spellcheck="false"
        aria-label="${esc(title)} 편집"
        placeholder="${esc(`${title} 내용을 입력해 주세요.`)}"
      >${esc(text)}</textarea>
    </section>
  `;
}

function monthlyReportPreviewStageMarkup() {
  const completedSectionCount = monthlyReportIncludedCount(monthlyReportPreview);
  return `
    <section class="monthly-report-stage">
      <div class="monthly-report-notice is-gpt" data-monthly-report-message aria-live="polite">
        <strong>GPT 정리 완료</strong>
        <span>${esc(monthlyReportMessage)}</span>
      </div>
      <section class="monthly-report-preview-card">
        <header class="monthly-report-card-head">
          <div><p class="eyebrow">STEP 2</p><h3>월말보고서 미리보기</h3></div>
          <small>세 영역의 내용은 자유롭게 추가·삭제·수정할 수 있습니다. 현재 입력된 최종 문구가 Word에 그대로 반영됩니다.</small>
        </header>
        <div class="monthly-report-document-grid">
          ${monthlyReportTextSectionMarkup("activity", "활동내용", "상위 업무와 하위 업무를 보고서 형식으로 직접 편집합니다.", 22)}
          ${monthlyReportTextSectionMarkup("production", "제작물 현황", "영상제작과_날짜_영상 제목 형식의 제작물 목록입니다.", 10)}
          ${monthlyReportTextSectionMarkup("next", "차월계획", "날짜와 하위 할 일을 제외한 다음 달 업무 목록입니다.", 10)}
        </div>
        <footer class="monthly-report-stage-actions">
          <button class="pill ghost" data-monthly-report-step="1" type="button">자료 선택·다시 정리</button>
          <span><b data-monthly-report-completed-section-count>${completedSectionCount}</b>개 영역 작성됨</span>
          <button class="pill primary" data-monthly-report-next="3" type="button" ${completedSectionCount ? "" : "disabled"}>출력 단계로</button>
        </footer>
      </section>
    </section>
  `;
}

function monthlyReportOutputStageMarkup() {
  const [year, monthNumber] = monthlyReportMonth.split("-");
  const manager = window.MonthlyReportCore?.monthlyReportManager(state.users);
  const completedSectionCount = monthlyReportIncludedCount(monthlyReportPreview);
  const filename = window.MonthlyReportDocx?.monthlyReportFilename(monthlyReportMonth) || `영상제작과_문화부_${Number(monthNumber)}월말보고서.docx`;
  return `
    <section class="monthly-report-stage">
      <section class="monthly-report-output-card">
        <header><p class="eyebrow">STEP 3</p><h3>월말보고서 출력</h3><p>최종 확인 후 지정된 Word 양식으로 파일을 생성합니다.</p></header>
        <div class="monthly-report-output-grid">
          <article><span>보고 월</span><strong>${year}년 ${Number(monthNumber)}월</strong></article>
          <article><span>보고자</span><strong>${esc(manager?.name || "과장 미지정")}</strong></article>
          <article><span>작성 영역</span><strong>${completedSectionCount}개</strong></article>
        </div>
        <div class="monthly-report-output-file"><span>생성 파일명</span><strong>${esc(filename)}</strong></div>
        <footer class="monthly-report-stage-actions">
          <button class="pill ghost" data-monthly-report-step="2" type="button">미리보기로 돌아가기</button>
          <button class="pill primary" data-monthly-report-download type="button" ${completedSectionCount ? "" : "disabled"}>Word 다운로드</button>
        </footer>
      </section>
    </section>
  `;
}

function renderMonthlyReportManager() {
  ensureMonthlyReportPreview();
  return `
    <div class="monthly-report-manager">
      ${monthlyReportStepperMarkup()}
      ${monthlyReportStep === 1
        ? monthlyReportDraftStageMarkup()
        : monthlyReportStep === 2
          ? monthlyReportPreviewStageMarkup()
          : monthlyReportOutputStageMarkup()}
    </div>
  `;
}

function monthlyReportFindItem(itemId, scope = "preview") {
  const sections = scope === "draft" ? monthlyReportDraft : {};
  for (const section of window.MonthlyReportCore?.SECTION_KEYS || []) {
    const item = sections[section]?.find((entry) => entry.id === itemId);
    if (item) return item;
  }
  return null;
}

function updateMonthlyReportTextSection(section, value) {
  if (!(window.MonthlyReportCore?.SECTION_KEYS || []).includes(section)) return;
  const text = String(value || "").slice(0, 30000);
  monthlyReportPreview[section] = text;
  const lineCount = text ? text.split(/\r?\n/).filter((line) => line.trim()).length : 0;
  document.querySelectorAll(`[data-monthly-report-line-count="${section}"]`).forEach((element) => {
    element.textContent = String(lineCount);
  });
  const hasContent = monthlyReportIncludedCount(monthlyReportPreview) > 0;
  document.querySelectorAll("[data-monthly-report-completed-section-count]").forEach((element) => {
    element.textContent = String(monthlyReportIncludedCount(monthlyReportPreview));
  });
  document.querySelectorAll('[data-monthly-report-next="3"], [data-monthly-report-download]').forEach((button) => {
    button.disabled = !hasContent;
  });
}

function monthlyReportGroupItems(sections, groupKey) {
  return (window.MonthlyReportCore?.SECTION_KEYS || []).flatMap((section) => sections?.[section] || [])
    .filter((item) => (item.reportGroup || item.sourceKind || (item.section === "activity" ? "work" : item.section)) === groupKey);
}

function setMonthlyReportGroupIncluded(scope, groupKey, included) {
  const sections = scope === "draft" ? monthlyReportDraft : monthlyReportPreview;
  const items = monthlyReportGroupItems(sections, groupKey);
  if (window.MonthlyReportCore?.setReportGroupIncluded) {
    window.MonthlyReportCore.setReportGroupIncluded(sections, groupKey, included);
  } else {
    items.forEach((item) => {
      item.included = included !== false;
    });
  }
  if (scope === "draft") invalidateMonthlyReportResult();
  return items.length;
}

async function saveMonthlyReportPrompt(button) {
  const input = button?.closest(".monthly-report-manager")?.querySelector("[data-monthly-report-prompt]")
    || $("[data-monthly-report-prompt]");
  if (!input) return;
  const previousPrompt = monthlyReportSharedPromptSnapshot;
  const prompt = String(input.value || window.MonthlyReportCore?.DEFAULT_PROMPT || "").slice(0, 12000);
  state.monthlyReport = { prompt };
  saveState();
  const remoteSaved = SUPABASE_ENABLED ? await saveRemoteDashboardState() : true;
  if (remoteSaved === false) {
    state.monthlyReport = { prompt: previousPrompt };
    saveState();
    input.value = previousPrompt;
    showToast("공용 프롬프트 서버 저장을 확인하지 못했습니다. 다시 시도해 주세요.");
    return;
  }
  monthlyReportSharedPromptSnapshot = prompt;
  showToast(SUPABASE_ENABLED
    ? "모든 계정에 월말보고 공용 프롬프트를 저장했습니다."
    : "월말보고 공용 프롬프트를 저장했습니다.");
}

async function monthlyReportApi(promptValue) {
  const client = getSupabaseClient();
  if (!client) throw new Error("배포된 대시보드에서 로그인한 뒤 GPT 정리를 사용할 수 있습니다.");
  const { data } = await client.auth.getSession();
  const accessToken = data?.session?.access_token;
  if (!accessToken) throw new Error("로그인 세션을 확인할 수 없습니다. 다시 로그인해 주세요.");
  const response = await fetch("/api/monthly-report", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      month: monthlyReportMonth,
      prompt: promptValue || state.monthlyReport?.prompt || window.MonthlyReportCore.DEFAULT_PROMPT,
      sources: window.MonthlyReportCore.apiSources(monthlyReportSources),
      candidates: window.MonthlyReportCore.previewItems(monthlyReportDraft)
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "GPT 보고서 정리를 완료하지 못했습니다.");
  return result;
}

async function generateMonthlyReportWithGpt(button) {
  if (!monthlyReportSources.length) return showToast("먼저 보고서 데이터를 수집해 주세요.");
  const selectedCount = monthlyReportIncludedCount(monthlyReportDraft);
  if (!selectedCount) return showToast("보고서에 포함할 항목을 먼저 선택해 주세요.");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "GPT 정리 중…";
  monthlyReportMessage = "체크된 보고서 전체를 검토해 문체, 업무 묶음과 항목 순서를 정리하고 있습니다.";
  const promptInput = button.closest(".monthly-report-manager")?.querySelector("[data-monthly-report-prompt]")
    || $("[data-monthly-report-prompt]");
  const prompt = String(promptInput?.value || state.monthlyReport?.prompt || window.MonthlyReportCore.DEFAULT_PROMPT).slice(0, 12000);
  const previousPrompt = monthlyReportSharedPromptSnapshot;
  state.monthlyReport = { prompt };
  saveState();
  try {
    if (SUPABASE_ENABLED && !await saveRemoteDashboardState()) {
      state.monthlyReport = { prompt: previousPrompt };
      saveState();
      if (promptInput) promptInput.value = previousPrompt;
      throw new Error("공용 프롬프트를 서버에 저장하지 못했습니다. 다시 시도해 주세요.");
    }
    monthlyReportSharedPromptSnapshot = prompt;
    const result = await monthlyReportApi(prompt);
    monthlyReportPreview = window.MonthlyReportCore.validateGeneratedTextSections(result.sections);
    monthlyReportGeneratedByGpt = true;
    monthlyReportStep = 2;
    monthlyReportMessage = "보고서 전체를 프롬프트에 따라 세 개의 편집 영역으로 정리했습니다.";
    renderAdmin();
    if (isMobileViewport() && mobileActiveSection === "settings" && mobileMoreRoute === "admin-report") renderMobileDashboard();
    showToast("GPT가 월말보고서 전체를 정리했습니다.");
  } catch (error) {
    monthlyReportGeneratedByGpt = false;
    monthlyReportStep = 1;
    monthlyReportMessage = `${error.message} 현재 미리보기는 그대로 유지됩니다.`;
    renderAdmin();
    if (isMobileViewport() && mobileActiveSection === "settings" && mobileMoreRoute === "admin-report") renderMobileDashboard();
    showToast(error.message || "GPT 보고서 정리를 완료하지 못했습니다.");
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function downloadMonthlyReportWord(button) {
  if (!window.MonthlyReportDocx) return showToast("Word 생성 모듈을 불러오지 못했습니다.");
  const completedSectionCount = monthlyReportIncludedCount(monthlyReportPreview);
  if (!completedSectionCount) return showToast("Word 문서에 포함할 보고서 내용이 없습니다.");
  const manager = window.MonthlyReportCore.monthlyReportManager(state.users);
  if (!manager) return showToast("활성 계정 중 직책이 과장인 사용자를 먼저 지정해 주세요.");
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Word 생성 중…";
  }
  try {
    const bytes = await window.MonthlyReportDocx.createMonthlyReportDocx({
      month: monthlyReportMonth,
      sections: monthlyReportPreview,
      author: manager.name
    });
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = window.MonthlyReportDocx.monthlyReportFilename(monthlyReportMonth);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("지정된 양식으로 월말보고서 Word 파일을 만들었습니다.");
  } catch (error) {
    showToast(error.message || "월말보고서 Word 파일을 만들지 못했습니다.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
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

  const dropdownGroups = [
    ["types", "프로젝트", "업무분류"],
    ["statuses", "프로젝트", "진행"],
    ["clients", "프로젝트", "발주 부서"],
    ["projectTaskTypes", "프로젝트", "할 일 분류"],
    ["workTaskTypes", "업무", "할 일 분류"],
    ["workTypes", "업무", "업무분류"],
    ["workStatuses", "업무", "진행"],
    ["workClients", "업무", "발주 부서"],
    ["boardPrefixes", "게시판", "게시판 말머리"],
    ["studioRooms", "방송실 일정 드롭다운", "장소 관리"],
    ["staffTypes", "방송실 일정 드롭다운", "스탭 종류 관리"],
    ["trainingTypes", "방송실 일정 드롭다운", "교육 유형 관리"]
  ];
  const renderOptionManager = ([key, section, label]) => `
      <article class="option-manager" data-option-group="${key}">
        <header class="admin-card-head">
          <div>
            <p class="eyebrow">${esc(section)}</p>
            <h3>${esc(label)}</h3>
          </div>
          <span>${state.options[key].length}개</span>
        </header>
        <form class="option-form">
          <input name="option" placeholder="${label} 추가" />
          <button class="pill primary" type="submit">추가</button>
        </form>
        <div class="option-list">
          ${state.options[key]
            .map((option, index) => `
              <span class="admin-chip" draggable="true" data-option-index="${index}" data-option-value="${esc(option)}">
                <i class="drag-handle">☰</i>
                ${COLORABLE_OPTION_GROUPS.has(key) ? `<button class="admin-option-color" data-option-color-group="${key}" data-option-color-value="${esc(option)}" type="button" title="${esc(OPTION_COLOR_PALETTE[optionColorKey(key, option)].label)}" aria-label="${esc(option)} 색상 설정"><i style="--option-accent:${OPTION_COLOR_PALETTE[optionColorKey(key, option)].color}"></i></button>` : ""}
                <input class="admin-option-input" data-option-edit-value value="${esc(option)}" aria-label="${esc(option)} 이름 수정" readonly />
                <button data-edit-option="${esc(option)}" type="button">수정</button>
                <button data-delete-option="${esc(option)}" aria-label="${esc(option)} 삭제">×</button>
              </span>
            `)
            .join("")}
        </div>
      </article>
    `;
  const sectionMeta = {
    dropdowns: ["드롭다운 관리", "화면에서 사용하는 선택 항목을 관리합니다."],
    members: ["멤버 관리", "계정, 직책, 담당자 연결을 관리합니다."],
    telegram: ["텔레그램 봇 관리", "데일리 업무 브리핑의 내용과 전송 방식을 관리합니다."],
    activity: ["업무 진행 이력", "월별 상태 변경, 할 일 체크, 관리기록 작성 내역을 확인합니다."],
    reports: ["보고서 작성", "제목과 날짜 중심으로 월말보고서를 만들고 Word로 내려받습니다."]
  };
  const [sectionTitle, sectionDescription] = sectionMeta[adminSection] || sectionMeta.dropdowns;
  const content = adminSection === "members"
    ? `<div class="admin-member-grid">${renderOptionManager(["positions", "멤버", "직책 관리"])}${renderOptionManager(["owners", "멤버", "담당자 슬롯"])}${renderOwnerLinkManager()}${renderAccountManager()}</div>`
    : adminSection === "telegram"
      ? renderTelegramDigestManager()
      : adminSection === "activity"
        ? renderAdminActivityManager()
        : adminSection === "reports"
          ? renderMonthlyReportManager()
        : `<div class="admin-dropdown-grid">${dropdownGroups.map(renderOptionManager).join("")}</div>`;

  $("#adminContent").innerHTML = `
    <div class="admin-hub-head">
      <div class="admin-hub-copy">
        <p class="eyebrow">ADMIN SETTINGS</p>
        <h2>${esc(sectionTitle)}</h2>
        <span>${esc(sectionDescription)}</span>
      </div>
      <nav aria-label="관리자 설정 메뉴">
        <button class="${adminSection === "dropdowns" ? "active" : ""}" data-admin-section="dropdowns" type="button">드롭다운 관리</button>
        <button class="${adminSection === "members" ? "active" : ""}" data-admin-section="members" type="button">멤버 관리</button>
        <button class="${adminSection === "activity" ? "active" : ""}" data-admin-section="activity" type="button">업무 진행 이력</button>
        <button class="${adminSection === "reports" ? "active" : ""}" data-admin-section="reports" type="button">보고서 작성</button>
        <button class="${adminSection === "telegram" ? "active" : ""}" data-admin-section="telegram" type="button">텔레그램 봇 관리</button>
      </nav>
    </div>
    ${content}
  `;
  if (adminSection === "telegram") queueMicrotask(refreshTelegramDigestStatus);
}



function renderOwnerLinkManager() {
  const users = state.users.filter((user) => (IS_LOCAL_ENV || user.username !== "1") && user.status !== "inactive" && user.approved !== false);
  return `
    <article class="option-manager account-manager owner-link-manager">
      <header class="admin-card-head">
        <div>
          <p class="eyebrow">owners</p>
          <h3>담당자 연결 관리</h3>
        </div>
        <span>${ownerSlots().length}개</span>
      </header>
      <div class="owner-link-actions">
        <small>계정을 선택한 뒤 연결 저장을 눌러야 반영됩니다.</small>
        <button class="pill primary" type="button" data-save-owner-links>연결 저장</button>
      </div>
      <div class="owner-link-table">
        <div class="owner-link-head"><span>담당자</span><span>연결 계정</span><span>상태</span><span>관리</span></div>
        ${ownerSlots().map((owner) => {
          const user = state.users.find((item) => item.id === owner.linkedUserId);
          const stateText = !owner.linkedUserId ? "알림 없음" : !user || user.status === "inactive" ? "비활성 계정" : "연결됨";
          const stateClass = !owner.linkedUserId ? "unlinked" : !user || user.status === "inactive" ? "inactive" : "connected";
          return `
            <div class="owner-link-row" data-owner-id="${esc(owner.id)}">
              <strong>${esc(owner.name)}</strong>
              <span>${esc(user?.username || "미연결")}</span>
              <small class="owner-link-state ${stateClass}"><i></i>${esc(stateText)}</small>
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

  const users = state.users.filter((user) => IS_LOCAL_ENV || user.username !== "1");
  return `
    <article class="option-manager account-manager">
      <header class="admin-card-head">
        <div>
          <p class="eyebrow">accounts</p>
          <h3>계정 관리</h3>
        </div>
        <span>${users.length}명</span>
      </header>
      <div class="account-list">
        ${users
          .map((user) => {
            const statusClass = user.status === "inactive" ? "inactive" : user.approved === false || user.status === "pending" ? "pending" : user.role === "admin" ? "admin" : "active";
            const statusText = user.status === "inactive" ? "삭제됨" : user.approved === false || user.status === "pending" ? "미승인" : user.role === "admin" ? "관리자" : "일반";
            return `
            <div class="account-row" data-user-id="${esc(user.id)}">
              <div class="account-copy">
                <div class="account-name-line">
                  <strong>${esc(user.name || user.username)}</strong>
                  <span class="account-status ${statusClass}">${statusText}</span>
                </div>
                <small>${esc(user.position || "과원")}</small>
                <small>${esc(user.email || user.username || "-")}</small>
              </div>
              <div class="account-actions">
                <label class="account-position"><span>직책</span><select data-user-position="${esc(user.id)}">${uniqueValues([user.position, ...state.options.positions]).map((position) => `<option value="${esc(position)}" ${user.position === position ? "selected" : ""}>${esc(position)}</option>`).join("")}</select></label>
                <button class="role-chip ${user.role === "admin" && user.approved !== false && user.status !== "pending" && user.status !== "inactive" ? "active" : ""}" data-set-role="admin" type="button">관리자</button>
                <button class="role-chip ${user.role !== "admin" && user.approved !== false && user.status !== "pending" && user.status !== "inactive" ? "active" : ""}" data-set-role="user" type="button">일반</button>
                <button class="role-chip ${user.approved === false || user.status === "pending" ? "active" : ""}" data-mark-pending="${esc(user.id)}" type="button">미승인</button>
                <button class="delete-btn" data-delete-user="${esc(user.id)}" ${user.id === state.currentUser ? "disabled" : ""} type="button" aria-label="계정 삭제">×</button>
              </div>
            </div>
          `;
          })
          .join("")}
      </div>
    </article>
  `;
}

function setUserRole(userId, role) {
  if (!isAdminUser()) return;
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  const activeAdmins = state.users.filter((item) => item.role === "admin" && item.approved !== false && item.status !== "pending" && item.status !== "inactive");
  if (user.role === "admin" && role !== "admin" && activeAdmins.length <= 1) {
    showToast("마지막 관리자 권한은 해제할 수 없습니다.");
    renderAll();
    return;
  }
  user.role = role;
  user.status = "active";
  user.approved = true;
  saveState();
  syncProfileToSupabase(user);
  renderAll();
  showToast("계정 권한이 변경되었습니다.");
}

function setUserPosition(userId, position) {
  if (!isAdminUser() || !state.options.positions.includes(position)) return;
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  user.position = position;
  if (currentProfile?.id === userId) currentProfile.position = position;
  saveState();
  syncProfileToSupabase(user);
  renderAll();
  showToast("직책이 변경되었습니다.");
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
  if (COLORABLE_OPTION_GROUPS.has(group) && state.optionColors[group]?.[oldValue]) {
    state.optionColors[group][clean] = state.optionColors[group][oldValue];
    delete state.optionColors[group][oldValue];
  }
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
  if (group === "positions") {
    state.users.forEach((user) => {
      if (user.position === oldValue) {
        user.position = clean;
        syncProfileToSupabase(user);
      }
    });
  }
  saveState();
  renderAll();
}

function deleteOption(group, value) {
  state.options[group] = state.options[group].filter((option) => option !== value);
  if (COLORABLE_OPTION_GROUPS.has(group) && state.optionColors[group]) delete state.optionColors[group][value];
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
  if (group === "positions") {
    const fallback = state.options.positions[0] || "과원";
    state.users.forEach((user) => {
      if (user.position === value) {
        user.position = fallback;
        syncProfileToSupabase(user);
      }
    });
  }
  saveState();
  renderAll();
}

function exportCsv() {
  const header = ["프로젝트명", "업무분류", "진행", "담당자", "발주 부서", "시작일자", "촬영일자", "1차 완성", "최종 출고일자", "진행률", "총예산", "집행액"];
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



let mobileActiveSection = viewPref("mobileStartSection", "tasks");
let mobileTaskFilter = viewPref("mobileTaskFilter", "all");
let mobileTaskSort = viewPref("mobileTaskSort", taskOverviewSort);
let mobileTaskHideDone = viewPref("mobileTaskHideDone", true);
let mobileTaskOwner = viewPref("mobileTaskOwner", "");
let mobileTaskSortOpen = false;
let mobileTaskOwnerFilterOpen = false;
let mobileTaskDetailRef = null;
let mobileProjectSortOpen = false;
let mobileAddMode = "";
let mobileMoreRoute = viewPref("mobileMoreRoute", "more");
let mobileMoreHistory = [];
let mobileOrganizationSearch = "";
let mobileOrganizationIncludeInactive = false;
let mobileProfileDirty = false;
let mobileProfileUploading = false;
let mobileProfileUploadMessage = "";
let mobilePendingAvatarBlob = null;
let mobilePendingAvatarUrl = "";
let mobileEdgeSwipe = null;
let mobileOrganizationLoading = false;
let mobileOrganizationError = "";
let mobileOrganizationNotice = "";
let mobileOrganizationSearchTimer = null;
let mobileOptionDrag = null;
let mobilePreviousSection = "tasks";
let mobileTouchActivation = null;
let mobileStudioViewMode = viewPref("mobileStudioViewMode", "day");
let mobileStudioDate = viewPref("mobileStudioDate", dateKey(new Date()));
let mobileStudioFilterOpen = false;
let mobileStudioFilterDraft = null;
let mobileStudioUnassignedOnly = viewPref("mobileStudioUnassignedOnly", false);
let mobileStudioOwnerQuery = "";
let mobileStudioFormOpen = false;
let mobileStudioFormMode = "create";
let mobileStudioFormStep = 1;
let mobileStudioFormErrors = {};
let mobileStudioFormDraft = null;
let mobileStudioDetailId = "";
let mobileStudioDetailDraft = null;
let mobileStudioDetailDirty = false;
let mobileStudioDeleteConfirm = false;

function isMobileViewport() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function mobileTitleForView(view) {
  return { projects: "영상", works: "업무", tasks: "할 일", calendar: "캘린더", studio: "방송실 일정", board: "게시판", admin: "관리자", notifications: "알림", settings: "더보기" }[view] || "영상";
}

function unreadNotifications() {
  const user = currentUser();
  return (state.notifications || []).filter((item) => !item.read && (!item.userId || item.userId === user?.id));
}

function currentUserNotifications({ includeRead = notificationShowRead } = {}) {
  const user = currentUser();
  return (state.notifications || [])
    .filter((item) => (!item.userId || item.userId === user?.id) && (includeRead || !item.read))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function notificationDateGroup(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "이전 알림";
  const today = dateKey(new Date());
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const key = dateKey(date);
  if (key === today) return "오늘";
  if (key === dateKey(yesterdayDate)) return "어제";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function notificationTime(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function notificationCategoryClass(item) {
  const action = item.actionType || item.source?.action || "";
  if (action.includes("delete") || action.includes("removed")) return "danger";
  if (action.includes("record")) return "record";
  if (action.includes("task") && action.includes("complete")) return "complete";
  if (action.includes("task")) return "task";
  if (action.includes("studio") || action.includes("staff")) return "studio";
  if (action.includes("owner")) return "owner";
  if (action.includes("status")) return "status";
  return "content";
}

function notificationCategoryIcon(item) {
  return { danger: "×", record: "▤", complete: "✓", task: "✓", studio: "▣", owner: "♙", status: "▣", content: "▤" }[notificationCategoryClass(item)] || "•";
}

function renderNotificationItem(item) {
  const actor = item.actorName || "알림";
  const message = item.message || item.body || item.title || "새 알림이 있습니다.";
  const sourceLabel = item.parentType === "project" || item.sourceType === "project" ? "프로젝트"
    : item.parentType === "work" || item.sourceType === "work" ? "업무"
      : item.sourceType?.includes("task") ? "할 일"
        : item.sourceType === "staff" ? "방송실" : item.sourceType === "schedule" ? "일정" : "알림";
  return `
    <button class="notification-item ${item.read ? "is-read" : "is-unread"} type-${notificationCategoryClass(item)}" data-notification-id="${esc(item.id)}" type="button">
      <span class="notification-avatar">${esc(actor.slice(0, 1) || notificationCategoryIcon(item))}<i>${notificationCategoryIcon(item)}</i></span>
      <span class="notification-copy"><strong>${esc(item.title || "알림")}</strong><span>${esc(message)}</span><small>${esc(notificationTime(item.createdAt))} · ${esc(sourceLabel)}</small></span>
      ${item.read ? "" : '<i class="notification-unread-dot" aria-label="읽지 않음"></i>'}
    </button>
  `;
}

function renderNotificationGroups(items) {
  if (!items.length) return '<div class="notification-empty"><span>✓</span><strong>새 알림이 없습니다.</strong><small>담당 항목의 변경사항이 여기에 표시됩니다.</small></div>';
  const groups = new Map();
  items.forEach((item) => {
    const label = notificationDateGroup(item.createdAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  });
  return [...groups.entries()].map(([label, group]) => `<section class="notification-date-group"><h3>${esc(label)}</h3>${group.map(renderNotificationItem).join("")}</section>`).join("");
}

function renderNotificationSettings() {
  const user = currentUser();
  const settings = notificationSettingsForUser(user?.id || "");
  const labels = {
    all: "전체 알림",
    projectStatus: "프로젝트 상태 변경",
    projectContent: "프로젝트 내용 수정",
    ownerChange: "담당자 변경",
    record: "관리기록 추가·수정·삭제",
    task: "할 일 추가·수정·완료·삭제",
    work: "업무 상태 및 내용 변경",
    studio: "방송실 일정 변경",
    schedule: "일정 변경",
    system: "기타 시스템 알림"
  };
  return `
    <section class="notification-settings ${notificationSettingsOpen ? "open" : ""}">
      <header><h3>설정</h3><span>화면 및 알림 환경</span></header>
      <div class="notification-setting-section-title">화면</div>
      <label class="notification-theme-setting">
        <span><b>다크 모드</b><small>어두운 화면 테마를 사용합니다.</small></span>
        <input data-theme-setting type="checkbox" ${settings.darkMode ? "checked" : ""} />
        <i></i>
      </label>
      <div class="notification-setting-section-title">알림</div>
      ${Object.entries(labels).map(([key, label]) => `<label><span>${label}</span><input data-notification-setting="${key}" type="checkbox" ${settings[key] !== false ? "checked" : ""} /><i></i></label>`).join("")}
    </section>
  `;
}

function renderWebNotificationPopup() {
  const popup = $("#webNotificationPopup");
  if (!popup) return;
  const items = currentUserNotifications().slice(0, 8);
  popup.innerHTML = `
    <header><h3>알림</h3><div><button data-notification-read-all type="button">모두 읽음</button><button data-notification-clear-all type="button">모두 지우기</button><button data-notification-settings type="button" aria-label="설정">⚙</button></div></header>
    <div class="web-notification-list">${items.length ? items.map(renderNotificationItem).join("") : '<div class="notification-empty compact"><strong>새 알림이 없습니다.</strong></div>'}</div>
    <button class="web-notification-all" data-notification-open-center type="button">모든 알림 보기</button>
  `;
  popup.classList.toggle("open", webNotificationsOpen);
  popup.setAttribute("aria-hidden", String(!webNotificationsOpen));
  $("#webNotifyBtn")?.setAttribute("aria-expanded", String(webNotificationsOpen));
}

function renderNotificationCenter() {
  const settingsMode = notificationSettingsOpen;
  const items = currentUserNotifications();
  const card = $("#notificationCenterModal .notification-center-card");
  const title = $("#notificationCenterTitle");
  const eyebrow = $("#notificationCenterEyebrow");
  const description = $("#notificationCenterDescription");
  card?.classList.toggle("is-empty", !items.length && !settingsMode);
  card?.classList.toggle("is-settings", settingsMode);
  if (title) title.textContent = settingsMode ? "설정" : "알림";
  if (eyebrow) eyebrow.textContent = settingsMode ? "SETTINGS" : "NOTIFICATIONS";
  if (description) description.textContent = settingsMode ? "화면 테마와 알림 수신 항목을 관리합니다." : "업무 변경과 담당 항목의 새 소식을 확인합니다.";
  $("#notificationCenterModal [data-notification-settings]")?.classList.toggle("active", settingsMode);
  const list = $("#notificationCenterList");
  if (list) list.innerHTML = renderNotificationGroups(items);
  const settings = $("#notificationCenterSettings");
  if (settings) settings.innerHTML = notificationSettingsOpen ? renderNotificationSettings() : "";
  const showRead = $("[data-notification-show-read]");
  if (showRead) showRead.checked = notificationShowRead;
}

function renderNotificationSurfaces() {
  const count = unreadNotifications().length;
  const webCount = $("#webNotifyCount");
  if (webCount) {
    webCount.textContent = String(count);
    webCount.hidden = count === 0;
  }
  const mobileCount = $("#mobileNotifyCount");
  if (mobileCount) {
    mobileCount.textContent = String(count);
    mobileCount.hidden = count === 0;
  }
  renderWebNotificationPopup();
  renderNotificationCenter();
}

function renderMobileNotifications() {
  const items = currentUserNotifications();
  return `
    <div class="mobile-notification-page ${!items.length ? "is-empty" : ""}">
      <header class="mobile-notification-head">
        <button class="mobile-notification-close" data-mobile-notifications-close type="button" aria-label="알림 닫기">‹</button>
        <div class="mobile-notification-title">
          <h2>알림</h2>
        </div>
      </header>
      <div class="mobile-notification-controlbar">
        <div class="mobile-notification-bulk-actions">
          <button data-notification-read-all type="button">모두 읽음</button>
          <button data-notification-clear-all type="button">모두 지우기</button>
        </div>
        <label class="notification-show-read"><input data-notification-show-read type="checkbox" ${notificationShowRead ? "checked" : ""} /><span>읽은 알림</span></label>
      </div>
      <div class="mobile-notification-list">${renderNotificationGroups(items)}</div>
    </div>
  `;
}

function closeWebNotifications() {
  webNotificationsOpen = false;
  renderWebNotificationPopup();
}

function openNotificationCenter(open = true) {
  notificationCenterOpen = open;
  const modal = $("#notificationCenterModal");
  if (!modal) return;
  modal.classList.toggle("open", open);
  modal.setAttribute("aria-hidden", String(!open));
  if (open) renderNotificationCenter();
}

function markAllNotificationsRead() {
  const user = currentUser();
  let changed = false;
  (state.notifications || []).forEach((item) => {
    if ((!item.userId || item.userId === user?.id) && !item.read) {
      item.read = true;
      changed = true;
    }
  });
  if (changed) saveState();
  if (mobileActiveSection === "notifications") renderMobileDashboard();
  renderNotificationSurfaces();
  showToast("모든 알림을 읽음 처리했습니다.");
}

function openNotificationClearConfirm() {
  const modal = $("#notificationClearModal");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  setTimeout(() => $("#notificationClearCancelBtn")?.focus(), 0);
}

function closeNotificationClearConfirm() {
  const modal = $("#notificationClearModal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function clearCurrentUserNotifications() {
  const user = currentUser();
  state.notifications = (state.notifications || []).filter((item) => item.userId !== user?.id);
  saveState();
  closeNotificationClearConfirm();
  if (mobileActiveSection === "notifications") renderMobileDashboard();
  renderNotificationSurfaces();
  showToast("모든 알림을 삭제했습니다.");
}

function markNotificationRead(item) {
  if (!item || item.read) return;
  item.read = true;
  saveState();
  renderNotificationSurfaces();
}

let notificationTargetHighlightTimer = null;

function highlightNotificationElement(element, { scroll = true } = {}) {
  if (!element) return false;
  $$(".notification-target-highlight").forEach((target) => target.classList.remove("notification-target-highlight"));
  clearTimeout(notificationTargetHighlightTimer);
  element.classList.remove("notification-target-highlight");
  void element.offsetWidth;
  element.classList.add("notification-target-highlight");
  if (scroll) element.scrollIntoView({ block: "center", behavior: "smooth" });
  notificationTargetHighlightTimer = setTimeout(() => element.classList.remove("notification-target-highlight"), 2800);
  return true;
}

function highlightProjectOrWorkNotification({ scope, tab = "basic", targetId = "" }) {
  requestAnimationFrame(() => {
    const isWork = scope === "work";
    const detail = isWork ? $("#workDetail .detail-page") : $("#projectDetail .detail-page");
    const panelIds = isWork
      ? { basic: "#workDetailBasicTab", tasks: "#workDetailTasksTab", records: "#workDetailRecordsTab", studio: "#workDetailStudioTab" }
      : { basic: "#detailBasicTab", tasks: "#detailTasksTab", records: "#detailRecordsTab" };
    const targetSelector = targetId
      ? tab === "tasks"
        ? `[data-notification-${isWork ? "work-" : "project-"}task="${CSS.escape(targetId)}"]`
        : tab === "records"
          ? `[data-notification-${isWork ? "work-" : "project-"}record="${CSS.escape(targetId)}"]`
          : ""
      : "";
    const target = targetSelector ? $(targetSelector) : null;
    highlightNotificationElement(target || $(panelIds[tab] || panelIds.basic) || detail, { scroll: Boolean(target || tab !== "basic") });
  });
}

function openNotificationTarget(item) {
  if (!item) return;
  markNotificationRead(item);
  closeWebNotifications();
  openNotificationCenter(false);
  openMobileMoreSheet(false);
  const sourceType = item.sourceType || item.source?.type || "";
  const projectId = item.parentType === "project" ? item.parentId : item.source?.projectId || (sourceType === "project" ? item.sourceId : "");
  const workId = item.parentType === "work" ? item.parentId : item.source?.workId || (sourceType === "work" ? item.sourceId : "");
  const targetId = item.subTargetId || item.source?.taskId || "";
  const targetTab = item.targetTab || "basic";
  if (projectId) {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (!project) return showToast("해당 항목이 삭제되었거나 더 이상 존재하지 않습니다.");
    mobileActiveSection = "projects";
    setView("projects");
    if (targetTab === "tasks" && targetId) highlightedProjectTaskId = targetId;
    if (targetTab === "tasks" && targetId) detailTaskHideDone = false;
    if (targetTab === "records" && targetId) {
      recordFilterMode = "all";
      recordSearchQuery = "";
    }
    openProjectDetail(projectId, targetTab, () => {
      highlightProjectOrWorkNotification({ scope: "project", tab: targetTab, targetId });
      if (targetTab === "tasks" && targetId) clearTaskHighlight("project");
    });
    return;
  }
  if (workId) {
    const work = state.works.find((entry) => entry.id === workId);
    if (!work) return showToast("해당 항목이 삭제되었거나 더 이상 존재하지 않습니다.");
    mobileActiveSection = "works";
    setView("works");
    if (targetTab === "tasks" && targetId) {
      highlightedWorkTaskId = targetId;
      workTaskHideDone = false;
    }
    if (targetTab === "records" && targetId) {
      workRecordFilterMode = "all";
      workRecordSearchQuery = "";
    }
    openWorkDetail(workId, targetTab, () => {
      highlightProjectOrWorkNotification({ scope: "work", tab: targetTab, targetId });
      if (targetTab === "tasks" && targetId) clearTaskHighlight("work");
    });
    return;
  }
  if (sourceType === "schedule") {
    const schedule = state.schedules.find((entry) => entry.id === (item.sourceId || item.source?.id));
    if (!schedule) return showToast("해당 항목이 삭제되었거나 더 이상 존재하지 않습니다.");
    selectedCalendarDate = item.eventDate || schedule.date;
    calendarDate = new Date(`${selectedCalendarDate}T00:00:00`);
    mobileActiveSection = "calendar";
    setView("calendar");
    renderAll();
    openScheduleEventDetail(schedule.id);
    return;
  }
  if (sourceType === "staff" || sourceType.includes("studio")) {
    const staffEventId = item.staffEventId || item.sourceId || item.source?.staffEventId || item.source?.id;
    const staffEvent = state.staffEvents.find((entry) => entry.id === staffEventId);
    if (!staffEvent) return showToast("해당 항목이 삭제되었거나 더 이상 존재하지 않습니다.");
    if (isMobileViewport()) {
      mobileActiveSection = "studio";
      mobileStudioDate = staffEvent.date || mobileStudioDate;
      saveViewPrefs({ mobileStudioDate });
      setView("studio");
      openMobileStudioDetail(staffEvent.id);
      requestAnimationFrame(() => highlightNotificationElement($(".mobile-studio-detail .mobile-studio-summary") || $(".mobile-studio-detail")));
      return;
    }
    setView("studio");
    openStaffEventDetail(staffEvent.id);
    requestAnimationFrame(() => highlightNotificationElement($("#staffEventDetailContent") || $("#staffEventDetailModal .modal-card")));
    return;
  }
  if (sourceType === "board") {
    const postId = item.sourceId || item.source?.postId;
    if (!(state.boardPosts || []).some((post) => post.id === postId && !post.deletedAt)) return showToast("해당 항목이 삭제되었거나 더 이상 존재하지 않습니다.");
    setView("board");
    openBoardDetail(postId);
    return;
  }
  showToast("해당 항목이 삭제되었거나 더 이상 존재하지 않습니다.");
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

const mobileProjectSortOptions = [
  [{ key: "finalDate", direction: "asc" }, "마감일 빠른 순"],
  [{ key: "finalDate", direction: "desc" }, "마감일 늦은 순"],
  [{ key: "createdAt", direction: "desc" }, "최신순"],
  [{ key: "title", direction: "asc" }, "프로젝트명순"]
];

function mobileProjectSortLabel() {
  const option = mobileProjectSortOptions.find(([value]) => value.key === projectSort.key && value.direction === projectSort.direction);
  return option?.[1] || "마감일 빠른 순";
}

function projectSortValue(project, key) {
  if (key === "status") return state.options.statuses.indexOf(project.status);
  if (key === "createdAt") return project.createdAt || project.id || "";
  return project[key] || "";
}

function sortedMobileProjects() {
  return state.projects.filter((project) => !(projectHideDone && project.broadcastCompleted)).sort((a, b) => {
    const direction = projectSort.direction === "desc" ? -1 : 1;
    const aValue = projectSortValue(a, projectSort.key);
    const bValue = projectSortValue(b, projectSort.key);
    if (typeof aValue === "number" && typeof bValue === "number") return (aValue - bValue) * direction;
    return String(aValue).localeCompare(String(bValue), "ko") * direction;
  });
}

function mobileProjectStatusClass(status) {
  return statusClass(status);
}

function mobileProjectDueInfo(project) {
  const isDone = String(project.status || "").includes("완료") || String(project.status || "").includes("납품");
  if (isDone) return { label: "완료", className: "done" };
  if (!project.finalDate) return { label: "마감 없음", className: "none" };
  const diff = daysUntil(project.finalDate);
  if (diff < 0) return { label: "지연", className: "overdue" };
  if (diff === 0) return { label: "오늘", className: "today" };
  if (diff <= 6) return { label: `D-${diff}`, className: "soon" };
  return { label: `D-${diff}`, className: "safe" };
}

function renderMobileProjectSortSheet() {
  if (!mobileProjectSortOpen) return "";
  return `
    <div class="mobile-sort-backdrop" data-mobile-close-project-sort></div>
    <section class="mobile-sort-sheet">
      <i></i>
      <h3>정렬 방식</h3>
      ${mobileProjectSortOptions.map(([value, label]) => {
        const active = projectSort.key === value.key && projectSort.direction === value.direction;
        return `
          <button class="${active ? "active" : ""}" data-mobile-project-sort-key="${esc(value.key)}" data-mobile-project-sort-direction="${esc(value.direction)}" type="button">
            <span></span>
            ${esc(label)}
            ${active ? "<b>✓</b>" : ""}
          </button>
        `;
      }).join("")}
    </section>
  `;
}

function renderMobileKpiStrip() {
  return `<div class="mobile-kpi-strip">${mobileKpis().map(([label, value]) => `<article><span>${esc(label)}</span><b>${value}</b></article>`).join("")}</div>`;
}

function renderMobileProjectCards() {
  const projects = sortedMobileProjects();
  const activeProjects = state.projects.filter((project) => mobileProjectDueInfo(project).className !== "done");
  const dueSoonCount = activeProjects.filter((project) => ["soon", "today"].includes(mobileProjectDueInfo(project).className)).length;
  const overdueCount = activeProjects.filter((project) => mobileProjectDueInfo(project).className === "overdue").length;
  return `
    <section class="mobile-video-summary-card">
      <div>
        <span>VIDEO</span>
        <strong>${activeProjects.length}개의 진행 프로젝트</strong>
        <small>제작 상태와 주요 마감 일정을 확인하세요.</small>
      </div>
      <div>
        <span><small>임박</small><b>${dueSoonCount}</b></span>
        <span><small>지연</small><b>${overdueCount}</b></span>
      </div>
    </section>
    <div class="mobile-project-toolbar">
      <button class="mobile-project-sort ${mobileProjectSortOpen ? "active" : ""}" data-mobile-open-project-sort type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 4v14"></path><path d="M5 15l3 3 3-3"></path>
          <path d="M16 20V6"></path><path d="M13 9l3-3 3 3"></path>
        </svg>
        <span>${esc(mobileProjectSortLabel())}</span>
        <i>⌄</i>
      </button>
      <label class="mobile-hide-done-toggle">
        <span>완료</span>
        <input data-mobile-show-completed-projects type="checkbox" ${!projectHideDone ? "checked" : ""} />
        <b></b>
      </label>
    </div>
    <div class="mobile-section-head mobile-project-head"><span>총 ${projects.length}건</span></div>
    <div class="mobile-card-list mobile-project-list">
      ${projects.length ? projects.map((project) => {
        const due = mobileProjectDueInfo(project);
        const statusClassName = mobileProjectStatusClass(project.status);
        return `
          <button class="mobile-project-card" data-mobile-open-project="${esc(project.id)}" type="button">
            <i class="mobile-project-accent ${statusClassName}" aria-hidden="true"></i>
            <div class="mobile-project-main">
              <strong>${esc(project.title || "제목 없음")}</strong>
              <div class="mobile-project-compact-meta">
                <span class="mobile-project-status ${statusClassName} ${optionColorClass("statuses", project.status)}"${optionColorAttributes("statuses", project.status)}>${esc(mobileStatusText(project.status))}</span>
                <span title="${esc(mobileOwnersText(projectOwners(project)))}">${esc(mobileOwnersText(projectOwners(project)))}</span>
                <span title="${esc(project.client || "-")}">${esc(project.client || "-")}</span>
                <span class="mobile-project-deadline ${esc(due.className)}">${project.finalDate ? esc(formatDate(project.finalDate)) : "마감 없음"}</span>
                <i>›</i>
              </div>
            </div>
          </button>
        `;
      }).join("") : `<div class="empty">${projectHideDone && state.projects.some((project) => project.broadcastCompleted) ? "방영완료 항목 표시를 켜면 확인할 수 있습니다." : "등록된 프로젝트가 없습니다."}</div>`}
    </div>
    ${renderMobileProjectSortSheet()}
  `;
}

const mobileWorkSortOptions = [
  [{ key: "finalDate", direction: "asc" }, "마감일 빠른 순"],
  [{ key: "finalDate", direction: "desc" }, "마감일 늦은 순"],
  [{ key: "kickoffDate", direction: "asc" }, "시작일 빠른 순"],
  [{ key: "status", direction: "asc" }, "진행 상태 순"],
  [{ key: "title", direction: "asc" }, "업무명 순"]
];

function mobileWorkSortLabel() {
  const option = mobileWorkSortOptions.find(([value]) => value.key === workSort.key && value.direction === workSort.direction);
  return option?.[1] || "마감일 빠른 순";
}

function mobileWorkSortValue(work, key) {
  if (key === "status") return state.options.workStatuses.indexOf(work.status);
  if (work.noSchedule && ["kickoffDate", "finalDate"].includes(key)) return "9999-12-31";
  return work[key] || "";
}

function sortedMobileWorks() {
  return state.works
    .filter((work) => !(workHideDone && work.status === "완료"))
    .sort((a, b) => {
      const direction = workSort.direction === "desc" ? -1 : 1;
      const aValue = mobileWorkSortValue(a, workSort.key);
      const bValue = mobileWorkSortValue(b, workSort.key);
      if (typeof aValue === "number" && typeof bValue === "number") return (aValue - bValue) * direction;
      return String(aValue).localeCompare(String(bValue), "ko") * direction;
    });
}

function mobileWorkDueInfo(work) {
  if (work.status === "완료") return { label: "완료", className: "done" };
  if (work.noSchedule || !work.finalDate) return { label: "일정 없음", className: "none" };
  const diff = daysUntil(work.finalDate);
  if (diff < 0) return { label: "지연", className: "overdue" };
  if (diff === 0) return { label: "오늘", className: "today" };
  if (diff <= 6) return { label: `D-${diff}`, className: "soon" };
  return { label: `D-${diff}`, className: "safe" };
}

function renderMobileWorkSortSheet() {
  if (!mobileWorkSortOpen) return "";
  return `
    <div class="mobile-sort-backdrop" data-mobile-close-work-sort></div>
    <section class="mobile-sort-sheet mobile-work-sort-sheet">
      <i></i>
      <h3>정렬 방식</h3>
      ${mobileWorkSortOptions.map(([value, label]) => {
        const active = workSort.key === value.key && workSort.direction === value.direction;
        return `
          <button class="${active ? "active" : ""}" data-mobile-work-sort-key="${esc(value.key)}" data-mobile-work-sort-direction="${esc(value.direction)}" type="button">
            <span></span>
            ${esc(label)}
            ${active ? "<b>✓</b>" : ""}
          </button>
        `;
      }).join("")}
    </section>
  `;
}

function renderMobileWorkCards() {
  const works = sortedMobileWorks();
  const activeWorks = state.works.filter((work) => work.status !== "완료");
  const dueSoonCount = activeWorks.filter((work) => ["soon", "today"].includes(mobileWorkDueInfo(work).className)).length;
  const overdueCount = activeWorks.filter((work) => mobileWorkDueInfo(work).className === "overdue").length;
  return `
    <section class="mobile-work-summary-card">
      <div>
        <span>WORK</span>
        <strong>${activeWorks.length}개의 진행 업무</strong>
        <small>담당 업무와 주요 마감 일정을 확인하세요.</small>
      </div>
      <div>
        <span><small>임박</small><b>${dueSoonCount}</b></span>
        <span><small>지연</small><b>${overdueCount}</b></span>
      </div>
    </section>
    <div class="mobile-work-toolbar">
      <button class="mobile-work-sort ${mobileWorkSortOpen ? "active" : ""}" data-mobile-open-work-sort type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 4v14"></path><path d="M5 15l3 3 3-3"></path>
          <path d="M16 20V6"></path><path d="M13 9l3-3 3 3"></path>
        </svg>
        <span>${esc(mobileWorkSortLabel())}</span>
        <i>⌄</i>
      </button>
      <label class="mobile-hide-done-toggle">
        <span>완료</span>
        <input data-mobile-show-completed-works type="checkbox" ${!workHideDone ? "checked" : ""} />
        <b></b>
      </label>
    </div>
    <div class="mobile-section-head mobile-work-head"><span>총 ${works.length}건</span></div>
    <div class="mobile-card-list mobile-work-list">
      ${works.length ? works.map((work) => {
        const due = mobileWorkDueInfo(work);
        const statusClassName = mobileWorkStatusClass(work.status);
        return `
          <button class="mobile-work-card" data-mobile-open-work="${esc(work.id)}" type="button">
            <i class="mobile-work-accent ${statusClassName}" aria-hidden="true"></i>
            <div class="mobile-work-main">
              <strong>${esc(work.title || "제목 없음")}</strong>
              <div class="mobile-work-compact-meta">
                <span class="mobile-work-status ${statusClassName} ${optionColorClass("workStatuses", work.status)}"${optionColorAttributes("workStatuses", work.status)}>${esc(mobileStatusText(work.status))}</span>
                <span title="${esc(mobileOwnersText(workOwners(work)))}">${esc(mobileOwnersText(workOwners(work)))}</span>
                <span title="${esc(work.client || "-")}">${esc(work.client || "-")}</span>
                <span class="mobile-work-deadline ${esc(due.className)}">${work.noSchedule || !work.finalDate ? "일정 없음" : esc(formatDate(work.finalDate))}</span>
              </div>
            </div>
            <span class="mobile-work-due-chip ${esc(due.className)}">${esc(due.label)}</span>
          </button>
        `;
      }).join("") : `<div class="empty">${workHideDone && state.works.some((work) => work.status === "완료") ? "완료 스위치를 켜면 완료된 업무를 볼 수 있습니다." : "등록된 업무가 없습니다."}</div>`}
    </div>
    ${renderMobileWorkSortSheet()}
  `;
}

function mobileWorkStatusClass(status) {
  const index = state.options.workStatuses.indexOf(status);
  const lastIndex = Math.max(state.options.workStatuses.length - 1, 1);
  const stage = Math.max(0, Math.min(5, Math.round((Math.max(index, 0) / lastIndex) * 5)));
  return `stage-${stage}`;
}

function mobileFilteredTasks() {
  const today = mobileTodayKey();
  const week = mobileWeekLimitKey();
  const allItems = taskOverviewItems();
  if (!["all", "today", "overdue", "week"].includes(mobileTaskFilter)) mobileTaskFilter = "all";
  mobileTaskSort = normalizeTaskSort(mobileTaskSort);
  const matchingItems = allItems.filter((item) => {
    const due = item.task.dueDate || "";
    if (mobileTaskOwner && !taskOwners(item.task).includes(mobileTaskOwner)) return false;
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
  const sourceLabel = item.source === "project" ? "영상" : "업무";
  return `
    <article class="mobile-task-card ${item.task.done ? "is-done" : ""}" data-mobile-task-card="${esc(item.id)}" data-mobile-open-task-source="${esc(item.source)}" data-mobile-open-task-id="${esc(item.id)}">
      <input class="mobile-task-check" type="checkbox" data-overview-task-source="${esc(item.source)}" data-overview-task-check="${esc(item.id)}" ${item.task.done ? "checked" : ""} ${item.canManage ? "" : "disabled"} />
      <button class="mobile-task-open" type="button">
        <span class="mobile-task-card-meta"><em>${esc(sourceLabel)}</em></span>
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

function renderMobileOwnerFilterSheet() {
  if (!mobileTaskOwnerFilterOpen) return "";
  const owners = ownerOptions();
  return `
    <div class="mobile-sort-backdrop" data-mobile-close-owner-filter></div>
    <section class="mobile-sort-sheet mobile-owner-chip-sheet">
      <i></i>
      <h3>담당자 필터</h3>
      <div class="mobile-owner-chip-grid">
        <button class="${!mobileTaskOwner ? "active" : ""}" data-mobile-task-owner="" type="button">전체</button>
        ${owners.map((ownerId) => `
          <button class="${mobileTaskOwner === ownerId ? "active" : ""}" data-mobile-task-owner="${esc(ownerId)}" type="button">${esc(ownerOptionLabel(ownerId))}</button>
        `).join("")}
      </div>
    </section>
  `;
}

function mobileTaskItem(source, taskId) {
  return taskOverviewItems().find((item) => item.source === source && item.id === taskId) || null;
}

function closeMobileTaskDetail() {
  mobileTaskDetailRef = null;
  renderMobileDashboard();
}

function openMobileTaskDetail(source, taskId) {
  const item = mobileTaskItem(source, taskId);
  if (!item) return;
  mobileTaskDetailRef = { source, taskId };
  mobileTaskSortOpen = false;
  mobileTaskOwnerFilterOpen = false;
  renderMobileDashboard();
}

function openMobileTaskParent(source, taskId) {
  const item = mobileTaskItem(source, taskId);
  if (!item) return;
  mobileTaskDetailRef = null;
  mobileTaskSortOpen = false;
  mobileTaskOwnerFilterOpen = false;
  if (item.source === "project") {
    const project = state.projects.find((entry) => entry.id === item.sourceId);
    if (!project) return showToast("연결된 영상을 찾을 수 없습니다.");
    mobileActiveSection = "projects";
    setView("projects");
    highlightedProjectTaskId = item.id;
    openProjectDetail(item.sourceId, "tasks", () => {
      highlightProjectOrWorkNotification({ scope: "project", tab: "tasks", targetId: item.id });
      clearTaskHighlight("project");
    });
    return;
  }
  const work = state.works.find((entry) => entry.id === item.sourceId);
  if (!work) return showToast("연결된 업무를 찾을 수 없습니다.");
  mobileActiveSection = "works";
  setView("works");
  highlightedWorkTaskId = item.id;
  workTaskHideDone = false;
  openWorkDetail(item.sourceId, "tasks", () => {
    highlightProjectOrWorkNotification({ scope: "work", tab: "tasks", targetId: item.id });
    clearTaskHighlight("work");
  });
}

function mobileSelectValue(name, options, selected = "", placeholder = "선택") {
  return `
    <select name="${name}">
      <option value="">${esc(placeholder)}</option>
      ${options.map((option) => `<option value="${esc(option)}" ${option === selected ? "selected" : ""}>${esc(option)}</option>`).join("")}
    </select>
  `;
}

function renderMobileTaskDetail() {
  if (!mobileTaskDetailRef) return "";
  const item = mobileTaskItem(mobileTaskDetailRef.source, mobileTaskDetailRef.taskId);
  if (!item) {
    mobileTaskDetailRef = null;
    return "";
  }
  const task = item.task;
  const editable = item.canManage;
  const dueDate = task.dueDate || dateKey(new Date());
  return `
    <div class="mobile-task-detail-layer" role="dialog" aria-modal="true" aria-label="할 일 상세">
      <button class="mobile-task-detail-backdrop" data-mobile-task-detail-close type="button" aria-label="닫기"></button>
      <form class="mobile-task-detail-card" data-mobile-task-detail-form>
        <header>
          <button data-mobile-task-detail-close type="button" aria-label="할 일 상세 닫기">×</button>
          <div><span>TASK</span><strong>${editable ? "할 일 수정" : "할 일 상세"}</strong></div>
          <b class="mobile-dday-badge ${esc(taskDdayInfo(item).className)}">${esc(taskDdayInfo(item).label)}</b>
        </header>
        <div class="mobile-task-detail-body">
          <section class="mobile-task-detail-parent">
            <span>${esc(item.sourceLabel)}</span>
            <strong>${esc(item.sourceTitle)}</strong>
          </section>
          <section>
            <h3>기본정보</h3>
            <label>할 일 제목 <b>*</b><input name="title" value="${esc(task.text || "")}" placeholder="할 일 제목" required ${editable ? "" : "disabled"} /></label>
            <label>업무 분류${mobileSelectValue("type", taskTypeOptions(), task.type || "", "업무 분류 선택").replace("<select", `<select ${editable ? "" : "disabled"}`)}</label>
          </section>
          <section>
            <h3>담당자</h3>
            ${mobileOwnerCheckboxes("owners", taskOwners(task)).replaceAll("<input ", `<input ${editable ? "" : "disabled"} `)}
          </section>
          <section class="mobile-task-date-section">
            <h3>일정</h3>
            <label>마감일<input name="dueDate" type="date" value="${esc(dueDate)}" ${editable ? "" : "disabled"} /></label>
            <div class="mobile-task-option-grid">
              <label class="mobile-toggle-line"><input name="noDueDate" type="checkbox" ${task.noDueDate || !task.dueDate ? "checked" : ""} ${editable ? "" : "disabled"} /> 마감일 없음</label>
              <label class="mobile-toggle-line"><input name="allDay" type="checkbox" ${task.allDay !== false ? "checked" : ""} ${editable ? "" : "disabled"} /> 종일</label>
              <label class="mobile-toggle-line"><input name="calendar" type="checkbox" ${task.calendar !== false ? "checked" : ""} ${editable ? "" : "disabled"} /> 캘린더 등록</label>
            </div>
            <div class="mobile-time-row"><label>시작<input name="startTime" type="time" step="600" value="${esc(task.startTime || "09:00")}" ${editable ? "" : "disabled"} /></label><span>~</span><label>종료<input name="endTime" type="time" step="600" value="${esc(task.endTime || "10:00")}" ${editable ? "" : "disabled"} /></label></div>
          </section>
          <section>
            <h3>세부내용</h3>
            <textarea name="detail" placeholder="세부내용을 입력하세요." ${editable ? "" : "disabled"}>${esc(task.detail || "")}</textarea>
          </section>
          ${editable ? `<button class="mobile-task-delete-button" data-mobile-task-delete type="button">할 일 삭제</button>` : ""}
        </div>
        <footer>
          <button data-mobile-task-detail-close type="button">${editable ? "취소" : "닫기"}</button>
          ${editable ? '<button class="primary" type="submit">변경사항 저장</button>' : ""}
        </footer>
      </form>
    </div>
  `;
}

function saveMobileTaskDetail(form) {
  if (!mobileTaskDetailRef) return;
  const item = mobileTaskItem(mobileTaskDetailRef.source, mobileTaskDetailRef.taskId);
  if (!item || !item.canManage) return showToast("담당자 또는 관리자만 할 일을 변경할 수 있습니다.");
  const data = new FormData(form);
  const previousOwners = taskOwners(item.task);
  const owners = mobileFormOwners(form);
  item.task.text = String(data.get("title") || "").trim() || "새 할 일";
  item.task.detail = String(data.get("detail") || "");
  item.task.type = String(data.get("type") || "");
  item.task.owners = owners;
  item.task.owner = owners[0] || "";
  item.task.noDueDate = Boolean(data.get("noDueDate"));
  item.task.dueDate = item.task.noDueDate ? "" : String(data.get("dueDate") || dateKey(new Date()));
  item.task.allDay = Boolean(data.get("allDay"));
  item.task.startTime = String(data.get("startTime") || "09:00");
  item.task.endTime = String(data.get("endTime") || "10:00");
  item.task.calendar = item.task.noDueDate ? false : Boolean(data.get("calendar"));
  const parent = item.source === "project"
    ? state.projects.find((project) => project.id === item.sourceId)
    : state.works.find((work) => work.id === item.sourceId);
  const parentOwners = parent ? (item.source === "project" ? projectOwners(parent) : workOwners(parent)) : [];
  notifyOwners(uniqueValues([...previousOwners, ...owners, ...parentOwners]), `${notificationActor().name}님이 ‘${item.sourceTitle}’의 할 일 ‘${item.task.text}’을 수정했습니다.`, {
    type: item.source === "project" ? "project-task" : "work-task",
    projectId: item.source === "project" ? item.sourceId : undefined,
    workId: item.source === "work" ? item.sourceId : undefined,
    taskId: item.id,
    actionType: item.source === "project" ? "project_task_updated" : "work_task_updated",
    title: "할 일 수정",
    targetTab: "tasks"
  });
  saveState();
  mobileTaskDetailRef = null;
  showToast("할 일이 수정되었습니다.");
  renderAll();
}

function deleteMobileTaskDetail() {
  if (!mobileTaskDetailRef) return;
  const item = mobileTaskItem(mobileTaskDetailRef.source, mobileTaskDetailRef.taskId);
  if (!item || !item.canManage) return showToast("담당자 또는 관리자만 할 일을 삭제할 수 있습니다.");
  confirmDelete(() => {
    notifyTaskDeletion(item.source, item.task);
    if (item.source === "project") {
      state.tasks = state.tasks.filter((task) => task.id !== item.id);
    } else {
      const work = state.works.find((entry) => entry.id === item.sourceId);
      if (work) work.tasks = (work.tasks || []).filter((task) => task.id !== item.id);
    }
    mobileTaskDetailRef = null;
    saveState();
    showToast("할 일이 삭제되었습니다.");
    renderAll();
  });
}

function renderMobileTasks() {
  const { allItems, matchingItems, visibleItems } = mobileFilteredTasks();
  const filters = [["all", "전체"], ["today", "오늘"], ["overdue", "지연"], ["week", "이번주"]];
  const emptyMessage = mobileTaskEmptyMessage(matchingItems.length, visibleItems.length);
  const openItems = allItems.filter((item) => !item.task.done);
  const todayKey = mobileTodayKey();
  const todayCount = openItems.filter((item) => item.task.dueDate === todayKey).length;
  const overdueCount = openItems.filter((item) => item.task.dueDate && item.task.dueDate < todayKey).length;
  return `
    <div class="mobile-task-page">
      <section class="mobile-task-summary-card">
        <div><span>TASKS</span><strong>${openItems.length}개의 미완료 할 일</strong><small>마감 일정과 담당 업무를 한눈에 확인하세요.</small></div>
        <div><span><small>오늘</small><b>${todayCount}</b></span><span><small>지연</small><b>${overdueCount}</b></span></div>
      </section>
      <div class="mobile-filter-chips">
        ${filters.map(([key, label]) => `<button class="${mobileTaskFilter === key ? "active" : ""}" data-mobile-task-filter="${key}" type="button">${label}</button>`).join("")}
      </div>
      <div class="mobile-task-tools">
        <button class="mobile-sort-trigger icon-only ${mobileTaskSortOpen ? "active" : ""}" data-mobile-open-sort type="button" aria-label="정렬">
          <svg class="mobile-sort-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 4v14"></path>
            <path d="M5 15l3 3 3-3"></path>
            <path d="M16 20V6"></path>
            <path d="M13 9l3-3 3 3"></path>
          </svg>
        </button>
        <button class="mobile-owner-filter-trigger ${mobileTaskOwnerFilterOpen || mobileTaskOwner ? "active" : ""}" data-mobile-open-owner-filter type="button" aria-label="담당자 필터">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16"></path><path d="M7 12h10"></path><path d="M10 18h4"></path></svg>
          ${mobileTaskOwner ? `<small>${esc(ownerOptionLabel(mobileTaskOwner))}</small>` : ""}
        </button>
        <label class="mobile-hide-done-toggle">
          <span>완료</span>
          <input data-mobile-hide-done type="checkbox" ${!mobileTaskHideDone ? "checked" : ""} />
          <b></b>
        </label>
      </div>
      <div class="mobile-card-list mobile-task-list">
        ${visibleItems.length ? visibleItems.map(renderMobileTaskCard).join("") : `<div class="mobile-task-empty"><div>✓</div><strong>${esc(emptyMessage)}</strong><span>새 할 일을 추가하거나 다른 필터를 확인해보세요.</span></div>`}
      </div>
      ${renderMobileSortSheet()}
      ${renderMobileOwnerFilterSheet()}
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

const mobileCalendarSources = [
  ["project", "영상"],
  ["work", "업무"],
  ["task", "할 일"],
  ["staff", "방송실"],
  ["schedule", "일반"]
];

function mobileCalendarSourceKey(source) {
  if (["projectTask", "workTask"].includes(source)) return "task";
  return source;
}

function mobileCalendarSourceLabel(source) {
  const key = mobileCalendarSourceKey(source);
  return mobileCalendarSources.find(([value]) => value === key)?.[1] || "일정";
}

function mobileCalendarFilterEnabled(filters, key) {
  return !Object.prototype.hasOwnProperty.call(filters || {}, key) || filters[key] !== false;
}

function mobileCalendarEventMatches(event, query = "") {
  const sourceKey = mobileCalendarSourceKey(event.source);
  if (!mobileCalendarFilterEnabled(calendarSourceFilters, sourceKey)) return false;
  if (!eventMatchesOwnerFilter(event.owners, calendarOwnerFilters)) return false;
  if (calendarRecurringFilter === "only" && !event.seriesId) return false;
  if (calendarRecurringFilter === "hide" && event.seriesId) return false;
  if (!calendarShowCompleted && event.completed) return false;
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase("ko");
  if (!normalizedQuery) return true;
  const searchable = [
    event.label,
    event.category,
    event.parentTitle,
    event.location,
    event.memo,
    ...ownerNames(event.owners || [])
  ].join(" ").toLocaleLowerCase("ko");
  return searchable.includes(normalizedQuery);
}

function mobileCalendarEventsForDate(key, query = "") {
  return sortCalendarEvents(allCalendarEventsForDate(key).filter((event) => mobileCalendarEventMatches(event, query)));
}

function mobileCalendarDateLabel(key, includeYear = false) {
  const date = new Date(`${key}T00:00:00`);
  return new Intl.DateTimeFormat("ko-KR", {
    ...(includeYear ? { year: "numeric" } : {}),
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(date);
}

function mobileCalendarCard(event, key) {
  const ownerText = mobileOwnersText(event.owners || []);
  const sourceKey = mobileCalendarSourceKey(event.source);
  return `
    <button class="mobile-calendar-event-card source-${esc(sourceKey)} ${event.completed ? "is-completed" : ""}"
      data-mobile-calendar-event
      data-event-source="${esc(event.source)}"
      data-event-id="${esc(event.id)}"
      data-project-id="${esc(event.projectId || "")}"
      data-work-id="${esc(event.workId || "")}"
      data-schedule-id="${esc(event.scheduleId || "")}"
      data-staff-event-id="${esc(event.staffEventId || "")}"
      data-mobile-calendar-date="${esc(key)}" type="button">
      <span class="mobile-calendar-event-time">${event.allDay === false ? esc(event.startTime || "시간 미정") : "종일"}${event.allDay === false && event.endTime ? `<small>${esc(event.endTime)}</small>` : ""}</span>
      <span class="mobile-calendar-event-body">
        <strong>${esc(event.label)}</strong>
        <span>${esc(event.category || mobileCalendarSourceLabel(event.source))} · 담당 ${esc(ownerText)}</span>
        ${event.location ? `<small>${esc(event.location)}</small>` : ""}
        <span class="mobile-calendar-event-chips"><i>${esc(mobileCalendarSourceLabel(event.source))}</i>${event.seriesId ? "<i>↻ 반복</i>" : ""}${event.completed ? "<i>완료</i>" : ""}</span>
      </span>
      <span class="mobile-calendar-event-arrow" aria-hidden="true">›</span>
    </button>
  `;
}

function renderMobileSelectedDateList(key = selectedCalendarDate) {
  const items = mobileCalendarEventsForDate(key);
  return `
    <section class="mobile-calendar-day-list" aria-live="polite">
      <header><h3>${esc(mobileCalendarDateLabel(key))}</h3><span>일정 ${items.length}개</span></header>
      <div class="mobile-calendar-event-list">
        ${items.length ? items.map((event) => mobileCalendarCard(event, key)).join("") : `
          <div class="mobile-calendar-empty">
            <strong>등록된 일정이 없습니다.</strong>
            <span>선택한 날짜에 새 일정을 등록할 수 있습니다.</span>
            <button data-mobile-calendar-add type="button">＋ 일정 추가</button>
          </div>
        `}
      </div>
    </section>
  `;
}

function renderMobileMonthCalendar() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const start = new Date(year, month, 1 - firstDay.getDay());
  return `
    <section class="mobile-month-calendar" data-mobile-calendar-swipe>
      <div class="mobile-month-weekdays"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>
      <div class="mobile-month-grid">
        ${Array.from({ length: 42 }, (_, index) => {
          const date = new Date(start);
          date.setDate(start.getDate() + index);
          const key = dateKey(date);
          const events = mobileCalendarEventsForDate(key);
          const dots = [...new Set(events.map((event) => mobileCalendarSourceKey(event.source)))].slice(0, 3);
          return `<button class="${date.getMonth() !== month ? "muted" : ""} ${key === mobileTodayKey() ? "today" : ""} ${key === selectedCalendarDate ? "selected" : ""}" data-mobile-month-date="${key}" type="button" aria-label="${esc(mobileCalendarDateLabel(key, true))}, 일정 ${events.length}개" aria-selected="${key === selectedCalendarDate}"><b>${date.getDate()}</b><span class="mobile-calendar-dots">${dots.map((source) => `<i class="source-${esc(source)}"></i>`).join("")}${events.length > 3 ? `<em>+${events.length - 3}</em>` : ""}</span></button>`;
        }).join("")}
      </div>
    </section>
  `;
}

function mobileCalendarMonthRange() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  return [dateKey(new Date(year, month, 1)), dateKey(new Date(year, month + 1, 0))];
}

function renderMobileCalendarListView(query = "") {
  const [from, to] = mobileCalendarMonthRange();
  const groups = [];
  for (let cursor = new Date(`${from}T00:00:00`); dateKey(cursor) <= to; cursor.setDate(cursor.getDate() + 1)) {
    const key = dateKey(cursor);
    const items = mobileCalendarEventsForDate(key, query);
    if (items.length) groups.push({ key, items });
  }
  return `<div class="mobile-calendar-month-list">${groups.length ? groups.map(({ key, items }) => `
    <section><header><h3>${esc(mobileCalendarDateLabel(key))}</h3><span>${items.length}개</span></header>${items.map((event) => mobileCalendarCard(event, key)).join("")}</section>
  `).join("") : `<div class="mobile-calendar-empty"><strong>${query ? "검색 결과가 없습니다." : "이번 달 일정이 없습니다."}</strong><span>필터를 변경하거나 새 일정을 등록해보세요.</span></div>`}</div>`;
}

function renderMobileWeekCalendar() {
  const selected = new Date(`${selectedCalendarDate}T00:00:00`);
  const start = new Date(selected);
  start.setDate(selected.getDate() - selected.getDay());
  return `
    <section class="mobile-week-calendar" data-mobile-calendar-swipe>
      ${Array.from({ length: 7 }, (_, index) => {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        const key = dateKey(date);
        const count = mobileCalendarEventsForDate(key).length;
        return `<button class="${key === selectedCalendarDate ? "selected" : ""} ${key === mobileTodayKey() ? "today" : ""}" data-mobile-month-date="${key}" type="button" aria-selected="${key === selectedCalendarDate}"><span>${["일", "월", "화", "수", "목", "금", "토"][index]}</span><b>${date.getDate()}</b>${count ? `<i>${count}</i>` : ""}</button>`;
      }).join("")}
    </section>
    ${renderMobileSelectedDateList()}
  `;
}

function mobileCalendarFilterCount() {
  let count = 0;
  if (!ownerFilterKeys().every((key) => ownerFilterEnabled(calendarOwnerFilters, key))) count += 1;
  if (!mobileCalendarSources.every(([key]) => mobileCalendarFilterEnabled(calendarSourceFilters, key))) count += 1;
  if (calendarRecurringFilter !== "include") count += 1;
  if (!calendarShowCompleted) count += 1;
  return count;
}

function cloneMobileCalendarFilters() {
  return {
    owners: { ...calendarOwnerFilters },
    sources: { ...calendarSourceFilters },
    recurring: calendarRecurringFilter,
    showCompleted: calendarShowCompleted
  };
}

function mobileFilterChip(label, key, selected, attribute) {
  return `<button class="${selected ? "selected" : ""}" ${attribute}="${esc(key)}" type="button"><span>${selected ? "✓" : ""}</span>${esc(label)}</button>`;
}

function renderMobileCalendarFilterSheet() {
  if (!mobileCalendarFilterOpen) return "";
  const draft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
  const owners = ownerFilterKeys();
  return `
    <div class="mobile-calendar-filter-sheet open" role="dialog" aria-modal="true" aria-label="캘린더 필터">
      <button class="mobile-calendar-filter-backdrop" data-mobile-calendar-filter-close type="button" aria-label="필터 닫기"></button>
      <section>
        <i class="mobile-sheet-handle"></i>
        <header><h2>필터</h2><button data-mobile-calendar-filter-reset type="button">초기화</button></header>
        <div class="mobile-calendar-filter-scroll">
          <fieldset><legend>담당자</legend><div class="mobile-calendar-filter-chips">
            ${mobileFilterChip("전체", "all", owners.every((key) => ownerFilterEnabled(draft.owners, key)), "data-mobile-calendar-filter-owner")}
            ${owners.map((key) => mobileFilterChip(ownerFilterLabel(key), key, ownerFilterEnabled(draft.owners, key), "data-mobile-calendar-filter-owner")).join("")}
          </div></fieldset>
          <fieldset><legend>일정 출처</legend><div class="mobile-calendar-filter-chips">
            ${mobileFilterChip("전체", "all", mobileCalendarSources.every(([key]) => mobileCalendarFilterEnabled(draft.sources, key)), "data-mobile-calendar-filter-source")}
            ${mobileCalendarSources.map(([key, label]) => mobileFilterChip(label, key, mobileCalendarFilterEnabled(draft.sources, key), "data-mobile-calendar-filter-source")).join("")}
          </div></fieldset>
          <fieldset><legend>반복 일정 표시</legend><div class="mobile-calendar-segmented">
            ${[["include", "포함"], ["only", "반복 일정만"], ["hide", "숨기기"]].map(([key, label]) => `<button class="${draft.recurring === key ? "selected" : ""}" data-mobile-calendar-filter-recurring="${key}" type="button">${label}</button>`).join("")}
          </div></fieldset>
          <label class="mobile-calendar-completed-toggle"><span><b>완료 일정 표시</b><small>완료된 프로젝트와 할 일을 목록에 포함합니다.</small></span><input data-mobile-calendar-filter-completed type="checkbox" ${draft.showCompleted ? "checked" : ""} /><i></i></label>
        </div>
        <footer><button data-mobile-calendar-filter-reset type="button">초기화</button><button data-mobile-calendar-filter-apply type="button">필터 적용</button></footer>
      </section>
    </div>
  `;
}

function renderMobileCalendar() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const selected = new Date(`${selectedCalendarDate}T00:00:00`);
  const weekStart = new Date(selected);
  weekStart.setDate(selected.getDate() - selected.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const weekTitle = weekStart.getMonth() === weekEnd.getMonth()
    ? `${weekStart.getMonth() + 1}월 ${weekStart.getDate()}일–${weekEnd.getDate()}일`
    : `${weekStart.getMonth() + 1}월 ${weekStart.getDate()}일–${weekEnd.getMonth() + 1}월 ${weekEnd.getDate()}일`;
  const periodTitle = mobileCalendarViewMode === "week" ? weekTitle : `${year}년 ${month + 1}월`;
  const periodUnit = mobileCalendarViewMode === "week" ? "주" : "달";
  const filterCount = mobileCalendarFilterCount();
  const searchView = mobileCalendarSearchOpen;
  const content = searchView
    ? renderMobileCalendarListView(mobileCalendarSearchQuery)
    : mobileCalendarViewMode === "list"
      ? renderMobileCalendarListView()
      : mobileCalendarViewMode === "week"
        ? renderMobileWeekCalendar()
        : `${renderMobileMonthCalendar()}${renderMobileSelectedDateList()}`;
  return `
    <div class="mobile-calendar-page ${searchView ? "is-searching" : ""}">
      <header class="mobile-calendar-toolbar">
        <div class="mobile-calendar-period">
          <button data-mobile-calendar-prev type="button" aria-label="이전 ${periodUnit}">‹</button>
          <label class="mobile-calendar-month-title"><span>${periodTitle}</span>${mobileCalendarViewMode === "week" ? "" : `<input data-mobile-calendar-month-picker type="month" value="${year}-${String(month + 1).padStart(2, "0")}" aria-label="월 선택" />`}</label>
          <button data-mobile-calendar-next type="button" aria-label="다음 ${periodUnit}">›</button>
        </div>
        <div class="mobile-calendar-actions">
          <button class="mobile-calendar-today" data-mobile-calendar-today type="button">오늘</button>
          <button class="mobile-calendar-icon ${searchView ? "active" : ""}" data-mobile-calendar-search-toggle type="button" aria-label="일정 검색"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg></button>
          <button class="mobile-calendar-icon ${filterCount ? "active" : ""}" data-mobile-calendar-filter-open type="button" aria-label="필터${filterCount ? ` ${filterCount}개 적용` : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"></path></svg>${filterCount ? `<b>${filterCount}</b>` : ""}</button>
          <button class="mobile-calendar-icon add" data-mobile-calendar-add type="button" aria-label="일정 추가">＋</button>
        </div>
      </header>
      ${searchView ? `<div class="mobile-calendar-search"><input data-mobile-calendar-search-input value="${esc(mobileCalendarSearchQuery)}" placeholder="제목, 담당자, 장소, 메모 검색" autocomplete="off" /><button data-mobile-calendar-search-close type="button">취소</button></div>` : ""}
      <div class="mobile-calendar-view-switch" aria-label="캘린더 보기 방식">
        ${[["month", "월간"], ["week", "주간"], ["list", "목록"]].map(([key, label]) => `<button class="${mobileCalendarViewMode === key ? "active" : ""}" data-mobile-calendar-view="${key}" type="button">${label}</button>`).join("")}
      </div>
      ${content}
      ${renderMobileCalendarFilterSheet()}
    </div>
  `;
}

function mobileStudioDateObject(value = mobileStudioDate) {
  const date = new Date(`${value || dateKey(new Date())}T00:00:00`);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function mobileStudioDateText(value, { short = false } = {}) {
  const date = mobileStudioDateObject(value);
  return new Intl.DateTimeFormat("ko-KR", short
    ? { month: "long", day: "numeric", weekday: "short" }
    : { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(date);
}

function mobileStudioMoveDate(direction) {
  const next = mobileStudioDateObject();
  if (mobileStudioViewMode === "month") next.setMonth(next.getMonth() + direction, 1);
  else next.setDate(next.getDate() + direction * (mobileStudioViewMode === "week" ? 7 : 1));
  mobileStudioDate = dateKey(next);
  saveViewPrefs({ mobileStudioDate });
  renderMobileDashboard();
}

function mobileStudioFilterCount() {
  let count = 0;
  if (!trainingTypeOptions().every((type) => studioTrainingFilterEnabled(type))) count += 1;
  if (!ownerFilterKeys().every((owner) => ownerFilterEnabled(studioOwnerFilters, owner))) count += 1;
  if (studioHideRecurring) count += 1;
  if (mobileStudioUnassignedOnly) count += 1;
  return count;
}

function cloneMobileStudioFilters() {
  return {
    types: { ...studioTrainingTypeFilters },
    owners: { ...studioOwnerFilters },
    hideRecurring: studioHideRecurring,
    unassignedOnly: mobileStudioUnassignedOnly
  };
}

function mobileStudioFilteredEvents() {
  return [...state.staffEvents]
    .filter((event) => studioTrainingFilterEnabled(event.trainingType || event.type || "기타"))
    .filter((event) => eventMatchesOwnerFilter(event.owners || [event.owner].filter(Boolean), studioOwnerFilters))
    .filter((event) => !(studioHideRecurring && event.seriesId))
    .filter((event) => !mobileStudioUnassignedOnly || needsStudioStaffAssignment(event))
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.startTime || "").localeCompare(String(b.startTime || "")));
}

function mobileStudioEventsOn(value) {
  return mobileStudioFilteredEvents().filter((event) => event.date === value);
}

function mobileStudioStaffSummary(event) {
  const rows = Array.isArray(event.staffRows) ? event.staffRows : [];
  const assigned = rows.filter((row) => row.type || row.owner);
  if (!assigned.length || needsStudioStaffAssignment(event)) return "스탭 미배정";
  return assigned.slice(0, 3).map((row) => `${row.type || "스탭"} ${ownerOptionLabel(row.owner) || "미배정"}`).join(" / ") + (assigned.length > 3 ? ` 외 ${assigned.length - 3}명` : "");
}

function renderMobileStudioEventCard(event) {
  const time = event.allDay !== false ? "종일" : `${event.startTime || "09:00"} ~ ${event.endTime || "10:00"}`;
  return `
    <button class="mobile-studio-event-card" data-mobile-studio-event="${esc(event.id)}" type="button" ${studioTypeStyle(event.trainingType || event.type)}>
      <i></i>
      <span class="mobile-studio-event-time">${esc(time)}</span>
      <span class="mobile-studio-event-copy">
        <strong>${esc(staffReservationTitle(event))}</strong>
        <small>${esc(event.trainingType || "기타")} · ${esc(event.room || "장소 미지정")}</small>
        <em>${esc(mobileStudioStaffSummary(event))}</em>
      </span>
      <span class="mobile-studio-event-chips">${event.seriesId ? "<b>↻ 반복</b>" : ""}${needsStudioStaffAssignment(event) ? "<b class=\"warning\">미배정</b>" : ""}</span>
      <span aria-hidden="true">›</span>
    </button>
  `;
}

function renderMobileStudioEmpty() {
  return `<div class="mobile-studio-empty"><span>▣</span><strong>등록된 방송실 일정이 없습니다.</strong><small>선택한 날짜에 새 일정을 등록할 수 있습니다.</small><button data-mobile-studio-create type="button">＋ 일정 등록</button></div>`;
}

function renderMobileStudioDateStrip() {
  const center = mobileStudioDateObject();
  return `<div class="mobile-studio-date-strip" data-horizontal-scroll>${Array.from({ length: 9 }, (_, index) => {
    const date = new Date(center);
    date.setDate(center.getDate() + index - 4);
    const key = dateKey(date);
    return `<button class="${key === mobileStudioDate ? "selected" : ""} ${key === dateKey(new Date()) ? "today" : ""}" data-mobile-studio-date="${key}" type="button"><span>${["일", "월", "화", "수", "목", "금", "토"][date.getDay()]}</span><b>${date.getDate()}</b></button>`;
  }).join("")}</div>`;
}

function renderMobileStudioDaily() {
  const events = mobileStudioEventsOn(mobileStudioDate);
  return `${renderMobileStudioDateStrip()}<section class="mobile-studio-day"><header><h3>${esc(mobileStudioDateText(mobileStudioDate, { short: true }))}</h3><span>예약 ${events.length}개</span></header><div>${events.length ? events.map(renderMobileStudioEventCard).join("") : renderMobileStudioEmpty()}</div></section>`;
}

function mobileStudioWeekStartDate() {
  const selected = mobileStudioDateObject();
  const start = new Date(selected);
  start.setDate(selected.getDate() - ((selected.getDay() + 6) % 7));
  return start;
}

function renderMobileStudioWeekly() {
  const start = mobileStudioWeekStartDate();
  return `<div class="mobile-studio-week-list">${Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = dateKey(date);
    const events = mobileStudioEventsOn(key);
    return `<section class="${key === mobileStudioDate ? "selected" : ""}"><button class="mobile-studio-week-date" data-mobile-studio-date-day="${key}" type="button"><span>${esc(mobileStudioDateText(key, { short: true }))}</span><b>${events.length}개</b><em>›</em></button><div>${events.length ? events.map(renderMobileStudioEventCard).join("") : "<p>등록된 일정 없음</p>"}</div></section>`;
  }).join("")}</div>`;
}

function renderMobileStudioMonthly() {
  const selected = mobileStudioDateObject();
  const year = selected.getFullYear();
  const month = selected.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return `<section class="mobile-studio-month"><div class="mobile-studio-month-weekdays">${["일", "월", "화", "수", "목", "금", "토"].map((day) => `<span>${day}</span>`).join("")}</div><div class="mobile-studio-month-grid">${Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = dateKey(date);
    const events = mobileStudioEventsOn(key);
    const dots = uniqueValues(events.map((event) => event.trainingType || event.type || "기타")).slice(0, 3);
    return `<button class="${date.getMonth() !== month ? "muted" : ""} ${key === mobileStudioDate ? "selected" : ""} ${key === dateKey(new Date()) ? "today" : ""}" data-mobile-studio-date-day="${key}" type="button" aria-label="${esc(mobileStudioDateText(key))}, 예약 ${events.length}개"><b>${date.getDate()}</b><span>${dots.map((type) => `<i ${studioTypeStyle(type)}></i>`).join("")}${events.length ? `<em>${events.length}</em>` : ""}${events.some(needsStudioStaffAssignment) ? "<strong>!</strong>" : ""}</span></button>`;
  }).join("")}</div></section>`;
}

function renderMobileStudioFilterSheet() {
  if (!mobileStudioFilterOpen) return "";
  const draft = mobileStudioFilterDraft || cloneMobileStudioFilters();
  const types = trainingTypeOptions();
  const owners = ownerFilterKeys().filter((key) => !mobileStudioOwnerQuery || ownerFilterLabel(key).toLowerCase().includes(mobileStudioOwnerQuery.toLowerCase()));
  return `<div class="mobile-studio-filter open" role="dialog" aria-modal="true" aria-label="방송실 일정 필터"><button class="mobile-studio-filter-backdrop" data-mobile-studio-filter-close type="button" aria-label="필터 닫기"></button><section><i></i><header><h2>필터</h2><button data-mobile-studio-filter-close type="button" aria-label="닫기">×</button></header><div class="mobile-studio-filter-scroll"><fieldset><legend>스탭 유형</legend><div class="mobile-studio-filter-chips"><button class="${types.every((type) => mobileCalendarFilterEnabled(draft.types, type)) ? "selected" : ""}" data-mobile-studio-filter-type="all" type="button">전체</button>${types.map((type) => `<button class="${mobileCalendarFilterEnabled(draft.types, type) ? "selected" : ""}" data-mobile-studio-filter-type="${esc(type)}" type="button">${esc(type)}</button>`).join("")}</div></fieldset><fieldset><legend>담당자</legend><input data-mobile-studio-owner-search placeholder="담당자 검색" value="${esc(mobileStudioOwnerQuery)}" /><div class="mobile-studio-filter-chips" data-mobile-studio-owner-options><button class="${ownerFilterKeys().every((owner) => ownerFilterEnabled(draft.owners, owner)) ? "selected" : ""}" data-mobile-studio-filter-owner="all" type="button">전체</button>${owners.map((owner) => `<button class="${ownerFilterEnabled(draft.owners, owner) ? "selected" : ""}" data-mobile-studio-filter-owner="${esc(owner)}" data-owner-label="${esc(ownerFilterLabel(owner))}" type="button">${esc(ownerFilterLabel(owner))}</button>`).join("")}</div></fieldset><fieldset><legend>기타</legend><label class="mobile-studio-check"><input data-mobile-studio-filter-recurring type="checkbox" ${draft.hideRecurring ? "checked" : ""} /><span>반복 일정 표시 제외</span></label><label class="mobile-studio-check"><input data-mobile-studio-filter-unassigned type="checkbox" ${draft.unassignedOnly ? "checked" : ""} /><span>미배정 일정만 보기</span></label></fieldset></div><footer><button data-mobile-studio-filter-reset type="button">초기화</button><button data-mobile-studio-filter-apply type="button">적용하기</button></footer></section></div>`;
}

function mobileStudioSelectOptions(options, selected, placeholder) {
  return `<option value="">${esc(placeholder)}</option>${options.map((option) => `<option value="${esc(option)}" ${option === selected ? "selected" : ""}>${esc(option)}</option>`).join("")}`;
}

function mobileStudioOwnerSelectOptions(selected) {
  return `<option value="">담당자 선택</option>${ownerOptions().map((owner) => `<option value="${esc(owner)}" ${owner === selected ? "selected" : ""}>${esc(ownerOptionLabel(owner))}</option>`).join("")}`;
}

function defaultMobileStudioFormDraft(event = null) {
  if (event) {
    const series = event.seriesId ? state.staffEvents.filter((item) => item.seriesId === event.seriesId) : [];
    return {
      editingStaffEventId: event.id,
      title: event.title || "",
      room: event.room || "",
      trainingType: event.trainingType || "",
      date: event.date || mobileStudioDate,
      allDay: event.allDay !== false,
      startTime: event.startTime || "09:00",
      endTime: event.endTime || "10:00",
      memo: event.memo || "",
      repeatEnabled: Boolean(event.seriesId),
      repeatDays: uniqueValues(series.map((item) => mobileStudioDateObject(item.date).getDay())),
      repeatCount: series.length || 1,
      seriesId: event.seriesId || "",
      staffRows: structuredClone(normalizeStaffEventRows(event))
    };
  }
  return { title: "", room: "", trainingType: "", date: mobileStudioDate, allDay: false, startTime: "09:00", endTime: "10:00", memo: "", repeatEnabled: false, repeatDays: [mobileStudioDateObject().getDay()], repeatCount: 8, seriesId: "", staffRows: [makeDefaultStaffRow(0)] };
}

function openMobileStudioForm(mode = "create", eventId = "") {
  const event = mode === "edit" ? state.staffEvents.find((item) => item.id === eventId) : null;
  if (mode === "edit" && !event) return;
  mobileStudioFormMode = mode;
  mobileStudioFormDraft = defaultMobileStudioFormDraft(event);
  mobileStudioFormStep = 1;
  mobileStudioFormErrors = {};
  mobileStudioFormOpen = true;
  renderMobileDashboard();
}

function closeMobileStudioForm() {
  mobileStudioFormOpen = false;
  mobileStudioFormDraft = null;
  mobileStudioFormErrors = {};
  renderMobileDashboard();
}

function validateMobileStudioBasic() {
  const draft = mobileStudioFormDraft || {};
  const errors = {};
  if (!String(draft.title || "").trim()) errors.title = "일정 제목을 입력하세요.";
  if (!draft.room) errors.room = "장소를 선택하세요.";
  if (!draft.trainingType) errors.trainingType = "예약 유형을 선택하세요.";
  if (!draft.date) errors.date = "날짜를 선택하세요.";
  if (draft.allDay === false && (!draft.startTime || !draft.endTime)) errors.time = "시작 시간과 종료 시간을 선택하세요.";
  if (draft.allDay === false && minutesFromTime(draft.endTime) <= minutesFromTime(draft.startTime)) errors.time = "종료 시간은 시작 시간보다 늦어야 합니다.";
  if (draft.repeatEnabled && (!draft.repeatDays?.length || Number(draft.repeatCount) < 1)) errors.repeat = "반복 요일과 횟수를 확인하세요.";
  mobileStudioFormErrors = errors;
  return Object.keys(errors).length === 0;
}

function renderMobileStudioBasicStep(draft) {
  const error = (key) => mobileStudioFormErrors[key] ? `<small class="mobile-studio-error">${esc(mobileStudioFormErrors[key])}</small>` : "";
  const selectTrigger = (key, value, placeholder) => {
    const colorGroup = key === "room" ? "studioRooms" : "trainingTypes";
    return `<button class="mobile-studio-select-trigger ${optionColorClass(colorGroup, value)}"${optionColorAttributes(colorGroup, value)} data-mobile-studio-select="${key}" type="button"><span>${esc(value || placeholder)}</span><i aria-hidden="true">⌄</i></button>`;
  };
  const timeTrigger = (key, value) => `<button class="mobile-studio-time-trigger" data-mobile-studio-time-picker="${key}" type="button" ${draft.allDay ? "disabled aria-disabled=\"true\"" : ""}><span>${esc(formatTimeButton(value))}</span><i aria-hidden="true">⌄</i></button>`;
  return `
    <section class="mobile-studio-form-step">
      <h2>기본 정보</h2>
      <div class="mobile-studio-form-section">
        <label>일정 제목 <b>*</b><input data-mobile-studio-form-field="title" value="${esc(draft.title)}" maxlength="100" placeholder="일정 제목" />${error("title")}</label>
        <label>장소 <b>*</b>${selectTrigger("room", draft.room, "장소 선택")}${error("room")}</label>
        <label>예약 유형 <b>*</b>${selectTrigger("trainingType", draft.trainingType, "예약 유형 선택")}${error("trainingType")}</label>
      </div>
      <div class="mobile-studio-form-section mobile-studio-schedule-section">
        <h3>일시</h3>
        <div class="mobile-studio-date-row">
          <label>날짜 <b>*</b><button class="mobile-studio-date-trigger" data-mobile-studio-date-picker type="button"><span>${esc(formatDate(draft.date))}</span><i aria-hidden="true">⌄</i></button>${error("date")}</label>
          <label class="mobile-studio-check"><input data-mobile-studio-form-toggle="allDay" type="checkbox" ${draft.allDay ? "checked" : ""} /><span>종일 일정</span></label>
        </div>
        <div class="mobile-studio-time-fields ${draft.allDay ? "is-disabled" : ""}">
          <label>시작 시간 <b>*</b>${timeTrigger("startTime", draft.startTime)}</label>
          <span>~</span>
          <label>종료 시간 <b>*</b>${timeTrigger("endTime", draft.endTime)}</label>
        </div>
        ${error("time")}
      </div>
      <div class="mobile-studio-form-section">
        <label>메모<textarea data-mobile-studio-form-field="memo" maxlength="200" placeholder="준비물, 교육 내용, 진행 메모를 입력하세요.">${esc(draft.memo)}</textarea><small class="mobile-studio-memo-count">${String(draft.memo || "").length} / 200</small></label>
      </div>
      <div class="mobile-studio-form-section">
        <h3>반복 설정</h3>
        <label class="mobile-studio-check"><input data-mobile-studio-form-toggle="repeatEnabled" type="checkbox" ${draft.repeatEnabled ? "checked" : ""} ${mobileStudioFormMode === "edit" && draft.seriesId ? "disabled" : ""} /><span>${draft.repeatEnabled ? "매주 반복" : "반복 안 함"}</span></label>
        ${draft.repeatEnabled ? `<div class="mobile-studio-repeat-days">${[[1,"월"],[2,"화"],[3,"수"],[4,"목"],[5,"금"],[6,"토"],[0,"일"]].map(([day,label]) => `<button class="${draft.repeatDays.includes(day) ? "selected" : ""}" data-mobile-studio-repeat-day="${day}" type="button" ${mobileStudioFormMode === "edit" && draft.seriesId ? "disabled" : ""}>${label}</button>`).join("")}</div><label>반복 횟수<input data-mobile-studio-form-field="repeatCount" type="number" min="1" max="52" value="${Number(draft.repeatCount) || 1}" ${mobileStudioFormMode === "edit" && draft.seriesId ? "disabled" : ""} /></label>${mobileStudioFormMode === "edit" && draft.seriesId ? "<small>기존 반복 일정은 현재 회차의 기본 정보만 수정됩니다.</small>" : ""}${error("repeat")}` : ""}
      </div>
    </section>
  `;
}

function renderMobileStudioStaffEditor(rows, prefix = "form") {
  const trigger = (row, key, value, placeholder) => `<button class="mobile-studio-select-trigger" data-mobile-studio-row-select="${key}" data-row-id="${esc(row.id)}" type="button"><span>${esc(value || placeholder)}</span><i aria-hidden="true">⌄</i></button>`;
  return `<div class="mobile-studio-staff-cards">${rows.map((row, index) => `<article data-mobile-studio-${prefix}-row="${esc(row.id)}"><header><span class="mobile-studio-drag" data-drag-handle>⋮⋮</span><strong>스탭 ${index + 1}</strong><div><button data-mobile-studio-row-up="${esc(row.id)}" type="button" aria-label="위로 이동" ${index === 0 ? "disabled" : ""}>↑</button><button data-mobile-studio-row-down="${esc(row.id)}" type="button" aria-label="아래로 이동" ${index === rows.length - 1 ? "disabled" : ""}>↓</button><button class="danger" data-mobile-studio-row-delete="${esc(row.id)}" type="button" aria-label="스탭 삭제">×</button></div></header><label>스탭 종류${trigger(row, "type", row.type, "스탭 종류 선택")}</label><label>담당자${trigger(row, "owner", ownerOptionLabel(row.owner), "담당자 선택")}</label><label>역할 또는 메모<input data-mobile-studio-row-field="memo" data-row-id="${esc(row.id)}" value="${esc(row.memo || "")}" maxlength="100" placeholder="역할 또는 메모" /></label></article>`).join("")}</div>`;
}

function renderMobileStudioStaffStep(draft) {
  return `<section class="mobile-studio-form-step"><h2>스탭 목록</h2><p>일정에 배정할 스탭을 선택하세요. 최대 6명</p>${renderMobileStudioStaffEditor(draft.staffRows, "form")}<button class="mobile-studio-add-staff" data-mobile-studio-row-add type="button" ${draft.staffRows.length >= 6 ? "disabled" : ""}>＋ 스탭 추가 <small>${draft.staffRows.length}/6</small></button></section>`;
}

function renderMobileStudioForm() {
  if (!mobileStudioFormOpen || !mobileStudioFormDraft) return "";
  const draft = mobileStudioFormDraft;
  const title = mobileStudioFormMode === "edit" ? "방송실 일정 수정" : "방송실 일정 등록";
  return `<div class="mobile-studio-fullscreen" role="dialog" aria-modal="true" aria-label="${title}"><header><button data-mobile-studio-form-close type="button" aria-label="닫기">×</button><strong>${title}</strong><span>${mobileStudioFormStep} / 2</span></header><div class="mobile-studio-step-indicator"><i class="active"></i><b></b><i class="${mobileStudioFormStep === 2 ? "active" : ""}"></i></div><main>${mobileStudioFormStep === 1 ? renderMobileStudioBasicStep(draft) : renderMobileStudioStaffStep(draft)}</main><footer>${mobileStudioFormStep === 1 ? `<button data-mobile-studio-form-close type="button">취소</button><button class="primary" data-mobile-studio-form-next type="button">다음</button>` : `<button data-mobile-studio-form-prev type="button">이전</button><button class="primary" data-mobile-studio-form-save type="button">${mobileStudioFormMode === "edit" ? "수정 완료" : "일정 등록"}</button>`}</footer></div>`;
}

function mobileStudioFormRows() {
  return mobileStudioFormDraft?.staffRows || mobileStudioDetailDraft?.staffRows || [];
}

function moveMobileStudioRow(rowId, direction) {
  const rows = mobileStudioFormRows();
  const index = rows.findIndex((row) => row.id === rowId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= rows.length) return;
  const [row] = rows.splice(index, 1);
  rows.splice(target, 0, row);
  if (!mobileStudioFormOpen) mobileStudioDetailDirty = true;
  renderMobileDashboard();
}

function saveMobileStudioReservation() {
  const draft = mobileStudioFormDraft;
  if (!draft || !validateMobileStudioBasic()) {
    mobileStudioFormStep = 1;
    renderMobileDashboard();
    return;
  }
  const rows = draft.staffRows.slice(0, 6).map((row) => ({ type: row.type || "", owner: row.owner || "", memo: row.memo || "" }));
  const owners = uniqueValues(rows.map((row) => row.owner).filter((owner) => !isUnassignedStudioOwner(owner)));
  const eventData = { title: String(draft.title).trim(), room: draft.room, trainingType: draft.trainingType, type: rows[0]?.type || "", owner: owners[0] || "", owners, staffRows: rows, date: draft.date, allDay: draft.allDay !== false, startTime: draft.startTime || "09:00", endTime: draft.endTime || "10:00", memo: String(draft.memo || "").trim() };
  if (mobileStudioFormMode === "edit" && draft.editingStaffEventId) {
    const event = state.staffEvents.find((item) => item.id === draft.editingStaffEventId);
    if (!event) return;
    const previousOwners = event.owners || [event.owner].filter(Boolean);
    Object.assign(event, eventData);
    notifyOwners(uniqueValues([...previousOwners, ...owners]), `${notificationActor().name}님이 ‘${eventData.title}’ 방송실 일정을 수정했습니다.`, { type: "staff", staffEventId: event.id, actionType: "studio_reservation_updated", title: "방송실 일정 수정", eventDate: event.date, targetView: "studio" });
    mobileStudioDetailId = event.id;
  } else {
    const base = mobileStudioDateObject(draft.date);
    const repeatDays = draft.repeatDays?.length ? draft.repeatDays : [base.getDay()];
    const count = draft.repeatEnabled ? Math.max(1, Math.min(52, Number(draft.repeatCount) || 1)) : 1;
    const seriesId = draft.repeatEnabled ? makeId() : "";
    const dates = [];
    const cursor = new Date(base);
    while (dates.length < count) {
      if (!draft.repeatEnabled || repeatDays.includes(cursor.getDay())) dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
      if (cursor.getTime() - base.getTime() > 370 * 86400000) break;
    }
    let firstId = "";
    dates.forEach((date) => {
      const id = makeId();
      if (!firstId) firstId = id;
      state.staffEvents.push({ id, ...eventData, date: dateKey(date), seriesId });
    });
    notifyOwners(owners, `${notificationActor().name}님이 ‘${eventData.title}’ 방송실 일정${draft.repeatEnabled ? " 반복 일정" : ""}을 생성했습니다.`, { type: "staff", staffEventId: firstId, actionType: draft.repeatEnabled ? "recurring_schedule_created" : "studio_reservation_created", title: draft.repeatEnabled ? "반복 일정 생성" : "방송실 일정 생성", eventDate: draft.date, targetView: "studio" });
    mobileStudioDate = draft.date;
  }
  saveState();
  mobileStudioFormOpen = false;
  mobileStudioFormDraft = null;
  showToast(mobileStudioFormMode === "edit" ? "방송실 일정이 수정되었습니다." : "방송실 일정이 등록되었습니다.");
  renderAll();
}

function mobileStudioSeriesSummary(event) {
  if (!event.seriesId) return "반복 안 함";
  const series = state.staffEvents.filter((item) => item.seriesId === event.seriesId).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const days = uniqueValues(series.map((item) => ["일", "월", "화", "수", "목", "금", "토"][mobileStudioDateObject(item.date).getDay()]));
  return `매주 ${days.join("·")}요일 · 총 ${series.length}회`;
}

function openMobileStudioDetail(eventId) {
  const event = state.staffEvents.find((item) => item.id === eventId);
  if (!event) return;
  mobileStudioDetailId = eventId;
  mobileStudioDetailDraft = { staffRows: structuredClone(normalizeStaffEventRows(event)) };
  mobileStudioDetailDirty = false;
  mobileStudioDeleteConfirm = false;
  renderMobileDashboard();
}

function closeMobileStudioDetail() {
  if (mobileStudioDetailDirty && !window.confirm("저장하지 않은 스탭 변경사항을 버리고 닫을까요?")) return;
  mobileStudioDetailId = "";
  mobileStudioDetailDraft = null;
  mobileStudioDetailDirty = false;
  mobileStudioDeleteConfirm = false;
  renderMobileDashboard();
}

function saveMobileStudioStaffOnly() {
  const event = state.staffEvents.find((item) => item.id === mobileStudioDetailId);
  if (!event || !mobileStudioDetailDraft) return;
  const previousOwners = event.owners || [event.owner].filter(Boolean);
  event.staffRows = mobileStudioDetailDraft.staffRows.slice(0, 6).map((row) => ({ type: row.type || "", owner: row.owner || "", memo: row.memo || "" }));
  syncStaffEventSummary(event);
  notifyOwners(uniqueValues([...previousOwners, ...(event.owners || [])]), `${notificationActor().name}님이 ‘${event.title}’ 방송실 일정을 변경했습니다.`, { type: "staff", staffEventId: event.id, actionType: "studio_staff_updated", title: "방송실 일정 변경", eventDate: event.date, targetView: "studio" });
  saveState();
  mobileStudioDetailDraft = { staffRows: structuredClone(normalizeStaffEventRows(event)) };
  mobileStudioDetailDirty = false;
  showToast("스탭 변경사항이 저장되었습니다.");
  renderAll();
}

function renderMobileStudioDetail() {
  const event = state.staffEvents.find((item) => item.id === mobileStudioDetailId);
  if (!event || !mobileStudioDetailDraft) return "";
  const time = event.allDay !== false ? "종일 일정" : `${event.startTime || "09:00"} ~ ${event.endTime || "10:00"}`;
  const fixedNotice = studioGlobalFixedNotice();
  return `
    <div class="mobile-studio-fullscreen mobile-studio-detail" role="dialog" aria-modal="true" aria-label="방송실 일정 상세">
      <header>
        <button data-mobile-studio-detail-close type="button" aria-label="뒤로가기">‹</button>
        <strong>방송실 일정 상세</strong>
        <button data-mobile-studio-edit="${esc(event.id)}" type="button">수정</button>
      </header>
      <main>
        <section class="mobile-studio-summary" ${studioTypeStyle(event.trainingType || event.type)}>
          <i></i>
          <h2>${esc(staffReservationTitle(event))}</h2>
          <p>${esc(event.trainingType || "기타")} · ${esc(event.room || "장소 미지정")}</p>
          <p>${esc(formatDate(event.date))} · ${esc(time)}</p>
          <p>${esc(mobileStudioSeriesSummary(event))}</p>
          ${event.memo ? `<small>${esc(event.memo)}</small>` : ""}
        </section>
        <section class="mobile-studio-detail-staff">
          <header>
            <div><h2>스탭 목록</h2><p>상세 화면에서 바로 수정할 수 있습니다. 최대 6명</p></div>
            <button data-mobile-studio-row-add type="button" ${mobileStudioDetailDraft.staffRows.length >= 6 ? "disabled" : ""}>＋ 스탭 추가</button>
          </header>
          ${renderMobileStudioStaffEditor(mobileStudioDetailDraft.staffRows, "detail")}
          <button class="mobile-studio-save-staff" data-mobile-studio-staff-save type="button" ${mobileStudioDetailDirty ? "" : "disabled"}>스탭 변경 저장</button>
        </section>
        ${isAdminUser() ? `<section class="mobile-studio-telegram-panel">
          <div class="mobile-studio-telegram-head"><span><h2>텔레그램 공지</h2><p>이 일정만 바로 전송합니다.</p></span><label class="mobile-studio-inline-calltime" title="일정 시작 전 도착 시간을 선택합니다."><span>콜타임</span><select data-mobile-studio-telegram-calltime-offset aria-label="콜타임 선택">${studioCallTimeOffsetOptions(event.telegramCallTimeOffsetMinutes)}</select></label></div>
          ${fixedNotice ? `<div class="studio-auto-fixed-notice"><span>자동 적용 고정 특이사항</span><p>${esc(fixedNotice)}</p><small>공지 전송 시 자동으로 포함됩니다.</small></div>` : ""}
          <label>${fixedNotice ? "이 일정 추가 특이사항" : "특이사항"}<textarea data-mobile-studio-telegram-note maxlength="1000" placeholder="준비물, 출입 안내 등을 입력하세요.">${esc(event.telegramNote || "")}</textarea></label>
          <small data-studio-event-telegram-message></small>
          <button class="mobile-studio-telegram-send" data-mobile-studio-telegram-send="${esc(event.id)}" type="button">텔레그램 푸쉬</button>
        </section>` : ""}
        <button class="mobile-studio-delete" data-mobile-studio-delete-open type="button">일정 삭제</button>
      </main>
      ${mobileStudioDeleteConfirm ? `<div class="mobile-studio-confirm"><section><h3>이 방송실 일정을 삭제하시겠습니까?</h3><p>삭제한 일정은 복구할 수 없습니다.</p><button data-mobile-studio-delete-cancel type="button">취소</button><button class="danger" data-mobile-studio-delete-one type="button">이 일정만 삭제</button>${event.seriesId ? `<button class="danger" data-mobile-studio-delete-series type="button">전체 반복 일정 삭제</button>` : ""}</section></div>` : ""}
    </div>
  `;
}

function renderMobileStudio() {
  const filterCount = mobileStudioFilterCount();
  const selected = mobileStudioDateObject();
  const period = mobileStudioViewMode === "month" ? `${selected.getFullYear()}년 ${selected.getMonth() + 1}월` : mobileStudioViewMode === "week" ? (() => { const start = mobileStudioWeekStartDate(); const end = new Date(start); end.setDate(start.getDate() + 6); return `${start.getMonth() + 1}월 ${start.getDate()}일 ~ ${end.getMonth() + 1}월 ${end.getDate()}일`; })() : mobileStudioDateText(mobileStudioDate, { short: true });
  const content = mobileStudioViewMode === "month" ? renderMobileStudioMonthly() : mobileStudioViewMode === "week" ? renderMobileStudioWeekly() : renderMobileStudioDaily();
  return `<div class="mobile-studio-page"><header class="mobile-studio-toolbar"><div><button data-mobile-studio-prev type="button" aria-label="이전 날짜">‹</button><strong>${esc(period)}</strong><button data-mobile-studio-next type="button" aria-label="다음 날짜">›</button><button data-mobile-studio-today type="button">오늘</button></div><div class="mobile-studio-toolbar-actions">${isAdminUser() ? `<button class="mobile-studio-telegram-manage" data-mobile-studio-telegram-manage type="button">공지 관리</button>` : ""}<button class="mobile-studio-filter-button ${filterCount ? "active" : ""}" data-mobile-studio-filter-open type="button">필터${filterCount ? ` ${filterCount}` : ""}</button></div></header><div class="mobile-studio-view-switch">${[["day","일간"],["week","주간"],["month","월간"]].map(([key,label]) => `<button class="${mobileStudioViewMode === key ? "active" : ""}" data-mobile-studio-view="${key}" type="button">${label}</button>`).join("")}</div>${content}<button class="mobile-studio-fab" data-mobile-studio-create type="button">＋ 일정</button>${renderMobileStudioFilterSheet()}${renderMobileStudioDetail()}${renderMobileStudioForm()}</div>`;
}

function mobileAvatarMarkup(user, className = "") {
  const label = String(user?.name || user?.username || "사용자").trim().slice(0, 1) || "사";
  const url = user?.avatarUrl || "";
  return `<span class="mobile-profile-avatar ${className}">${url ? `<img src="${esc(url)}" alt="${esc(user?.name || "프로필")}" loading="lazy" />` : esc(label)}</span>`;
}

function mobileMoreRow({ icon, label, route = "", target = "", badge = "", danger = false, disabled = false }) {
  const attrs = route ? `data-mobile-more-route="${esc(route)}"` : target ? `data-mobile-more-target="${esc(target)}"` : "";
  const iconPaths = {
    "♙": '<circle cx="9" cy="7" r="3"/><path d="M3.5 18a5.5 5.5 0 0 1 11 0"/><path d="M15 8.5h5M17.5 6v5"/>',
    "▤": '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    "▣": '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/>',
    "♢": '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4"/>',
    "⚙": '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5L9.2 6a7 7 0 0 0-1.7 1L5 6.1 3 9.5 5.1 11a7 7 0 0 0 0 2L3 14.5l2 3.4 2.5-1a7 7 0 0 0 1.7 1l.3 3.1h5l.3-3.1a7 7 0 0 0 1.7-1l2.5 1 2-3.4-2.1-1.5a7 7 0 0 0 .1-1Z"/>',
    "◇": '<path d="M12 3 20 7v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z"/><path d="m8.5 12 2.2 2.2L15.8 9"/>',
    "↪": '<path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10"/>'
  };
  const iconMarkup = iconPaths[icon] ? `<svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths[icon]}</svg>` : esc(icon);
  return `<button class="mobile-more-row ${danger ? "danger" : ""}" ${attrs} type="button" ${disabled ? "disabled" : ""}><i>${iconMarkup}</i><span>${esc(label)}</span>${badge ? `<b>${esc(badge)}</b>` : ""}<em>›</em></button>`;
}

function renderMobileMoreInline() {
  const user = currentUser();
  const unread = unreadNotifications().length;
  return `
    <div class="mobile-more-page">
      <button class="mobile-profile-summary" data-mobile-more-route="profile" type="button">
        ${mobileAvatarMarkup(user)}
        <span><strong>${esc(user?.name || user?.username || "사용자")}</strong><small>${esc([user?.position, user?.department || (user?.role === "admin" ? "관리자" : "일반 사용자")].filter(Boolean).join(" · "))}</small></span>
        <b>프로필 수정</b>
      </button>
      <section><h3>조직</h3><div>${mobileMoreRow({ icon: "♙", label: "조직도", route: "organization" })}</div></section>
      <section><h3>협업</h3><div>
        ${mobileMoreRow({ icon: "▤", label: "게시판", target: "board" })}
        ${mobileMoreRow({ icon: "▣", label: "방송실", target: "studio" })}
        ${mobileMoreRow({ icon: "♢", label: "알림", target: "notifications", badge: unread ? String(unread) : "" })}
      </div></section>
      <section><h3>설정</h3><div>${mobileMoreRow({ icon: "⚙", label: "설정", route: "preferences" })}</div></section>
      ${isAdminUser() ? `<section><h3>관리자</h3><div>${mobileMoreRow({ icon: "◇", label: "관리자 모드", route: "admin-home" })}</div></section>` : ""}
      <section><h3>계정</h3><div>${mobileMoreRow({ icon: "↪", label: "로그아웃", route: "logout", danger: true })}</div></section>
    </div>
  `;
}

function mobileSubpage(title, body, action = "") {
  return `<div class="mobile-more-subpage"><header><button data-mobile-more-back type="button" aria-label="뒤로가기">‹</button><h2>${esc(title)}</h2>${action || "<span></span>"}</header>${body}</div>`;
}

function renderMobileProfile() {
  const user = currentUser();
  const infoRows = [["이름", user?.name], ["직책", user?.position], ["소속", user?.department], ["이메일", user?.email], ["역할", user?.role === "admin" ? "관리자" : "일반 사용자"]].filter(([, value]) => value);
  return mobileSubpage("프로필 관리", `
    <form class="mobile-profile-form" data-mobile-profile-form>
      <section class="mobile-profile-photo-card">
        ${mobileAvatarMarkup({ ...user, avatarUrl: mobilePendingAvatarUrl || user?.avatarUrl }, "large")}
        <strong>${esc(user?.name || "사용자")}</strong>
        <small>${mobileProfileUploading ? "사진 업로드 중…" : esc(mobileProfileUploadMessage)}</small>
        <div class="mobile-profile-photo-actions">
          <label>사진 촬영<input data-mobile-profile-photo type="file" accept="image/jpeg,image/png,image/webp" capture="user" /></label>
          <label>앨범 선택<input data-mobile-profile-photo type="file" accept="image/jpeg,image/png,image/webp" /></label>
          <button class="record-control danger" data-mobile-profile-photo-delete type="button" ${user?.avatarPath || user?.avatarUrl ? "" : "disabled"}>사진 삭제</button>
        </div>
      </section>
      <section class="mobile-settings-group">${infoRows.map(([label, value]) => `<div class="mobile-info-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}</section>
      <section class="mobile-settings-group"><label class="mobile-profile-edit-row"><span>연락처</span><input name="phone" value="${esc(user?.phone || "")}" placeholder="연락처 입력" /></label></section>
      <button class="mobile-profile-save" type="submit">프로필 저장</button>
    </form>
  `);
}

async function refreshOrganizationDirectory() {
  const client = getSupabaseClient();
  if (!client || !currentProfile?.approved || mobileOrganizationLoading) return;
  mobileOrganizationLoading = true;
  mobileOrganizationError = "";
  mobileOrganizationNotice = "";
  renderMobileDashboard();
  try {
    const { data, error } = await client.rpc("get_organization_directory");
    if (error) throw error;
    (data || []).forEach((profile) => {
      const user = profileToUser(profile);
      const index = state.users.findIndex((item) => item.id === user.id);
      if (index >= 0) state.users[index] = { ...state.users[index], ...user };
      else state.users.push(user);
    });
    await Promise.all(state.users.filter((user) => user.avatarPath).map(async (user) => {
      user.avatarUrl = await signedProfileImageUrl(user.avatarPath);
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("Organization directory load failed", error);
    if (organizationUsers().length) {
      mobileOrganizationNotice = "운영 DB에 조직도 전용 설정이 아직 적용되지 않아 기존 승인 사용자 목록을 표시하고 있습니다.";
    } else {
      mobileOrganizationError = "조직도 전용 DB 설정이 아직 적용되지 않았고 표시 가능한 승인 사용자도 없습니다.";
    }
  } finally {
    mobileOrganizationLoading = false;
    if (mobileActiveSection === "settings" && mobileMoreRoute === "organization") renderMobileDashboard();
  }
}

function organizationUsers() {
  const query = mobileOrganizationSearch.trim().toLowerCase();
  return state.users.filter((user) => {
    if (!IS_LOCAL_ENV && user.username === "1") return false;
    if (user.organizationVisible === false) return false;
    const active = user.approved !== false && user.status !== "pending" && user.status !== "inactive";
    if (!active && !(isAdminUser() && mobileOrganizationIncludeInactive)) return false;
    return !query || `${user.name || ""} ${user.position || ""} ${user.department || ""} ${user.role || ""}`.toLowerCase().includes(query);
  }).sort((a, b) => (a.sortOrder - b.sortOrder) || String(a.name || "").localeCompare(String(b.name || ""), "ko"));
}

function renderDesktopOrganization() {
  const target = $("#desktopOrganizationContent");
  if (!target) return;
  const users = organizationUsers();
  const groups = new Map();
  users.forEach((user) => {
    const key = user.department || user.position || (user.role === "admin" ? "관리자" : "구성원");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(user);
  });
  target.innerHTML = mobileOrganizationLoading
    ? `<div class="mobile-directory-skeleton" aria-label="조직도 불러오는 중">${Array.from({ length: 6 }, () => "<i></i>").join("")}</div>`
    : users.length
      ? [...groups.entries()].map(([group, members], index) => `
        <details class="desktop-organization-group" ${index === 0 || mobileOrganizationSearch ? "open" : ""}>
          <summary>${esc(group)} <small>${members.length}명</small></summary>
          <div class="desktop-organization-members">
            ${members.map((user) => `<button class="desktop-organization-member" type="button">${mobileAvatarMarkup(user, "small")}<span><strong>${esc(user.name || user.username || "사용자")}</strong><small>${esc([user.position, user.department].filter(Boolean).join(" · "))}</small></span></button>`).join("")}
          </div>
        </details>
      `).join("")
      : `<div class="mobile-state-empty"><b>${mobileOrganizationSearch ? "검색 결과가 없습니다." : "표시할 구성원이 없습니다."}</b><span>이름, 직책 또는 부서로 다시 검색해주세요.</span></div>`;
}

function openDesktopOrganization(open = true) {
  const modal = $("#desktopOrganizationModal");
  if (!modal) return;
  modal.classList.toggle("open", open);
  modal.setAttribute("aria-hidden", String(!open));
  if (!open) return;
  mobileOrganizationSearch = "";
  const search = $("#desktopOrganizationSearch");
  if (search) search.value = "";
  renderDesktopOrganization();
  refreshOrganizationDirectory().finally(renderDesktopOrganization);
  window.setTimeout(() => search?.focus(), 0);
}

function openDesktopProfile(open = true) {
  const modal = $("#desktopProfileModal");
  const form = $("#desktopProfileForm");
  const user = currentUser();
  if (!modal || !form) return;
  modal.classList.toggle("open", open);
  modal.setAttribute("aria-hidden", String(!open));
  if (!open || !user) return;
  const infoRows = [["이름", user.name], ["직책", user.position], ["소속", user.department], ["이메일", user.email], ["역할", user.role === "admin" ? "관리자" : "일반 사용자"]].filter(([, value]) => value);
  $("#desktopProfileContent").innerHTML = `
    <section class="desktop-profile-photo-card">
      ${mobileAvatarMarkup({ ...user, avatarUrl: mobilePendingAvatarUrl || user.avatarUrl }, "large")}
      <strong>${esc(user.name || user.username || "사용자")}</strong>
      <small>${mobileProfileUploading ? "사진 업로드 중…" : esc(mobileProfileUploadMessage)}</small>
      <div class="desktop-profile-photo-actions">
        <label>사진 촬영<input data-desktop-profile-photo type="file" accept="image/jpeg,image/png,image/webp" capture="user" /></label>
        <label>앨범 선택<input data-desktop-profile-photo type="file" accept="image/jpeg,image/png,image/webp" /></label>
        <button class="danger" data-desktop-profile-photo-delete type="button" ${user.avatarPath || user.avatarUrl ? "" : "disabled"}>사진 삭제</button>
      </div>
    </section>
    <section class="desktop-profile-info">${infoRows.map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}</section>
    <label class="desktop-profile-contact"><span>연락처</span><input name="phone" value="${esc(user.phone || "")}" placeholder="연락처 입력" /></label>
    <button class="pill primary desktop-profile-save" type="submit">프로필 저장</button>
  `;
}

function toggleDesktopAccountMenu(force) {
  const menu = $("#sidebarAccountMenu");
  const button = $("#accountMenuBtn");
  if (!menu || !button) return;
  const open = typeof force === "boolean" ? force : !menu.classList.contains("open");
  menu.classList.toggle("open", open);
  menu.setAttribute("aria-hidden", String(!open));
  button.setAttribute("aria-expanded", String(open));
}

function renderMobileOrganization() {
  const users = organizationUsers();
  const groups = new Map();
  users.forEach((user) => {
    const key = user.department || user.position || (user.role === "admin" ? "관리자" : "구성원");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(user);
  });
  return mobileSubpage("조직도", `
    <div class="mobile-directory-search"><input data-mobile-organization-search value="${esc(mobileOrganizationSearch)}" placeholder="이름, 직책 검색" /></div>
    ${isAdminUser() ? `<label class="mobile-directory-inactive"><input data-mobile-organization-inactive type="checkbox" ${mobileOrganizationIncludeInactive ? "checked" : ""} /> 비활성 사용자 포함</label>` : ""}
    ${mobileOrganizationNotice ? `<div class="mobile-state-notice">${esc(mobileOrganizationNotice)}</div>` : ""}
    ${mobileOrganizationError ? `<div class="mobile-state-error"><b>${esc(mobileOrganizationError)}</b><button data-mobile-organization-retry type="button">다시 시도</button></div>` : ""}
    <div class="mobile-directory-groups">${mobileOrganizationLoading ? `<div class="mobile-directory-skeleton" aria-label="조직도 불러오는 중">${Array.from({ length: 5 }, () => "<i></i>").join("")}</div>` : users.length ? [...groups.entries()].map(([group, members]) => `<section><h3>${esc(group)} <small>${members.length}</small></h3><div>${members.map((user) => `<button data-mobile-member-id="${esc(user.id)}" type="button">${mobileAvatarMarkup(user, "small")}<span><strong>${esc(user.name || user.username || "사용자")}</strong><small>${esc([user.position, user.department].filter(Boolean).join(" · "))}</small></span><em>›</em></button>`).join("")}</div></section>`).join("") : `<div class="mobile-state-empty"><b>${mobileOrganizationSearch ? "검색 결과가 없습니다." : "표시할 구성원이 없습니다."}</b><span>승인된 활성 사용자가 여기에 표시됩니다.</span></div>`}</div>
  `);
}

function renderMobileMemberDetail(userId) {
  const member = state.users.find((user) => user.id === userId && (isAdminUser() || (user.approved !== false && user.status !== "inactive")));
  if (!member) return mobileSubpage("멤버 상세", '<div class="mobile-state-empty"><b>멤버 정보를 확인할 수 없습니다.</b></div>');
  const canViewContact = isAdminUser() || member.id === currentUser()?.id;
  const rows = [["직책", member.position], ["소속", member.department], ["역할", member.role === "admin" ? "관리자" : "일반 사용자"], ...(canViewContact ? [["이메일", member.email], ["연락처", member.phone]] : []), ["가입일", member.createdAt ? formatDate(member.createdAt.slice(0, 10)) : ""]].filter(([, value]) => value);
  return mobileSubpage("멤버 상세", `<section class="mobile-member-detail">${mobileAvatarMarkup(member, "large")}<h3>${esc(member.name || member.username || "사용자")}</h3><p>${esc([member.position, member.department].filter(Boolean).join(" · "))}</p><div>${rows.map(([label, value]) => `<span><small>${esc(label)}</small><b>${esc(value)}</b></span>`).join("")}</div></section>`);
}

function renderMobilePreferences() {
  const user = currentUser();
  const settings = notificationSettingsForUser(user?.id || "");
  const notificationLabels = { all: "전체 알림", projectStatus: "프로젝트 상태 변경", projectContent: "프로젝트 내용 수정", ownerChange: "담당자 변경", record: "관리기록 변경", task: "할 일 변경", work: "업무 변경", studio: "방송실 일정 변경", schedule: "일정 변경", system: "기타 알림" };
  return mobileSubpage("설정", `
    <section class="mobile-settings-section"><h3>계정 및 프로필</h3><div>${mobileMoreRow({ icon: "♙", label: "프로필 관리", route: "profile" })}<div class="mobile-info-row"><span>로그인 계정</span><b>${esc(user?.email || user?.username || "-")}</b></div></div></section>
    <section class="mobile-settings-section"><h3>화면 설정</h3><div><label class="mobile-setting-toggle"><span>다크 모드</span><input data-theme-setting type="checkbox" ${settings.darkMode ? "checked" : ""} /><i></i></label></div></section>
    <section class="mobile-settings-section"><h3>알림</h3><div>${Object.entries(notificationLabels).map(([key, label]) => `<label class="mobile-setting-toggle"><span>${esc(label)}</span><input data-notification-setting="${key}" type="checkbox" ${settings[key] !== false ? "checked" : ""} /><i></i></label>`).join("")}</div></section>
    <section class="mobile-settings-section"><h3>앱 설정</h3><div><label class="mobile-select-row"><span>앱 시작 화면</span><select data-mobile-start-section><option value="tasks" ${viewPref("mobileStartSection", "tasks") === "tasks" ? "selected" : ""}>할 일</option><option value="projects" ${viewPref("mobileStartSection", "tasks") === "projects" ? "selected" : ""}>영상</option><option value="works" ${viewPref("mobileStartSection", "tasks") === "works" ? "selected" : ""}>업무</option><option value="calendar" ${viewPref("mobileStartSection", "tasks") === "calendar" ? "selected" : ""}>캘린더</option></select></label><label class="mobile-setting-toggle"><span>완료된 할 일 기본 숨김</span><input data-mobile-default-hide-done type="checkbox" ${mobileTaskHideDone ? "checked" : ""} /><i></i></label></div></section>
    <section class="mobile-settings-section"><h3>앱 정보</h3><div><div class="mobile-info-row"><span>버전</span><b>v56</b></div></div></section>
    <button class="mobile-logout-button" data-mobile-more-route="logout" type="button">로그아웃</button>
  `);
}

function renderMobileAdminInline() {
  if (!isAdminUser()) {
    return `
      <div class="mobile-section-head"><h2>관리자</h2><span>권한 필요</span></div>
      <div class="empty">관리자 계정만 가입 상태를 확인하고 승인할 수 있습니다.</div>
    `;
  }
  const rows = state.users
    .map((user) => {
      const statusText = user.status === "inactive" ? "삭제됨" : user.approved === false || user.status === "pending" ? "미승인" : user.role === "admin" ? "관리자" : "일반";
      return `
        <article class="mobile-admin-user" data-mobile-admin-user="${esc(user.id)}">
          <div>
            <strong>${esc(user.name || user.username || user.email || "사용자")}</strong>
            <span>${esc(user.email || user.username || "-")}</span>
            <small>${esc(user.position || "과원")} · ${esc(statusText)}</small>
          </div>
          <div>
            <button class="${user.role === "admin" && user.approved !== false && user.status !== "pending" ? "active" : ""}" data-mobile-user-role="admin" type="button">관리자</button>
            <button class="${user.role !== "admin" && user.approved !== false && user.status !== "pending" ? "active" : ""}" data-mobile-user-role="user" type="button">일반</button>
            <button class="${user.approved === false || user.status === "pending" ? "active" : ""}" data-mobile-user-pending type="button">미승인</button>
            <button class="danger" data-mobile-user-delete type="button" ${user.id === state.currentUser ? "disabled" : ""}>삭제</button>
          </div>
        </article>
      `;
    })
    .join("");
  return `
    <div class="mobile-section-head"><h2>관리자</h2><span>가입 승인</span></div>
    <div class="mobile-admin-panel">
      <h3>계정 관리</h3>
      ${rows || '<div class="empty">등록된 계정이 없습니다.</div>'}
    </div>
  `;
}

const mobileAdminOptionGroups = [
  ["types", "프로젝트 분류"], ["statuses", "프로젝트 상태"], ["clients", "프로젝트 발주 부서"],
  ["projectTaskTypes", "프로젝트 할 일"], ["workTypes", "업무 분류"], ["workStatuses", "업무 상태"],
  ["workClients", "업무 발주 부서"], ["workTaskTypes", "업무 할 일"], ["boardPrefixes", "게시판 말머리"],
  ["studioRooms", "방송실 장소"], ["staffTypes", "스탭 종류"], ["trainingTypes", "교육 유형"]
];

function renderMobileAdminHome() {
  if (!isAdminUser()) return mobileSubpage("관리자 모드", '<div class="mobile-state-empty"><b>관리자 권한이 필요합니다.</b></div>');
  const pending = state.users.filter((user) => user.approved === false || user.status === "pending").length;
  const inactive = state.users.filter((user) => user.status === "inactive").length;
  return mobileSubpage("관리자 모드", `
    <section class="mobile-admin-summary"><article><span>승인 대기</span><b>${pending}</b></article><article><span>전체 사용자</span><b>${state.users.length}</b></article><article><span>비활성</span><b>${inactive}</b></article></section>
    <section class="mobile-settings-section"><h3>사용자 관리</h3><div>${mobileMoreRow({ icon: "♙", label: "승인 대기 및 전체 사용자", route: "admin-users", badge: pending ? String(pending) : "" })}</div></section>
    <section class="mobile-settings-section"><h3>업무 데이터</h3><div>${mobileMoreRow({ icon: "▥", label: "업무 진행 이력", route: "admin-activity" })}${mobileMoreRow({ icon: "▤", label: "월말보고서 작성", route: "admin-report" })}</div></section>
    <section class="mobile-settings-section"><h3>운영 설정</h3><div>${mobileMoreRow({ icon: "➤", label: "텔레그램 봇 관리", route: "admin-telegram" })}${mobileMoreRow({ icon: "◇", label: "담당자·직책 관리", route: "admin-members" })}${mobileMoreRow({ icon: "▤", label: "드롭다운 항목 관리", route: "admin-dropdowns" })}</div></section>
  `);
}

function renderMobileAdminActivity() {
  if (!isAdminUser()) return renderMobileAdminHome();
  return mobileSubpage("업무 진행 이력", renderAdminActivityManager({ mobile: true }));
}

function renderMobileMonthlyReport() {
  if (!isAdminUser()) return renderMobileAdminHome();
  return mobileSubpage("월말보고서 작성", `<div id="adminView" class="mobile-monthly-report" data-mobile-monthly-report>${renderMonthlyReportManager()}</div>`);
}

function renderMobileTelegramDigest() {
  if (!isAdminUser()) return renderMobileAdminHome();
  const settings = telegramDigestSettings();
  const hourOptions = Array.from({ length: 24 }, (_, hour) => {
    const value = `${String(hour).padStart(2, "0")}:00`;
    return `<option value="${value}" ${settings.deliveryTime === value ? "selected" : ""}>${String(hour).padStart(2, "0")}시대</option>`;
  }).join("");
  return mobileSubpage("텔레그램 봇 관리", `
    <form class="mobile-telegram-manager" data-telegram-digest-form>
      <section class="mobile-telegram-hero">
        <span>➤</span>
        <div><b>데일리 업무 브리핑</b><small>선택한 할 일과 마감 일정을 텔레그램으로 전송합니다.</small></div>
        <div class="telegram-runtime-status" data-telegram-runtime-status>${telegramDigestStatusMarkup()}<small>${esc(telegramDigestLastRunMarkup())}</small></div>
      </section>
      <section class="mobile-settings-section mobile-telegram-section">
        <h3>전송 방식</h3>
        <div class="mobile-telegram-modes">
          <label><input type="radio" name="deliveryMode" value="manual" ${settings.deliveryMode === "manual" ? "checked" : ""} /><span><b>직접 푸시</b><small>필요할 때 바로 전송</small></span></label>
          <label><input type="radio" name="deliveryMode" value="daily" ${settings.deliveryMode === "daily" ? "checked" : ""} /><span><b>매일 예약 푸시</b><small>매일 한 번 자동 전송</small></span></label>
          <label class="telegram-time-field ${settings.deliveryMode === "daily" ? "enabled" : ""}"><span>예약 시간대</span><select name="deliveryTime" ${settings.deliveryMode === "daily" ? "" : "disabled"}>${hourOptions}</select><small>한국 시간 기준 · 선택한 시간대 안에 전송</small></label>
        </div>
      </section>
      <section class="mobile-settings-section mobile-telegram-section">
        <h3>알림에 포함할 항목</h3>
        <div class="mobile-telegram-categories">
          ${Object.entries(telegramDigestCategoryLabels).map(([key, [label, description]]) => `<label><input type="checkbox" name="include-${key}" ${settings.include[key] ? "checked" : ""} /><i></i><span><b>${esc(label)}</b><small>${esc(description)}</small></span><em>${telegramDigestCategoryCount(key)}</em></label>`).join("")}
        </div>
      </section>
      <section class="mobile-settings-section mobile-telegram-section">
        <h3>추가 메시지</h3>
        <div class="mobile-telegram-message"><textarea name="additionalMessage" maxlength="1000" rows="6" placeholder="원하는 형식으로 메시지를 입력하세요.">${esc(settings.additionalMessage)}</textarea><small>별도 제목 없이 입력한 내용 그대로 표시 · 최대 1,000자</small></div>
      </section>
      <section class="mobile-settings-section mobile-telegram-section">
        <h3>미리보기</h3>
        <div class="mobile-telegram-preview" data-telegram-preview-output><span>✈</span><b>메시지 미리보기</b><small>버튼을 누르면 전송 형태가 표시됩니다.</small></div>
        <div class="telegram-form-message" data-telegram-form-message aria-live="polite"></div>
      </section>
      <div class="mobile-telegram-actions"><button data-telegram-preview type="button">미리보기</button><button type="submit">설정 저장</button><button data-telegram-send type="button">지금 전송</button></div>
    </form>
  `);
}

function renderMobileAdminUsers() {
  if (!isAdminUser()) return renderMobileAdminHome();
  const users = state.users.filter((user) => IS_LOCAL_ENV || user.username !== "1");
  return mobileSubpage("사용자 관리", `<div class="mobile-admin-user-list">${users.map((user) => {
    const pending = user.approved === false || user.status === "pending";
    return `<article data-mobile-admin-user="${esc(user.id)}"><button class="mobile-admin-user-open" data-mobile-admin-user-open="${esc(user.id)}" type="button">${mobileAvatarMarkup(user, "small")}<span><strong>${esc(user.name || user.username || "사용자")}</strong><small>${esc(user.email || user.username || "-")}</small></span><b>${pending ? "승인 대기" : user.status === "inactive" ? "비활성" : "활성"}</b></button><label>직책<select data-mobile-user-position="${esc(user.id)}">${uniqueValues([user.position, ...state.options.positions]).map((position) => `<option value="${esc(position)}" ${user.position === position ? "selected" : ""}>${esc(position)}</option>`).join("")}</select></label><div>${pending ? `<button class="primary" data-mobile-user-approve type="button">승인</button>` : ""}<button class="${user.role === "admin" ? "active" : ""}" data-mobile-user-role="admin" type="button">관리자</button><button class="${user.role !== "admin" && !pending ? "active" : ""}" data-mobile-user-role="user" type="button">일반</button><button data-mobile-user-pending type="button">미승인</button><button class="danger" data-mobile-user-delete type="button" ${user.id === currentUser()?.id ? "disabled" : ""}>삭제</button></div></article>`;
  }).join("") || '<div class="mobile-state-empty"><b>등록된 사용자가 없습니다.</b></div>'}</div>`);
}

function renderMobileAdminUserDetail(userId) {
  if (!isAdminUser()) return renderMobileAdminHome();
  const user = state.users.find((item) => item.id === userId);
  if (!user) return mobileSubpage("사용자 상세", '<div class="mobile-state-empty"><b>사용자 정보를 찾을 수 없습니다.</b></div>');
  const pending = user.approved === false || user.status === "pending";
  const rows = [["이메일", user.email || user.username], ["연락처", user.phone], ["소속", user.department], ["가입일", user.createdAt ? formatDate(user.createdAt.slice(0, 10)) : ""]].filter(([, value]) => value);
  return mobileSubpage("사용자 상세", `<section class="mobile-member-detail">${mobileAvatarMarkup(user, "large")}<h3>${esc(user.name || user.username || "사용자")}</h3><p>${esc([user.position, user.role === "admin" ? "관리자" : "일반 사용자"].filter(Boolean).join(" · "))}</p><div>${rows.map(([label, value]) => `<span><small>${esc(label)}</small><b>${esc(value)}</b></span>`).join("")}</div></section><section class="mobile-admin-user-list"><article data-mobile-admin-user="${esc(user.id)}"><label>직책<select data-mobile-user-position="${esc(user.id)}">${uniqueValues([user.position, ...state.options.positions]).map((position) => `<option value="${esc(position)}" ${user.position === position ? "selected" : ""}>${esc(position)}</option>`).join("")}</select></label><div>${pending ? `<button class="primary" data-mobile-user-approve type="button">승인</button>` : ""}<button class="${user.role === "admin" ? "active" : ""}" data-mobile-user-role="admin" type="button">관리자</button><button class="${user.role !== "admin" && !pending ? "active" : ""}" data-mobile-user-role="user" type="button">일반</button><button data-mobile-user-pending type="button" ${user.id === currentUser()?.id ? "disabled" : ""}>미승인</button><button class="danger" data-mobile-user-delete type="button" ${user.id === currentUser()?.id ? "disabled" : ""}>삭제</button></div></article></section>`);
}

function renderMobileOptionGroup(group, label) {
  return `<details class="mobile-admin-option-group" open data-mobile-option-group="${esc(group)}"><summary><span>${esc(label)}</span><b>${state.options[group].length}</b></summary><form data-mobile-option-add="${esc(group)}"><input name="option" placeholder="새 항목" /><button type="submit">추가</button></form><div>${state.options[group].map((option, index) => `<span data-mobile-option-index="${index}"><button class="mobile-option-drag" data-mobile-option-drag type="button" aria-label="${esc(option)} 순서 이동">☰</button>${COLORABLE_OPTION_GROUPS.has(group) ? `<button class="mobile-option-color" data-option-color-group="${group}" data-option-color-value="${esc(option)}" type="button" title="${esc(OPTION_COLOR_PALETTE[optionColorKey(group, option)].label)}" aria-label="${esc(option)} 색상 설정"><i style="--option-accent:${OPTION_COLOR_PALETTE[optionColorKey(group, option)].color}"></i></button>` : ""}<input value="${esc(option)}" data-mobile-option-value="${esc(option)}" /><button data-mobile-option-save="${esc(option)}" type="button" aria-label="${esc(option)} 수정">저장</button><button data-mobile-option-delete="${esc(option)}" type="button" aria-label="${esc(option)} 삭제">×</button></span>`).join("")}</div></details>`;
}

function renderMobileAdminDropdowns() {
  if (!isAdminUser()) return renderMobileAdminHome();
  return mobileSubpage("드롭다운 관리", `<div class="mobile-admin-options">${mobileAdminOptionGroups.map(([group, label]) => renderMobileOptionGroup(group, label)).join("")}</div>`);
}

function renderMobileAdminMembers() {
  if (!isAdminUser()) return renderMobileAdminHome();
  const users = state.users.filter((user) => (IS_LOCAL_ENV || user.username !== "1") && user.status !== "inactive" && user.approved !== false);
  return mobileSubpage("담당자·직책 관리", `<div class="mobile-admin-options">${renderMobileOptionGroup("positions", "직책")}${renderMobileOptionGroup("owners", "담당자 슬롯")}<details class="mobile-admin-option-group" open><summary><span>담당자 계정 연결</span><b>${ownerSlots().length}</b></summary><div class="mobile-owner-links">${ownerSlots().map((owner) => `<label><span>${esc(owner.name)}</span><select data-link-owner-id="${esc(owner.id)}"><option value="">미연결</option>${users.map((user) => `<option value="${esc(user.id)}" ${owner.linkedUserId === user.id ? "selected" : ""}>${esc(user.name || user.username)}</option>`).join("")}</select></label>`).join("")}</div><button class="mobile-admin-save-links" data-save-owner-links type="button">연결 저장</button></details></div>`);
}

function renderMobileMoreRoute() {
  if (mobileMoreRoute === "more") return renderMobileMoreInline();
  if (mobileMoreRoute === "profile") return renderMobileProfile();
  if (mobileMoreRoute === "organization") return renderMobileOrganization();
  if (mobileMoreRoute.startsWith("member:")) return renderMobileMemberDetail(mobileMoreRoute.slice(7));
  if (mobileMoreRoute === "preferences") return renderMobilePreferences();
  if (mobileMoreRoute === "admin-home") return renderMobileAdminHome();
  if (mobileMoreRoute === "admin-users") return renderMobileAdminUsers();
  if (mobileMoreRoute.startsWith("admin-user:")) return renderMobileAdminUserDetail(mobileMoreRoute.slice(11));
  if (mobileMoreRoute === "admin-activity") return renderMobileAdminActivity();
  if (mobileMoreRoute === "admin-report") return renderMobileMonthlyReport();
  if (mobileMoreRoute === "admin-telegram") return renderMobileTelegramDigest();
  if (mobileMoreRoute === "admin-dropdowns") return renderMobileAdminDropdowns();
  if (mobileMoreRoute === "admin-members") return renderMobileAdminMembers();
  return renderMobileMoreInline();
}

function bindMobileCoreActions(app) {
  const bind = (selector, handler) => {
    app.querySelectorAll(selector).forEach((element) => {
      element.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handler(element, event);
      });
    });
  };

  bind("[data-mobile-task-filter]", (button) => {
    mobileTaskFilter = button.dataset.mobileTaskFilter;
    mobileTaskSortOpen = false;
    mobileTaskOwnerFilterOpen = false;
    saveViewPrefs({ mobileTaskFilter });
    renderMobileDashboard();
  });
  bind("[data-mobile-open-sort]", () => {
    mobileTaskSortOpen = !mobileTaskSortOpen;
    mobileTaskOwnerFilterOpen = false;
    renderMobileDashboard();
  });
  bind("[data-mobile-close-sort]", () => { mobileTaskSortOpen = false; renderMobileDashboard(); });
  bind("[data-mobile-open-owner-filter]", () => {
    mobileTaskOwnerFilterOpen = !mobileTaskOwnerFilterOpen;
    mobileTaskSortOpen = false;
    renderMobileDashboard();
  });
  bind("[data-mobile-close-owner-filter]", () => { mobileTaskOwnerFilterOpen = false; renderMobileDashboard(); });
  bind("[data-mobile-task-owner]", (button) => {
    mobileTaskOwner = button.dataset.mobileTaskOwner || "";
    mobileTaskOwnerFilterOpen = false;
    saveViewPrefs({ mobileTaskOwner });
    renderMobileDashboard();
  });
  bind("[data-mobile-task-sort]", (button) => {
    mobileTaskSort = normalizeTaskSort(button.dataset.mobileTaskSort);
    mobileTaskSortOpen = false;
    saveViewPrefs({ mobileTaskSort });
    renderMobileDashboard();
  });
  bind("[data-mobile-open-project]", (button) => openProjectDetail(button.dataset.mobileOpenProject));
  bind("[data-mobile-open-work]", (button) => openWorkDetail(button.dataset.mobileOpenWork));
  bind("[data-mobile-open-project-sort]", () => { mobileProjectSortOpen = !mobileProjectSortOpen; renderMobileDashboard(); });
  bind("[data-mobile-close-project-sort]", () => { mobileProjectSortOpen = false; renderMobileDashboard(); });
  bind("[data-mobile-project-sort-key]", (button) => {
    projectSort = { key: button.dataset.mobileProjectSortKey, direction: button.dataset.mobileProjectSortDirection };
    mobileProjectSortOpen = false;
    saveViewPrefs({ projectSort });
    renderMobileDashboard();
  });
  bind("[data-mobile-open-work-sort]", () => { mobileWorkSortOpen = !mobileWorkSortOpen; renderMobileDashboard(); });
  bind("[data-mobile-close-work-sort]", () => { mobileWorkSortOpen = false; renderMobileDashboard(); });
  bind("[data-mobile-work-sort-key]", (button) => {
    workSort = { key: button.dataset.mobileWorkSortKey, direction: button.dataset.mobileWorkSortDirection };
    mobileWorkSortOpen = false;
    saveViewPrefs({ workSort });
    renderMobileDashboard();
  });
  bind("[data-mobile-more-route]", (button) => navigateMobileMore(button.dataset.mobileMoreRoute));
  bind("[data-mobile-more-back]", () => mobileMoreBack());
  bind("[data-mobile-more-target]", (button) => openMobileSection(button.dataset.mobileMoreTarget));
  bind("[data-monthly-report-step]", (button) => {
    const step = Number(button.dataset.monthlyReportStep);
    if (![1, 2, 3].includes(step) || !monthlyReportStepAvailable(step)) return;
    monthlyReportStep = step;
    monthlyReportMonthPickerOpen = false;
    renderMobileDashboard();
  });
  bind("[data-monthly-report-next]", (button) => {
    const step = Number(button.dataset.monthlyReportNext);
    if (![1, 2, 3].includes(step) || !monthlyReportStepAvailable(step)) return;
    monthlyReportStep = step;
    monthlyReportMonthPickerOpen = false;
    renderMobileDashboard();
  });
  bind("[data-monthly-report-month-trigger]", () => {
    monthlyReportMonthPickerOpen = !monthlyReportMonthPickerOpen;
    if (monthlyReportMonthPickerOpen) monthlyReportPickerYear = Number(monthlyReportMonth.slice(0, 4));
    renderMobileDashboard();
  });
  bind("[data-monthly-report-year-step]", (button) => {
    monthlyReportPickerYear = Math.max(1900, Math.min(2200, monthlyReportPickerYear + Number(button.dataset.monthlyReportYearStep || 0)));
    renderMobileDashboard();
  });
  bind("[data-monthly-report-month-value]", (button) => selectMonthlyReportMonth(button.dataset.monthlyReportMonthValue));
  bind("[data-monthly-report-current-month]", () => selectMonthlyReportMonth(dateKey(new Date()).slice(0, 7)));
  bind("[data-monthly-report-collect]", () => {
    collectMonthlyReportPreview();
    renderAdmin();
    renderMobileDashboard();
  });
  bind("[data-monthly-report-gpt]", (button) => generateMonthlyReportWithGpt(button));
  bind("[data-monthly-report-download]", (button) => downloadMonthlyReportWord(button));
  bind("[data-monthly-report-save-prompt]", (button) => saveMonthlyReportPrompt(button));
  bind("[data-telegram-preview]", (button) => runTelegramDigestAction("preview", button));
  bind("[data-telegram-send]", (button) => runTelegramDigestAction("send", button));
  bind("[data-mobile-admin-user-open]", (button) => navigateMobileMore(`admin-user:${button.dataset.mobileAdminUserOpen}`));
  bind("[data-mobile-user-role]", (button) => {
    const userRow = button.closest("[data-mobile-admin-user]");
    if (userRow) setUserRole(userRow.dataset.mobileAdminUser, button.dataset.mobileUserRole);
  });
  bind("[data-mobile-user-pending]", (button) => {
    const userRow = button.closest("[data-mobile-admin-user]");
    if (userRow) markUserPending(userRow.dataset.mobileAdminUser);
  });
  bind("[data-mobile-user-approve]", (button) => {
    const userRow = button.closest("[data-mobile-admin-user]");
    if (userRow) approveUser(userRow.dataset.mobileAdminUser);
  });
  bind("[data-mobile-user-delete]", (button) => {
    const userRow = button.closest("[data-mobile-admin-user]");
    if (userRow) confirmDelete(() => deleteUser(userRow.dataset.mobileAdminUser));
  });
  bind("[data-mobile-option-save]", (button) => {
    const manager = button.closest("[data-mobile-option-group]");
    const input = button.parentElement?.querySelector("[data-mobile-option-value]");
    if (manager && input) renameOption(manager.dataset.mobileOptionGroup, button.dataset.mobileOptionSave, input.value);
  });
  bind("[data-mobile-option-delete]", (button) => {
    const manager = button.closest("[data-mobile-option-group]");
    if (manager) confirmDelete(() => deleteOption(manager.dataset.mobileOptionGroup, button.dataset.mobileOptionDelete));
  });
  bind("[data-save-owner-links]", (button) => {
    button.disabled = true;
    saveOwnerLinkSettings().finally(() => { if (button.isConnected) button.disabled = false; });
  });
  app.querySelectorAll("[data-activity-log-filter]").forEach((input) => input.addEventListener("change", () => {
    updateAdminActivityFilter(input.dataset.activityLogFilter, input.value);
    renderMobileDashboard();
  }));
  app.querySelectorAll("[data-monthly-report-prompt]").forEach((input) => input.addEventListener("input", () => {
    state.monthlyReport = { prompt: String(input.value || "").slice(0, 12000) };
  }));
  app.querySelectorAll("[data-monthly-report-text]").forEach((input) => input.addEventListener("input", () => {
    const item = monthlyReportFindItem(input.dataset.monthlyReportText, input.dataset.monthlyReportScope);
    if (item) item.text = input.value.slice(0, 500);
  }));
  app.querySelectorAll("[data-monthly-report-section-text]").forEach((input) => input.addEventListener("input", () => {
    updateMonthlyReportTextSection(input.dataset.monthlyReportSectionText, input.value);
  }));
  app.querySelectorAll("[data-monthly-report-group-include]").forEach((input) => input.addEventListener("change", () => {
    setMonthlyReportGroupIncluded(
      input.dataset.monthlyReportScope || "preview",
      input.dataset.monthlyReportGroupInclude,
      input.checked
    );
    renderMobileDashboard();
  }));
  app.querySelectorAll("[data-monthly-report-include]").forEach((input) => input.addEventListener("change", () => {
    const scope = input.dataset.monthlyReportScope || "preview";
    const sections = scope === "draft" ? monthlyReportDraft : monthlyReportPreview;
    if (window.MonthlyReportCore?.setPreviewItemIncluded) {
      window.MonthlyReportCore.setPreviewItemIncluded(sections, input.dataset.monthlyReportInclude, input.checked);
    } else {
      const item = monthlyReportFindItem(input.dataset.monthlyReportInclude, scope);
      if (item) item.included = input.checked;
    }
    if (scope === "draft") invalidateMonthlyReportResult();
    renderMobileDashboard();
  }));
  bind("[data-mobile-notifications-close]", () => openMobileSection(mobilePreviousSection === "notifications" ? "tasks" : mobilePreviousSection));
  app.querySelectorAll("[data-mobile-open-task-id]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-overview-task-check]")) return;
      event.preventDefault();
      event.stopPropagation();
      openMobileTaskParent(card.dataset.mobileOpenTaskSource, card.dataset.mobileOpenTaskId);
    });
  });
  bind("[data-mobile-calendar-event]", (button) => openCalendarEventDetail(button));
  bind("[data-mobile-month-date]", (button) => {
    selectedCalendarDate = button.dataset.mobileMonthDate;
    const selected = new Date(`${selectedCalendarDate}T00:00:00`);
    if (selected.getFullYear() !== calendarDate.getFullYear() || selected.getMonth() !== calendarDate.getMonth()) {
      calendarDate = new Date(selected.getFullYear(), selected.getMonth(), 1);
    }
    saveViewPrefs({ selectedCalendarDate, calendarDate: dateKey(calendarDate) });
    renderMobileDashboard();
  });
  bind("[data-mobile-calendar-add]", () => openMobileAddSheet("schedule"));
  bind("[data-mobile-calendar-prev]", () => moveMobileCalendarPeriod(-1));
  bind("[data-mobile-calendar-next]", () => moveMobileCalendarPeriod(1));
  bind("[data-mobile-calendar-today]", () => {
    selectedCalendarDate = mobileTodayKey();
    calendarDate = new Date(`${selectedCalendarDate}T00:00:00`);
    saveViewPrefs({ selectedCalendarDate, calendarDate: dateKey(calendarDate) });
    renderMobileDashboard();
  });
  bind("[data-mobile-calendar-view]", (button) => {
    mobileCalendarViewMode = button.dataset.mobileCalendarView;
    saveViewPrefs({ mobileCalendarViewMode });
    renderMobileDashboard();
  });
  bind("[data-mobile-calendar-search-toggle]", () => {
    mobileCalendarSearchOpen = !mobileCalendarSearchOpen;
    if (!mobileCalendarSearchOpen) mobileCalendarSearchQuery = "";
    renderMobileDashboard();
    if (mobileCalendarSearchOpen) setTimeout(() => $("[data-mobile-calendar-search-input]")?.focus(), 0);
  });
  bind("[data-mobile-calendar-search-close]", () => {
    mobileCalendarSearchOpen = false;
    mobileCalendarSearchQuery = "";
    renderMobileDashboard();
  });
  bind("[data-mobile-calendar-filter-open]", () => {
    mobileCalendarFilterDraft = cloneMobileCalendarFilters();
    mobileCalendarFilterOpen = true;
    renderMobileDashboard();
  });
  bind("[data-mobile-calendar-filter-close]", () => closeMobileCalendarFilter());
  bind("[data-mobile-calendar-filter-reset]", () => {
    mobileCalendarFilterDraft = {
      owners: {},
      sources: { project: true, work: true, task: true, staff: true, schedule: true },
      recurring: "include",
      showCompleted: true
    };
    renderMobileDashboard();
  });
  bind("[data-mobile-calendar-filter-owner]", (button) => {
    const owner = button.dataset.mobileCalendarFilterOwner;
    mobileCalendarFilterDraft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
    if (owner === "all") {
      const allSelected = ownerFilterKeys().every((key) => ownerFilterEnabled(mobileCalendarFilterDraft.owners, key));
      mobileCalendarFilterDraft.owners = allSelected
        ? Object.fromEntries(ownerFilterKeys().map((key) => [key, false]))
        : {};
    }
    else mobileCalendarFilterDraft.owners[owner] = !ownerFilterEnabled(mobileCalendarFilterDraft.owners, owner);
    renderMobileDashboard();
  });
  bind("[data-mobile-calendar-filter-source]", (button) => {
    const source = button.dataset.mobileCalendarFilterSource;
    mobileCalendarFilterDraft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
    if (source === "all") {
      const allSelected = mobileCalendarSources.every(([key]) => mobileCalendarFilterEnabled(mobileCalendarFilterDraft.sources, key));
      mobileCalendarFilterDraft.sources = Object.fromEntries(mobileCalendarSources.map(([key]) => [key, !allSelected]));
    }
    else mobileCalendarFilterDraft.sources[source] = !mobileCalendarFilterEnabled(mobileCalendarFilterDraft.sources, source);
    renderMobileDashboard();
  });
  bind("[data-mobile-calendar-filter-recurring]", (button) => {
    mobileCalendarFilterDraft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
    mobileCalendarFilterDraft.recurring = button.dataset.mobileCalendarFilterRecurring;
    renderMobileDashboard();
  });
  bind("[data-mobile-calendar-filter-apply]", () => {
    const draft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
    calendarOwnerFilters = { ...draft.owners };
    calendarSourceFilters = { ...draft.sources };
    calendarRecurringFilter = draft.recurring;
    calendarShowCompleted = draft.showCompleted;
    mobileCalendarFilterOpen = false;
    mobileCalendarFilterDraft = null;
    saveViewPrefs({ calendarOwnerFilters, calendarSourceFilters, calendarRecurringFilter, calendarShowCompleted });
    renderCalendar();
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-prev]", () => mobileStudioMoveDate(-1));
  bind("[data-mobile-studio-next]", () => mobileStudioMoveDate(1));
  bind("[data-mobile-studio-today]", () => {
    mobileStudioDate = dateKey(new Date());
    saveViewPrefs({ mobileStudioDate });
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-view]", (button) => {
    mobileStudioViewMode = button.dataset.mobileStudioView;
    saveViewPrefs({ mobileStudioViewMode });
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-date]", (button) => {
    mobileStudioDate = button.dataset.mobileStudioDate;
    saveViewPrefs({ mobileStudioDate });
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-date-day]", (button) => {
    mobileStudioDate = button.dataset.mobileStudioDateDay;
    mobileStudioViewMode = "day";
    saveViewPrefs({ mobileStudioDate, mobileStudioViewMode });
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-event]", (button) => openMobileStudioDetail(button.dataset.mobileStudioEvent));
  bind("[data-mobile-studio-create]", () => openMobileStudioForm("create"));
  bind("[data-mobile-studio-telegram-manage]", () => openStudioTelegramModal());
  bind("[data-mobile-studio-filter-open]", () => {
    mobileStudioFilterDraft = cloneMobileStudioFilters();
    mobileStudioFilterOpen = true;
    mobileStudioOwnerQuery = "";
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-filter-close]", () => {
    mobileStudioFilterOpen = false;
    mobileStudioFilterDraft = null;
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-filter-reset]", () => {
    mobileStudioFilterDraft = { types: {}, owners: {}, hideRecurring: false, unassignedOnly: false };
    mobileStudioOwnerQuery = "";
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-filter-type]", (button) => {
    const type = button.dataset.mobileStudioFilterType;
    const draft = mobileStudioFilterDraft || cloneMobileStudioFilters();
    const types = trainingTypeOptions();
    if (type === "all") draft.types = {};
    else if (types.every((item) => mobileCalendarFilterEnabled(draft.types, item))) draft.types = Object.fromEntries(types.map((item) => [item, item === type]));
    else draft.types[type] = !mobileCalendarFilterEnabled(draft.types, type);
    mobileStudioFilterDraft = draft;
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-filter-owner]", (button) => {
    const owner = button.dataset.mobileStudioFilterOwner;
    const draft = mobileStudioFilterDraft || cloneMobileStudioFilters();
    const owners = ownerFilterKeys();
    if (owner === "all") draft.owners = {};
    else if (owners.every((item) => ownerFilterEnabled(draft.owners, item))) draft.owners = Object.fromEntries(owners.map((item) => [item, item === owner]));
    else draft.owners[owner] = !ownerFilterEnabled(draft.owners, owner);
    mobileStudioFilterDraft = draft;
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-filter-apply]", () => {
    const draft = mobileStudioFilterDraft || cloneMobileStudioFilters();
    studioTrainingTypeFilters = { ...draft.types };
    studioOwnerFilters = { ...draft.owners };
    studioHideRecurring = Boolean(draft.hideRecurring);
    mobileStudioUnassignedOnly = Boolean(draft.unassignedOnly);
    mobileStudioFilterOpen = false;
    mobileStudioFilterDraft = null;
    saveViewPrefs({ studioTrainingTypeFilters, studioOwnerFilters, studioHideRecurring, mobileStudioUnassignedOnly });
    if (!isMobileViewport()) renderStudioManage({ preserveScroll: true });
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-form-close]", () => closeMobileStudioForm());
  bind("[data-mobile-studio-form-next]", () => {
    if (!validateMobileStudioBasic()) return renderMobileDashboard();
    mobileStudioFormStep = 2;
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-form-prev]", () => {
    mobileStudioFormStep = 1;
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-form-save]", () => saveMobileStudioReservation());
  bind("[data-mobile-studio-select]", (button) => {
    if (!mobileStudioFormDraft) return;
    const key = button.dataset.mobileStudioSelect;
    const options = key === "room" ? studioRoomOptions() : trainingTypeOptions();
    openDropdown(button, options, mobileStudioFormDraft[key] || "", (value) => {
      if (!mobileStudioFormDraft) return;
      mobileStudioFormDraft[key] = value;
      renderMobileDashboard();
    }, (option) => option, key === "room" ? "studioRooms" : "trainingTypes");
  });
  bind("[data-mobile-studio-date-picker]", (button) => {
    if (!mobileStudioFormDraft) return;
    openDatePicker(button, mobileStudioFormDraft.date || mobileStudioDate, (value) => {
      if (!mobileStudioFormDraft || !value) return;
      mobileStudioFormDraft.date = value;
      renderMobileDashboard();
    });
  });
  bind("[data-mobile-studio-time-picker]", (button) => {
    if (!mobileStudioFormDraft || button.disabled || mobileStudioFormDraft.allDay) return;
    const key = button.dataset.mobileStudioTimePicker;
    openTimePicker(button, mobileStudioFormDraft[key] || (key === "startTime" ? "09:00" : "10:00"), (value) => {
      if (!mobileStudioFormDraft) return;
      mobileStudioFormDraft[key] = value;
      renderMobileDashboard();
    });
  });
  bind("[data-mobile-studio-row-select]", (button) => {
    const rows = mobileStudioFormRows();
    const row = rows.find((item) => item.id === button.dataset.rowId);
    if (!row) return;
    const key = button.dataset.mobileStudioRowSelect;
    const options = key === "type" ? staffTypeOptions() : ownerOptions();
    const formatter = key === "owner" ? ownerOptionLabel : (option) => option;
    openDropdown(button, options, row[key] || "", (value) => {
      row[key] = value;
      if (!mobileStudioFormOpen) mobileStudioDetailDirty = true;
      renderMobileDashboard();
    }, formatter);
  });
  bind("[data-mobile-studio-repeat-day]", (button) => {
    const day = Number(button.dataset.mobileStudioRepeatDay);
    const days = new Set(mobileStudioFormDraft?.repeatDays || []);
    if (days.has(day)) days.delete(day); else days.add(day);
    mobileStudioFormDraft.repeatDays = [...days].sort((a, b) => a - b);
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-row-add]", () => {
    const rows = mobileStudioFormRows();
    if (rows.length >= 6) return;
    rows.push(makeDefaultStaffRow(rows.length));
    if (!mobileStudioFormOpen) mobileStudioDetailDirty = true;
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-row-delete]", (button) => {
    const rows = mobileStudioFormRows();
    if (rows.length <= 1) return showToast("스탭 행은 최소 1개가 필요합니다.");
    const index = rows.findIndex((row) => row.id === button.dataset.mobileStudioRowDelete);
    if (index >= 0) rows.splice(index, 1);
    if (!mobileStudioFormOpen) mobileStudioDetailDirty = true;
    renderMobileDashboard();
  });
  bind("[data-mobile-studio-row-up]", (button) => moveMobileStudioRow(button.dataset.mobileStudioRowUp, -1));
  bind("[data-mobile-studio-row-down]", (button) => moveMobileStudioRow(button.dataset.mobileStudioRowDown, 1));
  bind("[data-mobile-studio-detail-close]", () => closeMobileStudioDetail());
  bind("[data-mobile-studio-edit]", (button) => openMobileStudioForm("edit", button.dataset.mobileStudioEdit));
  bind("[data-mobile-studio-staff-save]", () => saveMobileStudioStaffOnly());
  bind("[data-mobile-studio-telegram-send]", (button) => sendStudioEventTelegram(button.dataset.mobileStudioTelegramSend, button));
  bind("[data-mobile-studio-delete-open]", () => { mobileStudioDeleteConfirm = true; renderMobileDashboard(); });
  bind("[data-mobile-studio-delete-cancel]", () => { mobileStudioDeleteConfirm = false; renderMobileDashboard(); });
  bind("[data-mobile-studio-delete-one]", () => {
    const id = mobileStudioDetailId;
    mobileStudioDetailDirty = false;
    mobileStudioDetailId = "";
    mobileStudioDetailDraft = null;
    deleteStaffEvent(id);
  });
  bind("[data-mobile-studio-delete-series]", () => {
    const id = mobileStudioDetailId;
    mobileStudioDetailDirty = false;
    mobileStudioDetailId = "";
    mobileStudioDetailDraft = null;
    deleteStaffEventSeries(id);
  });

  app.querySelectorAll("[data-mobile-calendar-month-picker]").forEach((input) => {
    input.addEventListener("change", () => {
      const [year, month] = String(input.value || "").split("-").map(Number);
      if (!year || !month) return;
      calendarDate = new Date(year, month - 1, 1);
      selectedCalendarDate = dateKey(new Date(year, month - 1, 1));
      saveViewPrefs({ calendarDate: dateKey(calendarDate), selectedCalendarDate });
      renderMobileDashboard();
    });
  });
  app.querySelectorAll("[data-mobile-calendar-filter-completed]").forEach((input) => {
    input.addEventListener("change", () => {
      mobileCalendarFilterDraft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
      mobileCalendarFilterDraft.showCompleted = input.checked;
    });
  });
  app.querySelectorAll("[data-mobile-studio-filter-recurring]").forEach((input) => input.addEventListener("change", () => {
    mobileStudioFilterDraft = mobileStudioFilterDraft || cloneMobileStudioFilters();
    mobileStudioFilterDraft.hideRecurring = input.checked;
  }));
  app.querySelectorAll("[data-mobile-studio-filter-unassigned]").forEach((input) => input.addEventListener("change", () => {
    mobileStudioFilterDraft = mobileStudioFilterDraft || cloneMobileStudioFilters();
    mobileStudioFilterDraft.unassignedOnly = input.checked;
  }));
  app.querySelectorAll("[data-mobile-studio-form-field]").forEach((input) => {
    const update = () => {
      if (!mobileStudioFormDraft) return;
      const key = input.dataset.mobileStudioFormField;
      mobileStudioFormDraft[key] = key === "repeatCount" ? Math.max(1, Math.min(52, Number(input.value) || 1)) : input.value;
      if (key === "memo") input.closest("label")?.querySelector(".mobile-studio-memo-count") && (input.closest("label").querySelector(".mobile-studio-memo-count").textContent = `${input.value.length} / 200`);
    };
    input.addEventListener("input", update);
    input.addEventListener("change", update);
  });
  app.querySelectorAll("[data-mobile-studio-form-toggle]").forEach((input) => input.addEventListener("change", () => {
    if (!mobileStudioFormDraft) return;
    mobileStudioFormDraft[input.dataset.mobileStudioFormToggle] = input.checked;
    renderMobileDashboard();
  }));
  app.querySelectorAll("[data-mobile-studio-telegram-calltime-offset]").forEach((input) => input.addEventListener("change", () => {
    const event = state.staffEvents.find((item) => item.id === mobileStudioDetailId);
    if (!event) return;
    event.telegramCallTimeEnabled = true;
    event.telegramCallTimeOffsetMinutes = normalizeStudioCallTimeOffset(input.value);
    saveState();
  }));
  app.querySelectorAll("[data-mobile-studio-telegram-note]").forEach((input) => input.addEventListener("input", () => {
    const event = state.staffEvents.find((item) => item.id === mobileStudioDetailId);
    if (!event) return;
    event.telegramNote = input.value.slice(0, 1000);
    saveState();
  }));
  app.querySelectorAll("[data-mobile-studio-row-field]").forEach((input) => {
    const update = () => {
      const rows = mobileStudioFormRows();
      const row = rows.find((item) => item.id === input.dataset.rowId);
      if (!row) return;
      row[input.dataset.mobileStudioRowField] = input.value;
      if (!mobileStudioFormOpen) {
        mobileStudioDetailDirty = true;
        const saveButton = app.querySelector("[data-mobile-studio-staff-save]");
        if (saveButton) saveButton.disabled = false;
      }
    };
    input.addEventListener("input", update);
    input.addEventListener("change", update);
  });
  app.querySelectorAll("[data-mobile-studio-owner-search]").forEach((input) => input.addEventListener("input", () => {
    mobileStudioOwnerQuery = input.value;
    app.querySelectorAll("[data-owner-label]").forEach((button) => { button.hidden = !button.dataset.ownerLabel.toLowerCase().includes(input.value.toLowerCase()); });
  }));
}

function renderMobileDashboard() {
  const app = $("#mobileApp");
  if (!app) return;
  const current = mobileActiveSection || "projects";
  app.dataset.mobileSection = current;
  app.dataset.mobileMoreRoute = mobileMoreRoute;
  $("#mobileViewTitle") && ($("#mobileViewTitle").textContent = mobileTitleForView(current));
  $("#mobileFabWrap")?.classList.toggle("calendar-mode", current === "calendar");
  $("#mobileFabWrap")?.classList.toggle("is-hidden", ["settings", "notifications", "board", "studio"].includes(current));
  $$(".mobile-tab").forEach((button) => {
    const section = button.dataset.mobileSection;
    button.classList.toggle("active", section === current);
  });
  $("[data-mobile-more]")?.classList.toggle("active", current === "settings");
  const user = currentUser();
  $("#mobileUserName") && ($("#mobileUserName").textContent = user?.name || user?.username || "사용자");
  $("#mobileUserMeta") && ($("#mobileUserMeta").textContent = user?.position || "과원");
  const unread = unreadNotifications();
  if ($("#mobileNotifyCount")) {
    $("#mobileNotifyCount").textContent = String(unread.length);
    $("#mobileNotifyCount").hidden = unread.length === 0;
  }
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
    studio: renderMobileStudio,
    board: renderMobileBoard,
    admin: renderMobileAdminInline,
    notifications: renderMobileNotifications,
    settings: renderMobileMoreRoute
  };
  app.innerHTML = (renderers[current] || renderMobileProjectCards)();
  bindMobileCoreActions(app);
  renderNotificationSurfaces();
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

function performCloseMobileDetailSheets() {
  if ($("#projectDetail")?.classList.contains("open")) performCloseProjectDetail();
  if ($("#workDetail")?.classList.contains("open")) performCloseWorkDetail();
  closeDropdown();
  closeDatePicker();
  closeTimePicker();
}

function closeMobileDetailSheets(afterClose) {
  return requestAnyBasicLeave(() => {
    performCloseMobileDetailSheets();
    afterClose?.();
  });
}

function performOpenMobileSection(section) {
  if (section !== "tasks") mobileTaskDetailRef = null;
  if (section !== "board") {
    activeBoardPostId = null;
    boardEditorPostId = null;
    boardViewerPostId = null;
  }
  document.body.classList.toggle("mobile-pc-view", section === "admin");
  if (["projects", "works", "tasks", "calendar", "board", "notifications", "settings"].includes(section)) {
    if (section === "notifications" && mobileActiveSection !== "notifications") mobilePreviousSection = mobileActiveSection || "tasks";
    mobileActiveSection = section;
    if (section === "settings") {
      mobileMoreRoute = "more";
      mobileMoreHistory = [];
      history.replaceState({ ...(history.state || {}), mobileMoreRoute: "more" }, "");
    }
    if (!["notifications", "settings"].includes(section)) setView(section === "calendar" ? "calendar" : section);
    renderMobileDashboard();
    return;
  }
  if (section === "studio") {
    mobileActiveSection = "studio";
    setView("studio");
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

function openMobileSection(section) {
  closeMobileDetailSheets(() => performOpenMobileSection(section));
}

function canLeaveMobileMoreRoute() {
  if (mobileMoreRoute !== "profile" || !mobileProfileDirty) return true;
  if (!window.confirm("저장하지 않은 변경사항을 버리고 나갈까요?")) return false;
  mobileProfileDirty = false;
  return true;
}

function navigateMobileMore(route) {
  if (route === "logout") {
    if (window.confirm("로그아웃하시겠습니까?")) $("#logoutBtn")?.click();
    return;
  }
  if (route.startsWith("admin-") && !isAdminUser()) {
    showToast("관리자 권한이 필요합니다.");
    return;
  }
  if (!canLeaveMobileMoreRoute() || route === mobileMoreRoute) return;
  mobileMoreHistory.push(mobileMoreRoute);
  mobileMoreRoute = route;
  saveViewPrefs({ mobileMoreRoute });
  history.pushState({ ...(history.state || {}), mobileMoreRoute: route }, "");
  renderMobileDashboard();
  window.scrollTo({ top: 0, behavior: "auto" });
  if (route === "organization") refreshOrganizationDirectory();
  if (route === "admin-telegram") queueMicrotask(refreshTelegramDigestStatus);
}

function mobileMoreBack() {
  if (!canLeaveMobileMoreRoute()) return;
  if (mobileMoreHistory.length) {
    mobileMoreHistory.pop();
    history.back();
    return;
  }
  mobileMoreRoute = "more";
  saveViewPrefs({ mobileMoreRoute });
  renderMobileDashboard();
}

function handleMobilePopState(event) {
  if (!isMobileViewport()) return;
  if (event.state?.mobileTaskCreate && mobileAddMode !== "task" && mobileActiveSection === "tasks") {
    openMobileAddSheet("task");
    return;
  }
  if (mobileAddMode === "task" && !event.state?.mobileTaskCreate) {
    closeMobileAddSheet({ navigate: false });
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  if (mobileActiveSection !== "settings") return;
  const nextRoute = event.state?.mobileMoreRoute || "more";
  if (mobileProfileDirty && !window.confirm("저장하지 않은 변경사항을 버리고 나갈까요?")) {
    history.pushState({ ...(history.state || {}), mobileMoreRoute }, "");
    return;
  }
  mobileProfileDirty = false;
  if (mobileMoreHistory.at(-1) === nextRoute) mobileMoreHistory.pop();
  mobileMoreRoute = nextRoute;
  saveViewPrefs({ mobileMoreRoute });
  renderMobileDashboard();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function isMobileEdgeSwipeBlocked(target) {
  if (!(target instanceof Element)) return true;
  if (target.closest("input, textarea, select, [contenteditable='true'], [data-drag-handle], [data-mobile-option-drag], [data-mobile-calendar-swipe], .drag-handle, .image-crop, .horizontal-scroll")) return true;
  for (let element = target; element && element !== document.body; element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth + 2) continue;
    const overflowX = getComputedStyle(element).overflowX;
    if (overflowX === "auto" || overflowX === "scroll") return true;
  }
  return false;
}

function mobileLayerIsOpen(selector) {
  return Boolean($(selector)?.classList.contains("open"));
}

function closeTopMobileLayer() {
  if (mobileLayerIsOpen("#dropdownLayer")) { closeDropdown(); return true; }
  if (mobileLayerIsOpen("#datePickerLayer")) { closeDatePicker(); return true; }
  if (mobileLayerIsOpen("#timePickerLayer")) { closeTimePicker(); return true; }
  if (mobileLayerIsOpen("#deleteConfirmModal")) { closeDeleteConfirm(); return true; }
  if (mobileLayerIsOpen("#workTaskScopeModal")) { closeWorkTaskScopeModal(); return true; }
  if (mobileLayerIsOpen("#unsavedBasicModal")) { closeUnsavedBasicModal(); return true; }
  if (mobileLayerIsOpen("#notificationClearModal")) { closeNotificationClearConfirm(); return true; }
  if (mobileLayerIsOpen("#repeatDeleteModal")) { closeRepeatDeleteModal(); return true; }
  if (mobileLayerIsOpen("#taskOverviewFilterModal")) { closeTaskOverviewFilter(); return true; }
  if (mobileLayerIsOpen("#scheduleModal")) { closeScheduleModal(); return true; }
  if (mobileLayerIsOpen("#staffScheduleModal")) { closeStaffScheduleModal(); return true; }
  if (mobileLayerIsOpen("#studioTelegramPreviewModal")) { closeStudioTelegramPreview(); return true; }
  if (mobileLayerIsOpen("#staffEventDetailModal")) { closeStaffEventDetail(); return true; }
  if (mobileLayerIsOpen("#studioTelegramModal")) { closeStudioTelegramModal(); return true; }
  if (mobileLayerIsOpen("#recurringTrainingModal")) { closeRecurringTrainingModal(); return true; }
  if (mobileLayerIsOpen("#recurringTrainingManageModal")) { closeRecurringTrainingManageModal(); return true; }
  if (mobileLayerIsOpen("#notificationCenterModal")) { openNotificationCenter(false); return true; }
  if (mobileLayerIsOpen("#mobileAddSheet")) { closeMobileAddSheet(); return true; }
  if (mobileLayerIsOpen("#mobileMoreSheet")) { openMobileMoreSheet(false); return true; }
  if (mobileLayerIsOpen("#mobileFabMenu")) { toggleMobileFab(false); return true; }
  if (mobileTaskDetailRef) { closeMobileTaskDetail(); return true; }
  if (mobileStudioDeleteConfirm) { mobileStudioDeleteConfirm = false; renderMobileDashboard(); return true; }
  if (mobileStudioFilterOpen) { mobileStudioFilterOpen = false; mobileStudioFilterDraft = null; renderMobileDashboard(); return true; }
  if (mobileCalendarFilterOpen) { closeMobileCalendarFilter(); return true; }
  if (mobileProjectSortOpen) { mobileProjectSortOpen = false; renderMobileDashboard(); return true; }
  if (mobileWorkSortOpen) { mobileWorkSortOpen = false; renderMobileDashboard(); return true; }
  if (mobileTaskSortOpen || mobileTaskOwnerFilterOpen) {
    mobileTaskSortOpen = false;
    mobileTaskOwnerFilterOpen = false;
    renderMobileDashboard();
    return true;
  }
  if (mobileBoardFilterOpen) { mobileBoardFilterOpen = false; rerenderBoardSurfaces(); return true; }
  if (mobileCalendarSearchOpen) {
    mobileCalendarSearchOpen = false;
    mobileCalendarSearchQuery = "";
    renderMobileDashboard();
    return true;
  }
  if (boardViewerPostId) { boardViewerPostId = null; rerenderBoardSurfaces(); return true; }
  if (notificationSettingsOpen) {
    notificationSettingsOpen = false;
    renderNotificationSurfaces();
    if (mobileActiveSection === "notifications") renderMobileDashboard();
    return true;
  }
  return false;
}

function navigateMobileBack() {
  if (!isMobileViewport()) return false;
  if (closeTopMobileLayer()) return true;
  if (mobileStudioFormOpen) {
    if (mobileStudioFormStep > 1) {
      mobileStudioFormStep -= 1;
      renderMobileDashboard();
    } else closeMobileStudioForm();
    return true;
  }
  if (mobileStudioDetailId) { closeMobileStudioDetail(); return true; }
  if (boardEditorPostId !== null) { closeBoardEditor(); return true; }
  if (activeBoardPostId) { closeBoardDetail(); return true; }
  if ($("#projectDetail")?.classList.contains("open")) { closeProjectDetail(); return true; }
  if ($("#workDetail")?.classList.contains("open")) { closeWorkDetail(); return true; }
  if (mobileActiveSection === "settings" && mobileMoreRoute !== "more") { mobileMoreBack(); return true; }
  if (mobileActiveSection === "notifications" && mobilePreviousSection !== "notifications") {
    openMobileSection(mobilePreviousSection || "tasks");
    return true;
  }
  return false;
}

function createMobileEdgeSwipeBack({ edgeWidth = 30, minimumDistance = 80, onBack = navigateMobileBack } = {}) {
  const start = (event) => {
    if (!isMobileViewport() || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (touch.clientX > edgeWidth || isMobileEdgeSwipeBlocked(event.target)) return;
    mobileEdgeSwipe = { x: touch.clientX, y: touch.clientY, dx: 0, dy: 0, horizontal: false, cancelled: false };
  };
  const move = (event) => {
    if (!mobileEdgeSwipe || event.touches.length !== 1) return;
    const touch = event.touches[0];
    mobileEdgeSwipe.dx = touch.clientX - mobileEdgeSwipe.x;
    mobileEdgeSwipe.dy = touch.clientY - mobileEdgeSwipe.y;
    const absX = Math.abs(mobileEdgeSwipe.dx);
    const absY = Math.abs(mobileEdgeSwipe.dy);
    if (!mobileEdgeSwipe.horizontal && (mobileEdgeSwipe.dx < -8 || (absY > 12 && absY > absX))) {
      mobileEdgeSwipe.cancelled = true;
      return;
    }
    if (!mobileEdgeSwipe.cancelled && mobileEdgeSwipe.dx > 10 && mobileEdgeSwipe.dx > absY * 1.25) {
      mobileEdgeSwipe.horizontal = true;
      event.preventDefault();
    }
  };
  const finish = (event) => {
    if (!mobileEdgeSwipe) return;
    const gesture = mobileEdgeSwipe;
    mobileEdgeSwipe = null;
    if (event.type === "touchcancel" || gesture.cancelled) return;
    if (gesture.dx >= minimumDistance && gesture.dx > Math.abs(gesture.dy) * 1.35) onBack();
  };
  document.addEventListener("touchstart", start, { passive: true });
  document.addEventListener("touchmove", move, { passive: false });
  document.addEventListener("touchend", finish, { passive: true });
  document.addEventListener("touchcancel", finish, { passive: true });
  return () => {
    document.removeEventListener("touchstart", start);
    document.removeEventListener("touchmove", move);
    document.removeEventListener("touchend", finish);
    document.removeEventListener("touchcancel", finish);
  };
}

async function prepareMobileProfilePhoto(file) {
  mobileProfileUploadMessage = "";
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    mobileProfileUploadMessage = "JPG, PNG, WebP 이미지만 선택할 수 있습니다.";
    renderMobileDashboard();
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    mobileProfileUploadMessage = "프로필 사진은 5MB 이하만 사용할 수 있습니다.";
    renderMobileDashboard();
    return;
  }
  try {
    const image = await createImageBitmap(file);
    const side = Math.min(image.width, image.height);
    const sx = Math.floor((image.width - side) / 2);
    const sy = Math.floor((image.height - side) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    canvas.getContext("2d", { alpha: false }).drawImage(image, sx, sy, side, side, 0, 0, 512, 512);
    image.close?.();
    mobilePendingAvatarBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    if (mobilePendingAvatarUrl) URL.revokeObjectURL(mobilePendingAvatarUrl);
    mobilePendingAvatarUrl = URL.createObjectURL(mobilePendingAvatarBlob);
    mobileProfileDirty = true;
    mobileProfileUploadMessage = "프로필 사진을 저장하는 중…";
    renderMobileDashboard();
    await uploadMobileProfilePhoto();
    return;
  } catch {
    mobileProfileUploadMessage = "사진을 처리하지 못했습니다. 다른 이미지를 선택해주세요.";
  }
  renderMobileDashboard();
}

async function signedProfileImageUrl(path) {
  const client = getSupabaseClient();
  if (!client || !path) return "";
  const { data, error } = await client.storage.from("profile-images").createSignedUrl(path, 3600);
  return error ? "" : `${data.signedUrl}${data.signedUrl.includes("?") ? "&" : "?"}v=${Date.now()}`;
}

async function updateMySupabaseProfile(phone, avatarPath) {
  const client = getSupabaseClient();
  if (!client || !currentProfile?.id) return;
  const { error } = await client.rpc("update_my_profile", {
    p_phone: phone || null,
    p_avatar_path: avatarPath || null
  });
  if (error) throw error;
}

async function uploadMobileProfilePhoto() {
  const user = currentUser();
  if (!user || !mobilePendingAvatarBlob || mobileProfileUploading) return;
  mobileProfileUploading = true;
  mobileProfileUploadMessage = "업로드 중…";
  renderMobileDashboard();
  try {
    if (SUPABASE_ENABLED && currentProfile?.id) {
      const client = getSupabaseClient();
      const path = `${currentProfile.id}/${Date.now()}-${makeId().slice(-8)}.webp`;
      const { error: uploadError } = await client.storage.from("profile-images").upload(path, mobilePendingAvatarBlob, { contentType: "image/webp", upsert: false });
      if (uploadError) throw new Error("upload");
      try {
        await updateMySupabaseProfile(user.phone || "", path);
      } catch (profileError) {
        await client.storage.from("profile-images").remove([path]);
        throw profileError;
      }
      if (user.avatarPath) await client.storage.from("profile-images").remove([user.avatarPath]);
      user.avatarPath = path;
      user.avatarUrl = await signedProfileImageUrl(path);
      currentProfile.avatarPath = path;
      currentProfile.avatarUrl = user.avatarUrl;
    } else {
      user.avatarUrl = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(mobilePendingAvatarBlob); });
      user.avatarPath = "local-profile-image";
    }
    const directoryUser = state.users.find((item) => item.id === user.id);
    if (directoryUser && directoryUser !== user) {
      directoryUser.avatarPath = user.avatarPath;
      directoryUser.avatarUrl = user.avatarUrl;
    }
    mobilePendingAvatarBlob = null;
    if (mobilePendingAvatarUrl) URL.revokeObjectURL(mobilePendingAvatarUrl);
    mobilePendingAvatarUrl = "";
    mobileProfileDirty = false;
    mobileProfileUploadMessage = "프로필 사진이 변경되었습니다.";
    saveState();
  } catch {
    mobilePendingAvatarBlob = null;
    if (mobilePendingAvatarUrl) URL.revokeObjectURL(mobilePendingAvatarUrl);
    mobilePendingAvatarUrl = "";
    mobileProfileDirty = false;
    mobileProfileUploadMessage = "사진 업로드에 실패했습니다. Storage 설정과 권한을 확인해주세요.";
  } finally {
    mobileProfileUploading = false;
    renderMobileDashboard();
  }
}

async function deleteMobileProfilePhoto() {
  const user = currentUser();
  if (!user || !window.confirm("프로필 사진을 삭제하시겠습니까?")) return;
  try {
    if (SUPABASE_ENABLED && currentProfile?.id) {
      const client = getSupabaseClient();
      await updateMySupabaseProfile(user.phone || "", "");
      if (user.avatarPath) await client.storage.from("profile-images").remove([user.avatarPath]);
    }
    user.avatarPath = "";
    user.avatarUrl = "";
    const directoryUser = state.users.find((item) => item.id === user.id);
    if (directoryUser && directoryUser !== user) {
      directoryUser.avatarPath = "";
      directoryUser.avatarUrl = "";
    }
    if (currentProfile?.id === user.id) {
      currentProfile.avatarPath = "";
      currentProfile.avatarUrl = "";
    }
    saveState();
    mobileProfileUploadMessage = "기본 아바타로 변경되었습니다.";
  } catch {
    mobileProfileUploadMessage = "프로필 사진을 삭제하지 못했습니다.";
  }
  renderMobileDashboard();
}

async function saveMobileProfile(form) {
  const user = currentUser();
  if (!user) return;
  const phone = String(form.elements.phone?.value || "").trim();
  try {
    if (SUPABASE_ENABLED && currentProfile?.id) {
      await updateMySupabaseProfile(phone, user.avatarPath || "");
    }
    user.phone = phone;
    if (currentProfile?.id === user.id) currentProfile.phone = phone;
    mobileProfileDirty = false;
    saveState();
    showToast("프로필이 저장되었습니다.");
    renderMobileDashboard();
  } catch {
    showToast("프로필을 저장하지 못했습니다. 관리자에게 문의해주세요.");
  }
}

document.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
document.addEventListener("touchmove", (event) => {
  if (event.touches.length > 1) event.preventDefault();
}, { passive: false });

function closeMobileAddSheet({ navigate = true } = {}) {
  if (navigate && mobileAddMode === "task" && history.state?.mobileTaskCreate) {
    history.back();
    return;
  }
  closeDatePicker();
  const sheet = $("#mobileAddSheet");
  if (!sheet) return;
  sheet.classList.remove("open");
  sheet.setAttribute("aria-hidden", "true");
  $("#mobileAddForm")?.removeAttribute("data-mode");
  document.body.classList.remove("mobile-task-create-open");
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

function mobileTaskDropdown(name, options, placeholder) {
  return `
    <div class="mobile-task-dropdown" data-mobile-task-dropdown>
      <input type="hidden" name="${esc(name)}" value="" />
      <button class="mobile-task-dropdown-trigger" data-mobile-task-dropdown-toggle type="button" aria-expanded="false">
        <span>${esc(placeholder)}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5"></path></svg>
      </button>
      <div class="mobile-task-dropdown-menu" role="listbox" aria-hidden="true">
        ${options.length ? options.map((option) => `
          <button type="button" role="option" data-mobile-task-dropdown-value="${esc(option.value)}" data-mobile-task-dropdown-label="${esc(option.label)}">
            <span>${esc(option.label)}</span><i>✓</i>
          </button>
        `).join("") : '<p>선택할 항목이 없습니다.</p>'}
      </div>
    </div>
  `;
}

function mobileTaskTargetDropdown() {
  return mobileTaskDropdown("target", [
    ...state.projects.map((project) => ({ value: `project:${project.id}`, label: `영상 · ${project.title}` })),
    ...state.works.map((work) => ({ value: `work:${work.id}`, label: `업무 · ${work.title}` }))
  ], "연결 대상 선택");
}

function mobileTaskOwnerDropdown() {
  return mobileTaskDropdown("owners", ownerOptions().map((ownerId) => ({
    value: ownerId,
    label: ownerOptionLabel(ownerId)
  })), "담당자 선택");
}

function mobileScheduleOwnerDropdown(name = "owners", selected = []) {
  const selectedLabels = ownerOptions().filter((ownerId) => selected.includes(ownerId)).map(ownerOptionLabel);
  const summary = selectedLabels.length > 1 ? `${selectedLabels[0]} 외 ${selectedLabels.length - 1}명` : selectedLabels[0] || "담당자 선택";
  return `
    <details class="mobile-schedule-owner-dropdown ${selectedLabels.length ? "has-value" : ""}" data-mobile-schedule-owner-dropdown>
      <summary><span data-mobile-schedule-owner-summary>${esc(summary)}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5"></path></svg></summary>
      <div class="mobile-schedule-owner-menu">
        ${ownerOptions().map((ownerId) => `
          <label><input type="checkbox" name="${esc(name)}" value="${esc(ownerId)}" ${selected.includes(ownerId) ? "checked" : ""} /><span>${esc(ownerOptionLabel(ownerId))}</span><i>✓</i></label>
        `).join("")}
      </div>
    </details>
  `;
}

function updateMobileScheduleOwnerSummary(dropdown) {
  if (!dropdown) return;
  const labels = [...dropdown.querySelectorAll('input[name="owners"]:checked')].map((input) => ownerOptionLabel(input.value));
  const summary = dropdown.querySelector("[data-mobile-schedule-owner-summary]");
  if (summary) summary.textContent = labels.length > 1 ? `${labels[0]} 외 ${labels.length - 1}명` : labels[0] || "담당자 선택";
  dropdown.classList.toggle("has-value", labels.length > 0);
}

function mobileTaskDatePicker(name, value, label = "마감일") {
  return `
    <div class="mobile-task-date-field">
      <span>${esc(label)}</span>
      <input type="hidden" name="${esc(name)}" value="${esc(value)}" />
      <button class="mobile-task-date-trigger has-value" data-mobile-task-date-toggle type="button" aria-haspopup="dialog">
        <span>${esc(formatDate(value))}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5.5 3.5v3M14.5 3.5v3M3.5 8h13M4.5 5h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"></path>
        </svg>
      </button>
    </div>
  `;
}

function mobileScheduleTimePicker(name, value, label, disabled = false) {
  return `
    <div class="mobile-schedule-time-field ${disabled ? "is-disabled" : ""}">
      <span>${esc(label)}</span>
      <input type="hidden" name="${esc(name)}" value="${esc(value)}" />
      <button class="mobile-schedule-time-trigger" data-mobile-schedule-time-toggle type="button" aria-haspopup="dialog" ${disabled ? "disabled aria-disabled=\"true\"" : ""}>
        <span>${esc(formatTimeButton(value))}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"></circle><path d="M10 6v4l3 2"></path></svg>
      </button>
    </div>
  `;
}

function syncMobileWorkScheduleControls(section) {
  if (!section) return;
  const noScheduleInput = section.querySelector('input[name="noSchedule"]');
  const allDayInput = section.querySelector('input[name="allDay"]');
  const calendarInput = section.querySelector('input[name="calendar"]');
  const noSchedule = Boolean(noScheduleInput?.checked);
  const allDay = Boolean(allDayInput?.checked);
  const timeDisabled = noSchedule || allDay;

  section.classList.toggle("is-no-schedule", noSchedule);
  section.querySelectorAll("[data-mobile-task-date-toggle]").forEach((button) => {
    button.disabled = noSchedule;
    button.setAttribute("aria-disabled", String(noSchedule));
  });
  section.querySelectorAll("[data-mobile-schedule-time-toggle]").forEach((button) => {
    button.disabled = timeDisabled;
    button.setAttribute("aria-disabled", String(timeDisabled));
    button.closest(".mobile-schedule-time-field")?.classList.toggle("is-disabled", timeDisabled);
  });
  if (allDayInput) allDayInput.disabled = noSchedule;
  if (calendarInput) calendarInput.disabled = noSchedule;
}

function renderMobileAddForm(mode) {
  const today = mode === "schedule" && selectedCalendarDate ? selectedCalendarDate : dateKey(new Date());
  const configs = {
    project: ["프로젝트 추가", "프로젝트 등록"],
    work: ["업무 추가", "업무 등록"],
    task: ["할 일 추가", "할 일 등록"],
    schedule: ["간단 일정 추가", "일정 등록"]
  };
  const [title, submitLabel] = configs[mode] || configs.project;
  let body = "";
  if (mode === "project") {
    body = `
      <section><h3>기본정보</h3><input name="title" placeholder="프로젝트명" required />${mobileSelect("type", state.options.types, "분류 선택")}${mobileSelect("client", state.options.clients, "발주부서 선택")}</section>
      <section><h3>담당/상태</h3>${mobileOwnerCheckboxes("owners")}${mobileSelect("status", state.options.statuses, "진행상태 선택")}</section>
      <section><h3>일정</h3><label>시작일<input name="kickoffDate" type="date" value="${today}" /></label><label>촬영일<input name="shootDate" type="date" value="${today}" /></label><label>1차 완성일<input name="firstEditDate" type="date" value="${today}" /></label><label>최종 출고일<input name="finalDate" type="date" value="${today}" /></label></section>
      <section><h3>메모</h3><textarea name="memo" placeholder="메모"></textarea></section>
    `;
  } else if (mode === "work") {
    body = `
      <section><h3>기본정보</h3><input name="title" placeholder="업무명" required />${mobileSelect("type", state.options.workTypes, "분류 선택")}${mobileSelect("client", state.options.workClients, "발주부서 선택")}</section>
      <section><h3>담당/상태</h3>${mobileOwnerCheckboxes("owners")}${mobileSelect("status", state.options.workStatuses, "진행상태 선택")}</section>
      <section class="mobile-work-schedule-form"><h3>일정</h3><div class="mobile-work-date-fields">${mobileTaskDatePicker("kickoffDate", today, "시작일")}${mobileTaskDatePicker("finalDate", today, "마감일")}</div><div class="mobile-work-time-fields">${mobileScheduleTimePicker("startTime", "09:00", "시작 시간", true)}<span aria-hidden="true">~</span>${mobileScheduleTimePicker("endTime", "10:00", "종료 시간", true)}</div><div class="mobile-work-schedule-options"><label class="mobile-toggle-line"><input name="allDay" type="checkbox" checked /> 종일</label><label class="mobile-toggle-line"><input name="noSchedule" type="checkbox" /> 일정 없음</label><label class="mobile-toggle-line"><input name="calendar" type="checkbox" checked /> 캘린더 등록</label></div></section>
      <section><h3>메모</h3><textarea name="memo" placeholder="메모"></textarea></section>
    `;
  } else if (mode === "task") {
    body = `
      <section><h3>기본정보</h3><input name="title" placeholder="할 일 제목" required />${mobileTaskDropdown("type", taskTypeOptions().map((type) => ({ value: type, label: type })), "업무 분류 선택")}</section>
      <section><h3>연결</h3>${mobileTaskTargetDropdown()}</section>
      <section><h3>담당자</h3>${mobileTaskOwnerDropdown()}</section>
      <section><h3>일정</h3>${mobileTaskDatePicker("dueDate", today)}<div class="mobile-task-schedule-options"><label class="mobile-toggle-line"><input name="noDueDate" type="checkbox" /> 마감일 없음</label><label class="mobile-toggle-line"><input name="allDay" type="checkbox" checked /> 종일</label></div><div class="mobile-time-row"><input name="startTime" type="time" value="09:00" /><input name="endTime" type="time" value="10:00" /></div></section>
      <section><h3>세부내용</h3><textarea name="detail" placeholder="세부내용"></textarea></section>
    `;
  } else {
    body = `
      <section><h3>기본정보</h3><input name="title" placeholder="일정명" required /></section>
      <section><h3>일정</h3><div class="mobile-schedule-date-time-row">${mobileTaskDatePicker("date", today, "날짜")}${mobileScheduleTimePicker("startTime", "09:00", "시작 시간", true)}${mobileScheduleTimePicker("endTime", "10:00", "종료 시간", true)}</div><label class="mobile-toggle-line"><input name="allDay" type="checkbox" checked /> 종일 일정</label></section>
      <section><h3>담당자</h3>${mobileScheduleOwnerDropdown("owners")}</section>
      <section><h3>메모</h3><input name="location" placeholder="장소" /><textarea name="memo" placeholder="메모"></textarea></section>
    `;
  }
  const header = mode === "task"
    ? `<header><button type="button" data-close-mobile-add aria-label="할 일 목록으로 돌아가기">‹</button><div><span>TASK</span><strong>${esc(title)}</strong></div><i aria-hidden="true"></i></header>`
    : `<header><button type="button" data-close-mobile-add>닫기</button><strong>${esc(title)}</strong><button type="submit">${esc(submitLabel)}</button></header>`;
  return `
    ${header}
    <div class="mobile-add-body">${body}</div>
    <footer><button class="pill primary" type="submit">${esc(submitLabel)}</button></footer>
  `;
}

function openMobileAddSheet(mode) {
  mobileAddMode = mode;
  const sheet = $("#mobileAddSheet");
  const form = $("#mobileAddForm");
  if (!sheet || !form) return;
  if (mode === "task" && isMobileViewport() && !history.state?.mobileTaskCreate) {
    history.pushState({ ...(history.state || {}), mobileTaskCreate: true }, "");
  }
  form.dataset.mode = mode;
  form.innerHTML = renderMobileAddForm(mode);
  sheet.classList.add("open");
  sheet.setAttribute("aria-hidden", "false");
  document.body.classList.toggle("mobile-task-create-open", mode === "task");
  if (mode === "task") {
    window.scrollTo({ top: 0, behavior: "auto" });
  }
}

function mobileFormOwners(form) {
  return Array.from(form.querySelectorAll('input[name="owners"]'))
    .filter((input) => input.type !== "checkbox" || input.checked)
    .map((input) => input.value)
    .filter(Boolean);
}

function submitMobileAddForm(form) {
  const data = new FormData(form);
  const today = dateKey(new Date());
  if (mobileAddMode === "project") {
    const project = {
      id: makeId(),
      title: String(data.get("title") || "").trim() || "새 프로젝트",
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
    notifyOwners(projectOwners(project), `${notificationActor().name}님이 ‘${project.title}’ 프로젝트를 생성했습니다.`, {
      type: "project",
      projectId: project.id,
      actionType: "project_created",
      title: "프로젝트 생성",
      targetTab: "basic"
    });
    saveState();
    closeMobileAddSheet();
    mobileActiveSection = "projects";
    renderAll();
    return;
  }
  if (mobileAddMode === "work") {
    const noSchedule = Boolean(data.get("noSchedule"));
    const allDay = Boolean(data.get("allDay"));
    const startTime = String(data.get("startTime") || "09:00");
    const endTime = String(data.get("endTime") || "10:00");
    if (!noSchedule && !allDay && minutesFromTime(endTime) <= minutesFromTime(startTime)) {
      showToast("종료 시간은 시작 시간보다 늦어야 합니다.");
      return;
    }
    const work = {
      id: makeId(),
      title: String(data.get("title") || "").trim() || "새 업무",
      type: String(data.get("type") || ""),
      owners: mobileFormOwners(form),
      client: String(data.get("client") || ""),
      status: String(data.get("status") || ""),
      noSchedule,
      allDay,
      startTime,
      endTime,
      kickoffDate: String(data.get("kickoffDate") || today),
      finalDate: String(data.get("finalDate") || today),
      calendarFields: { ...defaultWorkCalendarFields, finalDate: Boolean(data.get("calendar")) },
      studioReservationEnabled: false,
      studioReservationId: "",
      studioReservation: null,
      memo: String(data.get("memo") || ""),
      tasks: [],
      records: []
    };
    state.works.unshift(work);
    notifyOwners(workOwners(work), `${notificationActor().name}님이 ‘${work.title}’ 업무를 생성했습니다.`, {
      type: "work",
      workId: work.id,
      actionType: "work_created",
      title: "업무 생성",
      targetTab: "basic"
    });
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
      const project = state.projects.find((item) => item.id === task.projectId);
      if (project) {
        notifyOwners(uniqueValues([...projectOwners(project), ...taskOwners(task)]), `${notificationActor().name}님이 ‘${project.title}’에 할 일 ‘${task.text}’을 추가했습니다.`, {
          type: "project-task",
          projectId: project.id,
          taskId: task.id,
          actionType: "project_task_added",
          title: "할 일 추가",
          targetTab: "tasks"
        });
      }
    } else {
      const work = state.works.find((item) => item.id === target.replace("work:", ""));
      if (!work) return;
      work.tasks = Array.isArray(work.tasks) ? work.tasks : [];
      work.tasks.unshift(task);
      notifyOwners(uniqueValues([...workOwners(work), ...taskOwners(task)]), `${notificationActor().name}님이 ‘${work.title}’에 할 일 ‘${task.text}’을 추가했습니다.`, {
        type: "work-task",
        workId: work.id,
        taskId: task.id,
        actionType: "work_task_added",
        title: "할 일 추가",
        targetTab: "tasks"
      });
    }
    saveState();
    const taskCreateHistoryActive = Boolean(history.state?.mobileTaskCreate);
    closeMobileAddSheet({ navigate: false });
    if (taskCreateHistoryActive) history.back();
    mobileActiveSection = "tasks";
    renderAll();
    return;
  }
  if (mobileAddMode === "schedule") {
    const schedule = {
      id: makeId(),
      title: String(data.get("title") || "").trim() || "새 일정",
      owners: mobileFormOwners(form),
      location: String(data.get("location") || ""),
      memo: String(data.get("memo") || ""),
      date: String(data.get("date") || today),
      allDay: Boolean(data.get("allDay")),
      startTime: String(data.get("startTime") || "09:00"),
      endTime: String(data.get("endTime") || "10:00")
    };
    state.schedules.push(schedule);
    notifyOwners(schedule.owners, `${notificationActor().name}님이 ‘${schedule.title}’ 일정을 생성했습니다.`, {
      type: "schedule",
      scheduleId: schedule.id,
      actionType: "schedule_created",
      title: "일정 생성",
      eventDate: schedule.date,
      targetView: "calendar"
    });
    saveState();
    closeMobileAddSheet();
    mobileActiveSection = "calendar";
    renderAll();
  }
}

function renderAll() {
  applyUserTheme();
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
  renderBoard();
  renderAdmin();
  renderAuth();
  renderMobileDashboard();
}

document.addEventListener("click", (event) => {
  if (handleBoardClick(event)) {
    event.stopPropagation();
  }
});

document.addEventListener("input", (event) => {
  handleBoardInput(event);
});

document.addEventListener("change", (event) => {
  handleBoardChange(event);
});

document.addEventListener("submit", (event) => {
  handleBoardSubmit(event);
});

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
$("#datePickerLayer").addEventListener("click", (event) => {
  event.stopPropagation();
  if (event.target === event.currentTarget) closeDatePicker();
});
$("#timePickerLayer").addEventListener("click", (event) => {
  event.stopPropagation();
  if (event.target === event.currentTarget) closeTimePicker();
});
[$("#datePickerLayer"), $("#timePickerLayer")].forEach((layer) => {
  layer.addEventListener("wheel", (event) => event.stopPropagation(), { passive: false });
  layer.addEventListener("touchmove", (event) => event.stopPropagation(), { passive: false });
});
$$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$$("[data-mobile-section]").forEach((button) => button.addEventListener("click", () => { openMobileSection(button.dataset.mobileSection); openMobileMoreSheet(false); toggleMobileFab(false); }));
$("[data-mobile-more]")?.addEventListener("click", () => {
  openMobileSection("settings");
  openMobileMoreSheet(false);
  toggleMobileFab(false);
});
$$("[data-close-mobile-sheet]").forEach((button) => button.addEventListener("click", () => openMobileMoreSheet(false)));
$$("[data-close-mobile-add]").forEach((button) => button.addEventListener("click", () => closeMobileAddSheet()));
$("#mobileNotifyBtn")?.addEventListener("click", () => openMobileSection("notifications"));
$("#webNotifyBtn")?.addEventListener("click", (event) => {
  event.stopPropagation();
  webNotificationsOpen = !webNotificationsOpen;
  renderWebNotificationPopup();
});
$("#closeNotificationCenterBtn")?.addEventListener("click", () => openNotificationCenter(false));
$("#notificationCenterModal")?.addEventListener("click", (event) => {
  if (event.target.id === "notificationCenterModal") openNotificationCenter(false);
});
$("#notificationClearCancelBtn")?.addEventListener("click", closeNotificationClearConfirm);
$("#notificationClearConfirmBtn")?.addEventListener("click", clearCurrentUserNotifications);
$("#notificationClearModal")?.addEventListener("click", (event) => {
  if (event.target.id === "notificationClearModal") closeNotificationClearConfirm();
});
document.addEventListener("click", (event) => {
  const notificationButton = event.target.closest("[data-notification-id]");
  if (notificationButton) {
    const item = (state.notifications || []).find((entry) => entry.id === notificationButton.dataset.notificationId);
    openNotificationTarget(item);
    return;
  }
  if (event.target.closest("[data-notification-read-all]")) {
    markAllNotificationsRead();
    return;
  }
  if (event.target.closest("[data-notification-clear-all]")) {
    openNotificationClearConfirm();
    return;
  }
  if (event.target.closest("[data-notification-open-center]")) {
    notificationSettingsOpen = false;
    closeWebNotifications();
    openNotificationCenter(true);
    return;
  }
  if (event.target.closest("[data-notification-settings]")) {
    notificationSettingsOpen = !notificationSettingsOpen;
    if (isMobileViewport() && mobileActiveSection === "notifications") renderMobileDashboard();
    else {
      closeWebNotifications();
      openNotificationCenter(true);
    }
    return;
  }
  if (webNotificationsOpen && !event.target.closest(".web-notification-wrap")) closeWebNotifications();
});
document.addEventListener("change", (event) => {
  if (event.target.matches("[data-notification-show-read]")) {
    notificationShowRead = event.target.checked;
    saveViewPrefs({ notificationShowRead });
    if (isMobileViewport() && mobileActiveSection === "notifications") renderMobileDashboard();
    renderNotificationSurfaces();
    return;
  }
  if (event.target.matches("[data-theme-setting]")) {
    const user = currentUser();
    if (!user) return;
    state.notificationSettingsByUser = state.notificationSettingsByUser || {};
    state.notificationSettingsByUser[user.id] = {
      ...notificationSettingsForUser(user.id),
      darkMode: event.target.checked
    };
    saveState();
    applyUserTheme();
    if (isMobileViewport() && mobileActiveSection === "settings") renderMobileDashboard();
    if (notificationCenterOpen) renderNotificationCenter();
    showToast(event.target.checked ? "다크 모드를 켰습니다." : "라이트 모드로 변경했습니다.");
    return;
  }
  const settingKey = event.target.dataset.notificationSetting;
  if (!settingKey) return;
  const user = currentUser();
  if (!user) return;
  state.notificationSettingsByUser = state.notificationSettingsByUser || {};
  state.notificationSettingsByUser[user.id] = { ...notificationSettingsForUser(user.id), [settingKey]: event.target.checked };
  saveState();
  if (isMobileViewport() && mobileActiveSection === "notifications") renderMobileDashboard();
  renderNotificationCenter();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (webNotificationsOpen) closeWebNotifications();
  if (notificationCenterOpen) openNotificationCenter(false);
  if ($("#notificationClearModal")?.classList.contains("open")) closeNotificationClearConfirm();
});
$("#mobileFabBtn")?.addEventListener("click", () => {
  closeMobileDetailSheets(() => {
    if (mobileActiveSection === "calendar") {
      openMobileAddSheet("schedule");
      return;
    }
    toggleMobileFab();
  });
});
$("#mobileFabMenu")?.addEventListener("click", (event) => {
  const mode = event.target.closest("[data-mobile-add]")?.dataset.mobileAdd;
  if (!mode) return;
  toggleMobileFab(false);
  closeMobileAddSheet();
  if (mode === "project") {
    mobileActiveSection = "projects";
    saveViewPrefs({ mobileActiveSection });
    addProject();
    return;
  }
  if (mode === "work") {
    mobileActiveSection = "works";
    saveViewPrefs({ mobileActiveSection });
    addWork();
  }
});
$("#mobileMoreSheet")?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-mobile-more-target]")?.dataset.mobileMoreTarget;
  if (!target) return;
  openMobileMoreSheet(false);
  openMobileSection(target);
});
$("#mobileAddSheet")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-mobile-add]")) {
    closeMobileAddSheet();
    return;
  }
  const dateTrigger = event.target.closest("[data-mobile-task-date-toggle]");
  if (dateTrigger) {
    event.stopPropagation();
    const field = dateTrigger.closest(".mobile-task-date-field");
    const input = field?.querySelector('input[type="hidden"]');
    if (!field || !input) return;
    $("#mobileAddForm")?.querySelectorAll("[data-mobile-task-dropdown].open").forEach((dropdown) => {
      dropdown.classList.remove("open");
      dropdown.querySelector("[data-mobile-task-dropdown-toggle]")?.setAttribute("aria-expanded", "false");
      dropdown.querySelector(".mobile-task-dropdown-menu")?.setAttribute("aria-hidden", "true");
    });
    openDatePicker(dateTrigger, input.value, (value) => {
      const noDueDate = field.closest("section")?.querySelector('input[name="noDueDate"]');
      if (!value) {
        input.value = "";
        if (noDueDate) noDueDate.checked = true;
        return;
      }
      input.value = value;
      if (noDueDate) noDueDate.checked = false;
      dateTrigger.querySelector("span").textContent = formatDate(value);
      dateTrigger.classList.add("has-value");
    });
    return;
  }
  const scheduleTimeTrigger = event.target.closest("[data-mobile-schedule-time-toggle]");
  if (scheduleTimeTrigger) {
    if (scheduleTimeTrigger.disabled) return;
    event.stopPropagation();
    const field = scheduleTimeTrigger.closest(".mobile-schedule-time-field");
    const input = field?.querySelector('input[type="hidden"]');
    if (!field || !input) return;
    openTimePicker(scheduleTimeTrigger, input.value, (value) => {
      input.value = value;
      scheduleTimeTrigger.querySelector("span").textContent = formatTimeButton(value);
    });
    return;
  }
  if (!event.target.closest("[data-mobile-schedule-owner-dropdown]")) {
    $("#mobileAddForm")?.querySelectorAll("[data-mobile-schedule-owner-dropdown][open]").forEach((dropdown) => { dropdown.open = false; });
  }
  const dropdownOption = event.target.closest("[data-mobile-task-dropdown-value]");
  if (dropdownOption) {
    const dropdown = dropdownOption.closest("[data-mobile-task-dropdown]");
    const input = dropdown?.querySelector('input[type="hidden"]');
    const trigger = dropdown?.querySelector("[data-mobile-task-dropdown-toggle]");
    if (!dropdown || !input || !trigger) return;
    input.value = dropdownOption.dataset.mobileTaskDropdownValue || "";
    trigger.querySelector("span").textContent = dropdownOption.dataset.mobileTaskDropdownLabel || "";
    trigger.classList.add("has-value");
    trigger.setAttribute("aria-expanded", "false");
    dropdown.querySelectorAll("[data-mobile-task-dropdown-value]").forEach((button) => {
      button.classList.toggle("selected", button === dropdownOption);
      button.setAttribute("aria-selected", String(button === dropdownOption));
    });
    dropdown.classList.remove("open");
    dropdown.querySelector(".mobile-task-dropdown-menu")?.setAttribute("aria-hidden", "true");
    return;
  }
  const dropdownToggle = event.target.closest("[data-mobile-task-dropdown-toggle]");
  if (dropdownToggle) {
    const dropdown = dropdownToggle.closest("[data-mobile-task-dropdown]");
    const willOpen = !dropdown?.classList.contains("open");
    $("#mobileAddForm")?.querySelectorAll("[data-mobile-task-dropdown]").forEach((item) => {
      item.classList.remove("open");
      item.querySelector("[data-mobile-task-dropdown-toggle]")?.setAttribute("aria-expanded", "false");
      item.querySelector(".mobile-task-dropdown-menu")?.setAttribute("aria-hidden", "true");
    });
    if (dropdown && willOpen) {
      dropdown.classList.add("open");
      dropdownToggle.setAttribute("aria-expanded", "true");
      dropdown.querySelector(".mobile-task-dropdown-menu")?.setAttribute("aria-hidden", "false");
    }
    return;
  }
  $("#mobileAddForm")?.querySelectorAll("[data-mobile-task-dropdown].open").forEach((dropdown) => {
    dropdown.classList.remove("open");
    dropdown.querySelector("[data-mobile-task-dropdown-toggle]")?.setAttribute("aria-expanded", "false");
    dropdown.querySelector(".mobile-task-dropdown-menu")?.setAttribute("aria-hidden", "true");
  });
});
$("#mobileAddSheet")?.addEventListener("change", (event) => {
  if (event.target.matches('#mobileAddForm[data-mode="work"] input[name="allDay"], #mobileAddForm[data-mode="work"] input[name="noSchedule"]')) {
    syncMobileWorkScheduleControls(event.target.closest(".mobile-work-schedule-form"));
    return;
  }
  if (event.target.matches('#mobileAddForm[data-mode="schedule"] input[name="allDay"]')) {
    const disabled = event.target.checked;
    event.target.closest("section")?.querySelectorAll("[data-mobile-schedule-time-toggle]").forEach((button) => {
      button.disabled = disabled;
      button.setAttribute("aria-disabled", String(disabled));
      button.closest(".mobile-schedule-time-field")?.classList.toggle("is-disabled", disabled);
    });
    return;
  }
  const ownerDropdown = event.target.closest("[data-mobile-schedule-owner-dropdown]");
  if (ownerDropdown && event.target.matches('input[name="owners"]')) updateMobileScheduleOwnerSummary(ownerDropdown);
});
$("#mobileAddForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitMobileAddForm(event.currentTarget);
});
$("#mobileApp")?.addEventListener("submit", (event) => {
  if (event.target.matches("[data-telegram-digest-form]")) {
    event.preventDefault();
    saveTelegramDigestSettings(event.target);
    return;
  }
  if (event.target.matches("[data-mobile-profile-form]")) {
    event.preventDefault();
    saveMobileProfile(event.target);
    return;
  }
  const optionGroup = event.target.dataset.mobileOptionAdd;
  if (optionGroup) {
    event.preventDefault();
    const value = String(event.target.elements.option?.value || "").trim();
    if (value) addOption(optionGroup, value);
  }
});
$("#mobileApp")?.addEventListener("change", (event) => {
  if (event.target.matches('[name="deliveryMode"]')) {
    toggleTelegramDigestScheduleFields(event.target.closest("[data-telegram-digest-form]"));
    return;
  }
  if (event.target.matches("[data-mobile-profile-photo]")) {
    prepareMobileProfilePhoto(event.target.files?.[0]);
    return;
  }
  if (event.target.matches("[data-mobile-organization-inactive]")) {
    mobileOrganizationIncludeInactive = event.target.checked;
    renderMobileDashboard();
    return;
  }
  if (event.target.matches("[data-mobile-start-section]")) {
    saveViewPrefs({ mobileStartSection: event.target.value });
    showToast("앱 시작 화면이 저장되었습니다.");
    return;
  }
  if (event.target.matches("[data-mobile-default-hide-done]")) {
    mobileTaskHideDone = event.target.checked;
    saveViewPrefs({ mobileTaskHideDone });
    return;
  }
  const mobilePosition = event.target.closest("[data-mobile-user-position]");
  if (mobilePosition) {
    setUserPosition(mobilePosition.dataset.mobileUserPosition, mobilePosition.value);
    return;
  }
  if (event.target.matches("[data-mobile-calendar-month-picker]")) {
    const [year, month] = String(event.target.value || "").split("-").map(Number);
    if (year && month) {
      calendarDate = new Date(year, month - 1, 1);
      const selectedDay = Math.min(new Date(`${selectedCalendarDate}T00:00:00`).getDate() || 1, new Date(year, month, 0).getDate());
      selectedCalendarDate = dateKey(new Date(year, month - 1, selectedDay));
      saveViewPrefs({ calendarDate: dateKey(calendarDate), selectedCalendarDate });
      renderMobileDashboard();
    }
    return;
  }
  if (event.target.matches("[data-mobile-calendar-filter-completed]")) {
    mobileCalendarFilterDraft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
    mobileCalendarFilterDraft.showCompleted = event.target.checked;
    renderMobileDashboard();
    return;
  }
  if (event.target.matches("[data-mobile-show-completed-projects]")) {
    projectHideDone = !event.target.checked;
    saveViewPrefs({ projectHideDone });
    renderMobileDashboard();
    return;
  }
  if (event.target.matches("[data-mobile-show-completed-works]")) {
    workHideDone = !event.target.checked;
    saveViewPrefs({ workHideDone });
    renderMobileDashboard();
    return;
  }
  const hideDone = event.target.closest("[data-mobile-hide-done]");
  if (hideDone) {
    mobileTaskHideDone = !hideDone.checked;
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
  setTaskCompletionState(item.task, event.target.checked);
  notifyTaskCompletion(item.source, item.task, item.task.done);
  saveState();
  renderAll();
});
$("#mobileApp")?.addEventListener("click", (event) => {
  const optionColorButton = event.target.closest("[data-option-color-group]");
  if (optionColorButton) {
    event.stopPropagation();
    openOptionColorPicker(optionColorButton, optionColorButton.dataset.optionColorGroup, optionColorButton.dataset.optionColorValue);
    return;
  }
  if (event.target.closest("[data-mobile-notifications-close]")) {
    openMobileSection(mobilePreviousSection === "notifications" ? "tasks" : mobilePreviousSection);
    return;
  }
  const moreRoute = event.target.closest("[data-mobile-more-route]")?.dataset.mobileMoreRoute;
  if (moreRoute) {
    navigateMobileMore(moreRoute);
    return;
  }
  if (event.target.closest("[data-mobile-more-back]")) {
    mobileMoreBack();
    return;
  }
  const memberId = event.target.closest("[data-mobile-member-id]")?.dataset.mobileMemberId;
  if (memberId) {
    navigateMobileMore(`member:${memberId}`);
    return;
  }
  if (event.target.closest("[data-mobile-profile-photo-delete]")) {
    deleteMobileProfilePhoto();
    return;
  }
  if (event.target.closest("[data-mobile-organization-retry]")) {
    refreshOrganizationDirectory();
    return;
  }
  const optionSave = event.target.closest("[data-mobile-option-save]");
  if (optionSave) {
    const manager = optionSave.closest("[data-mobile-option-group]");
    const input = optionSave.parentElement?.querySelector("[data-mobile-option-value]");
    if (manager && input) renameOption(manager.dataset.mobileOptionGroup, optionSave.dataset.mobileOptionSave, input.value);
    return;
  }
  const optionDelete = event.target.closest("[data-mobile-option-delete]");
  if (optionDelete) {
    const manager = optionDelete.closest("[data-mobile-option-group]");
    if (manager) confirmDelete(() => deleteOption(manager.dataset.mobileOptionGroup, optionDelete.dataset.mobileOptionDelete));
    return;
  }
  const saveOwnerLinks = event.target.closest("[data-save-owner-links]");
  if (saveOwnerLinks) {
    saveOwnerLinks.disabled = true;
    saveOwnerLinkSettings().finally(() => { saveOwnerLinks.disabled = false; });
    return;
  }
  if (event.target.closest("#mobileInlineLogoutBtn")) {
    $("#logoutBtn")?.click();
    return;
  }
  const moreTarget = event.target.closest("[data-mobile-more-target]")?.dataset.mobileMoreTarget;
  if (moreTarget) {
    openMobileSection(moreTarget);
    return;
  }
  const mobileAdminUser = event.target.closest("[data-mobile-admin-user]");
  const mobileUserRole = event.target.closest("[data-mobile-user-role]");
  if (mobileAdminUser && mobileUserRole) {
    setUserRole(mobileAdminUser.dataset.mobileAdminUser, mobileUserRole.dataset.mobileUserRole);
    renderMobileDashboard();
    return;
  }
  if (mobileAdminUser && event.target.closest("[data-mobile-user-pending]")) {
    markUserPending(mobileAdminUser.dataset.mobileAdminUser);
    renderMobileDashboard();
    return;
  }
  if (mobileAdminUser && event.target.closest("[data-mobile-user-approve]")) {
    approveUser(mobileAdminUser.dataset.mobileAdminUser);
    renderMobileDashboard();
    return;
  }
  if (mobileAdminUser && event.target.closest("[data-mobile-user-delete]")) {
    confirmDelete(() => {
      deleteUser(mobileAdminUser.dataset.mobileAdminUser);
      renderMobileDashboard();
    });
    return;
  }
  const projectId = event.target.closest("[data-mobile-open-project]")?.dataset.mobileOpenProject;
  if (projectId) {
    openProjectDetail(projectId);
    return;
  }
  const workId = event.target.closest("[data-mobile-open-work]")?.dataset.mobileOpenWork;
  if (workId) {
    openWorkDetail(workId);
    return;
  }
  if (event.target.closest("[data-mobile-open-project-sort]")) {
    mobileProjectSortOpen = !mobileProjectSortOpen;
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-close-project-sort]")) {
    mobileProjectSortOpen = false;
    renderMobileDashboard();
    return;
  }
  const projectSortButton = event.target.closest("[data-mobile-project-sort-key]");
  if (projectSortButton) {
    projectSort = {
      key: projectSortButton.dataset.mobileProjectSortKey,
      direction: projectSortButton.dataset.mobileProjectSortDirection
    };
    mobileProjectSortOpen = false;
    saveViewPrefs({ projectSort });
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-open-work-sort]")) {
    mobileWorkSortOpen = !mobileWorkSortOpen;
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-close-work-sort]")) {
    mobileWorkSortOpen = false;
    renderMobileDashboard();
    return;
  }
  const workSortButton = event.target.closest("[data-mobile-work-sort-key]");
  if (workSortButton) {
    workSort = {
      key: workSortButton.dataset.mobileWorkSortKey,
      direction: workSortButton.dataset.mobileWorkSortDirection
    };
    mobileWorkSortOpen = false;
    saveViewPrefs({ workSort });
    renderMobileDashboard();
    return;
  }
  const filter = event.target.closest("[data-mobile-task-filter]")?.dataset.mobileTaskFilter;
  if (filter) {
    mobileTaskFilter = filter;
    mobileTaskSortOpen = false;
    mobileTaskOwnerFilterOpen = false;
    saveViewPrefs({ mobileTaskFilter });
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-open-sort]")) {
    mobileTaskSortOpen = !mobileTaskSortOpen;
    mobileTaskOwnerFilterOpen = false;
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-close-sort]")) {
    mobileTaskSortOpen = false;
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-open-owner-filter]")) {
    mobileTaskOwnerFilterOpen = !mobileTaskOwnerFilterOpen;
    mobileTaskSortOpen = false;
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-close-owner-filter]")) {
    mobileTaskOwnerFilterOpen = false;
    renderMobileDashboard();
    return;
  }
  const owner = event.target.closest("[data-mobile-task-owner]")?.dataset.mobileTaskOwner;
  if (owner !== undefined) {
    mobileTaskOwner = owner;
    mobileTaskOwnerFilterOpen = false;
    saveViewPrefs({ mobileTaskOwner });
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
  if (event.target.closest("[data-overview-task-check]")) return;
  const taskButton = event.target.closest("[data-mobile-open-task-id]");
  if (taskButton) {
    openMobileTaskParent(taskButton.dataset.mobileOpenTaskSource, taskButton.dataset.mobileOpenTaskId);
    return;
  }
  const calendarEvent = event.target.closest("[data-mobile-calendar-event]");
  if (calendarEvent) {
    openCalendarEventDetail(calendarEvent);
    return;
  }
  const monthDate = event.target.closest("[data-mobile-month-date]")?.dataset.mobileMonthDate;
  if (monthDate) {
    selectedCalendarDate = monthDate;
    const selected = new Date(`${monthDate}T00:00:00`);
    if (selected.getFullYear() !== calendarDate.getFullYear() || selected.getMonth() !== calendarDate.getMonth()) {
      calendarDate = new Date(selected.getFullYear(), selected.getMonth(), 1);
    }
    saveViewPrefs({ selectedCalendarDate, calendarDate: dateKey(calendarDate) });
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-calendar-add]")) {
    openMobileAddSheet("schedule");
    return;
  }
  if (event.target.closest("[data-mobile-calendar-prev]")) {
    moveMobileCalendarPeriod(-1);
    return;
  }
  if (event.target.closest("[data-mobile-calendar-next]")) {
    moveMobileCalendarPeriod(1);
    return;
  }
  if (event.target.closest("[data-mobile-calendar-today]")) {
    selectedCalendarDate = mobileTodayKey();
    calendarDate = new Date(`${selectedCalendarDate}T00:00:00`);
    saveViewPrefs({ selectedCalendarDate, calendarDate: dateKey(calendarDate) });
    renderMobileDashboard();
    return;
  }
  const calendarViewMode = event.target.closest("[data-mobile-calendar-view]")?.dataset.mobileCalendarView;
  if (calendarViewMode) {
    mobileCalendarViewMode = calendarViewMode;
    saveViewPrefs({ mobileCalendarViewMode });
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-calendar-search-toggle]")) {
    mobileCalendarSearchOpen = !mobileCalendarSearchOpen;
    if (!mobileCalendarSearchOpen) mobileCalendarSearchQuery = "";
    renderMobileDashboard();
    if (mobileCalendarSearchOpen) setTimeout(() => $("[data-mobile-calendar-search-input]")?.focus(), 0);
    return;
  }
  if (event.target.closest("[data-mobile-calendar-search-close]")) {
    mobileCalendarSearchOpen = false;
    mobileCalendarSearchQuery = "";
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-calendar-filter-open]")) {
    mobileCalendarFilterDraft = cloneMobileCalendarFilters();
    mobileCalendarFilterOpen = true;
    renderMobileDashboard();
    setTimeout(() => $(".mobile-calendar-filter-sheet header [data-mobile-calendar-filter-reset]")?.focus(), 0);
    return;
  }
  if (event.target.closest("[data-mobile-calendar-filter-close]")) {
    closeMobileCalendarFilter();
    return;
  }
  if (event.target.closest("[data-mobile-calendar-filter-reset]")) {
    mobileCalendarFilterDraft = {
      owners: {},
      sources: { project: true, work: true, task: true, staff: true, schedule: true },
      recurring: "include",
      showCompleted: true
    };
    renderMobileDashboard();
    return;
  }
  const ownerFilter = event.target.closest("[data-mobile-calendar-filter-owner]")?.dataset.mobileCalendarFilterOwner;
  if (ownerFilter) {
    mobileCalendarFilterDraft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
    if (ownerFilter === "all") {
      const allSelected = ownerFilterKeys().every((key) => ownerFilterEnabled(mobileCalendarFilterDraft.owners, key));
      mobileCalendarFilterDraft.owners = allSelected
        ? Object.fromEntries(ownerFilterKeys().map((key) => [key, false]))
        : {};
    }
    else if (ownerFilterKeys().every((key) => ownerFilterEnabled(mobileCalendarFilterDraft.owners, key))) {
      mobileCalendarFilterDraft.owners = Object.fromEntries(ownerFilterKeys().map((key) => [key, key === ownerFilter]));
    } else mobileCalendarFilterDraft.owners[ownerFilter] = !ownerFilterEnabled(mobileCalendarFilterDraft.owners, ownerFilter);
    renderMobileDashboard();
    return;
  }
  const sourceFilter = event.target.closest("[data-mobile-calendar-filter-source]")?.dataset.mobileCalendarFilterSource;
  if (sourceFilter) {
    mobileCalendarFilterDraft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
    if (sourceFilter === "all") {
      const allSelected = mobileCalendarSources.every(([key]) => mobileCalendarFilterEnabled(mobileCalendarFilterDraft.sources, key));
      mobileCalendarFilterDraft.sources = Object.fromEntries(mobileCalendarSources.map(([key]) => [key, !allSelected]));
    }
    else if (mobileCalendarSources.every(([key]) => mobileCalendarFilterEnabled(mobileCalendarFilterDraft.sources, key))) {
      mobileCalendarFilterDraft.sources = Object.fromEntries(mobileCalendarSources.map(([key]) => [key, key === sourceFilter]));
    } else mobileCalendarFilterDraft.sources[sourceFilter] = !mobileCalendarFilterEnabled(mobileCalendarFilterDraft.sources, sourceFilter);
    renderMobileDashboard();
    return;
  }
  const recurringFilter = event.target.closest("[data-mobile-calendar-filter-recurring]")?.dataset.mobileCalendarFilterRecurring;
  if (recurringFilter) {
    mobileCalendarFilterDraft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
    mobileCalendarFilterDraft.recurring = recurringFilter;
    renderMobileDashboard();
    return;
  }
  if (event.target.closest("[data-mobile-calendar-filter-apply]")) {
    const draft = mobileCalendarFilterDraft || cloneMobileCalendarFilters();
    calendarOwnerFilters = { ...draft.owners };
    calendarSourceFilters = { ...draft.sources };
    calendarRecurringFilter = draft.recurring;
    calendarShowCompleted = draft.showCompleted;
    mobileCalendarFilterOpen = false;
    mobileCalendarFilterDraft = null;
    saveViewPrefs({ calendarOwnerFilters, calendarSourceFilters, calendarRecurringFilter, calendarShowCompleted });
    renderCalendar();
    renderMobileDashboard();
    setTimeout(() => $("[data-mobile-calendar-filter-open]")?.focus(), 0);
    return;
  }
});

// iOS Safari/PWA에서 일부 동적 버튼의 click이 누락되는 경우를 보완합니다.
$("#mobileApp")?.addEventListener("touchstart", (event) => {
  if (event.touches.length !== 1 || !(event.target instanceof Element)) return;
  const actionable = event.target.closest("button, [data-mobile-open-task-id], label.mobile-hide-done-toggle, label.mobile-setting-toggle, label.mobile-directory-inactive");
  if (!actionable || event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  const touch = event.touches[0];
  mobileTouchActivation = { target: actionable, x: touch.clientX, y: touch.clientY, at: Date.now() };
}, { passive: true });

$("#mobileApp")?.addEventListener("touchend", (event) => {
  if (!mobileTouchActivation || event.changedTouches.length !== 1) return;
  const activation = mobileTouchActivation;
  mobileTouchActivation = null;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - activation.x;
  const dy = touch.clientY - activation.y;
  if (Math.hypot(dx, dy) > 14 || Date.now() - activation.at > 900 || !activation.target.isConnected) return;
  event.preventDefault();
  activation.target.click();
}, { passive: false });

$("#mobileApp")?.addEventListener("touchcancel", () => { mobileTouchActivation = null; }, { passive: true });

function moveMobileCalendarMonth(delta) {
  const target = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + delta, 1);
  const currentDay = new Date(`${selectedCalendarDate}T00:00:00`).getDate() || 1;
  const day = Math.min(currentDay, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate());
  calendarDate = target;
  selectedCalendarDate = dateKey(new Date(target.getFullYear(), target.getMonth(), day));
  saveViewPrefs({ calendarDate: dateKey(calendarDate), selectedCalendarDate });
  renderCalendar();
  renderMobileDashboard();
}

function moveMobileCalendarPeriod(delta) {
  if (mobileCalendarViewMode !== "week") {
    moveMobileCalendarMonth(delta);
    return;
  }
  const target = new Date(`${selectedCalendarDate}T00:00:00`);
  target.setDate(target.getDate() + delta * 7);
  selectedCalendarDate = dateKey(target);
  calendarDate = new Date(target.getFullYear(), target.getMonth(), 1);
  saveViewPrefs({ calendarDate: dateKey(calendarDate), selectedCalendarDate });
  renderCalendar();
  renderMobileDashboard();
}

function closeMobileCalendarFilter() {
  mobileCalendarFilterOpen = false;
  mobileCalendarFilterDraft = null;
  renderMobileDashboard();
  setTimeout(() => $("[data-mobile-calendar-filter-open]")?.focus(), 0);
}

$("#mobileApp")?.addEventListener("input", (event) => {
  if (event.target.matches("[data-mobile-profile-form] input[name='phone']")) {
    mobileProfileDirty = true;
    return;
  }
  if (event.target.matches("[data-mobile-organization-search]")) {
    mobileOrganizationSearch = event.target.value;
    clearTimeout(mobileOrganizationSearchTimer);
    mobileOrganizationSearchTimer = setTimeout(() => {
      renderMobileDashboard();
      const input = $("[data-mobile-organization-search]");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }, 180);
    return;
  }
  if (event.target.matches("[data-mobile-calendar-search-input]")) {
    mobileCalendarSearchQuery = event.target.value;
    renderMobileDashboard();
    const input = $("[data-mobile-calendar-search-input]");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
});

$("#mobileApp")?.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest("[data-mobile-option-drag]");
  const row = handle?.closest("[data-mobile-option-index]");
  const group = handle?.closest("[data-mobile-option-group]")?.dataset.mobileOptionGroup;
  if (!handle || !row || !group) return;
  mobileOptionDrag = { pointerId: event.pointerId, group, from: Number(row.dataset.mobileOptionIndex), to: Number(row.dataset.mobileOptionIndex) };
  handle.setPointerCapture?.(event.pointerId);
  row.classList.add("is-dragging");
  event.preventDefault();
});

$("#mobileApp")?.addEventListener("pointermove", (event) => {
  if (!mobileOptionDrag || mobileOptionDrag.pointerId !== event.pointerId) return;
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-mobile-option-index]");
  const group = row?.closest("[data-mobile-option-group]")?.dataset.mobileOptionGroup;
  if (row && group === mobileOptionDrag.group) mobileOptionDrag.to = Number(row.dataset.mobileOptionIndex);
  event.preventDefault();
}, { passive: false });

const finishMobileOptionDrag = (event) => {
  if (!mobileOptionDrag || mobileOptionDrag.pointerId !== event.pointerId) return;
  const drag = mobileOptionDrag;
  mobileOptionDrag = null;
  if (drag.from !== drag.to) reorderOption(drag.group, drag.from, drag.to);
  else $("[data-mobile-option-index].is-dragging")?.classList.remove("is-dragging");
};
$("#mobileApp")?.addEventListener("pointerup", finishMobileOptionDrag);
$("#mobileApp")?.addEventListener("pointercancel", finishMobileOptionDrag);

$("#mobileApp")?.addEventListener("touchstart", (event) => {
  if (mobileActiveSection !== "calendar" || event.touches.length !== 1 || !event.target.closest("[data-mobile-calendar-swipe]")) return;
  const touch = event.touches[0];
  mobileCalendarSwipeStart = { x: touch.clientX, y: touch.clientY };
}, { passive: true });

$("#mobileApp")?.addEventListener("touchend", (event) => {
  if (!mobileCalendarSwipeStart || mobileActiveSection !== "calendar") return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - mobileCalendarSwipeStart.x;
  const dy = touch.clientY - mobileCalendarSwipeStart.y;
  mobileCalendarSwipeStart = null;
  if (Math.abs(dx) < 70 || Math.abs(dy) > 55) return;
  moveMobileCalendarPeriod(dx < 0 ? 1 : -1);
}, { passive: true });

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mobileCalendarFilterOpen) closeMobileCalendarFilter();
});
window.addEventListener("popstate", handleMobilePopState);
createMobileEdgeSwipeBack();
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

function setProjectBroadcastCompleted(project, completed) {
  const nextValue = Boolean(completed);
  if (!project || project.broadcastCompleted === nextValue) return false;
  project.broadcastCompleted = nextValue;
  notifyEntityFieldChanges({ entityType: "project", entity: project, ownerIds: projectOwners(project), fields: ["broadcastCompleted"] });
  saveState();
  return true;
}

$("#projectsView").addEventListener("change", (event) => {
  const completeInput = event.target.closest("[data-project-complete]");
  if (!completeInput) return;
  const project = state.projects.find((item) => item.id === completeInput.dataset.projectComplete);
  if (!project || !canEditProject(project)) return;
  setProjectBroadcastCompleted(project, completeInput.checked);
  renderAll();
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

$("#authForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if ($("#authForm").classList.contains("signup-mode")) return;
  login($("#authId").value, $("#authPassword").value);
});

$("#signupBtn").addEventListener("click", () => showAuthMode("signup"));

$("#backLoginBtn").addEventListener("click", () => showAuthMode("login"));

$("#signupPositionButton").addEventListener("click", (event) => {
  event.stopPropagation();
  setAuthPositionMenu(!event.currentTarget.classList.contains("open"));
});

$("#signupPositionMenu").addEventListener("click", (event) => {
  event.stopPropagation();
  const option = event.target.closest("[data-auth-position]");
  if (option) selectAuthPosition(option.dataset.authPosition);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".auth-position-field")) setAuthPositionMenu(false);
});

$("#createAccountBtn").addEventListener("click", () => {
  signup(
    $("#signupEmail").value,
    $("#signupPassword").value,
    $("#signupPasswordConfirm").value,
    $("#signupName").value,
    $("#signupPosition").value
  );
});

$("#accountMenuBtn")?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleDesktopAccountMenu();
});
$("#closeDesktopOrganizationBtn")?.addEventListener("click", () => openDesktopOrganization(false));
$("#desktopOrganizationModal")?.addEventListener("click", (event) => {
  if (event.target.id === "desktopOrganizationModal") openDesktopOrganization(false);
});
$("#desktopOrganizationSearch")?.addEventListener("input", (event) => {
  mobileOrganizationSearch = event.target.value;
  renderDesktopOrganization();
});
$("#closeDesktopProfileBtn")?.addEventListener("click", () => openDesktopProfile(false));
$("#desktopProfileModal")?.addEventListener("click", (event) => {
  if (event.target.id === "desktopProfileModal") openDesktopProfile(false);
});
$("#desktopProfileModal")?.addEventListener("change", async (event) => {
  if (!event.target.matches("[data-desktop-profile-photo]")) return;
  await prepareMobileProfilePhoto(event.target.files?.[0]);
  openDesktopProfile(true);
});
$("#desktopProfileModal")?.addEventListener("click", async (event) => {
  if (event.target.closest("[data-desktop-profile-photo-delete]")) {
    await deleteMobileProfilePhoto();
    openDesktopProfile(true);
  }
});
$("#desktopProfileForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveMobileProfile(event.currentTarget);
  openDesktopProfile(false);
});

document.addEventListener("click", (event) => {
  const accountAction = event.target.closest("[data-desktop-account-action]")?.dataset.desktopAccountAction;
  if (accountAction) {
    toggleDesktopAccountMenu(false);
    if (accountAction === "organization") openDesktopOrganization(true);
    if (accountAction === "profile") openDesktopProfile(true);
    if (accountAction === "settings") {
      notificationSettingsOpen = true;
      openNotificationCenter(true);
    }
    return;
  }
  if (!event.target.closest("#sidebarAccountMenu, #accountMenuBtn")) toggleDesktopAccountMenu(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  toggleDesktopAccountMenu(false);
  openDesktopOrganization(false);
  openDesktopProfile(false);
  if ($("#studioTelegramPreviewModal")?.classList.contains("open")) {
    closeStudioTelegramPreview();
    return;
  }
  if ($("#studioTelegramModal")?.classList.contains("open")) closeStudioTelegramModal();
});

$("#logoutBtn").addEventListener("click", async () => {
  toggleDesktopAccountMenu(false);
  currentProfile = null;
  state.currentUser = null;
  saveState();
  if (SUPABASE_ENABLED) {
    await getSupabaseClient()?.auth.signOut().catch(() => {
      showToast("서버 로그아웃 처리가 지연되고 있습니다.");
    });
  }
  if (SHARE_TOKEN) {
    try {
      const payload = await fetchSharedLinkPayload();
      if (payload) {
        installSharedGuestState(payload);
        renderAll();
        openSharedLinkTarget(payload);
        return;
      }
    } catch (error) {
      console.warn("Shared link reload after logout failed", error);
    }
  }
  renderAll();
});

document.body.addEventListener("click", (event) => {
  if (event.target.closest("button, input, label, textarea, select, .custom-select, .date-button")) return;
  const projectId = event.target.closest("[data-open-project]")?.dataset.openProject;
  if (projectId) openProjectDetail(projectId);
  const workId = event.target.closest("[data-open-work]")?.dataset.openWork;
  if (workId) openWorkDetail(workId);
});

$("#calendarView").addEventListener("change", (event) => {
  const ownerCheckbox = event.target.closest("[data-calendar-owner-filter]");
  if (ownerCheckbox) {
    const ownerId = ownerCheckbox.dataset.calendarOwnerFilter;
    if (ownerId === "all") ownerFilterKeys().forEach((key) => { calendarOwnerFilters[key] = ownerCheckbox.checked; });
    else calendarOwnerFilters[ownerId] = ownerCheckbox.checked;
    saveViewPrefs({ calendarOwnerFilters });
    renderCalendar();
    return;
  }
  if (event.target.id === "calendarHideRecurring") {
    calendarHideRecurring = event.target.checked;
    saveViewPrefs({ calendarHideRecurring });
    renderCalendar();
    return;
  }
  const checkbox = event.target.closest("[data-calendar-filter]");
  if (!checkbox) return;
  const key = checkbox.dataset.calendarFilter;
  if (key === "all") {
    calendarFilters = { video: checkbox.checked, work: checkbox.checked, staff: checkbox.checked, schedule: checkbox.checked };
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
  if (event.target.closest("#studioTelegramManageBtn")) {
    openStudioTelegramModal();
    return;
  }
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
  const ownerFilter = event.target.closest("[data-studio-owner-filter]");
  if (ownerFilter) {
    const ownerId = ownerFilter.dataset.studioOwnerFilter;
    if (ownerId === "all") ownerFilterKeys().forEach((key) => { studioOwnerFilters[key] = ownerFilter.checked; });
    else studioOwnerFilters[ownerId] = ownerFilter.checked;
    saveViewPrefs({ studioOwnerFilters });
    renderStudioManage({ preserveScroll: true });
    return;
  }
  if (event.target.id === "studioHideRecurring") {
    studioHideRecurring = event.target.checked;
    saveViewPrefs({ studioHideRecurring });
    renderStudioManage({ preserveScroll: true });
    return;
  }
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
$("#shareProjectBtn").addEventListener("click", (event) => {
  if (activeProjectId) createAndCopyShareLink("project", activeProjectId, event.currentTarget);
});
$("#saveProjectBasicBtn").addEventListener("click", () => saveProjectBasicChanges());
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
$("#shareWorkBtn").addEventListener("click", (event) => {
  if (activeWorkId) createAndCopyShareLink("work", activeWorkId, event.currentTarget);
});
$("#saveWorkBasicBtn").addEventListener("click", () => saveWorkBasicChanges());
$("#deleteWorkDetailBtn").addEventListener("click", () => {
  if (activeWorkId) confirmDelete(() => deleteWork(activeWorkId));
});
$$('[data-share-login]').forEach((button) => button.addEventListener("click", requestSharedLinkLogin));
$("#deleteConfirmCancelBtn").addEventListener("click", closeDeleteConfirm);
$("#deleteConfirmBtn").addEventListener("click", runDeleteConfirm);
$("#deleteConfirmModal").addEventListener("click", (event) => {
  if (event.target.id === "deleteConfirmModal") closeDeleteConfirm();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#deleteConfirmModal")?.classList.contains("open")) closeDeleteConfirm();
});
$("#unsavedBasicSaveBtn").addEventListener("click", () => {
  const pending = pendingBasicLeaveAction;
  const scope = pendingBasicLeaveScope;
  if (!pending || !scope) return;
  if (scope === "project") saveProjectBasicChanges({ showMessage: false });
  if (scope === "work") saveWorkBasicChanges({ showMessage: false });
  closeUnsavedBasicModal();
  pendingBasicLeaveAction = null;
  pendingBasicLeaveScope = "";
  pending.run();
  showToast("변경사항을 저장했습니다.");
});
$("#unsavedBasicDiscardBtn").addEventListener("click", () => {
  const pending = pendingBasicLeaveAction;
  const scope = pendingBasicLeaveScope;
  if (!pending || !scope) return;
  discardBasicChanges(scope);
  closeUnsavedBasicModal();
  pendingBasicLeaveAction = null;
  pendingBasicLeaveScope = "";
  pending.run();
});
function cancelUnsavedBasicLeave() {
  const focusTarget = pendingBasicLeaveAction?.focusTarget;
  closeUnsavedBasicModal();
  pendingBasicLeaveAction = null;
  pendingBasicLeaveScope = "";
  focusTarget?.focus?.();
}
$("#unsavedBasicCancelBtn").addEventListener("click", cancelUnsavedBasicLeave);
$("#unsavedBasicModal").addEventListener("click", (event) => {
  if (event.target.id === "unsavedBasicModal") cancelUnsavedBasicLeave();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#unsavedBasicModal")?.classList.contains("open")) cancelUnsavedBasicLeave();
});
window.addEventListener("beforeunload", (event) => {
  if (!projectBasicIsDirty() && !workBasicIsDirty()) return;
  event.preventDefault();
  event.returnValue = "";
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
  if (!work || !canEditWork(work)) return;
  if (event.target.closest("[data-work-studio-memo-toggle]")) {
    const memo = $("#workStudioMemo");
    if (memo) ensureWorkStudioReservation(work).memo = memo.value;
    workStudioMemoOpen = !workStudioMemoOpen;
    renderWorkStudioReservation(work);
    return;
  }
  if (!work.studioReservationEnabled) return;
  const reservation = ensureWorkStudioReservation(work);
  if (event.target.closest("#workStudioAddStaffBtn")) {
    if (reservation.staffRows.length < 6) reservation.staffRows.push(makeDefaultStaffRow(reservation.staffRows.length));
    renderWorkStudioReservation(work);
    const newRow = $("#workStudioRows")?.lastElementChild;
    newRow?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    newRow?.querySelector("button")?.focus();
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
  const nextTab = tab.dataset.workDetailTab;
  if (nextTab === activeWorkDetailTab) return;
  requestBasicLeave("work", () => {
    activeWorkDetailTab = nextTab;
    renderWorkDetailTabs();
    const work = state.works.find((item) => item.id === activeWorkId);
    syncBasicSaveButton("work", canEditWork(work));
  }, tab);
});
document.querySelector(".detail-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-detail-tab]");
  if (!tab) return;
  const nextTab = tab.dataset.detailTab;
  if (nextTab === activeDetailTab) return;
  requestBasicLeave("project", () => {
    activeDetailTab = nextTab;
    renderDetailTabs();
    const project = state.projects.find((item) => item.id === activeProjectId);
    syncBasicSaveButton("project", canEditProject(project));
  }, tab);
});

$("#workTaskPanel").addEventListener("click", (event) => {
  if (event.target.closest("[data-work-task-recurrence-toggle]")) {
    syncWorkTaskDraftInputs();
    workTaskRecurrenceOpen = !workTaskRecurrenceOpen;
    const work = state.works.find((item) => item.id === activeWorkId);
    if (work) renderWorkTasks(work);
    return;
  }
  if (event.target.closest("[data-work-task-detail-toggle]")) {
    syncWorkTaskDraftInputs();
    workTaskDetailOpen = !workTaskDetailOpen;
    const work = state.works.find((item) => item.id === activeWorkId);
    if (work) renderWorkTasks(work);
    return;
  }
  if (event.target.closest("#cancelWorkTaskBtn")) {
    const work = state.works.find((item) => item.id === activeWorkId);
    if (work) {
      resetWorkTaskDraft(work);
      workTaskComposerOpen = false;
      renderWorkTasks(work);
    }
    return;
  }
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
    const work = state.works.find((item) => item.id === activeWorkId);
    const task = work?.tasks?.find((item) => item.id === editButton.dataset.editWorkTask);
    if (task?.isRecurring) openWorkTaskScopeModal("edit", task.id);
    else editWorkTask(editButton.dataset.editWorkTask);
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
  if (task?.isRecurring) {
    openWorkTaskScopeModal("delete", taskId);
    return;
  }
  confirmDelete(() => {
    notifyTaskDeletion("work", task);
    work.tasks = work.tasks.filter((item) => item.id !== taskId);
    saveState();
    renderAll();
    renderWorkDetail();
  });
});

$("#workTaskScopeCancelBtn")?.addEventListener("click", closeWorkTaskScopeModal);
$("#workTaskScopeModal")?.addEventListener("click", (event) => {
  if (event.target.id === "workTaskScopeModal") {
    closeWorkTaskScopeModal();
    return;
  }
  const scopeButton = event.target.closest("[data-work-task-scope]");
  if (!scopeButton || !pendingWorkTaskScopeAction) return;
  const pending = { ...pendingWorkTaskScopeAction };
  const scope = scopeButton.dataset.workTaskScope;
  closeWorkTaskScopeModal();
  if (pending.action === "edit") {
    if (pending.entity === "project") editProjectTask(pending.taskId, scope);
    else editWorkTask(pending.taskId, scope);
  } else {
    confirmDelete(() => pending.entity === "project" ? deleteProjectTaskByScope(pending.taskId, scope) : deleteWorkTaskByScope(pending.taskId, scope));
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#workTaskScopeModal")?.classList.contains("open")) closeWorkTaskScopeModal();
});

$("#workTaskPanel").addEventListener("change", (event) => {
  if (!event.target.matches("#workTaskHideDone")) return;
  workTaskHideDone = event.target.checked;
  saveViewPrefs({ workTaskHideDone });
  const work = state.works.find((item) => item.id === activeWorkId);
  if (work) renderWorkTasks(work);
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
  setTaskCompletionState(task, event.target.checked);
  notifyTaskCompletion("work", task, task.done);
  saveState();
  renderAll();
  renderWorkDetail();
});

$("#workManagementRecords").addEventListener("click", (event) => {
  const themeButton = event.target.closest("[data-work-record-theme]");
  if (themeButton) {
    selectedWorkRecordTheme = normalizeManagementRecordTheme(themeButton.dataset.workRecordTheme);
    updateManagementRecordThemePicker($("#workManagementRecords"), "data-work-record-theme", selectedWorkRecordTheme);
    return;
  }
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
    const work = state.works.find((item) => item.id === activeWorkId);
    const record = work?.records?.find((item) => item.id === editButton.dataset.editWorkRecord);
    if (!canManageRecord(record)) return showToast("작성자 본인만 관리기록을 수정할 수 있습니다.");
    editingWorkRecordId = editButton.dataset.editWorkRecord;
    selectedWorkRecordTheme = normalizeManagementRecordTheme(record?.theme);
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
    selectedWorkRecordTheme = "work_content";
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
  const themeButton = event.target.closest("[data-record-theme]");
  if (themeButton) {
    selectedRecordTheme = normalizeManagementRecordTheme(themeButton.dataset.recordTheme);
    updateManagementRecordThemePicker($("#managementRecords"), "data-record-theme", selectedRecordTheme);
    return;
  }
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
    const project = state.projects.find((item) => item.id === activeProjectId);
    const record = project?.records?.find((item) => item.id === editButton.dataset.editRecord);
    if (!canManageRecord(record)) return showToast("작성자 본인만 관리기록을 수정할 수 있습니다.");
    editingRecordId = editButton.dataset.editRecord;
    selectedRecordTheme = normalizeManagementRecordTheme(record?.theme);
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
    selectedRecordTheme = "work_content";
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
  if (event.target.closest("[data-project-task-recurrence-toggle]")) {
    syncProjectTaskDraftInputs();
    detailTaskRecurrenceOpen = !detailTaskRecurrenceOpen;
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project) renderProjectTasks(project);
    return;
  }
  if (event.target.closest("[data-project-task-detail-toggle]")) {
    syncProjectTaskDraftInputs();
    detailTaskDetailOpen = !detailTaskDetailOpen;
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project) renderProjectTasks(project);
    return;
  }
  if (event.target.closest("#cancelProjectTaskBtn")) {
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project) {
      resetProjectTaskDraft(project);
      detailTaskComposerOpen = false;
      renderProjectTasks(project);
    }
    return;
  }
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
    const task = state.tasks.find((item) => item.id === editButton.dataset.editProjectTask);
    if (task?.isRecurring) openProjectTaskScopeModal("edit", task.id);
    else editProjectTask(editButton.dataset.editProjectTask);
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
  if (task?.isRecurring) {
    openProjectTaskScopeModal("delete", taskId);
    return;
  }
  confirmDelete(() => {
    notifyTaskDeletion("project", task);
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    saveState();
    renderAll();
    renderProjectDetail();
  });
});

$("#projectTaskPanel").addEventListener("change", (event) => {
  if (event.target.matches("#projectTaskHideDone")) {
    detailTaskHideDone = event.target.checked;
    saveViewPrefs({ detailTaskHideDone });
    const project = state.projects.find((item) => item.id === activeProjectId);
    if (project) renderProjectTasks(project);
    return;
  }
  const taskId = event.target.dataset.projectTaskCheck;
  if (!taskId) return;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!canManageTask(task)) {
    event.target.checked = !event.target.checked;
    showToast("담당자 또는 관리자만 할 일을 변경할 수 있습니다.");
    return;
  }
  setTaskCompletionState(task, event.target.checked);
  notifyTaskCompletion("project", task, task.done);
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
  setTaskCompletionState(item.task, event.target.checked);
  notifyTaskCompletion(item.source, item.task, item.task.done);
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
    detailTaskHideDone = false;
    openProjectDetail(item.sourceId, "tasks");
    renderDetailTabs();
    clearTaskHighlight("project");
  }
  if (item.source === "work") {
    highlightedWorkTaskId = item.id;
    workTaskHideDone = false;
    openWorkDetail(item.sourceId, "tasks");
    renderWorkDetailTabs();
    clearTaskHighlight("work");
  }
});

$("#hideDoneTasks").addEventListener("change", (event) => {
  taskOverviewHideDone = event.target.checked;
  saveViewPrefs({ taskOverviewHideDone });
  renderTasks();
});

$("#hideCompletedProjects").addEventListener("change", (event) => {
  projectHideDone = event.target.checked;
  saveViewPrefs({ projectHideDone });
  renderProjectList();
});

$("#hideCompletedWorks").addEventListener("change", (event) => {
  workHideDone = event.target.checked;
  saveViewPrefs({ workHideDone });
  renderWorkList();
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
$("#sendStaffEventTelegramBtn").addEventListener("click", (event) => {
  if (activeStaffEventId) sendStudioEventTelegram(activeStaffEventId, event.currentTarget);
});
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
  const activeEvent = state.staffEvents.find((item) => item.id === activeStaffEventId);
  if (!activeEvent) return;
  const telegramNote = event.target.closest("[data-studio-event-telegram-note]");
  if (telegramNote) {
    activeEvent.telegramNote = telegramNote.value.slice(0, 1000);
    saveState();
    return;
  }
  const memoInput = event.target.closest("[data-detail-staff-row-memo]");
  if (!memoInput) return;
  const row = normalizeStaffEventRows(activeEvent).find((item) => item.id === memoInput.dataset.detailStaffRowMemo);
  if (!row) return;
  row.memo = memoInput.value;
  saveState();
});
$("#staffEventDetailContent").addEventListener("change", (event) => {
  if (!event.target.matches("[data-studio-event-call-time-offset]")) return;
  const activeEvent = state.staffEvents.find((item) => item.id === activeStaffEventId);
  if (!activeEvent) return;
  activeEvent.telegramCallTimeEnabled = true;
  activeEvent.telegramCallTimeOffsetMinutes = normalizeStudioCallTimeOffset(event.target.value);
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

$("#closeStudioTelegramBtn").addEventListener("click", closeStudioTelegramModal);
$("#cancelStudioTelegramBtn").addEventListener("click", closeStudioTelegramModal);
$("#studioTelegramModal").addEventListener("click", (event) => {
  if (event.target.id === "studioTelegramModal") closeStudioTelegramModal();
  if (!studioTelegramDraft) return;
  if (event.target.closest("#studioTelegramAddRuleBtn")) {
    if (studioTelegramDraft.rules.length >= 30) return showToast("예약 규칙은 최대 30개까지 만들 수 있습니다.");
    openStudioTelegramRuleEditor();
    return;
  }
  const previewButton = event.target.closest("[data-preview-studio-rule]");
  if (previewButton) {
    previewStudioTelegramRule(previewButton.dataset.previewStudioRule, previewButton);
    return;
  }
  const editButton = event.target.closest("[data-edit-studio-rule]");
  if (editButton) {
    openStudioTelegramRuleEditor(editButton.dataset.editStudioRule);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-studio-rule]");
  if (deleteButton) {
    studioTelegramDraft.rules = studioTelegramDraft.rules.filter((rule) => rule.id !== deleteButton.dataset.deleteStudioRule);
    if (studioTelegramRuleEditor?.rule.id === deleteButton.dataset.deleteStudioRule) studioTelegramRuleEditor = null;
    renderStudioTelegramRules();
    return;
  }
  if (event.target.closest("[data-confirm-studio-rule]")) return confirmStudioTelegramRuleEditor();
  if (event.target.closest("[data-cancel-studio-rule]")) {
    studioTelegramRuleEditor = null;
    renderStudioTelegramRules();
  }
});
$("#closeStudioTelegramPreviewBtn").addEventListener("click", closeStudioTelegramPreview);
$("#cancelStudioTelegramPreviewBtn").addEventListener("click", closeStudioTelegramPreview);
$("#confirmStudioTelegramSendBtn").addEventListener("click", confirmStudioTelegramSend);
$("#studioTelegramPreviewModal").addEventListener("click", (event) => {
  if (event.target.id === "studioTelegramPreviewModal") closeStudioTelegramPreview();
});
function updateStudioTelegramDraftField(target) {
  const enabledRuleId = target.dataset.studioRuleEnabled;
  if (enabledRuleId) {
    const rule = studioTelegramDraft?.rules.find((item) => item.id === enabledRuleId);
    if (!rule) return false;
    rule.enabled = target.checked;
    target.closest(".studio-rule-summary")?.classList.toggle("is-disabled", !target.checked);
    return true;
  }
  const field = target.dataset.studioRuleEditorField;
  if (!field || !studioTelegramRuleEditor) return false;
  studioTelegramRuleEditor.rule[field] = target.type === "checkbox"
    ? target.checked
    : ["weekday", "callTimeOffsetMinutes"].includes(field)
      ? Number(target.value)
      : target.value;
  if (field === "notice") {
    const count = target.closest(".studio-rule-notice")?.querySelector("[data-studio-rule-notice-count]");
    if (count) count.textContent = `${target.value.length} / 1500`;
  }
  return true;
}
$("#studioTelegramRules").addEventListener("input", (event) => updateStudioTelegramDraftField(event.target));
$("#studioTelegramRules").addEventListener("change", (event) => {
  if (!updateStudioTelegramDraftField(event.target)) return;
  if (event.target.dataset.studioRuleEditorField === "mode") renderStudioTelegramRules();
});
$("#studioTelegramFixedNotice").addEventListener("input", (event) => {
  if (!studioTelegramDraft) return;
  studioTelegramDraft.fixedNotice = event.target.value.slice(0, 1500);
  $("#studioTelegramFixedNoticeCount").textContent = `${studioTelegramDraft.fixedNotice.length} / 1500`;
});
$("#studioTelegramForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveStudioTelegramSettings();
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

$("#adminContent").addEventListener("submit", async (event) => {
  event.preventDefault();
  const telegramForm = event.target.closest("[data-telegram-digest-form]");
  if (telegramForm) {
    await saveTelegramDigestSettings(telegramForm);
    return;
  }
  const manager = event.target.closest("[data-option-group]");
  if (!manager) return;
  addOption(manager.dataset.optionGroup, new FormData(event.target).get("option"));
});

$("#adminContent").addEventListener("click", (event) => {
  if (monthlyReportMonthPickerOpen && !event.target.closest("[data-monthly-report-month-control]")) {
    monthlyReportMonthPickerOpen = false;
    $(".monthly-report-month-popover")?.remove();
    $("[data-monthly-report-month-trigger]")?.setAttribute("aria-expanded", "false");
  }
  const monthTrigger = event.target.closest("[data-monthly-report-month-trigger]");
  if (monthTrigger) {
    monthlyReportMonthPickerOpen = !monthlyReportMonthPickerOpen;
    if (monthlyReportMonthPickerOpen) monthlyReportPickerYear = Number(monthlyReportMonth.slice(0, 4));
    renderAdmin();
    return;
  }
  const yearStep = event.target.closest("[data-monthly-report-year-step]");
  if (yearStep) {
    monthlyReportPickerYear = Math.max(1900, Math.min(2200, monthlyReportPickerYear + Number(yearStep.dataset.monthlyReportYearStep || 0)));
    renderAdmin();
    return;
  }
  const monthValue = event.target.closest("[data-monthly-report-month-value]")?.dataset.monthlyReportMonthValue;
  if (monthValue) {
    selectMonthlyReportMonth(monthValue);
    return;
  }
  if (event.target.closest("[data-monthly-report-current-month]")) {
    selectMonthlyReportMonth(dateKey(new Date()).slice(0, 7));
    return;
  }
  const reportStepButton = event.target.closest("[data-monthly-report-step]");
  if (reportStepButton) {
    selectMonthlyReportStep(reportStepButton.dataset.monthlyReportStep);
    return;
  }
  const reportNextButton = event.target.closest("[data-monthly-report-next]");
  if (reportNextButton) {
    selectMonthlyReportStep(reportNextButton.dataset.monthlyReportNext);
    return;
  }
  const collectReportButton = event.target.closest("[data-monthly-report-collect]");
  if (collectReportButton) {
    collectMonthlyReportPreview();
    renderAdmin();
    return;
  }
  const gptReportButton = event.target.closest("[data-monthly-report-gpt]");
  if (gptReportButton) {
    generateMonthlyReportWithGpt(gptReportButton);
    return;
  }
  const downloadReportButton = event.target.closest("[data-monthly-report-download]");
  if (downloadReportButton) {
    downloadMonthlyReportWord(downloadReportButton);
    return;
  }
  if (event.target.closest("[data-monthly-report-save-prompt]")) {
    saveMonthlyReportPrompt(event.target.closest("[data-monthly-report-save-prompt]"));
    return;
  }
  const colorButton = event.target.closest("[data-option-color-group]");
  if (colorButton) {
    event.stopPropagation();
    openOptionColorPicker(colorButton, colorButton.dataset.optionColorGroup, colorButton.dataset.optionColorValue);
    return;
  }
  const sectionButton = event.target.closest("[data-admin-section]");
  if (sectionButton) {
    adminSection = sectionButton.dataset.adminSection;
    saveViewPrefs({ adminSection });
    renderAdmin();
    return;
  }
  const telegramPreviewButton = event.target.closest("[data-telegram-preview]");
  if (telegramPreviewButton) {
    runTelegramDigestAction("preview", telegramPreviewButton);
    return;
  }
  const telegramSendButton = event.target.closest("[data-telegram-send]");
  if (telegramSendButton) {
    runTelegramDigestAction("send", telegramSendButton);
    return;
  }
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

$("#adminContent").addEventListener("input", (event) => {
  const promptInput = event.target.closest("[data-monthly-report-prompt]");
  if (promptInput) {
    state.monthlyReport = { prompt: String(promptInput.value || "").slice(0, 12000) };
    return;
  }
  const sectionTextInput = event.target.closest("[data-monthly-report-section-text]");
  if (sectionTextInput) {
    updateMonthlyReportTextSection(sectionTextInput.dataset.monthlyReportSectionText, sectionTextInput.value);
    return;
  }
  const textInput = event.target.closest("[data-monthly-report-text]");
  if (!textInput) return;
  const item = monthlyReportFindItem(textInput.dataset.monthlyReportText, textInput.dataset.monthlyReportScope);
  if (item) item.text = textInput.value.slice(0, 500);
});

$("#adminContent").addEventListener("change", async (event) => {
  const reportGroupInclude = event.target.closest("[data-monthly-report-group-include]");
  if (reportGroupInclude) {
    setMonthlyReportGroupIncluded(
      reportGroupInclude.dataset.monthlyReportScope || "preview",
      reportGroupInclude.dataset.monthlyReportGroupInclude,
      reportGroupInclude.checked
    );
    renderAdmin();
    return;
  }
  const reportInclude = event.target.closest("[data-monthly-report-include]");
  if (reportInclude) {
    const scope = reportInclude.dataset.monthlyReportScope || "preview";
    const sections = scope === "draft" ? monthlyReportDraft : monthlyReportPreview;
    const changedIds = window.MonthlyReportCore?.setPreviewItemIncluded
      ? window.MonthlyReportCore.setPreviewItemIncluded(sections, reportInclude.dataset.monthlyReportInclude, reportInclude.checked)
      : (() => {
        const item = monthlyReportFindItem(reportInclude.dataset.monthlyReportInclude, scope);
        if (item) item.included = reportInclude.checked;
        return [reportInclude.dataset.monthlyReportInclude];
      })();
    if (scope === "draft") {
      invalidateMonthlyReportResult();
      renderAdmin();
      return;
    }
    const changedSet = new Set(changedIds);
    $("#adminContent")?.querySelectorAll(`[data-monthly-report-include][data-monthly-report-scope="${scope}"]`).forEach((input) => {
      if (!changedSet.has(input.dataset.monthlyReportInclude)) return;
      const changedItem = monthlyReportFindItem(input.dataset.monthlyReportInclude, scope);
      if (!changedItem) return;
      input.checked = changedItem.included !== false;
      input.closest("[data-monthly-report-item]")?.classList.toggle("is-excluded", changedItem.included === false);
    });
    return;
  }
  const activityFilter = event.target.closest("[data-activity-log-filter]");
  if (activityFilter) {
    updateAdminActivityFilter(activityFilter.dataset.activityLogFilter, activityFilter.value);
    renderAdmin();
    return;
  }
  if (event.target.matches('[name="deliveryMode"]')) {
    toggleTelegramDigestScheduleFields(event.target.closest("[data-telegram-digest-form]"));
    return;
  }
  const positionSelect = event.target.closest("[data-user-position]");
  if (positionSelect) {
    setUserPosition(positionSelect.dataset.userPosition, positionSelect.value);
    return;
  }
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
if (["overview", "projects", "works", "tasks", "calendar", "studio", "board", "admin"].includes(hashView)) setView(hashView);
renderAll();
initSupabaseSession();

document.addEventListener("pointerdown", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled || button.matches(".mobile-board-row")) return;
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
