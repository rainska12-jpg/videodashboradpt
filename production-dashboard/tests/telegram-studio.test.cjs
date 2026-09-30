const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const telegram = import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(require('node:path').join(__dirname, '../lib/telegram-digest.js'), 'utf8')).toString('base64')}`);
const event = { id: 's1', title: '교육 생중계', date: '2026-09-30', startTime: '10:00', room: '방송실', memo: '자료 사전 확인\n발표자 마이크 준비', telegramNote: '출입증 지참', staffRows: [{ type: 'PD', owner: 'o1', memo: '카메라 배터리 확인' }] };

test('manual and weekly studio messages include event and staff memos next to their event', async () => {
  const { buildStudioTelegramMessage } = await telegram;
  for (const mode of ['manual', 'weekly']) {
    const text = buildStudioTelegramMessage({ owners: [{ id: 'o1', name: '김PD' }] }, [event, { ...event, id: 's2', title: '다음 교육', date: '2026-10-01', memo: '두 번째 일정 메모', staffRows: [] }], { mode, fixedNotice: '공통 안내' });
    assert.match(text, /PD - 김PD\n  ↳ 카메라 배터리 확인/);
    assert.match(text, /📝 일정 메모\n자료 사전 확인\n발표자 마이크 준비/);
    assert.ok(text.indexOf('자료 사전 확인') < text.indexOf('다음 교육'));
    assert.match(text, /두 번째 일정 메모/);
    assert.match(text, /출입증 지참/); assert.match(text, /공통 안내/);
  }
});

test('empty memos add no blank labels; long notices stay within Telegram limits', async () => {
  const { buildStudioTelegramMessage } = await telegram;
  assert.doesNotMatch(buildStudioTelegramMessage({}, [{ ...event, memo: '', staffRows: [{ type: 'PD', owner: 'o1' }] }]), /일정 메모|↳/);
  const text = buildStudioTelegramMessage({}, Array.from({ length: 8 }, (_, i) => ({ ...event, id: `${i}`, memo: '메모'.repeat(1500) })));
  assert.ok(text.length <= 4000); assert.match(text, /나머지 일정은 대시보드/);
});
