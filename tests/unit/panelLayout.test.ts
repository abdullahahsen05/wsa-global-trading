import { describe, expect, test } from "vitest";
import {
  PANEL_SHARE_MAX,
  PANEL_SHARE_MIN,
  PANEL_SHARE_STEP,
  PANEL_ZOOM_MAX,
  PANEL_ZOOM_MIN,
  PANEL_ZOOM_STEP,
  SPLIT_HANDLE_WIDTH,
  WIDE_LAYOUT_WIDTH,
  clampShare,
  clampZoom,
  effectiveZoom,
  fitZoom,
  isWideLayout,
  sanitizeShare,
  sanitizeZoom,
  shareFromPointer,
  splitColumns,
  stepShare,
  stepZoom,
  zoomLabel,
} from "@/lib/trade/panelLayout";

describe("the zoom of the WSA Trade panel", () => {
  test("a zoom is kept inside 60 - 160 % and rounded to a whole percent; anything that is not a number is 100 %", () => {
    expect(PANEL_ZOOM_MIN).toBe(0.6);
    expect(PANEL_ZOOM_MAX).toBe(1.6);
    expect(PANEL_ZOOM_STEP).toBe(0.1);
    expect(clampZoom(0.3)).toBe(0.6);
    expect(clampZoom(2)).toBe(1.6);
    expect(clampZoom(1.234)).toBe(1.23);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });

  test("only a number in range is stored; everything else means 'fit the room'", () => {
    expect(sanitizeZoom(1)).toBe(1);
    expect(sanitizeZoom(0.95)).toBe(0.95);
    expect(sanitizeZoom(0.6)).toBe(0.6);
    expect(sanitizeZoom(1.6)).toBe(1.6);
    expect(sanitizeZoom(1.234)).toBe(1.23);
    for (const bad of [0.5, 1.7, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined, {}, true]) {
      expect(sanitizeZoom(bad)).toBeNull();
    }
  });

  test("a step goes to the next round tenth - also from a value the fit picked, such as 95 %", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.95, 1)).toBe(1);
    expect(stepZoom(0.95, -1)).toBe(0.9);
    expect(stepZoom(0.85, -1)).toBe(0.8);
    expect(stepZoom(0.8, 1)).toBe(0.9);
    expect(stepZoom(0.9, -1)).toBe(0.8);
    expect(stepZoom(1.1, 1)).toBe(1.2);
    expect(stepZoom(1.1, -1)).toBe(1);
  });

  test("stepping stops at the limits", () => {
    let zoom = 1;
    const down: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      zoom = stepZoom(zoom, -1);
      down.push(zoom);
    }
    expect(down).toEqual([0.9, 0.8, 0.7, 0.6, 0.6, 0.6]);

    zoom = 1;
    const up: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      zoom = stepZoom(zoom, 1);
      up.push(zoom);
    }
    expect(up).toEqual([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.6, 1.6]);
  });

  test("the fit: 100 % when there is room, smaller in steps of 5 % when the pane is narrow or low, never below 80 %", () => {
    expect(fitZoom(1000, 900)).toBe(1);
    expect(fitZoom(380, 680)).toBe(1);
    expect(fitZoom(361, 900)).toBe(0.95);
    expect(fitZoom(350, 900)).toBe(0.9);
    expect(fitZoom(342, 900)).toBe(0.9);
    expect(fitZoom(300, 500)).toBe(0.8);
    expect(fitZoom(190, 3000)).toBe(0.8);
    expect(fitZoom(500, 340)).toBe(0.8);
  });

  test("a room that is not known yet fits at 100 % in that direction", () => {
    expect(fitZoom(0, 0)).toBe(1);
    expect(fitZoom(0, 400)).toBe(0.8);
    expect(fitZoom(345, 0)).toBe(0.9);
  });

  test("the zoom in force is the person's choice, else the fit", () => {
    expect(effectiveZoom(null, 300, 500)).toBe(0.8);
    expect(effectiveZoom(null, 0, 0)).toBe(1);
    expect(effectiveZoom(1.2, 300, 500)).toBe(1.2);
    expect(effectiveZoom(5, 0, 0)).toBe(1.6);
    expect(effectiveZoom(0.1, 0, 0)).toBe(0.6);
  });

  test("ticket and lists go side by side from 720 px of room, counted at the zoom in force", () => {
    expect(WIDE_LAYOUT_WIDTH).toBe(720);
    expect(isWideLayout(720, 1)).toBe(true);
    expect(isWideLayout(719, 1)).toBe(false);
    // a smaller panel fits more across the same width, a larger one less
    expect(isWideLayout(600, 0.8)).toBe(true);
    expect(isWideLayout(900, 1.6)).toBe(false);
    expect(isWideLayout(900, 0)).toBe(false);
  });

  test("the label is a whole percent", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(0.85)).toBe("85%");
    expect(zoomLabel(0.9)).toBe("90%");
    expect(zoomLabel(1.15)).toBe("115%");
  });
});

describe("the share of the split view that WSA Trade takes", () => {
  test("only a share in 20 - 60 % is stored; everything else means 'the usual column'", () => {
    expect(PANEL_SHARE_MIN).toBe(0.2);
    expect(PANEL_SHARE_MAX).toBe(0.6);
    expect(sanitizeShare(0.4)).toBe(0.4);
    expect(sanitizeShare(0.2)).toBe(0.2);
    expect(sanitizeShare(0.6)).toBe(0.6);
    expect(sanitizeShare(0.41234)).toBe(0.412);
    for (const bad of [0.1, 0.7, 0, -0.3, Number.NaN, "0.4", null, undefined, {}]) expect(sanitizeShare(bad)).toBeNull();
  });

  test("a share is kept in range; anything that is not a number falls back to the smallest", () => {
    expect(clampShare(0.1)).toBe(0.2);
    expect(clampShare(0.9)).toBe(0.6);
    expect(clampShare(0.4567)).toBe(0.457);
    expect(clampShare(Number.NaN)).toBe(0.2);
  });

  test("an arrow key on the divider moves it by 2 % and stops at the limits", () => {
    expect(PANEL_SHARE_STEP).toBe(0.02);
    expect(stepShare(0.4, 1)).toBe(0.42);
    expect(stepShare(0.4, -1)).toBe(0.38);
    expect(stepShare(0.6, 1)).toBe(0.6);
    expect(stepShare(0.2, -1)).toBe(0.2);
  });

  test("a pointer position becomes the share to its right, leaving half of the divider to the gap", () => {
    expect(SPLIT_HANDLE_WIDTH).toBe(16);
    // 1000 px wide split starting at 0: the pointer at 600 leaves 400 - 8 for the panel
    expect(shareFromPointer(600, 0, 1000)).toBe(0.392);
    // the same split starting 100 px from the left edge of the window
    expect(shareFromPointer(700, 100, 1000)).toBe(0.392);
    // dragged beyond either end the share stops at its limits
    expect(shareFromPointer(0, 0, 1000)).toBe(0.6);
    expect(shareFromPointer(1000, 0, 1000)).toBe(0.2);
    // no width, no share
    expect(shareFromPointer(10, 0, 0)).toBeNull();
    expect(shareFromPointer(10, 0, -5)).toBeNull();
  });

  test("the grid columns: chart | divider | panel", () => {
    expect(splitColumns(null)).toBe("minmax(0, 1fr) 16px minmax(380px, 440px)");
    expect(splitColumns(0.3)).toBe("minmax(0, 1fr) 16px clamp(320px, 30.0%, 1100px)");
    expect(splitColumns(0.4567)).toBe("minmax(0, 1fr) 16px clamp(320px, 45.7%, 1100px)");
  });
});
