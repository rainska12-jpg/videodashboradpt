const fs = require("node:fs");
const path = require("node:path");
const { createMonthlyReportDocx } = require("../lib/monthly-report-docx.js");

const output = path.resolve(process.argv[2] || "monthly-report-qa.docx");
const bytes = createMonthlyReportDocx({
  month: "2026-07",
  organization: "영상제작과",
  author: "관리자",
  sections: {
    activity: [
      { included: true, itemType: "project", parentSourceId: "video-1", parentTitle: "7월 개강 홍보영상", department: "교육팀", text: "7월 개강 홍보영상 / 교육팀 / 7월 3일, 7월 8일, 7월 12일, 7월 25일" },
      { included: true, itemType: "task", parentSourceId: "video-1", parentTitle: "7월 개강 홍보영상", department: "교육팀", text: "촬영 진행 / 7월 8일" },
      { included: true, text: "7월 20일: 정기예배 방송실 운영" }
    ],
    production: [
      { included: true, text: "7월 개강 홍보영상 / 마감일: 7월 25일" }
    ],
    next: [
      { included: true, text: "8월 12일: 방송실 운영" }
    ]
  }
});
fs.writeFileSync(output, bytes);
process.stdout.write(`${output}\n`);
