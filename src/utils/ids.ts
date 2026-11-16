import { randomUUID } from 'node:crypto';

const DOCUMENT_ID = /^doc_[0-9a-f]{32}$/;
const JOB_ID = /^job_[0-9a-f]{32}$/;

const compactUuid = () => randomUUID().replace(/-/g, '');

export const newDocumentId = (): string => `doc_${compactUuid()}`;
export const newJobId = (): string => `job_${compactUuid()}`;

export const isDocumentId = (value: string): boolean => DOCUMENT_ID.test(value);
export const isJobId = (value: string): boolean => JOB_ID.test(value);
