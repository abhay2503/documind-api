import { describe, expect, it } from 'vitest';
import { documentS3Key, fileTypeForName, normalizeContentType, sanitizeFileName } from '../../src/utils/fileTypes';
import { isDocumentId, isJobId, newDocumentId, newJobId } from '../../src/utils/ids';

describe('file types', () => {
  it('detects accepted extensions case-insensitively', () => {
    expect(fileTypeForName('Report.PDF')?.mimeType).toBe('application/pdf');
    expect(fileTypeForName('notes.txt')?.mimeType).toBe('text/plain');
    expect(fileTypeForName('doc.docx')?.extension).toBe('.docx');
    expect(fileTypeForName('image.png')).toBeUndefined();
    expect(fileTypeForName('archive.pdf.exe')).toBeUndefined();
  });

  it('normalizes content types', () => {
    expect(normalizeContentType('Text/Plain; charset=utf-8')).toBe('text/plain');
    expect(normalizeContentType(undefined)).toBe('');
  });

  it('sanitizes file names for S3 keys', () => {
    expect(sanitizeFileName('../../etc/My Invoice (1).pdf', '.pdf')).toBe('My_Invoice_1.pdf');
    expect(sanitizeFileName('???.txt', '.txt')).toBe('document.txt');
    expect(documentS3Key('doc_x', 'a.pdf')).toBe('documents/doc_x/a.pdf');
  });

  it('generates and validates ids', () => {
    expect(isDocumentId(newDocumentId())).toBe(true);
    expect(isJobId(newJobId())).toBe(true);
    expect(isDocumentId(newJobId())).toBe(false);
    expect(isDocumentId('doc_123')).toBe(false);
  });
});
