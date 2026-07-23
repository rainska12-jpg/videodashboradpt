const fs = require("node:fs");
const path = require("node:path");
const { createMonthlyReportDocx } = require("../lib/monthly-report-docx.js");

async function main() {
  const output = path.resolve(process.argv[2] || "monthly-report-qa.docx");
  const templateBytes = fs.readFileSync(path.join(__dirname, "../templates/monthly-report-template.docx"));
  const bytes = await createMonthlyReportDocx({
    month: "2026-07",
    author: "관리자",
    templateBytes,
    sections: {
      activity: [
        { included: true, itemType: "project", parentSourceId: "video-1", parentTitle: "7월 개강 홍보영상", department: "교육팀", text: "7월 개강 홍보영상 / 교육팀 / 7월 3일" },
        { included: true, itemType: "task", parentSourceId: "video-1", parentTitle: "7월 개강 홍보영상", department: "교육팀", text: "촬영 진행 / 7월 8일" },
        { included: true, itemType: "task", parentSourceId: "video-1", parentTitle: "7월 개강 홍보영상", department: "교육팀", text: "편집본 검수 / 7월 12일" },
        { included: true, text: "정기예배 방송실 운영 / 문화부 / 7월 20일" }
      ],
      production: [
        { included: true, text: "7월 개강 홍보영상 / 마감일: 7월 25일" }
      ],
      next: [
        { included: true, text: "8월 정기예배 방송실 운영 / 문화부 / 8월 12일" }
      ]
    }
  });
  fs.writeFileSync(output, bytes);
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
