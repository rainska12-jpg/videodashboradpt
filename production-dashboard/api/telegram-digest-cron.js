import { handleScheduledTelegramDigest } from "../lib/telegram-digest.js";

export default function handler(req, res) {
  const rawHour = Array.isArray(req.query?.scheduledHour) ? req.query.scheduledHour[0] : req.query?.scheduledHour;
  const scheduledHour = Number(rawHour);
  if (!Number.isInteger(scheduledHour) || scheduledHour < 0 || scheduledHour > 23) {
    return res.status(400).json({ ok: false, error: "예약 실행 시간이 올바르지 않습니다." });
  }
  return handleScheduledTelegramDigest(req, res, scheduledHour);
}
