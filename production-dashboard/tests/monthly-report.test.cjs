const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const core = require("../lib/monthly-report-core.js");
const { createMonthlyReportDocx } = require("../lib/monthly-report-docx.js");

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

test("생성한 Word 파일은 필수 OOXML 구성과 보고서 텍스트를 포함한다", () => {
  const bytes = createMonthlyReportDocx({
    month: "2026-07",
    organization: "영상제작과",
    author: "관리자",
    sections: {
      activity: [
        { included: true, itemType: "project", parentSourceId: "video-1", parentTitle: "7월 개강 홍보영상", department: "교육팀", text: "7월 개강 홍보영상 / 교육팀 / 7월 3일, 7월 8일" },
        { included: true, itemType: "task", parentSourceId: "video-1", parentTitle: "7월 개강 홍보영상", department: "교육팀", text: "촬영 진행 / 7월 8일" }
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
  assert.match(list, /word\/numbering\.xml/);
  const documentXml = execFileSync("unzip", ["-p", file, "word/document.xml"], { encoding: "utf8" });
  assert.match(documentXml, /2026년 7월 월말보고서/);
  assert.match(documentXml, /7월 개강 홍보영상/);
  assert.match(documentXml, /7월 개강 홍보영상 \/ 교육팀 \/ 7월 3일, 7월 8일/);
  assert.match(documentXml, /촬영 진행 \/ 7월 8일/);
  assert.ok(documentXml.indexOf("7월 개강 홍보영상 / 교육팀 / 7월 3일, 7월 8일") < documentXml.indexOf("촬영 진행 / 7월 8일"));
  assert.doesNotMatch(documentXml, /해당 없음.*해당 없음.*해당 없음/);
});
