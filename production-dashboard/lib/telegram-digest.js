const SEOUL_TIME_ZONE = "Asia/Seoul";
const DASHBOARD_STATE_ROW_ID = "main";
const TELEGRAM_STATUS_ROW_ID = "telegram-digest-status";
const TELEGRAM_STUDIO_STATUS_ROW_ID = "telegram-studio-status";

export const TELEGRAM_DIGEST_DEFAULTS = {
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

export const STUDIO_TELEGRAM_DEFAULTS = {
  fixedNotice: "",
  rules: []
};

const STUDIO_CALL_TIME_OFFSETS = [30, 60, 120, 180, 240, 300, 360];

function normalizeStudioCallTimeOffset(value) {
  const minutes = Number(value);
  return STUDIO_CALL_TIME_OFFSETS.includes(minutes) ? minutes : 60;
}

function cleanText(value, maxLength = 500) {
  return String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

export function normalizeTelegramDigestSettings(value = {}) {
  const include = value && typeof value.include === "object" ? value.include : {};
  const hour = Math.max(0, Math.min(23, Number(String(value.deliveryTime || TELEGRAM_DIGEST_DEFAULTS.deliveryTime).split(":")[0]) || 0));
  return {
    deliveryMode: value.deliveryMode === "daily" ? "daily" : "manual",
    deliveryTime: `${String(hour).padStart(2, "0")}:00`,
    include: Object.fromEntries(Object.keys(TELEGRAM_DIGEST_DEFAULTS.include).map((key) => [key, include[key] !== false])),
    additionalMessage: cleanText(value.additionalMessage, 1000)
  };
}

export function normalizeStudioTelegramSettings(value = {}) {
  const rules = Array.isArray(value?.rules) ? value.rules : [];
  return {
    fixedNotice: cleanText(value.fixedNotice, 1500),
    rules: rules.slice(0, 30).map((rule, index) => {
      const rawHour = Number(String(rule.deliveryTime || "09:00").split(":")[0]);
      const hour = Math.max(0, Math.min(23, Number.isFinite(rawHour) ? rawHour : 9));
      const notice = rule.notice !== undefined ? rule.notice : rule.fixedNotice;
      return {
        id: cleanText(rule.id || `studio-rule-${index + 1}`, 80).replace(/[^a-zA-Z0-9_-]/g, "-") || `studio-rule-${index + 1}`,
        name: cleanText(rule.name || `공지 규칙 ${index + 1}`, 80),
        enabled: rule.enabled !== false,
        trainingType: cleanText(rule.trainingType || "all", 120) || "all",
        mode: rule.mode === "weekly" ? "weekly" : "previous-day",
        weekday: Math.max(0, Math.min(6, Number(rule.weekday) || 0)),
        deliveryTime: `${String(hour).padStart(2, "0")}:00`,
        includeCallTime: true,
        callTimeOffsetMinutes: normalizeStudioCallTimeOffset(rule.callTimeOffsetMinutes),
        notice: cleanText(notice, 1500)
      };
    })
  };
}

function seoulDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SEOUL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    key: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour || 0)
  };
}

function dateDiff(dateKey, todayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return null;
  const target = Date.parse(`${dateKey}T00:00:00Z`);
  const today = Date.parse(`${todayKey}T00:00:00Z`);
  return Math.round((target - today) / 86400000);
}

function koreanDateLabel(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(date);
}

function ownerNameMap(state) {
  return new Map((state.owners || []).map((owner) => [owner.id, owner.name || owner.id]));
}

function ownerLabels(item, owners) {
  const ids = Array.isArray(item?.owners) ? item.owners : [item?.owner].filter(Boolean);
  const labels = ids.map((id) => owners.get(id) || id).filter(Boolean);
  return labels.length ? labels.join(", ") : "미배정";
}

function openTaskItems(state) {
  const projects = new Map((state.projects || []).map((project) => [project.id, project]));
  const projectTasks = (state.tasks || []).map((task) => {
    const project = projects.get(task.projectId);
    return { task, source: "영상", parentTitle: project?.title || "영상 제목 없음" };
  });
  const workTasks = (state.works || []).flatMap((work) => (work.tasks || []).map((task) => ({
    task,
    source: "업무",
    parentTitle: work.title || "업무 제목 없음"
  })));
  return [...projectTasks, ...workTasks]
    .filter((item) => !item.task.done && !item.task.noDueDate && item.task.dueDate)
    .sort((a, b) => `${a.task.dueDate} ${a.task.startTime || ""}`.localeCompare(`${b.task.dueDate} ${b.task.startTime || ""}`));
}

function isCompletedStatus(value) {
  return /완료|납품|종료/.test(String(value || ""));
}

function taskLine(item, owners, todayKey) {
  const task = item.task || {};
  const diff = dateDiff(task.dueDate, todayKey);
  const due = diff === 0 ? "오늘" : diff > 0 ? `D-${diff}` : `지연 ${Math.abs(diff)}일`;
  const time = task.allDay === false && task.startTime ? ` ${task.startTime}` : "";
  return `• [${item.source}] ${cleanText(item.parentTitle, 80)} · ${cleanText(task.text || task.title || "할 일", 120)} (${due}${time}, ${cleanText(ownerLabels(task, owners), 80)})`;
}

function deadlineLine(item, owners, todayKey) {
  const diff = dateDiff(item.finalDate, todayKey);
  const due = diff === 0 ? "오늘" : `D-${diff}`;
  return `• ${cleanText(item.title || "제목 없음", 140)} (${due}, ${cleanText(ownerLabels(item, owners), 80)})`;
}

function section(title, items, lineBuilder) {
  const visible = items.slice(0, 18);
  const lines = visible.length ? visible.map(lineBuilder) : ["• 해당 항목 없음"];
  if (items.length > visible.length) lines.push(`• 외 ${items.length - visible.length}건은 대시보드에서 확인`);
  return [`[${title} · ${items.length}건]`, ...lines].join("\n");
}

export function buildTelegramDigest(state = {}, rawSettings = {}, options = {}) {
  const settings = normalizeTelegramDigestSettings(rawSettings);
  const todayKey = options.todayKey || seoulDateParts(options.now || new Date()).key;
  const owners = ownerNameMap(state);
  const tasks = openTaskItems(state);
  const projects = (state.projects || []).filter((item) => item.finalDate && !isCompletedStatus(item.status));
  const works = (state.works || []).filter((item) => item.finalDate && !item.noSchedule && !isCompletedStatus(item.status));
  const selectedSections = [];

  const taskSections = [
    ["tasksToday", "📌 오늘 할 일", tasks.filter((item) => dateDiff(item.task.dueDate, todayKey) === 0)],
    ["tasksThreeDays", "⏳ 3일 이내 할 일", tasks.filter((item) => {
      const diff = dateDiff(item.task.dueDate, todayKey);
      return diff >= 1 && diff <= 3;
    })],
    ["tasksWeek", "🗓 1주일 이내 할 일", tasks.filter((item) => {
      const diff = dateDiff(item.task.dueDate, todayKey);
      return diff >= 4 && diff <= 7;
    })]
  ];
  taskSections.forEach(([key, title, items]) => {
    if (settings.include[key]) selectedSections.push(section(title, items, (item) => taskLine(item, owners, todayKey)));
  });

  const deadlineSections = [
    ["projectsToday", "🎬 오늘 마감 · 영상", projects.filter((item) => dateDiff(item.finalDate, todayKey) === 0)],
    ["projectsSoon", "⚠️ 마감 임박 · 영상", projects.filter((item) => {
      const diff = dateDiff(item.finalDate, todayKey);
      return diff >= 1 && diff <= 3;
    })],
    ["worksToday", "📂 오늘 마감 · 업무", works.filter((item) => dateDiff(item.finalDate, todayKey) === 0)],
    ["worksSoon", "⚠️ 마감 임박 · 업무", works.filter((item) => {
      const diff = dateDiff(item.finalDate, todayKey);
      return diff >= 1 && diff <= 3;
    })]
  ];
  deadlineSections.forEach(([key, title, items]) => {
    if (settings.include[key]) selectedSections.push(section(title, items, (item) => deadlineLine(item, owners, todayKey)));
  });

  if (!selectedSections.length) selectedSections.push("[알림 항목]\n• 선택된 항목이 없습니다.");
  if (settings.additionalMessage) selectedSections.push(settings.additionalMessage);

  const message = `📋 영상제작과 업무 브리핑\n${koreanDateLabel(todayKey)}\n\n${selectedSections.join("\n\n")}`;
  if (message.length <= 4000) return message;
  return `${message.slice(0, 3940).trimEnd()}\n\n…일부 항목은 대시보드에서 확인해 주세요.`;
}

function offsetDateKey(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function dateWeekday(value) {
  return new Date(`${value}T00:00:00Z`).getUTCDay();
}

function callTimeLabel(startTime, offsetMinutes = 60) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(startTime || ""));
  if (!match) return "";
  const minutes = Number(match[1]) * 60 + Number(match[2]) - normalizeStudioCallTimeOffset(offsetMinutes);
  const wrapped = (minutes + 1440) % 1440;
  const label = `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
  return minutes < 0 ? `${label} (전날)` : label;
}

function studioOwnerLabel(ownerId, owners) {
  return cleanText(owners.get(ownerId) || ownerId || "미배정", 80);
}

function studioShortDateLabel(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}(${weekdays[date.getUTCDay()]})`;
}

function studioStaffEmoji(type) {
  const value = String(type || "");
  if (/\bPD\b/i.test(value) || /영상|카메라/.test(value)) return "🎥";
  if (/\bCG\b/i.test(value) || /자막/.test(value)) return "💻";
  if (/\bPC\b/i.test(value) || /송출|중계/.test(value)) return "🖥️";
  if (/음향|오디오|sound/i.test(value)) return "🎧";
  return "👤";
}

function studioEventBlock(event, owners, { includeCallTime = true, callTimeOffsetMinutes = 60 } = {}) {
  const rows = Array.isArray(event.staffRows) && event.staffRows.length
    ? event.staffRows
    : [{ type: event.type || "스탭", owner: event.owner || "" }];
  const startTime = cleanText(event.startTime || "09:00", 10);
  const lines = [`📡 ${cleanText(event.title || event.trainingType || "방송실 일정", 120)}`];
  const callTime = callTimeLabel(event.startTime, callTimeOffsetMinutes);
  lines.push(includeCallTime && callTime ? `⏰ [${startTime}] ${callTime} 도착` : `⏰ [${startTime}] 일정 시작`);
  lines.push(`📍 장소 - ${cleanText(event.room || "장소 미정", 120)}`);
  rows.slice(0, 12).forEach((row) => {
    const type = cleanText(row.type || "스탭", 80);
    lines.push(`${studioStaffEmoji(type)} ${type} - ${studioOwnerLabel(row.owner, owners)}`);
  });
  return lines.join("\n");
}

export function buildStudioTelegramMessage(state = {}, events = [], options = {}) {
  const owners = ownerNameMap(state);
  const sorted = [...events].sort((a, b) => `${a.date || ""} ${a.startTime || ""}`.localeCompare(`${b.date || ""} ${b.startTime || ""}`));
  if (!sorted.length) return "";
  const fixedNotice = cleanText(options.fixedNotice, 1500);
  const ruleNotice = cleanText(options.notice, 1500);
  const eventBlock = (event) => studioEventBlock(event, owners, {
    includeCallTime: options.includeCallTime !== false,
    callTimeOffsetMinutes: normalizeStudioCallTimeOffset(options.callTimeOffsetMinutes)
  });
  const isWeekly = options.mode === "weekly";
  let header = `🎬 ${studioShortDateLabel(sorted[0].date)} 방송실 스탭 공지`;
  let body = sorted.map(eventBlock).join("\n\n──────────\n\n");
  if (isWeekly) {
    const referenceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.referenceDate || "")) ? options.referenceDate : "";
    const rangeStart = referenceDate ? offsetDateKey(referenceDate, 1) : sorted[0].date;
    const rangeEnd = referenceDate ? offsetDateKey(referenceDate, 7) : sorted[sorted.length - 1].date;
    header = `🎬 ${studioShortDateLabel(rangeStart)}~${studioShortDateLabel(rangeEnd)} 방송실 주간 스탭 공지`;
    const dateGroups = [];
    sorted.forEach((event) => {
      const current = dateGroups[dateGroups.length - 1];
      if (current?.date === event.date) current.events.push(event);
      else dateGroups.push({ date: event.date, events: [event] });
    });
    body = dateGroups.map((group) => [
      `📅 ${studioShortDateLabel(group.date)}`,
      group.events.map(eventBlock).join("\n\n──────────\n\n")
    ].join("\n\n")).join("\n\n\n");
  }
  const sharedNotices = [
    fixedNotice,
    ruleNotice,
    ...sorted.map((event) => cleanText(event.telegramNote, 1000))
  ].filter(Boolean);
  const message = [
    `${header}\n\n${body}`,
    sharedNotices.length ? `📢 특이사항\n${sharedNotices.join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
  if (message.length <= 4000) return message;
  return `${message.slice(0, 3940).trimEnd()}\n\n…나머지 일정은 대시보드에서 확인해 주세요.`;
}

function studioEventsForRule(state, rule, todayKey) {
  const events = Array.isArray(state.staffEvents) ? state.staffEvents : [];
  const matchesType = (event) => rule.trainingType === "all" || event.trainingType === rule.trainingType;
  if (dateWeekday(todayKey) !== rule.weekday) return [];
  if (rule.mode === "previous-day") {
    const tomorrow = offsetDateKey(todayKey, 1);
    return events.filter((event) => event.date === tomorrow && matchesType(event));
  }
  return events.filter((event) => {
    const diff = dateDiff(event.date, todayKey);
    return diff >= 1 && diff <= 7 && matchesType(event);
  });
}

export function studioPreviewEventsForRule(state, rule, todayKey) {
  const events = (Array.isArray(state.staffEvents) ? state.staffEvents : [])
    .filter((event) => rule.trainingType === "all" || event.trainingType === rule.trainingType)
    .filter((event) => {
      const diff = dateDiff(event.date, todayKey);
      return diff !== null && diff >= 0;
    })
    .sort((a, b) => `${a.date || ""} ${a.startTime || ""}`.localeCompare(`${b.date || ""} ${b.startTime || ""}`));
  if (rule.mode === "weekly") {
    return events.filter((event) => dateDiff(event.date, todayKey) <= 7);
  }
  const nearestDate = events[0]?.date;
  return nearestDate ? events.filter((event) => event.date === nearestDate) : [];
}

export function studioGlobalFixedNotice(state) {
  return normalizeStudioTelegramSettings(state.studioTelegram || {}).fixedNotice;
}

function envValue(...keys) {
  return keys.map((key) => process.env[key]).find(Boolean) || "";
}

function supabaseConfig({ privileged = false } = {}) {
  const url = envValue("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
  const anonKey = envValue("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const secretKey = envValue("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");
  return { url, key: privileged ? secretKey : anonKey, anonKey, secretKey };
}

function restHeaders(apiKey, accessToken = "") {
  const headers = {
    apikey: apiKey,
    "Content-Type": "application/json"
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  else if (!String(apiKey).startsWith("sb_secret_")) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function readDashboardRow(id, { accessToken = "", privileged = false } = {}) {
  const config = supabaseConfig({ privileged });
  if (!config.url || !config.key) throw new Error(privileged ? "SUPABASE_SECRET_KEY가 설정되지 않았습니다." : "Supabase 환경변수가 없습니다.");
  const response = await fetch(`${config.url}/rest/v1/dashboard_state?id=eq.${encodeURIComponent(id)}&select=data,updated_at`, {
    headers: restHeaders(config.key, accessToken)
  });
  if (!response.ok) throw new Error(`Supabase 데이터를 읽지 못했습니다. (${response.status})`);
  const rows = await response.json();
  return rows[0] || null;
}

async function upsertDashboardRow(id, data, { accessToken = "", privileged = false } = {}) {
  const config = supabaseConfig({ privileged });
  if (!config.url || !config.key) throw new Error(privileged ? "SUPABASE_SECRET_KEY가 설정되지 않았습니다." : "Supabase 환경변수가 없습니다.");
  const response = await fetch(`${config.url}/rest/v1/dashboard_state?on_conflict=id`, {
    method: "POST",
    headers: {
      ...restHeaders(config.key, accessToken),
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({ id, data, updated_at: new Date().toISOString() })
  });
  if (!response.ok) throw new Error(`Supabase 상태를 저장하지 못했습니다. (${response.status})`);
}

async function acquireRunLock(id, data = {}) {
  const config = supabaseConfig({ privileged: true });
  if (!config.url || !config.key) throw new Error("SUPABASE_SECRET_KEY가 설정되지 않았습니다.");
  const response = await fetch(`${config.url}/rest/v1/dashboard_state`, {
    method: "POST",
    headers: {
      ...restHeaders(config.key),
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ id, data: { status: "sending", startedAt: new Date().toISOString(), ...data } })
  });
  if (response.status === 409) return { acquired: false, id };
  if (!response.ok) throw new Error(`예약 전송 잠금을 만들지 못했습니다. (${response.status})`);
  return { acquired: true, id };
}

async function verifyAdminAccess(accessToken) {
  const { url, anonKey } = supabaseConfig();
  if (!url || !anonKey || !accessToken) return false;
  const userResponse = await fetch(`${url}/auth/v1/user`, {
    headers: restHeaders(anonKey, accessToken)
  });
  if (!userResponse.ok) return false;
  const user = await userResponse.json();
  if (!user?.id) return false;
  const profileResponse = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role,status,approved`, {
    headers: restHeaders(anonKey, accessToken)
  });
  if (!profileResponse.ok) return false;
  const profiles = await profileResponse.json();
  const profile = profiles[0];
  return profile?.role === "admin" && profile?.approved === true && ["approved", "active"].includes(profile?.status);
}

function escapeTelegramHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatTelegramMessageHtml(text) {
  return String(text || "").split("\n").map((line) => {
    const escapedLine = escapeTelegramHtml(line);
    if (/^\[.+ · \d+건\]$/.test(line) || /^\[[^\]]+\](?:\[[^\]]+\])?$/.test(line) || /^🎬 /.test(line) || /^📅 /.test(line) || /^📡 /.test(line) || /^⏰ /.test(line) || line === "📢 특이사항") return `<b>${escapedLine}</b>`;
    return escapedLine;
  }).join("\n");
}

async function sendTelegramMessage(text) {
  const token = envValue("TELEGRAM_BOT_TOKEN");
  const chatId = envValue("TELEGRAM_CHAT_ID");
  if (!token || !chatId) throw new Error("텔레그램 봇 토큰 또는 챗 아이디가 설정되지 않았습니다.");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: formatTelegramMessageHtml(text), parse_mode: "HTML" })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(result.description || `텔레그램 전송에 실패했습니다. (${response.status})`);
  return result.result || {};
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function publicError(error) {
  const message = String(error?.message || "요청을 처리하지 못했습니다.");
  if (/TELEGRAM|SUPABASE|텔레그램|Supabase|예약 전송/.test(message)) return message;
  console.error(error);
  return "요청을 처리하지 못했습니다. Vercel 로그를 확인해 주세요.";
}

export async function handleTelegramDigestRequest(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ ok: false, error: "지원하지 않는 요청입니다." });
  const accessToken = bearerToken(req);
  if (!await verifyAdminAccess(accessToken)) return res.status(403).json({ ok: false, error: "관리자 인증이 필요합니다." });

  try {
    if (req.method === "GET") {
      const [status, studioStatus] = await Promise.all([
        readDashboardRow(TELEGRAM_STATUS_ROW_ID, { accessToken }).catch(() => null),
        readDashboardRow(TELEGRAM_STUDIO_STATUS_ROW_ID, { accessToken }).catch(() => null)
      ]);
      return res.status(200).json({
        ok: true,
        configured: Boolean(envValue("TELEGRAM_BOT_TOKEN") && envValue("TELEGRAM_CHAT_ID")),
        schedulerConfigured: Boolean(envValue("CRON_SECRET") && envValue("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY")),
        status: status?.data || null,
        studioStatus: studioStatus?.data || null
      });
    }

    const action = String(req.body?.action || "send");
    const row = await readDashboardRow(DASHBOARD_STATE_ROW_ID, { accessToken });
    const state = row?.data || {};
    if (action === "studio-rule-preview") {
      const previewSettings = normalizeStudioTelegramSettings({
        fixedNotice: req.body?.fixedNotice,
        rules: [req.body?.rule || {}]
      });
      const rule = previewSettings.rules[0];
      if (!rule) return res.status(400).json({ ok: false, error: "미리볼 예약 규칙을 찾을 수 없습니다." });
      const { key: todayKey } = seoulDateParts(new Date());
      const events = studioPreviewEventsForRule(state, rule, todayKey);
      if (!events.length) return res.status(404).json({ ok: false, error: "이 규칙으로 미리볼 예정 일정이 없습니다." });
      const message = buildStudioTelegramMessage(state, events, {
        mode: rule.mode,
        includeCallTime: true,
        callTimeOffsetMinutes: rule.callTimeOffsetMinutes,
        fixedNotice: previewSettings.fixedNotice,
        notice: rule.notice
      });
      return res.status(200).json({ ok: true, message, eventCount: events.length, ruleName: rule.name });
    }
    if (action === "studio-preview" || action === "studio-send") {
      const eventId = cleanText(req.body?.eventId, 120);
      const studioEvent = (state.staffEvents || []).find((event) => event.id === eventId);
      if (!studioEvent) return res.status(404).json({ ok: false, error: "방송실 일정을 찾을 수 없습니다." });
      const studioSettings = normalizeStudioTelegramSettings(state.studioTelegram || {});
      const message = buildStudioTelegramMessage(state, [studioEvent], {
        title: "방송실 일정 안내",
        includeCallTime: true,
        callTimeOffsetMinutes: normalizeStudioCallTimeOffset(studioEvent.telegramCallTimeOffsetMinutes),
        fixedNotice: studioSettings.fixedNotice
      });
      if (action === "studio-preview") return res.status(200).json({ ok: true, message });
      const telegramResult = await sendTelegramMessage(message);
      const studioStatus = {
        type: "manual",
        status: "sent",
        sentAt: new Date().toISOString(),
        eventId,
        messageId: telegramResult.message_id || null
      };
      await upsertDashboardRow(TELEGRAM_STUDIO_STATUS_ROW_ID, studioStatus, { accessToken });
      return res.status(200).json({ ok: true, message, status: studioStatus });
    }

    const settings = normalizeTelegramDigestSettings(state.telegramDigest || {});
    const message = buildTelegramDigest(state, settings);
    if (action === "preview") return res.status(200).json({ ok: true, message });

    const telegramResult = await sendTelegramMessage(message);
    const status = {
      type: "manual",
      status: "sent",
      sentAt: new Date().toISOString(),
      messageId: telegramResult.message_id || null
    };
    await upsertDashboardRow(TELEGRAM_STATUS_ROW_ID, status, { accessToken });
    return res.status(200).json({ ok: true, message, status });
  } catch (error) {
    return res.status(500).json({ ok: false, error: publicError(error) });
  }
}

export async function handleScheduledTelegramDigest(req, res, scheduledHour) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "지원하지 않는 요청입니다." });
  const cronSecret = envValue("CRON_SECRET");
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) return res.status(401).json({ ok: false, error: "예약 실행 인증에 실패했습니다." });

  try {
    const row = await readDashboardRow(DASHBOARD_STATE_ROW_ID, { privileged: true });
    const state = row?.data || {};
    const now = new Date();
    const { key: todayKey } = seoulDateParts(now);
    const results = [];
    const failures = [];

    const digestSettings = normalizeTelegramDigestSettings(state.telegramDigest || {});
    const digestHour = Number(String(digestSettings.deliveryTime).slice(0, 2));
    if (digestSettings.deliveryMode === "daily" && Number(scheduledHour) === digestHour) {
      const lock = await acquireRunLock(`telegram-digest-run-${todayKey}`, { date: todayKey, kind: "digest" });
      if (!lock.acquired) {
        results.push({ kind: "digest", skipped: "already-sent" });
      } else {
        try {
          const message = buildTelegramDigest(state, digestSettings, { now, todayKey });
          const telegramResult = await sendTelegramMessage(message);
          const status = { type: "scheduled", status: "sent", sentAt: new Date().toISOString(), date: todayKey, deliveryTime: digestSettings.deliveryTime, messageId: telegramResult.message_id || null };
          await upsertDashboardRow(lock.id, status, { privileged: true });
          await upsertDashboardRow(TELEGRAM_STATUS_ROW_ID, status, { privileged: true });
          results.push({ kind: "digest", status });
        } catch (error) {
          const status = { type: "scheduled", status: "failed", failedAt: new Date().toISOString(), date: todayKey, error: publicError(error) };
          await upsertDashboardRow(lock.id, status, { privileged: true }).catch(() => {});
          await upsertDashboardRow(TELEGRAM_STATUS_ROW_ID, status, { privileged: true }).catch(() => {});
          failures.push({ kind: "digest", error: status.error });
        }
      }
    }

    const studioSettings = normalizeStudioTelegramSettings(state.studioTelegram || {});
    for (const rule of studioSettings.rules) {
      const ruleHour = Number(String(rule.deliveryTime).slice(0, 2));
      if (!rule.enabled || Number(scheduledHour) !== ruleHour) continue;
      const events = studioEventsForRule(state, rule, todayKey);
      if (!events.length) {
        results.push({ kind: "studio", ruleId: rule.id, skipped: "no-events" });
        continue;
      }
      const lock = await acquireRunLock(`telegram-studio-run-${rule.id}-${todayKey}`, { date: todayKey, kind: "studio", ruleId: rule.id });
      if (!lock.acquired) {
        results.push({ kind: "studio", ruleId: rule.id, skipped: "already-sent" });
        continue;
      }
      try {
        const message = buildStudioTelegramMessage(state, events, {
          mode: rule.mode,
          referenceDate: todayKey,
          includeCallTime: rule.includeCallTime,
          callTimeOffsetMinutes: rule.callTimeOffsetMinutes,
          fixedNotice: studioSettings.fixedNotice,
          notice: rule.notice
        });
        const telegramResult = await sendTelegramMessage(message);
        const status = {
          type: "scheduled",
          status: "sent",
          sentAt: new Date().toISOString(),
          date: todayKey,
          ruleId: rule.id,
          ruleName: rule.name,
          eventCount: events.length,
          deliveryTime: rule.deliveryTime,
          messageId: telegramResult.message_id || null
        };
        await upsertDashboardRow(lock.id, status, { privileged: true });
        await upsertDashboardRow(TELEGRAM_STUDIO_STATUS_ROW_ID, status, { privileged: true });
        results.push({ kind: "studio", ruleId: rule.id, status });
      } catch (error) {
        const status = { type: "scheduled", status: "failed", failedAt: new Date().toISOString(), date: todayKey, ruleId: rule.id, ruleName: rule.name, error: publicError(error) };
        await upsertDashboardRow(lock.id, status, { privileged: true }).catch(() => {});
        await upsertDashboardRow(TELEGRAM_STUDIO_STATUS_ROW_ID, status, { privileged: true }).catch(() => {});
        failures.push({ kind: "studio", ruleId: rule.id, error: status.error });
      }
    }

    if (failures.length) return res.status(500).json({ ok: false, results, failures });
    return res.status(200).json({ ok: true, results, skipped: results.length ? undefined : "no-matching-schedule" });
  } catch (error) {
    return res.status(500).json({ ok: false, error: publicError(error) });
  }
}
