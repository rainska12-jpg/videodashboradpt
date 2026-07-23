(function monthlyReportDocxModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MonthlyReportDocx = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createMonthlyReportDocxModule() {
  "use strict";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const TEMPLATE_URL = "./templates/monthly-report-template.docx?v=1";

  function xml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  function decodeXml(value) {
    return String(value ?? "")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&");
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(value) {
    return Uint8Array.of(value & 255, (value >>> 8) & 255);
  }

  function u32(value) {
    return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255);
  }

  function join(chunks) {
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    chunks.forEach((chunk) => {
      output.set(chunk, offset);
      offset += chunk.length;
    });
    return output;
  }

  function zipStore(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    Object.entries(files).forEach(([name, content]) => {
      const nameBytes = encoder.encode(name);
      const data = typeof content === "string" ? encoder.encode(content) : content;
      const crc = crc32(data);
      const local = join([
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data
      ]);
      const central = join([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), nameBytes
      ]);
      localParts.push(local);
      centralParts.push(central);
      offset += local.length;
    });
    const central = join(centralParts);
    return join([
      ...localParts,
      central,
      u32(0x06054b50), u16(0), u16(0), u16(centralParts.length), u16(centralParts.length),
      u32(central.length), u32(offset), u16(0)
    ]);
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("이 브라우저에서는 Word 양식 압축을 열 수 없습니다. 브라우저를 최신 버전으로 업데이트해 주세요.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function findEndOfCentralDirectory(bytes, view) {
    const minimumOffset = Math.max(0, bytes.length - 65557);
    for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) return offset;
    }
    throw new Error("Word 양식의 ZIP 디렉터리를 찾지 못했습니다.");
  }

  async function unzipFiles(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocdOffset = findEndOfCentralDirectory(bytes, view);
    const entryCount = view.getUint16(eocdOffset + 10, true);
    let centralOffset = view.getUint32(eocdOffset + 16, true);
    const files = {};

    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(centralOffset, true) !== 0x02014b50) {
        throw new Error("Word 양식의 ZIP 항목이 손상되었습니다.");
      }
      const method = view.getUint16(centralOffset + 10, true);
      const compressedSize = view.getUint32(centralOffset + 20, true);
      const nameLength = view.getUint16(centralOffset + 28, true);
      const extraLength = view.getUint16(centralOffset + 30, true);
      const commentLength = view.getUint16(centralOffset + 32, true);
      const localOffset = view.getUint32(centralOffset + 42, true);
      const name = decoder.decode(bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength));
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
      if (!name.endsWith("/")) {
        if (method === 0) files[name] = compressed;
        else if (method === 8) files[name] = await inflateRaw(compressed);
        else throw new Error(`Word 양식에서 지원하지 않는 압축 방식입니다: ${method}`);
      }
      centralOffset += 46 + nameLength + extraLength + commentLength;
    }
    return files;
  }

  function paragraphText(paragraphXml) {
    return Array.from(paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g))
      .map((match) => decodeXml(match[1]))
      .join("");
  }

  function replaceParagraphText(documentXml, originalText, replacementText) {
    let replaced = false;
    const output = documentXml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraphXml) => {
      if (replaced || paragraphText(paragraphXml) !== originalText) return paragraphXml;
      let inserted = false;
      replaced = true;
      return paragraphXml.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, () => {
        if (inserted) return "<w:t></w:t>";
        inserted = true;
        return `<w:t xml:space="preserve">${xml(replacementText)}</w:t>`;
      });
    });
    if (!replaced) throw new Error(`Word 양식에서 입력 위치를 찾지 못했습니다: ${originalText}`);
    return output;
  }

  function cellParagraph(text, kind, baseParagraphXml) {
    let paragraphProperties = baseParagraphXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || "<w:pPr/>";
    if (kind === "child") {
      paragraphProperties = paragraphProperties.replace(
        /<\/w:pPr>/,
        '<w:ind w:left="360"/></w:pPr>'
      );
    }
    const bold = kind === "parent" ? "<w:b/>" : "";
    const color = kind === "empty" ? '<w:color w:val="666666"/>' : "";
    return `<w:p>${paragraphProperties}<w:r><w:rPr><w:rFonts w:ascii="함초롬바탕" w:eastAsia="함초롬바탕" w:hAnsi="함초롬바탕" w:cs="함초롬바탕"/>${bold}${color}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  }

  function replaceTableCell(tableXml, lines) {
    return tableXml.replace(/<w:tc>([\s\S]*?)<\/w:tc>/, (cellXml, innerXml) => {
      const cellProperties = innerXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] || "";
      const baseParagraph = innerXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/)?.[0] || "<w:p><w:pPr/></w:p>";
      const content = (lines.length ? lines : [{ text: "해당 없음", kind: "empty" }])
        .map((line) => cellParagraph(line.text, line.kind, baseParagraph))
        .join("");
      return `<w:tc>${cellProperties}${content}</w:tc>`;
    });
  }

  function replaceReportTables(documentXml, sections) {
    const tableLines = [
      buildActivityLines(sections?.activity || []),
      buildSimpleLines(sections?.production || []),
      buildSimpleLines(sections?.next || [])
    ];
    let tableIndex = 0;
    const output = documentXml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tableXml) => {
      if (tableIndex >= tableLines.length) return tableXml;
      return replaceTableCell(tableXml, tableLines[tableIndex++]);
    });
    if (tableIndex !== tableLines.length) throw new Error("Word 양식의 보고서 표 3개를 찾지 못했습니다.");
    return output;
  }

  function buildSimpleLines(items) {
    return items
      .filter((item) => item.included !== false && String(item.text || "").trim())
      .map((item) => ({ text: item.text.trim(), kind: "regular" }));
  }

  function buildActivityLines(items) {
    const projectItems = items.filter((item) => ["project", "task"].includes(item.itemType));
    const groups = new Map();
    const groupKeyOf = (item) => item.parentSourceId || `${item.parentTitle || "연결 업무 없음"}\u0000${item.department || ""}`;

    projectItems.forEach((item) => {
      const key = groupKeyOf(item);
      if (!groups.has(key)) groups.set(key, { parent: null, tasks: [] });
      if (item.itemType === "project") groups.get(key).parent = item;
      else groups.get(key).tasks.push(item);
    });

    const renderedGroups = new Set();
    const lines = [];
    items.forEach((item) => {
      if (!["project", "task"].includes(item.itemType)) {
        if (item.included !== false && String(item.text || "").trim()) {
          lines.push({ text: item.text.trim(), kind: "regular" });
        }
        return;
      }
      const key = groupKeyOf(item);
      if (renderedGroups.has(key)) return;
      renderedGroups.add(key);
      const group = groups.get(key) || { parent: null, tasks: [] };
      if (group.parent?.included === false) return;
      const includedTasks = group.tasks.filter((task) => task.included !== false && String(task.text || "").trim());
      const parentText = String(
        group.parent?.text ||
        `${item.parentTitle || "연결 업무 없음"} / ${item.department || "발주부서 미지정"} / 일정 미정`
      ).trim();
      if (group.parent?.included !== false && parentText) lines.push({ text: parentText, kind: "parent" });
      includedTasks.forEach((task) => lines.push({ text: `ㄴ ${task.text.trim()}`, kind: "child" }));
    });
    return lines;
  }

  function reportPeriod(month) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
    if (!match) throw new Error("보고 월 형식이 올바르지 않습니다.");
    const year = Number(match[1]);
    const monthNumber = Number(match[2]);
    if (monthNumber < 1 || monthNumber > 12) throw new Error("보고 월 형식이 올바르지 않습니다.");
    return {
      year,
      monthNumber,
      shincheonjiYear: year - 1983,
      lastDay: new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
    };
  }

  function monthlyReportFilename(month) {
    const { monthNumber } = reportPeriod(month);
    return `영상제작과_문화부_${monthNumber}월말보고서.docx`;
  }

  async function loadTemplateBytes(templateBytes) {
    if (templateBytes) return templateBytes instanceof Uint8Array ? templateBytes : new Uint8Array(templateBytes);
    if (typeof fetch !== "function") throw new Error("Word 양식 파일을 불러올 수 없습니다.");
    const response = await fetch(TEMPLATE_URL);
    if (!response.ok) throw new Error("Word 양식 파일을 불러오지 못했습니다.");
    return new Uint8Array(await response.arrayBuffer());
  }

  function updateCoreProperties(files, month, author) {
    if (!files["docProps/core.xml"]) return;
    const { year, monthNumber } = reportPeriod(month);
    let coreXml = decoder.decode(files["docProps/core.xml"]);
    coreXml = coreXml.replace(
      /<dc:title>[\s\S]*?<\/dc:title>/,
      `<dc:title>${xml(`${year}년 ${monthNumber}월 문화부 영상제작과 월말보고서`)}</dc:title>`
    );
    if (author) {
      coreXml = coreXml.replace(
        /<dc:creator>[\s\S]*?<\/dc:creator>/,
        `<dc:creator>${xml(author)}</dc:creator>`
      );
    }
    files["docProps/core.xml"] = encoder.encode(coreXml);
  }

  async function createMonthlyReportDocx({ month, sections, author = "", templateBytes } = {}) {
    const period = reportPeriod(month);
    const files = await unzipFiles(await loadTemplateBytes(templateBytes));
    if (!files["word/document.xml"]) throw new Error("Word 양식에 본문 파일이 없습니다.");

    let documentXml = decoder.decode(files["word/document.xml"]);
    documentXml = replaceParagraphText(
      documentXml,
      "(신천기 00(0000)년 0월분)",
      `(신천기 ${period.shincheonjiYear}(${period.year})년 ${period.monthNumber}월분)`
    );
    documentXml = replaceParagraphText(
      documentXml,
      "신천기 00(0000)년 0월 00일",
      `신천기 ${period.shincheonjiYear}(${period.year})년 ${period.monthNumber}월 ${period.lastDay}일`
    );
    documentXml = replaceParagraphText(
      documentXml,
      "보고자 : 영상제작과장 000",
      `보고자 : 영상제작과장 ${String(author || "").trim() || "미지정"}`
    );
    documentXml = replaceReportTables(documentXml, sections || {});
    files["word/document.xml"] = encoder.encode(documentXml);
    updateCoreProperties(files, month, author);
    return zipStore(files);
  }

  return {
    createMonthlyReportDocx,
    monthlyReportFilename,
    reportPeriod,
    unzipFiles
  };
});
