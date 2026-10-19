/**
 * The size of the WSA Trade panel: how big its contents are (zoom) and how much of the split view
 * it takes. Pure - no DOM, no React - so the maths is testable and the workspace document can
 * validate what it stores with the same limits.
 *
 * Zoom is a factor of the panel's own contents (1 = normal). `null` means "fit": the panel picks the
 * factor from the room it has, so a narrow or low pane shrinks instead of overflowing and nobody has
 * to zoom the whole browser to reach the buttons.
 */

export const PANEL_ZOOM_MIN = 0.6;
export const PANEL_ZOOM_MAX = 1.6;
/** One click on the zoom buttons. */
export const PANEL_ZOOM_STEP = 0.1;

/** Side by side with the chart: the share of the width the order panel takes. */
export const PANEL_SHARE_MIN = 0.2;
export const PANEL_SHARE_MAX = 0.6;
/** One press of an arrow key on the divider. */
export const PANEL_SHARE_STEP = 0.02;

/** The room (CSS pixels) in which the ticket is comfortable at zoom 1. */
const COMFORT_WIDTH = 380;
/** Header + figures + the whole ticket with its Buy / Sell buttons, without scrolling, at zoom 1. */
const COMFORT_HEIGHT = 680;
/** "Fit" never makes the panel smaller than this - below it the text is no longer readable. */
const FIT_FLOOR = 0.8;

/**
 * From this much room (counted at the current zoom) the panel puts the ticket on the left and the
 * positions on the right; narrower, everything stacks in one column.
 */
export const WIDE_LAYOUT_WIDTH = 720;

/** A zoom inside the allowed range, rounded to whole percent. Anything that is not a number is 1. */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(PANEL_ZOOM_MAX, Math.max(PANEL_ZOOM_MIN, value)) * 100) / 100;
}

/** A zoom that may be stored: a number in range, else null (= fit). */
export function sanitizeZoom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= PANEL_ZOOM_MIN && value <= PANEL_ZOOM_MAX
    ? Math.round(value * 100) / 100
    : null;
}

/** The next / previous round step (10 %) from where the panel is now - also from a "fit" value such as 95 %. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const tenths = current * 10;
  const epsilon = 1e-6;
  const next = direction === 1 ? Math.floor(tenths + epsilon) + 1 : Math.ceil(tenths - epsilon) - 1;
  return clampZoom(next / 10);
}

/**
 * The zoom that makes the panel fit the room it has: 1 when there is enough, smaller (in steps of
 * 5 %, down to `FIT_FLOOR`) when the pane is narrow or low. Unknown room (0) fits at 1.
 */
export function fitZoom(width: number, height: number): number {
  const byWidth = width > 0 ? width / COMFORT_WIDTH : 1;
  const byHeight = height > 0 ? height / COMFORT_HEIGHT : 1;
  const fit = Math.min(1, byWidth, byHeight);
  return clampZoom(Math.max(FIT_FLOOR, Math.round(fit * 20) / 20));
}

/** The zoom in force: the person's choice, or the fit when they have not chosen one. */
export function effectiveZoom(setting: number | null, width: number, height: number): number {
  return setting === null ? fitZoom(width, height) : clampZoom(setting);
}

/** Ticket and positions side by side? Decided on the room the contents really have at this zoom. */
export function isWideLayout(width: number, zoom: number): boolean {
  return zoom > 0 && width / zoom >= WIDE_LAYOUT_WIDTH;
}

/** "90%". */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** A share of the split view that may be stored: a number in range, else null (= the default column). */
export function sanitizeShare(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= PANEL_SHARE_MIN && value <= PANEL_SHARE_MAX
    ? Math.round(value * 1000) / 1000
    : null;
}

/** A share inside the allowed range (non-numbers fall back to the lower bound). */
export function clampShare(value: number): number {
  if (!Number.isFinite(value)) return PANEL_SHARE_MIN;
  return Math.round(Math.min(PANEL_SHARE_MAX, Math.max(PANEL_SHARE_MIN, value)) * 1000) / 1000;
}

/** The share after pressing an arrow key on the divider (a wider panel = a larger share). */
export function stepShare(current: number, direction: 1 | -1): number {
  return clampShare(current + direction * PANEL_SHARE_STEP);
}

/** Width of the divider between the chart and the order panel (it is also the gap between them). */
export const SPLIT_HANDLE_WIDTH = 16;

/**
 * The share of the width a pointer position leaves for the panel on the right of the divider (the
 * pointer is in the middle of the divider, so half of it still belongs to the gap).
 */
export function shareFromPointer(pointerX: number, left: number, width: number): number | null {
  if (!(width > 0)) return null;
  return clampShare((left + width - pointerX - SPLIT_HANDLE_WIDTH / 2) / width);
}

/**
 * The grid columns of the side-by-side split: chart | divider | order panel. Without a stored share
 * the panel keeps its usual column (380 - 440 px); with one it takes that share of the width, but never
 * less than 320 px (a narrower ticket is unusable) and never more than 1100 px.
 */
export function splitColumns(share: number | null): string {
  const panel = share === null ? "minmax(380px, 440px)" : `clamp(320px, ${(share * 100).toFixed(1)}%, 1100px)`;
  return `minmax(0, 1fr) ${SPLIT_HANDLE_WIDTH}px ${panel}`;
}
