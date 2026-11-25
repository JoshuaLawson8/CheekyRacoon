import type { TextDocumentContentChangeEvent } from 'vscode';
import type { EditData } from './types';

type Change = Pick<TextDocumentContentChangeEvent, 'rangeOffset' | 'rangeLength' | 'text'>;

export function editRanges(changes: readonly Change[], reason?: EditData['reason']): EditData[] {
  const edits: EditData[] = [];
  for (const { rangeOffset, rangeLength, text } of changes) {
    if (rangeLength || text.length) {
      edits.push({ offset: rangeOffset, charsInserted: text.length, charsDeleted: rangeLength, reason });
    }
  }
  return edits;
}
