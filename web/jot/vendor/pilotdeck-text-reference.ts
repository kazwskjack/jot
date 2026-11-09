// Adapted from PilotDeck revision 783499ffdb2d501bf590b2e035acd027a882df10.
// Original source ui/src/types/contentReference.ts, text-reference types and creation.
// Upstream GNU Affero General Public License v3.0 terms apply.
// Complete license retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt
// Jot extracts the used text-reference branch and retains the original schema and rect normalization.
export const CONTENT_REFERENCE_ATTACHMENT_KIND = 'content-reference';
export const CONTENT_REFERENCE_PROMPT_MARKER = '[Content references selected by user:]';

export type ContentReferenceSelectionMode = 'text' | 'cells' | 'region';
export type ContentReferenceSurface = 'document' | 'page' | 'slide' | 'sheet' | 'editor';
export type ContentReferenceRendererId =
  | 'pdf'
  | 'office-pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'text'
  | 'html'
  | 'image';
export type ContentReferenceLocatorQuality = 'semantic' | 'approximate' | 'visual';

export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ContentReferenceSource = {
  projectName?: string;
  relativePath: string;
  fileName: string;
  mimeType?: string;
  revision?: {
    /**
     * Renderer/cache revision when an exact content digest is unavailable.
     * It is opaque and only intended for stale-reference comparison.
     */
    id?: string;
    size?: number;
    mtimeMs?: number;
    sha256?: string;
  };
};

export type ContentReferenceRenderer = {
  id: ContentReferenceRendererId;
  backend: 'builtin' | 'libreoffice';
  locatorQuality: ContentReferenceLocatorQuality;
};

export type ContentReferenceBase = {
  schemaVersion: 1;
  kind: typeof CONTENT_REFERENCE_ATTACHMENT_KIND;
  id: string;
  selectionMode: ContentReferenceSelectionMode;
  source: ContentReferenceSource;
  renderer: ContentReferenceRenderer;
  createdAt: string;
};

export type TextContentReference = ContentReferenceBase & {
  selectionMode: 'text';
  locator: {
    surface: Extract<ContentReferenceSurface, 'document' | 'page' | 'slide' | 'editor'>;
    pageNumbers?: number[];
    slideNumbers?: number[];
    headingPath?: string[];
    quote: {
      exact: string;
      prefix?: string;
      suffix?: string;
    };
    occurrenceIndex?: number | null;
    rects?: NormalizedRect[];
  };
  selectedText: string;
  surroundingText?: string;
  truncated?: boolean;
};

type CreateContentReferenceInput<T extends TextContentReference> = Omit<
  T,
  'schemaVersion' | 'kind' | 'id' | 'createdAt'
> & {
  id?: string;
  createdAt?: string;
};

function createReferenceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `content-ref-${crypto.randomUUID()}`;
  }
  return `content-ref-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clampNormalized(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function normalizeRect(rect: NormalizedRect): NormalizedRect {
  const x = clampNormalized(rect.x);
  const y = clampNormalized(rect.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(1 - x, clampNormalized(rect.width))),
    height: Math.max(0, Math.min(1 - y, clampNormalized(rect.height))),
  };
}

function createContentReference<T extends TextContentReference>(
  input: CreateContentReferenceInput<T>,
): T {
  return {
    ...input,
    schemaVersion: 1,
    kind: CONTENT_REFERENCE_ATTACHMENT_KIND,
    id: input.id || createReferenceId(),
    createdAt: input.createdAt || new Date().toISOString(),
  } as T;
}

export function createTextContentReference(
  input: CreateContentReferenceInput<TextContentReference>,
): TextContentReference {
  return createContentReference<TextContentReference>({
    ...input,
    locator: {
      ...input.locator,
      ...(input.locator.rects
        ? { rects: input.locator.rects.map(normalizeRect) }
        : {}),
    },
  });
}
