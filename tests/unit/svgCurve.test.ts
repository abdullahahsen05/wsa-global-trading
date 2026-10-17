import { describe, expect, test } from "vitest";
import {
  toLinearAreaPath,
  toLinearPath,
  toSmoothAreaPath,
  toSmoothPath,
  toStepAreaPath,
  toStepPath,
} from "@/lib/charts/svgCurve";

/** Every number in a path, in order. */
function numbers(path: string): number[] {
  return (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

const peak = [
  { x: 0, y: 0 },
  { x: 10, y: 10 },
  { x: 20, y: 0 },
];

describe("linear paths", () => {
  test("nothing in, nothing out", () => {
    expect(toLinearPath([])).toBe("");
    expect(toLinearAreaPath([], 100)).toBe("");
  });

  test("one point is only a move command, never a generated shape", () => {
    expect(toLinearPath([{ x: 5, y: 7 }])).toBe("M 5 7");
    expect(toLinearAreaPath([{ x: 5, y: 7 }], 100)).toBe("");
  });

  test("goes through the given points and adds none", () => {
    expect(
      toLinearPath([
        { x: 0, y: 10 },
        { x: 10, y: 20 },
        { x: 20, y: 5 },
      ]),
    ).toBe("M 0 10 L 10 20 L 20 5");
  });

  test("a flat series stays flat (no invented bell curve)", () => {
    const path = toLinearPath([
      { x: 0, y: 50 },
      { x: 10, y: 50 },
      { x: 20, y: 50 },
    ]);
    const values = numbers(path);
    const ys = values.filter((_, index) => index % 2 === 1);
    expect(ys).toEqual([50, 50, 50]);
  });

  test("non-finite points are dropped", () => {
    expect(
      toLinearPath([
        { x: 0, y: 1 },
        { x: Number.NaN, y: 2 },
        { x: 5, y: Number.POSITIVE_INFINITY },
        { x: 10, y: 3 },
      ]),
    ).toBe("M 0 1 L 10 3");
  });

  test("the area closes down to the baseline", () => {
    expect(
      toLinearAreaPath(
        [
          { x: 0, y: 10 },
          { x: 10, y: 20 },
        ],
        30,
      ),
    ).toBe("M 0 10 L 10 20 L 10 30 L 0 30 Z");
  });
});

describe("step paths", () => {
  test("the value holds until the next point and then jumps", () => {
    expect(
      toStepPath([
        { x: 0, y: 10 },
        { x: 10, y: 20 },
        { x: 20, y: 5 },
      ]),
    ).toBe("M 0 10 L 10 10 L 10 20 L 20 20 L 20 5");
  });

  test("empty and single point inputs", () => {
    expect(toStepPath([])).toBe("");
    expect(toStepPath([{ x: 3, y: 4 }])).toBe("M 3 4");
    expect(toStepAreaPath([{ x: 3, y: 4 }], 50)).toBe("");
  });

  test("the area follows the steps and closes on the baseline", () => {
    expect(
      toStepAreaPath(
        [
          { x: 0, y: 10 },
          { x: 10, y: 20 },
          { x: 20, y: 5 },
        ],
        30,
      ),
    ).toBe("M 0 10 L 10 10 L 10 20 L 20 20 L 20 5 L 20 30 L 0 30 Z");
  });
});

describe("smooth paths", () => {
  test("no points, one point, two points", () => {
    expect(toSmoothPath([])).toBe("");
    expect(toSmoothPath([{ x: 3, y: 4 }])).toBe("M 3 4");
    expect(
      toSmoothPath([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe("M 0 0 L 10 10");
    expect(toSmoothAreaPath([{ x: 3, y: 4 }], 50)).toBe("");
  });

  test("a peak is not overshot: the tangent at a turning point is flat", () => {
    expect(toSmoothPath(peak)).toBe("M 0 0 C 3.33 3.33, 6.67 10, 10 10 C 13.33 10, 16.67 3.33, 20 0");
  });

  test("one cubic segment per interval, ending exactly on every point", () => {
    const points = [
      { x: 0, y: 40 },
      { x: 10, y: 25 },
      { x: 25, y: 30 },
      { x: 30, y: 12 },
      { x: 50, y: 12 },
      { x: 60, y: 3 },
    ];
    const path = toSmoothPath(points);
    expect(path.match(/C/g)).toHaveLength(points.length - 1);

    const segments = path.split("C").slice(1);
    segments.forEach((segment, index) => {
      const values = numbers(segment);
      expect(values).toHaveLength(6);
      expect(values[4]).toBe(points[index + 1].x);
      expect(values[5]).toBe(points[index + 1].y);
    });
  });

  test("control points never leave the vertical range of their segment (no overshoot)", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 2 },
      { x: 20, y: 40 },
      { x: 30, y: 41 },
      { x: 40, y: 80 },
    ];
    const path = toSmoothPath(points);
    const segments = path.split("C").slice(1);
    segments.forEach((segment, index) => {
      const values = numbers(segment);
      const low = Math.min(points[index].y, points[index + 1].y);
      const high = Math.max(points[index].y, points[index + 1].y);
      expect(values[1]).toBeGreaterThanOrEqual(low - 0.01);
      expect(values[1]).toBeLessThanOrEqual(high + 0.01);
      expect(values[3]).toBeGreaterThanOrEqual(low - 0.01);
      expect(values[3]).toBeLessThanOrEqual(high + 0.01);
    });
  });

  test("a flat series stays flat", () => {
    const path = toSmoothPath([
      { x: 0, y: 5 },
      { x: 10, y: 5 },
      { x: 20, y: 5 },
      { x: 30, y: 5 },
    ]);
    const ys = numbers(path).filter((_, index) => index % 2 === 1);
    expect(new Set(ys)).toEqual(new Set([5]));
  });

  test("x values that do not strictly increase fall back to straight lines", () => {
    expect(
      toSmoothPath([
        { x: 0, y: 0 },
        { x: 10, y: 5 },
        { x: 10, y: 8 },
        { x: 20, y: 1 },
      ]),
    ).toBe("M 0 0 L 10 5 L 10 8 L 20 1");
  });

  test("the area closes on the baseline", () => {
    const area = toSmoothAreaPath(peak, 30);
    expect(area.startsWith("M 0 0 C")).toBe(true);
    expect(area.endsWith("L 20 30 L 0 30 Z")).toBe(true);
  });
});
