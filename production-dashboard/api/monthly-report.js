const SOURCE_TYPES = new Set(["video_project", "work_project", "task", "management_record", "studio_schedule"]);
const SECTION_KEYS = ["activity", "production", "next"];

function envValue(...keys) {
  return keys.map((key) => process.env[key]).find(Boolean) || "";
}

function supabaseConfig() {
  return {
    url: envValue("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, ""),
    anonKey: envValue("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY")
  };
}

function restHeaders(apiKey, accessToken) {
  return { apikey: apiKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
}

async function verifyAdminAccess(accessToken) {
  const { url, anonKey } = supabaseConfig();
  if (!url || !anonKey || !accessToken) return false;
  const userResponse = await fetch(`${url}/auth/v1/user`, { headers: restHeaders(anonKey, accessToken) });
  if (!userResponse.ok) return false;
  const user = await userResponse.json();
  if (!user?.id) return false;
  const profileResponse = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role,status,approved`, {
    headers: restHeaders(anonKey, accessToken)
  });
  if (!profileResponse.ok) return false;
  const [profile] = await profileResponse.json();
  return profile?.role === "admin" && profile?.approved === true && ["approved", "active"].includes(profile?.status);
}

function bearerToken(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function cleanDate(value) {
  const result = cleanText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : "";
}

function uniqueDates(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanDate).filter(Boolean))].sort();
}

function sanitizeSources(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).map((item) => {
    const sourceType = cleanText(item?.sourceType, 40);
    const sourceId = cleanText(item?.sourceId, 160);
    const title = cleanText(item?.title, 240);
    if (!SOURCE_TYPES.has(sourceType) || !sourceId || !title) return null;
    const dueDate = cleanDate(item?.dueDate);
    return {
      sourceType,
      sourceId,
      ...(item?.projectId ? { projectId: cleanText(item.projectId, 160) } : {}),
      title,
      dates: uniqueDates(item?.dates),
      ...(dueDate ? { dueDate } : {}),
      ...(item?.status ? { status: cleanText(item.status, 80) } : {}),
      ...(item?.department ? { department: cleanText(item.department, 160) } : {}),
      ...(item?.category ? { category: cleanText(item.category, 80) } : {})
    };
  }).filter(Boolean);
}

function sanitizeCandidates(value, sourceById) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).map((item) => {
    const section = cleanText(item?.section, 20);
    const sourceIds = [...new Set((Array.isArray(item?.sourceIds) ? item.sourceIds : []).map((id) => cleanText(id, 160)).filter((id) => sourceById.has(id)))];
    const title = cleanText(item?.title, 240);
    const dates = uniqueDates(item?.dates);
    const text = cleanText(item?.text, 500);
    if (!SECTION_KEYS.includes(section) || !sourceIds.length || !title) return null;
    const allowedSources = sourceIds.map((id) => sourceById.get(id));
    if (!allowedSources.some((source) => source.title === title)) return null;
    const allowedDates = new Set(allowedSources.flatMap((source) => uniqueDates([...(source.dates || []), source.dueDate])));
    if (dates.some((date) => !allowedDates.has(date))) return null;
    return { section, sourceIds, title, dates, text };
  }).filter(Boolean);
}

function outputText(result) {
  if (typeof result?.output_text === "string") return result.output_text;
  for (const output of result?.output || []) {
    for (const content of output?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function validateModelResult(value, sources, candidates) {
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const candidatesBySection = Object.fromEntries(SECTION_KEYS.map((section) => [section, candidates.filter((item) => item.section === section)]));
  const result = { activity: [], production: [], next: [] };
  SECTION_KEYS.forEach((section) => {
    const allowedIds = new Set(candidatesBySection[section].flatMap((item) => item.sourceIds));
    const rawItems = Array.isArray(value?.[section]) ? value[section].slice(0, 300) : [];
    rawItems.forEach((item) => {
      const sourceIds = [...new Set((Array.isArray(item?.sourceIds) ? item.sourceIds : []).map((id) => cleanText(id, 160)))];
      if (!sourceIds.length || sourceIds.some((id) => !allowedIds.has(id) || !sourceById.has(id))) return;
      const referenced = sourceIds.map((id) => sourceById.get(id));
      const title = cleanText(item?.title, 240);
      if (!referenced.some((source) => source.title === title)) return;
      const allowedDates = new Set(referenced.flatMap((source) => uniqueDates([...(source.dates || []), source.dueDate])));
      const dates = uniqueDates(item?.dates);
      if (dates.some((date) => !allowedDates.has(date))) return;
      const matchingCandidate = candidatesBySection[section].find((candidate) =>
        candidate.title === title && candidate.sourceIds.some((id) => sourceIds.includes(id))
      );
      const generatedText = cleanText(item?.text, 500);
      result[section].push({
        sourceIds,
        title,
        dates,
        text: generatedText.includes(title) ? generatedText : matchingCandidate?.text || title
      });
    });

    const covered = new Set(result[section].flatMap((item) => item.sourceIds));
    candidatesBySection[section].forEach((candidate) => {
      if (!candidate.sourceIds.some((id) => covered.has(id))) {
        result[section].push({ sourceIds: candidate.sourceIds, title: candidate.title, dates: candidate.dates, text: candidate.text });
      }
    });
  });
  return result;
}

function publicError(error) {
  const message = String(error?.message || "월말보고서를 정리하지 못했습니다.");
  if (/OPENAI_API_KEY|OpenAI API|API 사용량|관리자 인증/.test(message)) return message;
  console.error(error);
  return "월말보고서를 정리하지 못했습니다. Vercel 로그를 확인해 주세요.";
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "지원하지 않는 요청입니다." });
  if (!await verifyAdminAccess(bearerToken(req))) return res.status(403).json({ ok: false, error: "관리자 인증이 필요합니다." });

  try {
    const apiKey = envValue("OPENAI_API_KEY");
    if (!apiKey) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");
    const month = cleanText(req.body?.month, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ ok: false, error: "조회 월이 올바르지 않습니다." });
    const sources = sanitizeSources(req.body?.sources);
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const candidates = sanitizeCandidates(req.body?.candidates, sourceById);
    const prompt = cleanText(req.body?.prompt, 12000);
    if (!sources.length || !candidates.length) return res.status(400).json({ ok: false, error: "정리할 보고서 데이터가 없습니다." });

    const schemaItem = {
      type: "object",
      additionalProperties: false,
      required: ["sourceIds", "title", "dates", "text"],
      properties: {
        sourceIds: { type: "array", minItems: 1, items: { type: "string" } },
        title: { type: "string" },
        dates: { type: "array", items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
        text: { type: "string" }
      }
    };
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: envValue("OPENAI_MONTHLY_REPORT_MODEL") || "gpt-5.6-luna",
        store: false,
        reasoning: { effort: "low" },
        instructions: `${prompt}\n\n출력 규칙: 입력 후보를 빠뜨리지 말고 제목과 날짜를 그대로 유지한다. 각 항목은 근거가 되는 sourceIds를 모두 포함한다. text에는 사용자의 프롬프트에 따라 정리한 최종 미리보기 문구를 작성하되 원본 title을 정확히 포함하고 목록 기호는 붙이지 않는다. 원본에 없는 사실은 추가하지 않는다. 설명문 없이 지정된 JSON 구조만 반환한다.`,
        input: JSON.stringify({ month, sources, candidates }),
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "monthly_report",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: SECTION_KEYS,
              properties: Object.fromEntries(SECTION_KEYS.map((section) => [section, { type: "array", items: schemaItem }]))
            }
          }
        }
      })
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const apiMessage = cleanText(responseBody?.error?.message, 300);
      if (response.status === 429) throw new Error("OpenAI API 사용량 한도를 확인해 주세요.");
      throw new Error(apiMessage ? `OpenAI API 오류: ${apiMessage}` : `OpenAI API 오류 (${response.status})`);
    }
    const text = outputText(responseBody);
    if (!text) throw new Error("OpenAI API가 보고서 결과를 반환하지 않았습니다.");
    const generated = JSON.parse(text);
    return res.status(200).json({ ok: true, sections: validateModelResult(generated, sources, candidates) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: publicError(error) });
  }
}
