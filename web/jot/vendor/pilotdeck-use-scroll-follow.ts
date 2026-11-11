// Adapted from PilotDeck 783499ff useScrollFollow.ts; retained AGPL-3.0 terms.
// See THIRD_PARTY_NOTICES.md and packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

const BOTTOM_EPSILON = 2;
const VIEWPORT_SELECTOR = '[data-stream-scroll-viewport]';
const FOLLOW_CHANGE = 'stream-scroll-follow-change';
const controllers = new WeakMap<HTMLElement, { resume: () => void }>();
export type ReadingAnchor = { key: string; offset: number };
type UserScroll = { top: number; direction: number; dragging?: boolean };

/** Keep user intent, viewport geometry, and the return-to-latest affordance separate. */
export function useScrollFollow({
  containerRef, enabled = true, scopeKey, contentKey, contentSelector, canFollow, windowViewport = false,
}: {
  containerRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  scopeKey?: string | null;
  contentKey?: unknown;
  contentSelector?: string;
  canFollow?: () => boolean;
  windowViewport?: boolean;
}) {
  const [isPaused, setIsPaused] = useState(false);
  const [canReturnToLatest, setCanReturnToLatest] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const pausedRef = useRef(false);
  const optionsRef = useRef({ enabled, canFollow });
  optionsRef.current = { enabled, canFollow };
  // Jot's conversation uses the document viewport; nested thinking keeps element geometry.
  const readGeometry = useCallback((node: HTMLElement) => windowViewport && node === containerRef.current
    ? { top: window.scrollY, height: (document.scrollingElement ?? document.documentElement).scrollHeight, viewport: document.documentElement.clientHeight || window.innerHeight }
    : { top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight }, [containerRef, windowViewport]);
  const writeTop = useCallback((node: HTMLElement, top: number) => {
    if (windowViewport && node === containerRef.current) window.scrollTo({ top, behavior: 'auto' });
    else node.scrollTop = top;
  }, [containerRef, windowViewport]);
  const viewportTop = useCallback((node: HTMLElement) => windowViewport && node === containerRef.current ? 0 : node.getBoundingClientRect().top, [containerRef, windowViewport]);
  const frameRef = useRef<number | null>(null);
  const initialFrameRef = useRef(false);
  const anchorRef = useRef<ReadingAnchor | null>(null);
  const metricsRef = useRef({ top: 0, height: 0, viewport: 0 });
  const programmaticTopRef = useRef<number | null>(null);
  const userScrollRef = useRef<UserScroll | null>(null);

  const cancelFollow = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    initialFrameRef.current = false;
  }, []);

  const updateAvailability = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    setHasOverflow(readGeometry(node).height - readGeometry(node).viewport > BOTTOM_EPSILON);
    setCanReturnToLatest([node, ...node.querySelectorAll<HTMLElement>(VIEWPORT_SELECTOR)].some((viewport) => (
      readGeometry(viewport).viewport > 0
      && (viewport.dataset.scrollFollowPaused === 'true' || (viewport === node && !optionsRef.current.enabled))
      && readGeometry(viewport).height - readGeometry(viewport).viewport - readGeometry(viewport).top > BOTTOM_EPSILON
    )));
  }, [containerRef, readGeometry]);

  const publish = useCallback(() => {
    updateAvailability();
    containerRef.current?.dispatchEvent(new Event(FOLLOW_CHANGE, { bubbles: true }));
  }, [containerRef, updateAvailability]);

  const rememberMetrics = useCallback(() => {
    const node = containerRef.current;
    if (node) metricsRef.current = readGeometry(node);
  }, [containerRef, readGeometry]);

  const captureAnchor = useCallback(() => {
    const node = containerRef.current;
    if (!node || !contentSelector) return;
    const top = viewportTop(node);
    const row = Array.from(node.querySelectorAll<HTMLElement>('[data-message-key]'))
      .find((item) => item.getBoundingClientRect().bottom > top);
    anchorRef.current = row ? { key: row.dataset.messageKey!, offset: row.getBoundingClientRect().top - top } : null;
    if (row) node.dataset.readingAnchorKey = row.dataset.messageKey;
    else delete node.dataset.readingAnchorKey;
  }, [containerRef, contentSelector, viewportTop]);

  const restoreAnchor = useCallback(() => {
    const node = containerRef.current;
    const anchor = anchorRef.current;
    if (!node || !anchor) return;
    const row = Array.from(node.querySelectorAll<HTMLElement>('[data-message-key]'))
      .find((item) => item.dataset.messageKey === anchor.key);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - viewportTop(node) - anchor.offset;
    if (Math.abs(delta) > 0.5) {
      const targetTop = readGeometry(node).top + delta;
      writeTop(node, targetTop);
      programmaticTopRef.current = readGeometry(node).top;
      // Shrinking content can make the old offset unreachable. Adopt the
      // clamped position so later growth cannot replay that stale correction.
      if (Math.abs(readGeometry(node).top - targetTop) > 0.5) captureAnchor();
    }
    rememberMetrics();
  }, [containerRef, rememberMetrics, captureAnchor, readGeometry, writeTop, viewportTop]);

  const getReadingAnchor = useCallback(() => anchorRef.current ? { ...anchorRef.current } : null, []);
  const restoreReadingAnchor = useCallback((anchor: ReadingAnchor) => {
    anchorRef.current = { ...anchor };
    if (containerRef.current) containerRef.current.dataset.readingAnchorKey = anchor.key;
    restoreAnchor();
  }, [containerRef, restoreAnchor]);

  const setPaused = useCallback((paused: boolean) => {
    pausedRef.current = paused;
    setIsPaused(paused);
    if (containerRef.current) containerRef.current.dataset.scrollFollowPaused = String(paused);
    if (paused) {
      cancelFollow();
      captureAnchor();
    } else {
      anchorRef.current = null;
      if (containerRef.current) delete containerRef.current.dataset.readingAnchorKey;
    }
    publish();
  }, [cancelFollow, captureAnchor, containerRef, publish]);

  // A resize can run before the browser delivers scroll. Account for the actual
  // user displacement before any anchor restoration, including in that order.
  const acceptUserDisplacement = useCallback(() => {
    const node = containerRef.current;
    const input = userScrollRef.current;
    if (!node || !input) return false;
    const delta = readGeometry(node).top - input.top;
    if (!delta || (input.direction && Math.sign(delta) !== input.direction)) return false;
    const previous = metricsRef.current;
    const layoutChanged = readGeometry(node).height !== previous.height || readGeometry(node).viewport !== previous.viewport;
    if (layoutChanged && anchorRef.current) {
      // Preserve the reader's gesture AND any independent insertion above it.
      anchorRef.current.offset -= delta;
      restoreAnchor();
    }
    captureAnchor();
    userScrollRef.current = input.dragging ? { ...input, top: readGeometry(node).top } : null;
    rememberMetrics();
    return true;
  }, [containerRef, captureAnchor, rememberMetrics, restoreAnchor, readGeometry]);

  const writeBottom = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    writeTop(node, Math.max(0, readGeometry(node).height - readGeometry(node).viewport));
    programmaticTopRef.current = readGeometry(node).top;
    if (!optionsRef.current.enabled) captureAnchor();
    rememberMetrics();
    publish();
  }, [containerRef, captureAnchor, rememberMetrics, publish, readGeometry, writeTop]);

  const queuePosition = useCallback((initial: boolean) => {
    const allowed = () => !pausedRef.current
      && (initial || optionsRef.current.enabled) && (optionsRef.current.canFollow?.() ?? true);
    if (!allowed()) return;
    if (initial) cancelFollow();
    if (frameRef.current !== null) return;
    initialFrameRef.current = initial;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      initialFrameRef.current = false;
      if (allowed()) writeBottom();
    });
  }, [cancelFollow, writeBottom]);
  const scheduleFollow = useCallback(() => queuePosition(false), [queuePosition]);
  const scheduleInitialPosition = useCallback(() => queuePosition(true), [queuePosition]);
  const getIsPaused = useCallback(() => pausedRef.current, []);
  const pause = useCallback(() => setPaused(true), [setPaused]);

  const resumeOwnViewport = useCallback(() => {
    cancelFollow();
    userScrollRef.current = null;
    setPaused(false);
    writeBottom();
    scheduleFollow();
  }, [cancelFollow, setPaused, writeBottom, scheduleFollow]);
  const scrollToBottom = useCallback(() => {
    // The global control represents all visible nested viewports as well.
    const nested = containerRef.current?.querySelectorAll<HTMLElement>(VIEWPORT_SELECTOR) ?? [];
    Array.from(nested).reverse().forEach((viewport) => {
      if (readGeometry(viewport).viewport > 0) controllers.get(viewport)?.resume();
    });
    resumeOwnViewport();
  }, [containerRef, resumeOwnViewport, readGeometry]);

  useLayoutEffect(() => {
    cancelFollow();
    anchorRef.current = null;
    if (containerRef.current) delete containerRef.current.dataset.readingAnchorKey;
    programmaticTopRef.current = null;
    userScrollRef.current = null;
    setPaused(false);
    rememberMetrics();
    return cancelFollow;
  }, [scopeKey, cancelFollow, containerRef, rememberMetrics, setPaused]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let touchY: number | null = null;
    const atBottom = () => readGeometry(node).height - readGeometry(node).top - readGeometry(node).viewport <= BOTTOM_EPSILON;
    const sourceViewport = (target: EventTarget | null) => {
      let source = target instanceof Element ? target.closest<HTMLElement>(VIEWPORT_SELECTOR) ?? node : node;
      // A short nested block cannot consume the gesture; its scrollable
      // ancestor owns it. A nested block with overflow keeps that ownership.
      while (source !== node && readGeometry(source).height - readGeometry(source).viewport <= BOTTOM_EPSILON) {
        source = source.parentElement?.closest<HTMLElement>(VIEWPORT_SELECTOR) ?? node;
      }
      return source;
    };
    const beginUpwardInput = (target: EventTarget | null) => {
      const source = sourceViewport(target);
      if (readGeometry(source).height - readGeometry(source).viewport <= BOTTOM_EPSILON) return;
      setPaused(true);
      if (source === node) {
        programmaticTopRef.current = null;
        userScrollRef.current = { top: readGeometry(node).top, direction: -1 };
      }
    };
    const beginDownwardInput = (target: EventTarget | null) => {
      if (sourceViewport(target) !== node) return;
      if (atBottom()) scrollToBottom();
      else userScrollRef.current = { top: readGeometry(node).top, direction: 1 };
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      if (event.deltaY < 0) beginUpwardInput(event.target);
      else if (event.deltaY > 0) beginDownwardInput(event.target);
    };
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
    const touchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      if (nextY !== null && touchY !== null && nextY > touchY) beginUpwardInput(event.target);
      else if (nextY !== null && touchY !== null && nextY < touchY) beginDownwardInput(event.target);
      touchY = nextY;
    };
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && (target.closest('input, textarea, select, [contenteditable="true"]')
        || windowViewport && target.closest('[role="menu"], [role="listbox"], [role="combobox"], [role="search"], [role="dialog"], [role="alertdialog"]'))) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) beginUpwardInput(target);
      else if (event.key === 'End' && sourceViewport(target) === node) scrollToBottom();
      else if (['ArrowDown', 'PageDown', ' '].includes(event.key)) beginDownwardInput(target);
    };
    const pointerDown = (event: PointerEvent) => {
      // A click in blank content is not a scrollbar drag.
      const source = sourceViewport(event.target);
      const pageScrollbar = windowViewport && source === node && (event.target === document.documentElement || event.target === document.body || event.target === document);
      const right = windowViewport && source === node ? window.innerWidth : source.getBoundingClientRect().right;
      if ((event.target === source || pageScrollbar) && readGeometry(source).height > readGeometry(source).viewport
        && event.clientX >= right - 16) {
        setPaused(true);
        if (source === node) userScrollRef.current = { top: readGeometry(node).top, direction: 0, dragging: true };
      }
    };
    const pointerUp = () => { if (userScrollRef.current?.dragging) userScrollRef.current = null; };
    const scroll = () => {
      const previous = metricsRef.current;
      const top = readGeometry(node).top;
      const userMoved = acceptUserDisplacement();
      if (!userMoved && programmaticTopRef.current !== null && Math.abs(top - programmaticTopRef.current) < 0.5) {
        programmaticTopRef.current = null;
        rememberMetrics();
        publish();
        return;
      }
      programmaticTopRef.current = null;
      const layoutChanged = readGeometry(node).height !== previous.height || readGeometry(node).viewport !== previous.viewport;
      if (userMoved || !layoutChanged) {
        if (!userMoved && top < previous.top) setPaused(true);
        else if (top > previous.top && atBottom()) scrollToBottom();
        if (pausedRef.current || !optionsRef.current.enabled) captureAnchor();
      }
      rememberMetrics();
      publish();
    };
    controllers.set(node, { resume: resumeOwnViewport });
    node.addEventListener(FOLLOW_CHANGE, updateAvailability);
    const surface: EventTarget = windowViewport ? window : node;
    surface.addEventListener('wheel', wheel as EventListener, { capture: true, passive: true });
    surface.addEventListener('touchstart', touchStart as EventListener, { capture: true, passive: true });
    surface.addEventListener('touchmove', touchMove as EventListener, { capture: true, passive: true });
    surface.addEventListener('keydown', keyDown as EventListener, true);
    surface.addEventListener('pointerdown', pointerDown as EventListener, true);
    window.addEventListener('pointerup', pointerUp);
    surface.addEventListener('scroll', scroll as EventListener, { passive: true });
    rememberMetrics();
    return () => {
      controllers.delete(node);
      node.removeEventListener(FOLLOW_CHANGE, updateAvailability);
      surface.removeEventListener('wheel', wheel as EventListener, true);
      surface.removeEventListener('touchstart', touchStart as EventListener, true);
      surface.removeEventListener('touchmove', touchMove as EventListener, true);
      surface.removeEventListener('keydown', keyDown as EventListener, true);
      surface.removeEventListener('pointerdown', pointerDown as EventListener, true);
      window.removeEventListener('pointerup', pointerUp);
      surface.removeEventListener('scroll', scroll as EventListener);
    };
  }, [containerRef, scopeKey, contentKey, acceptUserDisplacement, captureAnchor, rememberMetrics, publish, resumeOwnViewport, scrollToBottom, setPaused, updateAvailability, readGeometry, windowViewport]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    const content = contentSelector ? node?.querySelector(contentSelector) : node?.firstElementChild;
    if (!node || !content) return;
    const resized = () => {
      acceptUserDisplacement();
      if (pausedRef.current || !optionsRef.current.enabled) restoreAnchor();
      else scheduleFollow();
      publish();
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resized);
    observer?.observe(content);observer?.observe(node);
    if (windowViewport) window.addEventListener('resize', resized);
    return () => { observer?.disconnect();if (windowViewport) window.removeEventListener('resize', resized); };
  }, [containerRef, contentSelector, scopeKey, contentKey, acceptUserDisplacement, restoreAnchor, scheduleFollow, publish, windowViewport]);

  useLayoutEffect(() => {
    acceptUserDisplacement();
    if (pausedRef.current || !enabled) {
      if (pausedRef.current || !initialFrameRef.current) cancelFollow();
      restoreAnchor();
      if (!anchorRef.current) captureAnchor();
    } else scheduleFollow();
    publish();
  });

  return { isPaused, canReturnToLatest, hasOverflow, setPaused, getIsPaused, pause, scrollToBottom, scheduleFollow, scheduleInitialPosition, cancelFollow, captureAnchor, getReadingAnchor, restoreReadingAnchor };
}
