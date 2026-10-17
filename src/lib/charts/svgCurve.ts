/**
 * SVG path helpers for charts.
 *
 * Honesty rule: every path goes through the real points it is given and never
 * adds points of its own. (An earlier version replaced flat or one-point series
 * with a generated "bell" curve; that made empty accounts look as if they had
 * history and has been removed.) A flat series is drawn as a flat line and a
 * single point yields only a move command, so callers can render a dot instead.
 */

export type SvgCurvePoint = {
  x: number;
  y: number;
};

function finitePoints(points: SvgCurvePoint[]): SvgCurvePoint[] {
  return points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

const fmt = (value: number): string => (Math.round(value * 100) / 100).toString();

export function toLinearPath(points: SvgCurvePoint[]): string {
  const valid = finitePoints(points);
  if (valid.length === 0) return "";
  return valid
    .map((point, index) => `${index === 0 ? "M" : "L"} ${fmt(point.x)} ${fmt(point.y)}`)
    .join(" ");
}

export function toLinearAreaPath(points: SvgCurvePoint[], baselineY: number): string {
  const valid = finitePoints(points);
  if (valid.length < 2) return "";
  const first = valid[0];
  const last = valid[valid.length - 1];
  return `${toLinearPath(valid)} L ${fmt(last.x)} ${fmt(baselineY)} L ${fmt(first.x)} ${fmt(baselineY)} Z`;
}

/**
 * "Step after" path: the value holds until the next point and then jumps. This
 * is the honest shape of a quantity that only changes at discrete events, such
 * as cumulative closed P&L (it changes only when a trade closes).
 */
export function toStepPath(points: SvgCurvePoint[]): string {
  const valid = finitePoints(points);
  if (valid.length === 0) return "";
  let path = `M ${fmt(valid[0].x)} ${fmt(valid[0].y)}`;
  for (let index = 1; index < valid.length; index += 1) {
    const previous = valid[index - 1];
    const point = valid[index];
    path += ` L ${fmt(point.x)} ${fmt(previous.y)} L ${fmt(point.x)} ${fmt(point.y)}`;
  }
  return path;
}

export function toStepAreaPath(points: SvgCurvePoint[], baselineY: number): string {
  const valid = finitePoints(points);
  if (valid.length < 2) return "";
  const first = valid[0];
  const last = valid[valid.length - 1];
  return `${toStepPath(valid)} L ${fmt(last.x)} ${fmt(baselineY)} L ${fmt(first.x)} ${fmt(baselineY)} Z`;
}

/**
 * Monotone cubic interpolation (Fritsch-Carlson). The curve passes through
 * every point and never overshoots between them, so peaks and troughs of the
 * data are not exaggerated or hidden.
 */
function toMonotoneCubicPath(points: SvgCurvePoint[]): string {
  const count = points.length;
  if (count === 0) return "";
  if (count === 1) return `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  if (count === 2) return toLinearPath(points);

  const strictlyIncreasing = points.every(
    (point, index) => index === 0 || point.x > points[index - 1].x,
  );
  if (!strictlyIncreasing) return toLinearPath(points);

  const widths: number[] = [];
  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const width = points[index + 1].x - points[index].x;
    widths.push(width);
    slopes.push((points[index + 1].y - points[index].y) / width);
  }

  const tangents: number[] = new Array(count).fill(0);
  tangents[0] = slopes[0];
  tangents[count - 1] = slopes[count - 2];
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1];
    const next = slopes[index];
    if (previous * next <= 0) {
      tangents[index] = 0;
    } else {
      const widthPrevious = widths[index - 1];
      const widthNext = widths[index];
      tangents[index] =
        (3 * (widthPrevious + widthNext)) /
        ((2 * widthNext + widthPrevious) / previous + (widthNext + 2 * widthPrevious) / next);
    }
  }

  let path = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let index = 0; index < count - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    const third = widths[index] / 3;
    path +=
      ` C ${fmt(from.x + third)} ${fmt(from.y + tangents[index] * third)},` +
      ` ${fmt(to.x - third)} ${fmt(to.y - tangents[index + 1] * third)},` +
      ` ${fmt(to.x)} ${fmt(to.y)}`;
  }
  return path;
}

export function toSmoothPath(points: SvgCurvePoint[]): string {
  return toMonotoneCubicPath(finitePoints(points));
}

export function toSmoothAreaPath(points: SvgCurvePoint[], baselineY: number): string {
  const valid = finitePoints(points);
  if (valid.length < 2) return "";
  const first = valid[0];
  const last = valid[valid.length - 1];
  return `${toMonotoneCubicPath(valid)} L ${fmt(last.x)} ${fmt(baselineY)} L ${fmt(first.x)} ${fmt(baselineY)} Z`;
}
