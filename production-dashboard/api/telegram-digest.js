import { handleTelegramDigestRequest } from "../lib/telegram-digest.js";

export default function handler(req, res) {
  return handleTelegramDigestRequest(req, res);
}
