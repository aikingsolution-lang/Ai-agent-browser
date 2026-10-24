// chrome-extension/src/background/agent/linkedin/resumeDraft.ts
import type { ICareerBrain } from '@extension/storage';

/**
 * Deterministic draft-resume builder (Phase 5).
 *
 * When an employer requires a Resume upload but the candidate has no resume file
 * configured, the apply flow auto-generates a truthful draft resume assembled
 * STRICTLY from the candidate's own profile data (name, contact, narrative,
 * skills, work history, education). No LLM call, no invented content, 0 credits.
 *
 * The PDF is hand-rolled (ASCII-safe, standard Helvetica) so no new dependency
 * is needed in the extension bundle.
 */

const BULLET_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[•●▪◦‣]/g, '-'],
  [/[–—]/g, '-'],
  [/[“”„]/g, '"'],
  [/[‘’`]/g, "'"],
];

/** Strip or transliterate characters outside the PDF WinAnsi-safe printable range. */
function sanitizePdfText(raw: unknown): string {
  let s = String(raw || '');
  for (const [re, sub] of BULLET_REPLACEMENTS) s = s.replace(re, sub);
  return s
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Safe file name for the generated PDF (e.g. "Resume_Amit_Sharma.pdf"). */
export function buildDraftResumeFileName(brain: ICareerBrain): string {
  const namePart =
    sanitizePdfText(brain.fullName)
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'Candidate';
  return `Resume_${namePart}.pdf`;
}

/** Assemble an ATS-friendly plain-text resume from structured profile data only. */
export function buildDraftResumeText(brain: ICareerBrain): string {
  const lines: string[] = [];

  const name = sanitizePdfText(brain.fullName);
  const title = sanitizePdfText(brain.currentTitle);
  if (name) lines.push(name);
  if (title && title.toLowerCase() !== name.toLowerCase()) lines.push(title);

  const contact = [sanitizePdfText(brain.email), sanitizePdfText(brain.phoneNumber)].filter(Boolean).join(' | ');
  if (contact) lines.push(contact);
  const links = [brain.linkedinUrl, brain.githubUrl, brain.portfolioUrl]
    .filter(u => u && String(u).trim())
    .map(sanitizePdfText)
    .filter(Boolean);
  if (links.length > 0) lines.push(links.join(' | '));

  const summary = sanitizePdfText(brain.backgroundNarrative);
  if (summary) {
    lines.push('');
    lines.push('PROFESSIONAL SUMMARY');
    lines.push(summary);
  }

  const skills = Array.from(new Set([...(brain.skills || []), ...(brain.autoExtractedSkills || [])]))
    .map(sanitizePdfText)
    .filter(Boolean);
  if (skills.length > 0) {
    lines.push('');
    lines.push('SKILLS');
    lines.push(skills.join(', '));
  }

  const skillExp = Object.entries(brain.skillExperience || {}).filter(
    ([skill, years]) => sanitizePdfText(skill) && typeof years === 'number' && years > 0,
  );
  if (skillExp.length > 0) {
    lines.push('');
    lines.push('SKILLS & EXPERIENCE');
    for (const [skill, years] of skillExp) {
      lines.push(`- ${sanitizePdfText(skill)}: ${years} year${years === 1 ? '' : 's'}`);
    }
  }

  const work = Array.isArray(brain.workExperience)
    ? brain.workExperience.filter(w => w && sanitizePdfText(w.title) && sanitizePdfText(w.company))
    : [];
  if (work.length > 0) {
    lines.push('');
    lines.push('WORK EXPERIENCE');
    for (const w of work) {
      const start = [sanitizePdfText(w.startMonth), sanitizePdfText(w.startYear)].filter(Boolean).join(' ');
      const end = w.isCurrent
        ? 'Present'
        : [sanitizePdfText(w.endMonth), sanitizePdfText(w.endYear)].filter(Boolean).join(' ');
      const dates = [start, end].filter(Boolean).join(' - ');
      lines.push(
        `${sanitizePdfText(w.title)} | ${sanitizePdfText(w.company)}${dates ? ` | ${sanitizePdfText(dates)}` : ''}`,
      );
      const desc = sanitizePdfText(w.description);
      if (desc) lines.push(`- ${desc}`);
    }
  }

  const eduParts = [brain.highestEducation, brain.education, brain.college].map(sanitizePdfText).filter(Boolean);
  if (eduParts.length > 0 || sanitizePdfText(brain.cgpa)) {
    lines.push('');
    lines.push('EDUCATION');
    if (eduParts.length > 0) lines.push(eduParts.join(' | '));
    if (sanitizePdfText(brain.cgpa)) lines.push(`CGPA / Score: ${sanitizePdfText(brain.cgpa)}`);
  }

  const structured = lines.filter(l => l.trim().length > 0);
  if (structured.length <= 3 && String(brain.resumeText || '').trim().length >= 50) {
    // No structured data worth assembling: fall back to the candidate's own resume
    // text (their real content, sanitized for the PDF font subset).
    return String(brain.resumeText || '')
      .split(/\r?\n/)
      .map(sanitizePdfText)
      .filter(Boolean)
      .join('\n');
  }

  return lines.join('\n');
}

/** Minimal hand-rolled PDF generator (single/multi page, ASCII text, Helvetica). */
export function buildDraftResumePdf(brain: ICareerBrain): Uint8Array {
  const text = buildDraftResumeText(brain);
  const MAX_LINE = 95;
  const PAGE_H = 842;
  const MARGIN = 57;

  const escapePdf = (s: string) =>
    sanitizePdfText(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const entries: Array<{ text: string; size: number }> = [];
  let isFirst = true;
  for (const raw of text.split('\n')) {
    let s = String(raw).trimEnd();
    const size = isFirst && s ? 14 : 10;
    if (s) isFirst = false;
    while (s.length > MAX_LINE) {
      let cut = s.lastIndexOf(' ', MAX_LINE);
      if (cut <= 30) cut = MAX_LINE;
      entries.push({ text: s.slice(0, cut), size });
      s = s.slice(cut).trimStart();
    }
    entries.push({ text: s, size });
  }

  const pageStreams: string[] = [];
  let content: string[] = [];
  let y = PAGE_H - MARGIN;
  for (const { text: t, size } of entries) {
    if (y < MARGIN + size) {
      pageStreams.push(content.join('\n'));
      content = [];
      y = PAGE_H - MARGIN;
    }
    if (!t) {
      y -= 7;
      continue;
    }
    content.push(`BT /F1 ${size} Tf ${MARGIN} ${y} Td (${escapePdf(t)}) Tj ET`);
    y -= size + 5;
  }
  if (content.length > 0) pageStreams.push(content.join('\n'));

  const objects: string[] = [];
  const offsets: number[] = [];
  let pdf = '%PDF-1.4\n';
  const addObj = (body: string) => {
    offsets.push(pdf.length);
    objects.push(body);
    pdf += `${objects.length} 0 obj\n${body}\nendobj\n`;
  };

  addObj('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pageStreams.map((_, i) => `${3 + i} 0 R`).join(' ');
  addObj(`<< /Type /Pages /Kids [${kids}] /Count ${pageStreams.length} >>`);
  for (const s of pageStreams) {
    addObj(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  }
  addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) {
    pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

/** Encode bytes as base64 without blowing the call stack on large inputs. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
