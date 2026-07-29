const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "daily_draw_migration.sql"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("제비뽑기 문구가 9개 점수 구간과 24개 주제로 216개 생성된다", () => {
  const bands = migration.match(/^    \('\d{2}', \d+/gm) || [];
  const themes = migration.match(/^    \('\d{2}', '[^']+',/gm) || [];
  assert.equal(bands.length, 9);
  assert.equal(themes.length, 24);
  assert.equal(bands.length * themes.length, 216);
});

test("1일 1회, 한국 날짜, 트랜잭션 잠금과 변경 금지를 적용한다", () => {
  assert.match(migration, /unique \(user_id, draw_date\)/);
  assert.match(migration, /timezone\('Asia\/Seoul', now\(\)\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /revoke insert, update, delete on public\.daily_draw_results/);
  assert.match(migration, /recent\.draw_date >= v_today - 14/);
});

test("클라이언트는 서버 RPC 결과만 확정하고 사용자 화면에는 제비뽑기 명칭을 쓴다", () => {
  assert.match(app, /\.rpc\("draw_today"/);
  assert.match(app, /p_draw_date: seoulNowParts\(\)\.date/);
  assert.match(html, /오늘의 제비뽑기/);
  assert.doesNotMatch(`${app}\n${html}`, /오늘의 운세|운세 측정|운세 점수|운세 랭킹|미측정/);
});
