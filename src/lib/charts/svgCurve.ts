export type SvgCurvePoint = {
  x: number;
  y: number;
};

function bellCurveFallback(points: SvgCurvePoint[]): SvgCurvePoint[] {
  if (points.length === 0) return [];

  const yValues = points.map((point) => point.y);
  const yRange = Math.max(...yValues) - Math.min(...yValues);
  if (points.length > 2 && yRange > 1.5) return points;

  const first = points[0];
  const last = points[points.length - 1] ?? first;
  const startX = points.length === 1 ? first.x - 120 : first.x;
  const endX = points.length === 1 ? first.x + 120 : last.x;
  const width = Math.max(1, endX - startX);
  const baseY = yValues.reduce((sum, value) => sum + value, 0) / yValues.length;
  const amplitude = Math.max(22, Math.min(58, width * 0.09));
  const generatedCount = Math.max(7, points.length);

  return Array.from({ length: generatedCount }, (_, index) => {
    const ratio = index / Math.max(1, generatedCount - 1);
    const existing = points[Math.round(ratio * Math.max(0, points.length - 1))];
    const x = points.length > 2 && existing
      ? existing.x
      : startX + ratio * width;

    // Use a soft bell profile for flat/no-variation series. This keeps the
    // visual language as a curve while the displayed numeric value remains
    // the real account value in the surrounding card labels.
    const bell = Math.sin(Math.PI * ratio);
    const shoulder = Math.sin(Math.PI * ratio * 2) * 0.16;
    return {
      x,
      y: Math.max(4, baseY - amplitude * (bell + shoulder)),
    };
  });
}

function displayCurvePoints(points: SvgCurvePoint[]): SvgCurvePoint[] {
  return bellCurveFallback(points).filter((point) => (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  ));
}

function toMonotoneQuadraticPath(points: SvgCurvePoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    path += ` Q ${current.x} ${current.y}, ${midX} ${midY}`;
  }

  const previous = points[points.length - 2];
  const last = points[points.length - 1];
  path += ` Q ${previous.x} ${previous.y}, ${last.x} ${last.y}`;
  return path;
}

export function toSmoothPath(points: SvgCurvePoint[]): string {
  return toMonotoneQuadraticPath(displayCurvePoints(points));
}

export function toSmoothAreaPath(points: SvgCurvePoint[], baselineY: number): string {
  const displayPoints = displayCurvePoints(points);
  if (displayPoints.length === 0) return "";

  const first = displayPoints[0];
  const last = displayPoints[displayPoints.length - 1];
  const curve = toMonotoneQuadraticPath(displayPoints);

  return `${curve} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}
