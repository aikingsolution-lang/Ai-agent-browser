/**
 * Resume Generation Service
 *
 * Generates clean, ATS-compliant PDF resumes tailored to specific job keywords.
 * Creates standard PDF 1.4 binary documents without external binary dependencies.
 */

export interface ResumeGenerationParams {
  candidateName: string;
  candidateEmail: string;
  candidatePhone?: string;
  currentTitle?: string;
  skills: string[];
  targetKeywords: string[];
  jobTitle: string;
  company: string;
  backgroundNarrative?: string;
}

export interface GeneratedResumeResult {
  pdfBuffer: Buffer;
  base64Pdf: string;
  fileName: string;
  fileSize: number;
  highlightedKeywords: string[];
}

/**
 * Builds a valid ATS-friendly PDF 1.4 binary buffer.
 */
export function buildPdfDocument(contentLines: string[]): Buffer {
  // Sanitize lines to ASCII text for standard Type 1 font encoding
  const sanitizedLines = contentLines.map(line => line.replace(/[^\x20-\x7E]/g, ' ').replace(/[()\\]/g, '\\$&'));

  let textStream = 'BT\n/F1 11 Tf\n14 TL\n50 750 Td\n';

  for (const line of sanitizedLines) {
    if (line.startsWith('### ')) {
      // Header 1
      textStream += `/F2 16 Tf\n(${line.substring(4)}) Tj\n/F1 11 Tf\nT*\n`;
    } else if (line.startsWith('## ')) {
      // Header 2
      textStream += `/F2 13 Tf\n(${line.substring(3)}) Tj\n/F1 11 Tf\nT*\n`;
    } else if (line.startsWith('- ')) {
      // Bullet item
      textStream += `  (${line}) Tj\nT*\n`;
    } else if (line.trim() === '') {
      textStream += 'T*\n';
    } else {
      textStream += `(${line}) Tj\nT*\n`;
    }
  }

  textStream += 'ET';
  const streamLength = Buffer.byteLength(textStream, 'utf8');

  // PDF Objects
  const pdfObjects = [
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${textStream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n',
  ];

  // Calculate xref table
  let currentOffset = 0;
  const xrefOffsets: number[] = [];

  for (let i = 0; i < pdfObjects.length; i++) {
    if (i > 0) {
      xrefOffsets.push(currentOffset);
    }
    currentOffset += Buffer.byteLength(pdfObjects[i], 'utf8');
  }

  const xrefStart = currentOffset;
  let xref = `xref\n0 ${pdfObjects.length}\n0000000000 65535 f \n`;

  for (const offset of xrefOffsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${pdfObjects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  const fullPdfString = pdfObjects.join('') + xref + trailer;
  return Buffer.from(fullPdfString, 'binary');
}

export class ResumeGeneratorService {
  /**
   * Generates a targeted PDF resume aligning candidate profile with target job keywords.
   */
  static async generateTailoredResume(params: ResumeGenerationParams): Promise<GeneratedResumeResult> {
    const {
      candidateName,
      candidateEmail,
      candidatePhone,
      currentTitle,
      skills,
      targetKeywords,
      jobTitle,
      company,
      backgroundNarrative,
    } = params;

    // Highlight intersecting keywords
    const highlightedKeywords = skills.filter(skill =>
      targetKeywords.some(
        kw => kw.toLowerCase().includes(skill.toLowerCase()) || skill.toLowerCase().includes(kw.toLowerCase()),
      ),
    );

    const docLines: string[] = [
      `### ${candidateName || 'Candidate Name'}`,
      `${currentTitle ? currentTitle + ' | ' : ''}${candidateEmail || ''}${candidatePhone ? ' | ' + candidatePhone : ''}`,
      '',
      `## Professional Summary (Tailored for ${jobTitle} at ${company})`,
      backgroundNarrative ||
        `Experienced professional with strong expertise in ${skills.slice(0, 5).join(', ')}. Proven track record delivering high-impact solutions.`,
      '',
      '## Core Competencies & Key Skills',
      `- Key Skills: ${skills.join(', ')}`,
      `- Highlighted Alignments: ${highlightedKeywords.length > 0 ? highlightedKeywords.join(', ') : skills.slice(0, 4).join(', ')}`,
      '',
      '## Relevant Experience',
      `- Role: ${currentTitle || 'Professional'} (${jobTitle} Focus)`,
      `- Spearheaded technical and operational tasks aligned with modern industry standards.`,
      `- Successfully leveraged ${highlightedKeywords.slice(0, 3).join(' and ') || 'modern methodologies'} to drive efficiency.`,
      '',
      '## Target Role Alignment',
      `- Position: ${jobTitle}`,
      `- Target Company: ${company}`,
    ];

    const pdfBuffer = buildPdfDocument(docLines);
    const base64Pdf = pdfBuffer.toString('base64');
    const sanitizedName = (candidateName || 'Resume').replace(/\s+/g, '_');
    const sanitizedCompany = (company || 'Job').replace(/\s+/g, '_');
    const fileName = `${sanitizedName}_${sanitizedCompany}_Resume.pdf`;

    return {
      pdfBuffer,
      base64Pdf,
      fileName,
      fileSize: pdfBuffer.length,
      highlightedKeywords,
    };
  }
}
