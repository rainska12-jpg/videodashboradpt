(function monthlyReportDocxModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MonthlyReportDocx = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createMonthlyReportDocx() {
  "use strict";

  const encoder = new TextEncoder();

  function xml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  }

  function paragraph(text, style = "Normal", bullet = false) {
    const numberingId = bullet === "child" ? 2 : bullet ? 1 : 0;
    const numbering = numberingId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numberingId}"/></w:numPr>` : "";
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${numbering}</w:pPr><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  }

  function sectionParagraphs(items, section) {
    if (section !== "activity") return items.map((item) => paragraph(item.text.trim(), "Normal", true));
    const groupKeyOf = (item) => item.parentSourceId || `${item.parentTitle || "연결 업무 없음"}\u0000${item.department || ""}`;
    const groups = new Map();
    items.filter((item) => ["project", "task"].includes(item.itemType)).forEach((item) => {
      const key = groupKeyOf(item);
      if (!groups.has(key)) groups.set(key, { parent: null, tasks: [] });
      if (item.itemType === "project") groups.get(key).parent = item;
      else groups.get(key).tasks.push(item);
    });
    const renderedGroups = new Set();
    return items.flatMap((item) => {
      if (!["project", "task"].includes(item.itemType)) return [paragraph(item.text.trim(), "Normal", true)];
      const key = groupKeyOf(item);
      if (renderedGroups.has(key)) return [];
      renderedGroups.add(key);
      const group = groups.get(key) || { parent: null, tasks: [] };
      const parentText = group.parent?.text || `${item.parentTitle || "연결 업무 없음"} / ${item.department || "발주부서 미지정"} / 일정 미정`;
      return [
        paragraph(parentText, "TaskParent"),
        ...group.tasks.map((task) => paragraph(task.text.trim(), "Normal", "child"))
      ];
    });
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

  function createMonthlyReportDocx({ month, sections, organization = "", author = "" }) {
    const [year, monthNumber] = String(month).split("-");
    const title = `${year}년 ${Number(monthNumber)}월 월말보고서`;
    const sectionMeta = [
      ["activity", "4-1. 활동내용"],
      ["production", "4-2. 제작물현황"],
      ["next", "4-3. 차월계획"]
    ];
    const body = [
      paragraph(title, "ReportTitle"),
      organization ? paragraph(organization, "Subtitle") : "",
      paragraph(`작성일 ${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(new Date())}`, "ReportMeta"),
      ...sectionMeta.flatMap(([key, label]) => {
        const items = (sections?.[key] || []).filter((item) => item.included !== false && String(item.text || "").trim());
        return [paragraph(label, "Heading1"), ...(items.length ? sectionParagraphs(items, key) : [paragraph("해당 없음", "Muted")])];
      })
    ].join("");
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`;
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Apple SD Gothic Neo" w:hAnsi="Apple SD Gothic Neo" w:eastAsia="Apple SD Gothic Neo" w:cs="Apple SD Gothic Neo"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="222222"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Apple SD Gothic Neo" w:hAnsi="Apple SD Gothic Neo" w:eastAsia="Apple SD Gothic Neo" w:cs="Apple SD Gothic Neo"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ReportTitle"><w:name w:val="Report Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="80"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="111111"/><w:sz w:val="46"/><w:szCs w:val="46"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="100"/></w:pPr><w:rPr><w:color w:val="555555"/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ReportMeta"><w:name w:val="Report Metadata"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="280"/></w:pPr><w:rPr><w:color w:val="777777"/><w:sz w:val="19"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TaskParent"><w:name w:val="Task Parent"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="180" w:after="80"/><w:ind w:left="360"/></w:pPr><w:rPr><w:b/><w:color w:val="35566F"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Muted"><w:name w:val="Muted"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="777777"/><w:i/></w:rPr></w:style>
</w:styles>`;
    const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/><w:spacing w:after="160" w:line="280" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Apple SD Gothic Neo" w:hAnsi="Apple SD Gothic Neo" w:eastAsia="Apple SD Gothic Neo"/></w:rPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="ㄴ"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="900"/></w:tabs><w:ind w:left="900" w:hanging="360"/><w:spacing w:after="140" w:line="280" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Apple SD Gothic Neo" w:hAnsi="Apple SD Gothic Neo" w:eastAsia="Apple SD Gothic Neo"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
    const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="6" w:color="D9D9D9"/></w:pBdr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Apple SD Gothic Neo" w:hAnsi="Apple SD Gothic Neo" w:eastAsia="Apple SD Gothic Neo"/><w:color w:val="777777"/><w:sz w:val="18"/></w:rPr><w:t>월말 업무보고</w:t></w:r></w:p></w:hdr>`;
    const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:color w:val="777777"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
    const now = new Date().toISOString();
    return zipStore({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
      "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
      "word/document.xml": documentXml,
      "word/styles.xml": stylesXml,
      "word/numbering.xml": numberingXml,
      "word/header1.xml": headerXml,
      "word/footer1.xml": footerXml,
      "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
      "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>${xml(author || "영상 업무 대시보드")}</dc:creator><cp:lastModifiedBy>영상 업무 대시보드</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
      "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>영상 업무 대시보드</Application><AppVersion>1.0</AppVersion></Properties>`
    });
  }

  return { createMonthlyReportDocx };
});
