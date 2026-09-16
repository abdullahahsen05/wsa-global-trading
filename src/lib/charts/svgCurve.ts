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

export function toSmoothPath(points: SvgCurvePoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  return points.reduce((path, point, index, list) => {
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
  if (points.length === 0) return "";

  const first = points[0];
  const last = points[points.length - 1];
  const curve = toSmoothPath(points);

  return `M ${first.x} ${baselineY} L ${first.x} ${first.y} ${curve.replace(/^M [^C]+/, "")} L ${last.x} ${baselineY} Z`;
}
