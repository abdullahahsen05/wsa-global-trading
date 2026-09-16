export type SvgCurvePoint = {
  x: number;
  y: number;
};

function controlPoint(
  current: SvgCurvePoint,
  previous: SvgCurvePoint,
  next: SvgCurvePoint,
  reverse = false,
): SvgCurvePoint {
  const smoothing = 0.18;
  const opposedLine = {
    x: next.x - previous.x,
    y: next.y - previous.y,
  };
  const angle = Math.atan2(opposedLine.y, opposedLine.x) + (reverse ? Math.PI : 0);
  const length = Math.hypot(opposedLine.x, opposedLine.y) * smoothing;

  return {
    x: current.x + Math.cos(angle) * length,
    y: current.y + Math.sin(angle) * length,
  };
}

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

export function toSmoothPath(points: SvgCurvePoint[]): string {
  const displayPoints = bellCurveFallback(points);
  if (displayPoints.length === 0) return "";
  if (displayPoints.length === 1) return `M ${displayPoints[0].x} ${displayPoints[0].y}`;

  return displayPoints.reduce((path, point, index, list) => {
    if (index === 0) return `M ${point.x} ${point.y}`;

    const previous = list[index - 1];
    const next = list[index + 1] ?? point;
    const beforePrevious = list[index - 2] ?? previous;
    const start = controlPoint(previous, beforePrevious, point);
    const end = controlPoint(point, previous, next, true);

    return `${path} C ${start.x} ${start.y}, ${end.x} ${end.y}, ${point.x} ${point.y}`;
  }, "");
}

export function toSmoothAreaPath(points: SvgCurvePoint[], baselineY: number): string {
  const displayPoints = bellCurveFallback(points);
  if (displayPoints.length === 0) return "";

  const first = displayPoints[0];
  const last = displayPoints[displayPoints.length - 1];
  const curve = toSmoothPath(displayPoints);

  return `M ${first.x} ${baselineY} L ${first.x} ${first.y} ${curve.replace(/^M [^C]+/, "")} L ${last.x} ${baselineY} Z`;
}
