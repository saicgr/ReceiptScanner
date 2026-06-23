/**
 * Unit tests for the pure PDF page-count parser used by the on-device PDF
 * intake (TASK 36). It scans raw PDF bytes for `/Type /Page` markers (excluding
 * the `/Type /Pages` tree node) and defaults to 1 when it can't tell.
 *
 * NOTE: `countPdfPages` lives in `src/services/imagePipeline.ts` alongside the
 * rest of the PDF intake, but it is a pure string function with no native
 * imports, so we import it directly. The surrounding module only pulls in native
 * modules lazily inside async functions, so importing the pure helper is safe.
 */
import { countPdfPages } from '../../services/imagePipeline';

describe('countPdfPages', () => {
  it('defaults to 1 for empty or non-PDF input', () => {
    expect(countPdfPages('')).toBe(1);
    expect(countPdfPages('not a pdf at all')).toBe(1);
  });

  it('counts a single-page PDF as 1', () => {
    const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF';
    expect(countPdfPages(pdf)).toBe(1);
  });

  it('counts multiple page objects', () => {
    const pdf = [
      '%PDF-1.4',
      '<< /Type /Pages /Kids [2 0 R 3 0 R 4 0 R] /Count 3 >>',
      '<< /Type /Page /Parent 1 0 R >>',
      '<< /Type /Page /Parent 1 0 R >>',
      '<< /Type /Page /Parent 1 0 R >>',
      '%%EOF',
    ].join('\n');
    expect(countPdfPages(pdf)).toBe(3);
  });

  it('does NOT count the /Type /Pages tree node as a page', () => {
    const pdf = '<< /Type /Pages /Count 0 >>';
    // No real /Type /Page markers -> falls back to 1.
    expect(countPdfPages(pdf)).toBe(1);
  });

  it('tolerates varied whitespace between /Type and /Page', () => {
    const pdf = '<< /Type/Page >>\n<< /Type   /Page >>';
    expect(countPdfPages(pdf)).toBe(2);
  });
});
