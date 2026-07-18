import { handleScheduledTelegramDigest } from "../lib/telegram-digest.js";

export default function handler(req, res) {
  return handleScheduledTelegramDigest(req, res, 1);
}
