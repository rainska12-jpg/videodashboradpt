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
      { included: true, text: "7월 3일, 7월 12일, 7월 25일: 7월 개강 홍보영상" },
      { included: true, text: "7월 8일: 촬영 진행" },
      { included: true, text: "7월 20일: 정기예배 방송실 운영" }
    ],
    production: [
      { included: true, text: "7월 개강 홍보영상 / 마감일: 7월 25일" }
    ],
    next: [
      { included: true, text: "8월 4일: 8월 방송실 점검" },
      { included: true, text: "8월 12일: 방송실 운영" },
      { included: true, text: "8월 12일: 장비 점검" }
    ]
  }
});
fs.writeFileSync(output, bytes);
process.stdout.write(`${output}\n`);
