const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const core = require("../lib/monthly-report-core.js");
const { createMonthlyReportDocx, monthlyReportFilename } = require("../lib/monthly-report-docx.js");

function fixtureState() {
  return {
    projects: [{
      id: "video-1",
      title: "7월 개강 홍보영상",
      client: "교육팀",
      finalDate: "2026-07-25",
      status: "편집",
      records: [
        { id: "record-1", theme: "work_content", body: "기획안 작성", createdAt: "2026-07-03T01:10:00.000Z" },
        { id: "record-2", theme: "work_content", body: "촬영 진행", createdAt: "2026-07-08T02:10:00.000Z" },
        { id: "record-3", theme: "work_content", body: "중복 날짜 기록", createdAt: "2026-07-08T09:30:00.000Z" },
        { id: "record-4", theme: "internal_share", body: "참고 메모", createdAt: "2026-07-15T02:10:00.000Z" }
      ]
    }],
    works: [{
      id: "work-1",
      title: "방송실 운영",
      client: "내부",
      finalDate: "2026-08-12",
      status: "진행",
      records: [],
      tasks: [{ id: "work-task-1", text: "장비 점검", dueDate: "2026-08-12", done: false, detail: "긴 설명", createdAt: "2026-07-01T00:00:00Z" }]
    }],
    tasks: [{ id: "task-1", projectId: "video-1", text: "촬영 진행", dueDate: "2026-07-08", done: true, detail: "현장 세부 메모", createdAt: "2026-07-01T00:00:00Z", completedAt: "2026-07-08T10:00:00Z" }],
    activityLogs: [],
    staffEvents: [
      { id: "studio-linked", projectId: "video-1", title: "개강 홍보영상 촬영", date: "2026-07-12", startTime: "14:00", endTime: "16:00", room: "방송실 A", memo: "상세 메모" },
      { id: "studio-free", title: "정기예배 방송실 운영", date: "2026-07-20", startTime: "09:00", room: "본당", memo: "담당자 메모" },
      { id: "studio-next", title: "8월 방송실 점검", date: "2026-08-04", startTime: "11:00", memo: "다음 달 메모" }
    ]
  };
}

async function monthlyReportApiInternals() {
  const apiPath = path.join(__dirname, "../api/monthly-report.js");
  const source = fs.readFileSync(apiPath, "utf8")
    .replace("export default async function handler", "async function handler");
  const testableSource = `${source}\nexport { wholeReportDraft, validateModelResult };`;
  return import(`data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`);
}

test("업무내용 카테고리만 수집하고 본문·메모·시간은 API 데이터에서 제외한다", () => {
  const sources = core.collectMonthlyReportSources(fixtureState(), "2026-07", "work_content");
  const records = sources.filter((item) => item.sourceType === "management_record");
  assert.deepEqual(records.map((item) => item.sourceId).sort(), ["record-1", "record-2", "record-3"]);
  assert.ok(records.every((item) => item.category === "work_content"));
  const serialized = JSON.stringify(core.apiSources(sources));
  ["기획안 작성", "참고 메모", "현장 세부 메모", "상세 메모", "14:00", "방송실 A", "본당"].forEach((forbidden) => {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} should be excluded`);
  });
});

test("활동내용을 업무·발주부서·업무 날짜 아래 하위 할 일과 날짜로 구성한다", () => {
  const sources = core.collectMonthlyReportSources(fixtureState(), "2026-07", "work_content");
  const preview = core.buildMonthlyReportPreview(sources, "2026-07");
  const task = preview.activity.find((item) => item.title === "촬영 진행");
  const project = preview.activity.find((item) => item.title === "7월 개강 홍보영상");
  assert.deepEqual(task.dates, ["2026-07-08"]);
  assert.equal(task.itemType, "task");
  assert.equal(task.parentTitle, "7월 개강 홍보영상");
  assert.equal(task.parentSourceId, "video-1");
  assert.equal(task.department, "교육팀");
  assert.equal(task.text, "촬영 진행 / 7월 8일");
  assert.deepEqual(task.sourceIds.sort(), ["task-1", "video-1"]);
  assert.equal(project.itemType, "project");
  assert.equal(project.department, "교육팀");
  assert.equal(project.parentSourceId, "video-1");
  assert.deepEqual(project.dates, ["2026-07-03", "2026-07-08", "2026-07-12", "2026-07-25"]);
  assert.equal(project.text, "7월 개강 홍보영상 / 교육팀 / 7월 3일, 7월 8일, 7월 12일, 7월 25일");
  assert.equal(project.text.includes("기획안"), false);
  assert.equal(project.text.includes("편집"), false);
});

test("연결 방송실 일정은 프로젝트에 통합하고 미연결 일정은 독립 표시한다", () => {
  const sources = core.collectMonthlyReportSources(fixtureState(), "2026-07", "work_content");
  const preview = core.buildMonthlyReportPreview(sources, "2026-07");
  assert.equal(preview.activity.some((item) => item.title === "개강 홍보영상 촬영"), false);
  assert.equal(preview.activity.some((item) => item.title === "정기예배 방송실 운영" && item.dates[0] === "2026-07-20"), true);
});

test("초안과 GPT 입력에 업무·영상·방송실 업무·차월 업무 분류를 명시한다", () => {
  const state = fixtureState();
  state.works.push({
    id: "work-current",
    title: "월간 행정자료 정리",
    client: "문화부",
    finalDate: "2026-07-18",
    status: "완료",
    records: [],
    tasks: []
  });
  const sources = core.collectMonthlyReportSources(state, "2026-07", "work_content");
  const preview = core.buildMonthlyReportPreview(sources, "2026-07");
  assert.equal(preview.activity.find((item) => item.title === "월간 행정자료 정리").reportGroupLabel, "업무");
  assert.equal(preview.activity.find((item) => item.title === "7월 개강 홍보영상").reportGroupLabel, "영상");
  assert.equal(preview.activity.find((item) => item.title === "촬영 진행").sourceKindLabel, "영상");
  assert.equal(preview.activity.find((item) => item.title === "정기예배 방송실 운영").reportGroupLabel, "방송실 업무");
  assert.equal(preview.next[0].reportGroupLabel, "차월 업무");
  assert.equal(preview.next[0].sourceKindLabel, "업무");

  const report = core.wholeReportDraft(preview);
  assert.equal(report.activityGroups.find((group) => group.parent?.title === "월간 행정자료 정리").reportGroupLabel, "업무");
  assert.equal(report.activityGroups.find((group) => group.parent?.title === "7월 개강 홍보영상").reportGroupLabel, "영상");
  assert.equal(report.activityGroups.find((group) => group.parent?.title === "정기예배 방송실 운영").reportGroupLabel, "방송실 업무");
  assert.equal(report.next[0].reportGroupLabel, "차월 업무");
});

test("월말보고 보고자는 관리자 권한이 아니라 활성 과장 직책으로 찾는다", () => {
  const manager = core.monthlyReportManager([
    { id: "admin", name: "출력한 관리자", position: "과원", role: "admin", approved: true, status: "active" },
    { id: "manager", name: "실제 과장", position: "과장", role: "user", approved: true, status: "approved", sortOrder: 2 },
    { id: "inactive-manager", name: "퇴직 과장", position: "과장", approved: true, status: "inactive", sortOrder: 1 }
  ]);
  assert.equal(manager.id, "manager");
  assert.equal(core.monthlyReportManager([
    { id: "admin", name: "출력한 관리자", position: "과원", role: "admin", approved: true, status: "active" }
  ]), null);
});

test("선택 월 마감 영상은 현재 상태와 무관하게 제작물현황에 포함한다", () => {
  const sources = core.collectMonthlyReportSources(fixtureState(), "2026-07", "work_content");
  const preview = core.buildMonthlyReportPreview(sources, "2026-07");
  assert.equal(preview.production.length, 1);
  assert.equal(preview.production[0].text, "7월 개강 홍보영상 / 마감일: 7월 25일");
});

test("차월계획은 바로 다음 한 달의 업무만 포함하고 하위 할 일과 방송실 일정은 제외한다", () => {
  const state = fixtureState();
  state.tasks.push({ id: "unfinished", projectId: "video-1", text: "검수 요청", dueDate: "2026-07-29", done: false, createdAt: "2026-07-20T00:00:00Z" });
  state.projects.push({ id: "future-video", title: "9월 기관 행사영상", client: "홍보팀", finalDate: "2026-09-05", status: "예정", records: [] });
  const sources = core.collectMonthlyReportSources(state, "2026-07", "work_content");
  const preview = core.buildMonthlyReportPreview(sources, "2026-07");
  const titles = preview.next.map((item) => item.title);
  assert.deepEqual(titles, ["방송실 운영"]);
  assert.equal(preview.next.some((item) => item.itemType === "task"), false);
  assert.equal(titles.includes("8월 방송실 점검"), false);
  assert.equal(titles.includes("9월 기관 행사영상"), false);
});

test("할 일이 없는 업무에는 하위 할 일 항목을 만들지 않는다", () => {
  const state = fixtureState();
  state.projects.push({ id: "video-no-task", title: "기관 소개영상", client: "홍보팀", finalDate: "2026-07-30", status: "진행", records: [] });
  const sources = core.collectMonthlyReportSources(state, "2026-07", "work_content");
  const preview = core.buildMonthlyReportPreview(sources, "2026-07");
  const project = preview.activity.find((item) => item.title === "기관 소개영상");
  assert.ok(project);
  assert.equal(project.itemType, "project");
  assert.equal(project.text, "기관 소개영상 / 홍보팀 / 7월 30일");
  assert.equal(preview.activity.some((item) => item.itemType === "task" && item.parentSourceId === "video-no-task"), false);
});

test("상위 업무 체크를 해제하면 같은 업무의 하위 할 일도 모두 해제한다", () => {
  const sources = core.collectMonthlyReportSources(fixtureState(), "2026-07", "work_content");
  const preview = core.buildMonthlyReportPreview(sources, "2026-07");
  const project = preview.activity.find((item) => item.itemType === "project" && item.parentSourceId === "video-1");
  const task = preview.activity.find((item) => item.itemType === "task" && item.parentSourceId === "video-1");
  const changedIds = core.setPreviewItemIncluded(preview, project.id, false);
  assert.equal(project.included, false);
  assert.equal(task.included, false);
  assert.deepEqual(new Set(changedIds), new Set([project.id, task.id]));
  core.setPreviewItemIncluded(preview, project.id, true);
  assert.equal(project.included, true);
  assert.equal(task.included, false);
});

test("ISO 타임스탬프는 Asia/Seoul 날짜로 변환한다", () => {
  assert.equal(core.seoulDateKey("2026-07-31T16:30:00.000Z"), "2026-08-01");
});

test("GPT 결과의 원본에 없는 제목과 날짜는 미리보기에서 거부한다", () => {
  const sources = core.collectMonthlyReportSources(fixtureState(), "2026-07", "work_content");
  const fallback = core.buildMonthlyReportPreview(sources, "2026-07");
  const generated = {
    activity: [{ sourceIds: ["record-1"], title: "촬영 및 편집 진행", dates: ["2026-07-30"] }],
    production: [],
    next: []
  };
  const validated = core.validateGeneratedSections(generated, sources, fallback);
  assert.deepEqual(validated.activity.map((item) => item.text), fallback.activity.map((item) => item.text));
});

test("GPT 정리 후에도 활동내용의 업무·하위 할 일 구조를 복원한다", () => {
  const sources = core.collectMonthlyReportSources(fixtureState(), "2026-07", "work_content");
  const fallback = core.buildMonthlyReportPreview(sources, "2026-07");
  const validated = core.validateGeneratedSections({
    activity: [
      { sourceIds: ["record-1"], title: "7월 개강 홍보영상", dates: ["2026-07-03"] },
      { sourceIds: ["task-1"], title: "촬영 진행", dates: ["2026-07-08"] }
    ],
    production: [],
    next: []
  }, sources, fallback);
  const project = validated.activity.find((item) => item.title === "7월 개강 홍보영상");
  const task = validated.activity.find((item) => item.title === "촬영 진행");
  assert.equal(project.itemType, "project");
  assert.equal(project.text, "7월 개강 홍보영상 / 교육팀 / 7월 3일");
  assert.equal(task.itemType, "task");
  assert.equal(task.parentSourceId, "video-1");
  assert.equal(task.text, "촬영 진행 / 7월 8일");
});

test("체크 해제 항목은 GPT 후보에서 제외하고 프롬프트로 정리된 문구는 유지한다", () => {
  const sources = core.collectMonthlyReportSources(fixtureState(), "2026-07", "work_content");
  const fallback = core.buildMonthlyReportPreview(sources, "2026-07");
  const excluded = fallback.production[0];
  excluded.included = false;
  assert.equal(core.previewItems(fallback).some((item) => item.title === excluded.title && item.section === "production"), false);

  const validated = core.validateGeneratedSections({
    activity: [{
      sourceIds: ["record-1"],
      title: "7월 개강 홍보영상",
      dates: ["2026-07-03"],
      text: "7월 개강 홍보영상 / 교육팀 / 7월 3일 진행"
    }],
    production: [],
    next: []
  }, sources, fallback);
  assert.equal(validated.activity[0].text, "7월 개강 홍보영상 / 교육팀 / 7월 3일 진행");
});

test("GPT 입력은 상위 업무와 하위 업무를 전체 보고서 묶음으로 구성한다", () => {
  const sources = core.collectMonthlyReportSources(fixtureState(), "2026-07", "work_content");
  const preview = core.buildMonthlyReportPreview(sources, "2026-07");
  const report = core.wholeReportDraft(preview);
  const projectGroup = report.activityGroups.find((group) => group.parent?.title === "7월 개강 홍보영상");
  assert.ok(projectGroup);
  assert.equal(projectGroup.parent.itemType, "project");
  assert.deepEqual(projectGroup.tasks.map((item) => item.title), ["촬영 진행"]);
  assert.ok(projectGroup.parent.candidateId);
  assert.equal(report.production[0].section, "production");
  assert.equal(report.next[0].section, "next");
});

test("전체 보고서 결과는 순서와 문구를 일괄 반영하고 프롬프트에 따른 항목 생략을 허용한다", () => {
  const sources = core.collectMonthlyReportSources(fixtureState(), "2026-07", "work_content");
  const fallback = core.buildMonthlyReportPreview(sources, "2026-07");
  const candidates = core.previewItems(fallback);
  const generated = { activity: [], production: [], next: [] };
  candidates.slice().reverse().forEach((candidate) => {
    generated[candidate.section].push({
      candidateId: candidate.candidateId,
      text: `${candidate.text} / 전체 문체 정리`
    });
  });
  generated.activity[0].text = "프롬프트로 자유롭게 바꾼 업무 표현 / 7.2.";
  const validated = core.validateGeneratedSections(generated, sources, fallback, { requireComplete: true });
  assert.deepEqual(
    validated.activity.map((item) => item.id),
    generated.activity.map((item) => item.candidateId)
  );
  assert.equal(validated.activity[0].text, "프롬프트로 자유롭게 바꾼 업무 표현 / 7.2.");

  const missing = {
    activity: generated.activity.slice(1),
    production: generated.production,
    next: generated.next
  };
  assert.throws(
    () => core.validateGeneratedSections(missing, sources, fallback, { requireComplete: true }),
    /누락된 항목/
  );
  const omitted = core.validateGeneratedSections(
    missing,
    sources,
    fallback,
    { requireComplete: true, allowOmissions: true }
  );
  assert.equal(omitted.activity.length, missing.activity.length);
  assert.equal(omitted.activity[0].text, missing.activity[0].text);
});

test("서버도 전체 업무 묶음을 전달하고 프롬프트의 항목 생략과 날짜 표기를 유지한다", async () => {
  const { wholeReportDraft, validateModelResult } = await monthlyReportApiInternals();
  const candidates = [
    {
      candidateId: "project-1",
      section: "activity",
      sourceIds: ["project-1"],
      title: "기관 홍보영상",
      dates: ["2026-07-03"],
      text: "기관 홍보영상 / 홍보팀 / 7월 3일",
      itemType: "project",
      parentSourceId: "project-1",
      parentTitle: "기관 홍보영상",
      department: "홍보팀",
      reportGroup: "video",
      reportGroupLabel: "영상",
      sourceKind: "video",
      sourceKindLabel: "영상",
      itemRoleLabel: "상위 업무"
    },
    {
      candidateId: "task-1",
      section: "activity",
      sourceIds: ["task-1", "project-1"],
      title: "촬영 진행",
      dates: ["2026-07-08"],
      text: "촬영 진행 / 7월 8일",
      itemType: "task",
      parentSourceId: "project-1",
      parentTitle: "기관 홍보영상",
      department: "홍보팀",
      reportGroup: "video",
      reportGroupLabel: "영상",
      sourceKind: "video",
      sourceKindLabel: "영상",
      itemRoleLabel: "하위 업무"
    }
  ];
  const draft = wholeReportDraft(candidates);
  assert.equal(draft.activityGroups.length, 1);
  assert.equal(draft.activityGroups[0].parent.candidateId, "project-1");
  assert.equal(draft.activityGroups[0].tasks[0].candidateId, "task-1");
  assert.equal(draft.activityGroups[0].reportGroupLabel, "영상");
  assert.equal(draft.activityGroups[0].sourceKindLabel, "영상");

  const valid = validateModelResult({
    activity: [
      { candidateId: "project-1", text: "기관 홍보영상 / 홍보팀 / 7월 3일 추진" },
      { candidateId: "task-1", text: "촬영 진행 / 7월 8일 완료" }
    ],
    production: [],
    next: []
  }, candidates);
  assert.equal(valid.activity[0].text, "기관 홍보영상 / 홍보팀 / 7월 3일 추진");
  const omitted = validateModelResult({
    activity: [{ candidateId: "project-1", text: "기관 홍보영상 관련 업무 / 7.3., 7.8. / 현장 촬영 포함" }],
    production: [],
    next: []
  }, candidates);
  assert.deepEqual(omitted.activity.map((item) => item.candidateId), ["project-1"]);
  assert.equal(omitted.activity[0].text, "기관 홍보영상 관련 업무 / 7.3., 7.8. / 현장 촬영 포함");
  const formatted = validateModelResult({
    activity: [
      { candidateId: "project-1", text: "홍보팀 영상 업무 / 7.3. 추진" },
      { candidateId: "task-1", text: "현장 촬영 / 7.8. 완료" }
    ],
    production: [],
    next: []
  }, candidates);
  assert.equal(formatted.activity[0].text, "홍보팀 영상 업무 / 7.3. 추진");
  assert.equal(formatted.activity[1].text, "현장 촬영 / 7.8. 완료");
});

test("지정 양식 Word 파일에 연월·보고일·보고자와 보고서 내용을 정확히 입력한다", async () => {
  const templateBytes = fs.readFileSync(path.join(__dirname, "../templates/monthly-report-template.docx"));
  const bytes = await createMonthlyReportDocx({
    month: "2026-07",
    author: "관리자",
    templateBytes,
    sections: {
      activity: [
        { included: true, itemType: "project", parentSourceId: "video-1", parentTitle: "7월 개강 홍보영상", department: "교육팀", text: "7월 개강 홍보영상 / 교육팀 / 7월 3일, 7월 8일" },
        { included: true, itemType: "task", parentSourceId: "video-1", parentTitle: "7월 개강 홍보영상", department: "교육팀", text: "촬영 진행 / 7월 8일" },
        { included: true, itemType: "task", parentSourceId: "video-1", parentTitle: "7월 개강 홍보영상", department: "교육팀", text: "편집 진행 / 7월 15일" }
      ],
      production: [{ included: true, text: "7월 개강 홍보영상 / 마감일: 7월 25일" }],
      next: [{ included: true, text: "8월 4일: 방송실 장비 점검" }]
    }
  });
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString("hex"), "504b0304");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monthly-report-test-"));
  const file = path.join(tempDir, "report.docx");
  fs.writeFileSync(file, bytes);
  const list = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
  assert.match(list, /word\/document\.xml/);
  assert.match(list, /word\/theme\/theme1\.xml/);
  assert.match(list, /word\/fontTable\.xml/);
  const documentXml = execFileSync("unzip", ["-p", file, "word/document.xml"], { encoding: "utf8" });
  assert.match(documentXml, /문화부 영상제작과 월말보고서/);
  assert.match(documentXml, /신천기 43\(2026\)년 7월분/);
  assert.match(documentXml, /신천기 43\(2026\)년 7월 31일/);
  assert.match(documentXml, /보고자 : 영상제작과장 관리자/);
  assert.match(documentXml, /7월 개강 홍보영상/);
  assert.match(documentXml, /- 7월 개강 홍보영상 \/ 교육팀 \/ 7월 3일, 7월 8일/);
  assert.match(documentXml, /1\) 촬영 진행 \/ 7월 8일/);
  assert.match(documentXml, /2\) 편집 진행 \/ 7월 15일/);
  assert.ok(documentXml.indexOf("7월 개강 홍보영상 / 교육팀 / 7월 3일, 7월 8일") < documentXml.indexOf("촬영 진행 / 7월 8일"));
  assert.equal(
    monthlyReportFilename("2026-07"),
    "영상제작과_문화부_7월말보고서.docx"
  );
});
