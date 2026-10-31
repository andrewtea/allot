import { createHash } from 'node:crypto';
import { MAX_PREVIEW_BYTES, type ScanResult } from './protocol.ts';

export function verifyPreview(base64: string, evidence: Extract<ScanResult['evidence'], { status: 'ready' }>) {
  if (base64.length > 4 * Math.ceil(MAX_PREVIEW_BYTES / 3)) throw new Error('OVERSIZED_EVIDENCE');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64 || bytes.length !== evidence.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== evidence.sha256 ||
      bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.subarray(12, 16).toString() !== 'IHDR' || bytes.readUInt32BE(16) < 1 ||
      bytes.readUInt32BE(16) > 2048 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 4096) {
    throw new Error('INVALID_EVIDENCE');
  }
  return bytes.length;
}
