const SOURCE_TYPES = new Set(["video_project", "work_project", "task", "management_record", "studio_schedule"]);
const SECTION_KEYS = ["activity", "production", "next"];
const REPORT_GROUPS = new Set(["work", "video", "studio", "production", "next"]);
const SOURCE_KINDS = new Set(["work", "video", "studio"]);

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
  const candidates = value.slice(0, 500).map((item) => {
    const candidateId = cleanText(item?.candidateId, 200);
    const section = cleanText(item?.section, 20);
    const sourceIds = [...new Set((Array.isArray(item?.sourceIds) ? item.sourceIds : []).map((id) => cleanText(id, 160)).filter((id) => sourceById.has(id)))];
    const title = cleanText(item?.title, 240);
    const dates = uniqueDates(item?.dates);
    const text = cleanText(item?.text, 500);
    const itemTypeValue = cleanText(item?.itemType, 20);
    const itemType = ["project", "task"].includes(itemTypeValue) ? itemTypeValue : "standard";
    const parentSourceId = cleanText(item?.parentSourceId, 160);
    const parentTitle = cleanText(item?.parentTitle, 240);
    const department = cleanText(item?.department, 160);
    const reportGroupValue = cleanText(item?.reportGroup, 20);
    const reportGroup = REPORT_GROUPS.has(reportGroupValue) ? reportGroupValue : section === "activity" ? "work" : section;
    const reportGroupLabel = cleanText(item?.reportGroupLabel, 40);
    const sourceKindValue = cleanText(item?.sourceKind, 20);
    const sourceKind = SOURCE_KINDS.has(sourceKindValue) ? sourceKindValue : "";
    const sourceKindLabel = cleanText(item?.sourceKindLabel, 40);
    const itemRoleLabel = cleanText(item?.itemRoleLabel, 40);
    if (!candidateId || !SECTION_KEYS.includes(section) || !sourceIds.length || !title) return null;
    const allowedSources = sourceIds.map((id) => sourceById.get(id));
    if (!allowedSources.some((source) => source.title === title)) return null;
    const allowedDates = new Set(allowedSources.flatMap((source) => uniqueDates([...(source.dates || []), source.dueDate])));
    if (dates.some((date) => !allowedDates.has(date))) return null;
    return {
      candidateId,
      section,
      sourceIds,
      title,
      dates,
      text,
      itemType,
      parentSourceId,
      parentTitle,
      department,
      reportGroup,
      reportGroupLabel,
      sourceKind,
      sourceKindLabel,
      itemRoleLabel
    };
  }).filter(Boolean);
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.candidateId)) return false;
    seen.add(candidate.candidateId);
    return true;
  });
}

function wholeReportDraft(candidates) {
  const activityGroups = new Map();
  candidates.filter((candidate) => candidate.section === "activity").forEach((candidate) => {
    const key = candidate.itemType === "standard"
      ? `standalone:${candidate.candidateId}`
      : `work:${candidate.parentSourceId || candidate.parentTitle || candidate.candidateId}`;
    if (!activityGroups.has(key)) {
      activityGroups.set(key, {
        groupTitle: candidate.parentTitle || candidate.title,
        department: candidate.department,
        reportGroup: candidate.reportGroup,
        reportGroupLabel: candidate.reportGroupLabel,
        sourceKind: candidate.sourceKind,
        sourceKindLabel: candidate.sourceKindLabel,
        parent: null,
        tasks: []
      });
    }
    const group = activityGroups.get(key);
    if (candidate.itemType === "task") group.tasks.push(candidate);
    else group.parent = candidate;
  });
  return {
    activityGroups: [...activityGroups.values()],
    production: candidates.filter((candidate) => candidate.section === "production"),
    next: candidates.filter((candidate) => candidate.section === "next")
  };
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

function validateModelResult(value, candidates) {
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const result = { activity: [], production: [], next: [] };
  const seen = new Set();
  SECTION_KEYS.forEach((section) => {
    const rawItems = Array.isArray(value?.[section]) ? value[section].slice(0, 500) : [];
    rawItems.forEach((item) => {
      const candidateId = cleanText(item?.candidateId, 200);
      const candidate = candidateById.get(candidateId);
      if (!candidate || candidate.section !== section || seen.has(candidateId)) {
        throw new Error("GPT 전체 정리 결과의 항목 구성이 원본과 일치하지 않습니다.");
      }
      const generatedText = cleanText(item?.text, 500);
      if (!generatedText) throw new Error("GPT 전체 정리 결과에 비어 있는 항목이 있습니다.");
      seen.add(candidateId);
      result[section].push({
        candidateId,
        sourceIds: candidate.sourceIds,
        title: candidate.title,
        dates: candidate.dates,
        text: generatedText
      });
    });
  });
  return result;
}

function publicError(error) {
  const message = String(error?.message || "월말보고서를 정리하지 못했습니다.");
  if (/OPENAI_API_KEY|OpenAI API|API 사용량|관리자 인증|GPT 전체 정리 결과/.test(message)) return message;
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
      required: ["candidateId", "text"],
      properties: {
        candidateId: { type: "string" },
        text: { type: "string", minLength: 1 }
      }
    };
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: envValue("OPENAI_MONTHLY_REPORT_MODEL") || "gpt-5.6-luna",
        store: false,
        reasoning: { effort: "medium" },
        instructions: `${prompt}

전체 정리 규칙:
1. report 전체를 먼저 읽고 활동내용, 제작물현황, 차월계획을 하나의 월말보고서로 편집한다.
2. 각 항목을 서로 독립된 문장처럼 처리하지 말고 전체 문체, 표현 방식, 날짜 표기와 순서를 일관되게 맞춘다.
3. activityGroups의 parent와 tasks는 하나의 상위 업무 묶음이다. 출력 activity에서는 상위 업무 다음에 연결된 하위 업무가 오도록 배치한다.
4. reportGroupLabel은 보고서에서 묶어야 할 분류다. 활동내용은 업무, 영상, 방송실 업무끼리 모으고 차월계획은 모두 차월 업무로 묶는다.
5. sourceKindLabel은 원본이 업무, 영상, 방송실 업무 중 무엇인지 알려 주며 itemRoleLabel은 상위 업무, 하위 업무 등의 역할을 알려 준다. 제목만 보고 유형을 추측하지 말고 이 표식을 기준으로 정리한다.
6. 각 섹션 안에서 보고서 흐름에 맞게 묶음과 항목 순서를 조정할 수 있다. 항목을 다른 섹션으로 이동하지 않는다.
7. 사용자 프롬프트에 따라 중요도가 낮거나 중복되는 항목은 결과에서 생략할 수 있다.
8. 여러 항목을 하나로 통합할 때는 대표 candidateId 하나만 반환하고, 통합된 다른 candidateId는 생략한다. 대표 항목의 text에는 생략한 항목의 원본 사실과 날짜를 함께 정리할 수 있다.
9. 하위 업무를 상위 업무에 흡수하거나 반복 업무의 날짜를 상위 업무에 합칠 때는 상위 업무의 candidateId를 대표로 사용하고, 흡수된 하위 candidateId는 생략한다.
10. text의 제목 표현, 날짜 표기, 기간 표기, 문장 구성과 상태 표현은 사용자 프롬프트에 맞게 자유롭게 교정할 수 있다.
11. 제작물 공식 명칭 정리, 제목 속 날짜 제거와 오탈자 교정도 사용자 프롬프트를 따른다.
12. 반환하는 candidateId는 입력에 존재해야 하고 중복하거나 다른 섹션으로 이동하지 않는다.
13. 입력 전체에 존재하는 사실의 범위 안에서 작성하고, 입력에 없는 업무나 날짜를 새로 추가하지 않는다. 목록 기호는 붙이지 않는다.
14. 설명문 없이 지정된 JSON 구조만 반환한다.`,
        input: JSON.stringify({ month, report: wholeReportDraft(candidates) }),
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
    return res.status(200).json({ ok: true, mode: "whole_report", allowOmissions: true, sections: validateModelResult(generated, candidates) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: publicError(error) });
  }
}
