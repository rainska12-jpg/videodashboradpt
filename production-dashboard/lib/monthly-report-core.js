(function monthlyReportModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MonthlyReportCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createMonthlyReportCore() {
  "use strict";

  const SOURCE_TYPES = new Set(["video_project", "work_project", "task", "management_record", "studio_schedule"]);
  const SECTION_KEYS = ["activity", "production", "next"];
  const DEFAULT_PROMPT = `제공된 원본 데이터만 사용하여 월말보고서를 작성한다.

월말보고서에서는 세부 업무 설명보다 날짜와 공식 제목이 중요하다.

결과를 활동내용, 제작물현황, 차월계획으로 구분한다.

각 항목에는 실제 날짜와 영상 제목, 업무 제목, 할 일 제목 또는 일정 제목을 정확하게 유지한다.

날짜를 변경하거나 원본에 없는 날짜를 새로 만들지 않는다.

업무명, 영상명, 일정명 및 고유명사를 임의로 수정하지 않는다.

관리기록은 본문 내용이 아니라 기록이 작성된 날짜만 업무 수행 근거로 사용한다.

관리기록 중 카테고리가 업무내용인 기록만 사용한다.

관리기록 본문 내용을 추측하거나 요약하거나 보고서에 작성하지 않는다.

같은 프로젝트의 여러 관리기록은 프로젝트별로 묶고 날짜를 중복 제거한 뒤 시간순으로 정리한다.

할 일은 실제 할 일 제목과 작업일 또는 완료일을 사용한다.

방송실 일정은 일정 날짜와 일정 제목만 사용한다.

방송실 일정의 시간, 장소, 메모, 상세 내용은 작성하지 않는다.

영상과 업무 프로젝트의 메모 및 상세 설명은 작성하지 않는다.

같은 업무가 프로젝트와 방송실 일정에 모두 연결되어 있으면 프로젝트를 우선하고 방송실 일정은 중복 작성하지 않는다.

원본에 없는 작업 내용을 추측하여 추가하지 않는다.

보고서에 적합한 간결하고 공식적인 문체로 작성한다.`;

  function validMonth(value) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""));
  }

  function monthRange(month) {
    if (!validMonth(month)) throw new Error("올바른 조회 월이 아닙니다.");
    const [year, monthNumber] = month.split("-").map(Number);
    const nextDate = new Date(Date.UTC(year, monthNumber, 1));
    const nextMonth = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const last = new Date(Date.UTC(year, monthNumber, 0));
    return {
      month,
      start: `${month}-01`,
      end: `${month}-${String(last.getUTCDate()).padStart(2, "0")}`,
      nextMonth,
      nextStart: `${nextMonth}-01`,
      nextEnd: `${nextMonth}-${String(new Date(Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, 0)).getUTCDate()).padStart(2, "0")}`
    };
  }

  function seoulDateKey(value) {
    if (!value) return "";
    const raw = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date).reduce((result, part) => {
      if (["year", "month", "day"].includes(part.type)) result[part.type] = part.value;
      return result;
    }, {});
    return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : "";
  }

  function uniqueDates(values) {
    return [...new Set((values || []).map(seoulDateKey).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort();
  }

  function inMonth(value, month) {
    return seoulDateKey(value).startsWith(`${month}-`);
  }

  function titleOf(task) {
    return String(task?.title || task?.text || "").trim();
  }

  function taskCompletionDate(state, entityType, entityId, task) {
    const explicit = seoulDateKey(task.actualWorkDate || task.completedAt || task.doneAt || "");
    if (explicit) return explicit;
    const dates = (state.activityLogs || [])
      .filter((log) => log.entityType === entityType && log.entityId === entityId && log.activityType === "task_check" && log.taskId === task.id && log.taskChecked === true)
      .map((log) => seoulDateKey(log.activityDate || log.occurredAt))
      .filter(Boolean)
      .sort();
    return dates.at(-1) || "";
  }

  function collectMonthlyReportSources(state, month, workContentCategoryValue) {
    const range = monthRange(month);
    if (!String(workContentCategoryValue || "").trim()) throw new Error("업무내용 카테고리 저장값을 확인할 수 없습니다.");
    const sources = [];
    const projectSourceMap = new Map();
    const currentTaskDatesByProject = new Map();
    const relevantProjectIds = new Set();

    function pushSource(item) {
      const sourceId = String(item.sourceId || "").trim();
      const title = String(item.title || "").trim();
      if (!SOURCE_TYPES.has(item.sourceType) || !sourceId || !title) return;
      sources.push({
        sourceType: item.sourceType,
        sourceId,
        ...(item.projectId ? { projectId: String(item.projectId) } : {}),
        title,
        dates: uniqueDates(item.dates),
        ...(item.dueDate ? { dueDate: seoulDateKey(item.dueDate) } : {}),
        ...(item.status ? { status: String(item.status) } : {}),
        ...(item.category ? { category: String(item.category) } : {}),
        reportSections: [...new Set((item.reportSections || []).filter((key) => SECTION_KEYS.includes(key)))]
      });
    }

    function registerProject(entity, sourceType) {
      const dueDate = seoulDateKey(entity.finalDate || entity.dueDate || "");
      const item = {
        sourceType,
        sourceId: String(entity.id),
        projectId: String(entity.id),
        title: String(entity.title || "").trim(),
        dates: dueDate ? [dueDate] : [],
        dueDate,
        status: String(entity.status || ""),
        reportSections: []
      };
      if (dueDate && inMonth(dueDate, month)) item.reportSections.push("activity");
      if (sourceType === "video_project" && dueDate && inMonth(dueDate, month)) item.reportSections.push("production");
      if (dueDate && inMonth(dueDate, range.nextMonth)) item.reportSections.push("next");
      projectSourceMap.set(String(entity.id), item);
      return item;
    }

    (state.projects || []).forEach((project) => registerProject(project, "video_project"));
    (state.works || []).forEach((work) => registerProject(work, "work_project"));

    function collectTask(task, entityType, entityId) {
      const completionDate = taskCompletionDate(state, entityType, entityId, task);
      const actualDate = seoulDateKey(task.actualWorkDate || completionDate || task.dueDate || "");
      const dueDate = seoulDateKey(task.dueDate || "");
      const createdDate = seoulDateKey(task.createdAt || "");
      const wasIncompleteAtMonthEnd = (!task.done || !completionDate || completionDate > range.end) && (!createdDate || createdDate <= range.end);
      const sections = [];
      if (actualDate && inMonth(actualDate, month)) sections.push("activity");
      if (wasIncompleteAtMonthEnd || (dueDate && inMonth(dueDate, range.nextMonth))) sections.push("next");
      if (!sections.length || !titleOf(task)) return;
      const sourceDates = uniqueDates([actualDate, dueDate]);
      pushSource({
        sourceType: "task",
        sourceId: task.id,
        projectId: entityId,
        title: titleOf(task),
        dates: sourceDates,
        dueDate,
        status: task.done && completionDate <= range.end ? "완료" : "미완료",
        reportSections: sections
      });
      relevantProjectIds.add(String(entityId));
      if (actualDate && inMonth(actualDate, month)) {
        const dates = currentTaskDatesByProject.get(String(entityId)) || new Set();
        dates.add(actualDate);
        currentTaskDatesByProject.set(String(entityId), dates);
      }
    }

    (state.tasks || []).forEach((task) => collectTask(task, "project", String(task.projectId || "")));
    (state.works || []).forEach((work) => (work.tasks || []).forEach((task) => collectTask(task, "work", String(work.id))));

    function collectRecords(entity, sourceType) {
      (entity.records || []).forEach((record) => {
        if (record.theme !== workContentCategoryValue) return;
        const createdDate = seoulDateKey(record.createdAt);
        if (!createdDate || !inMonth(createdDate, month)) return;
        pushSource({
          sourceType: "management_record",
          sourceId: record.id,
          projectId: entity.id,
          title: entity.title,
          dates: [createdDate],
          category: workContentCategoryValue,
          reportSections: ["activity"]
        });
        relevantProjectIds.add(String(entity.id));
      });
    }

    (state.projects || []).forEach((project) => collectRecords(project, "video_project"));
    (state.works || []).forEach((work) => collectRecords(work, "work_project"));

    (state.staffEvents || []).forEach((event) => {
      const eventDate = seoulDateKey(event.date);
      if (!eventDate || (!inMonth(eventDate, month) && !inMonth(eventDate, range.nextMonth))) return;
      const linkedId = String(event.projectId || event.workId || "");
      const sections = [];
      if (inMonth(eventDate, month)) sections.push("activity");
      if (inMonth(eventDate, range.nextMonth)) sections.push("next");
      pushSource({
        sourceType: "studio_schedule",
        sourceId: event.id,
        projectId: linkedId,
        title: event.title || event.trainingType || "방송실 일정",
        dates: [eventDate],
        reportSections: sections
      });
      if (linkedId) relevantProjectIds.add(linkedId);
    });

    projectSourceMap.forEach((projectSource, projectId) => {
      if (projectSource.reportSections.length || relevantProjectIds.has(projectId)) pushSource(projectSource);
    });

    return sources;
  }

  function formatKoreanDate(value) {
    const date = seoulDateKey(value);
    if (!date) return "일정 미정";
    const [, month, day] = date.split("-");
    return `${Number(month)}월 ${Number(day)}일`;
  }

  function formatDates(values) {
    const dates = uniqueDates(values);
    return dates.length ? dates.map(formatKoreanDate).join(", ") : "일정 미정";
  }

  function buildMonthlyReportPreview(sources, month) {
    const range = monthRange(month);
    const validSources = (sources || []).filter((source) => SOURCE_TYPES.has(source.sourceType));
    const sourceById = new Map(validSources.map((source) => [source.sourceId, source]));
    const projectSources = new Map(validSources
      .filter((source) => ["video_project", "work_project"].includes(source.sourceType))
      .map((source) => [source.sourceId, source]));
    const sections = { activity: [], production: [], next: [] };
    let serial = 0;

    function add(section, payload) {
      const dates = uniqueDates(payload.dates);
      const title = String(payload.title || "").trim();
      if (!title) return;
      const dueStyle = payload.dueStyle === true;
      const text = dueStyle
        ? `${title} / 마감일: ${formatDates(dates)}`
        : `${formatDates(dates)}: ${title}`;
      sections[section].push({
        id: `report-${section}-${++serial}`,
        section,
        sourceIds: [...new Set(payload.sourceIds || [])],
        title,
        dates,
        text,
        included: true
      });
    }

    const tasksCurrentByProject = new Map();
    validSources.filter((source) => source.sourceType === "task" && source.reportSections.includes("activity")).forEach((task) => {
      const dates = uniqueDates(task.dates).filter((date) => inMonth(date, month));
      if (!dates.length) return;
      const projectDates = tasksCurrentByProject.get(task.projectId) || new Set();
      dates.forEach((date) => projectDates.add(date));
      tasksCurrentByProject.set(task.projectId, projectDates);
      add("activity", { sourceIds: [task.sourceId], title: task.title, dates });
    });

    const projectActivity = new Map();
    function addProjectActivity(projectId, source, dates) {
      if (!projectId || !source) return false;
      const entry = projectActivity.get(projectId) || { sourceIds: new Set([source.sourceId]), title: source.title, dates: new Set() };
      (dates || []).filter((date) => inMonth(date, month)).forEach((date) => entry.dates.add(date));
      entry.sourceIds.add(source.sourceId);
      projectActivity.set(projectId, entry);
      return true;
    }

    validSources.filter((source) => ["video_project", "work_project"].includes(source.sourceType) && source.reportSections.includes("activity"))
      .forEach((source) => addProjectActivity(source.sourceId, source, [source.dueDate]));

    validSources.filter((source) => source.sourceType === "management_record").forEach((record) => {
      const project = projectSources.get(record.projectId);
      addProjectActivity(record.projectId, project || record, record.dates);
      const entry = projectActivity.get(record.projectId);
      if (entry) entry.sourceIds.add(record.sourceId);
    });

    const standaloneStudio = [];
    validSources.filter((source) => source.sourceType === "studio_schedule" && source.reportSections.includes("activity")).forEach((schedule) => {
      const project = projectSources.get(schedule.projectId);
      if (schedule.projectId && project) {
        addProjectActivity(schedule.projectId, project, schedule.dates);
        projectActivity.get(schedule.projectId)?.sourceIds.add(schedule.sourceId);
      } else {
        standaloneStudio.push(schedule);
      }
    });

    projectActivity.forEach((entry, projectId) => {
      const taskDates = tasksCurrentByProject.get(projectId) || new Set();
      const dates = [...entry.dates].filter((date) => !taskDates.has(date));
      if (dates.length) add("activity", { sourceIds: [...entry.sourceIds], title: entry.title, dates });
    });
    standaloneStudio.forEach((schedule) => add("activity", { sourceIds: [schedule.sourceId], title: schedule.title, dates: schedule.dates }));

    validSources.filter((source) => source.sourceType === "video_project" && source.reportSections.includes("production"))
      .forEach((source) => add("production", { sourceIds: [source.sourceId], title: source.title, dates: [source.dueDate], dueStyle: true }));

    const nextAdded = new Set();
    validSources.filter((source) => ["video_project", "work_project"].includes(source.sourceType) && source.dueDate && inMonth(source.dueDate, range.nextMonth))
      .forEach((source) => {
        add("next", { sourceIds: [source.sourceId], title: source.title, dates: [source.dueDate] });
        nextAdded.add(source.sourceId);
      });

    validSources.filter((source) => source.sourceType === "task" && source.reportSections.includes("next")).forEach((task) => {
      if (nextAdded.has(task.sourceId)) return;
      const nextDates = uniqueDates(task.dates).filter((date) => inMonth(date, range.nextMonth));
      const dates = nextDates.length ? nextDates : uniqueDates([task.dueDate, ...task.dates]);
      add("next", { sourceIds: [task.sourceId], title: task.title, dates: dates.slice(0, 1) });
      nextAdded.add(task.sourceId);
    });

    validSources.filter((source) => source.sourceType === "studio_schedule" && source.reportSections.includes("next")).forEach((schedule) => {
      if (schedule.projectId && nextAdded.has(schedule.projectId)) return;
      const project = projectSources.get(schedule.projectId);
      add("next", {
        sourceIds: [schedule.sourceId, ...(project ? [project.sourceId] : [])],
        title: project?.title || schedule.title,
        dates: schedule.dates
      });
    });

    SECTION_KEYS.forEach((section) => sections[section].sort((a, b) => {
      const dateCompare = String(a.dates[0] || "9999-99-99").localeCompare(String(b.dates[0] || "9999-99-99"));
      return dateCompare || a.title.localeCompare(b.title, "ko");
    }));
    return sections;
  }

  function apiSources(sources) {
    return (sources || []).map((source) => ({
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      title: source.title,
      dates: uniqueDates(source.dates),
      ...(source.dueDate ? { dueDate: source.dueDate } : {}),
      ...(source.status ? { status: source.status } : {}),
      ...(source.category ? { category: source.category } : {})
    }));
  }

  function previewItems(sections) {
    return SECTION_KEYS.flatMap((section) => (sections?.[section] || []).map((item) => ({
      section,
      sourceIds: [...new Set(item.sourceIds || [])],
      title: String(item.title || ""),
      dates: uniqueDates(item.dates)
    })));
  }

  function validateGeneratedSections(generated, sources, fallbackSections) {
    const sourceById = new Map((sources || []).map((source) => [source.sourceId, source]));
    const fallback = fallbackSections || { activity: [], production: [], next: [] };
    const result = { activity: [], production: [], next: [] };
    let serial = 0;
    SECTION_KEYS.forEach((section) => {
      const candidates = Array.isArray(generated?.[section]) ? generated[section] : [];
      candidates.forEach((item) => {
        const sourceIds = [...new Set((item.sourceIds || []).map(String))].filter((id) => sourceById.has(id));
        if (!sourceIds.length) return;
        const allowedSources = sourceIds.map((id) => sourceById.get(id));
        const allowedTitles = new Set(allowedSources.map((source) => source.title));
        const title = String(item.title || "");
        if (!allowedTitles.has(title)) return;
        const allowedDates = new Set(allowedSources.flatMap((source) => uniqueDates([...(source.dates || []), source.dueDate])));
        const dates = uniqueDates(item.dates).filter((date) => allowedDates.has(date));
        if ((item.dates || []).length && dates.length !== uniqueDates(item.dates).length) return;
        const dueStyle = section === "production";
        result[section].push({
          id: `report-${section}-gpt-${++serial}`,
          section,
          sourceIds,
          title,
          dates,
          text: dueStyle ? `${title} / 마감일: ${formatDates(dates)}` : `${formatDates(dates)}: ${title}`,
          included: true
        });
      });
      if (!result[section].length && (fallback[section] || []).length) result[section] = fallback[section].map((item) => ({ ...item }));
    });
    return result;
  }

  return {
    DEFAULT_PROMPT,
    SECTION_KEYS,
    monthRange,
    seoulDateKey,
    uniqueDates,
    formatKoreanDate,
    formatDates,
    collectMonthlyReportSources,
    buildMonthlyReportPreview,
    apiSources,
    previewItems,
    validateGeneratedSections
  };
});
