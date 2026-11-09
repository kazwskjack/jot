// Adapted from PilotDeck revision 783499ffdb2d501bf590b2e035acd027a882df10.
// Original source ui/src/components/code-editor/utils/pdfOutline.ts
// Upstream GNU Affero General Public License v3.0 terms apply.
// Complete license retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt
// Jot resolves outlines sequentially with cancellation for original fixed-file viewing.
import type { PDFDocumentProxy } from 'pdfjs-dist';

type PdfReference = {
  num: number;
  gen: number;
};

type RawPdfOutlineItem = {
  title: string;
  dest: string | unknown[] | null;
  items: RawPdfOutlineItem[];
};

type PdfOutlineDocument = Pick<
  PDFDocumentProxy,
  'getDestination' | 'getPageIndex' | 'numPages'
>;

export type PdfOutlineItem = {
  id: string;
  title: string;
  pageNumber: number | null;
  items: PdfOutlineItem[];
};

function isPdfReference(value: unknown): value is PdfReference {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PdfReference>;
  return Number.isInteger(candidate.num) && Number.isInteger(candidate.gen);
}

async function resolveDestinationPage(
  pdfDocument: PdfOutlineDocument,
  destination: RawPdfOutlineItem['dest'],
): Promise<number | null> {
  try {
    const resolvedDestination = typeof destination === 'string'
      ? await pdfDocument.getDestination(destination)
      : destination;
    if (!Array.isArray(resolvedDestination) || resolvedDestination.length === 0) {
      return null;
    }

    const pageReference = resolvedDestination[0];
    const pageIndex = typeof pageReference === 'number'
      ? pageReference
      : isPdfReference(pageReference)
        ? await pdfDocument.getPageIndex(pageReference)
        : null;
    if (pageIndex === null || !Number.isInteger(pageIndex)) return null;

    const pageNumber = pageIndex + 1;
    return pageNumber >= 1 && pageNumber <= pdfDocument.numPages
      ? pageNumber
      : null;
  } catch {
    return null;
  }
}

async function resolveOutlineLevel(
  pdfDocument: PdfOutlineDocument,
  items: RawPdfOutlineItem[],
  parentId: string,
  signal?: AbortSignal,
): Promise<PdfOutlineItem[]> {
  const resolved: PdfOutlineItem[] = [];
  for (const [index, item] of items.entries()) {
    signal?.throwIfAborted();
    const id = `${parentId}-${index}`;
    const title = item.title.replace(/\s+/g, ' ').trim();
    const pageNumber = await resolveDestinationPage(pdfDocument, item.dest);
    signal?.throwIfAborted();
    const children = await resolveOutlineLevel(pdfDocument, item.items || [], id, signal);
    if (!title) {
      for (const child of children) resolved.push(child);
    } else if (pageNumber !== null || children.length > 0) {
      resolved.push({ id, title, pageNumber, items: children });
    }
  }
  return resolved;
}

export async function resolvePdfOutline(
  pdfDocument: PdfOutlineDocument,
  outline: RawPdfOutlineItem[] | null,
  signal?: AbortSignal,
): Promise<PdfOutlineItem[]> {
  signal?.throwIfAborted();
  if (!outline || outline.length === 0) return [];
  return resolveOutlineLevel(pdfDocument, outline, 'outline', signal);
}
