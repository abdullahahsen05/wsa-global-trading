export type SvgCurvePoint = {
  x: number;
  y: number;
};

function validPoints(points: SvgCurvePoint[]): SvgCurvePoint[] {
  return points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

/**
 * Monotone cubic interpolation keeps every broker sample as an anchor without
 * overshooting between points. A flat account history stays flat; no visual
 * data is fabricated to make the chart look more active.
 */
function toMonotoneCubicPath(points: SvgCurvePoint[]): string {
  const data = validPoints(points);
  if (data.length === 0) return "";
  if (data.length === 1) return `M ${data[0].x} ${data[0].y}`;
  if (data.length === 2) return `M ${data[0].x} ${data[0].y} L ${data[1].x} ${data[1].y}`;

  const slopes: number[] = [];
  for (let index = 0; index < data.length - 1; index += 1) {
    const width = data[index + 1].x - data[index].x;
    if (width <= 0) return data.map((point, pointIndex) => `${pointIndex === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
    slopes.push((data[index + 1].y - data[index].y) / width);
  }

  const tangents = new Array<number>(data.length);
  tangents[0] = slopes[0];
  tangents[data.length - 1] = slopes[slopes.length - 1];
  for (let index = 1; index < data.length - 1; index += 1) {
    const previous = slopes[index - 1];
    const next = slopes[index];
    tangents[index] = previous === 0 || next === 0 || previous * next < 0 ? 0 : (previous + next) / 2;
  }

  let path = `M ${data[0].x} ${data[0].y}`;
  for (let index = 0; index < data.length - 1; index += 1) {
    const current = data[index];
    const next = data[index + 1];
    const width = next.x - current.x;
    const slope = slopes[index];
    let startTangent = tangents[index];
    let endTangent = tangents[index + 1];
    if (slope === 0) {
      startTangent = 0;
      endTangent = 0;
    } else {
      const startRatio = startTangent / slope;
      const endRatio = endTangent / slope;
      const magnitude = Math.hypot(startRatio, endRatio);
      if (magnitude > 3) {
        const scale = 3 / magnitude;
        startTangent = scale * startRatio * slope;
        endTangent = scale * endRatio * slope;
      }
    }
    path += ` C ${(current.x + width / 3).toFixed(2)} ${(current.y + (startTangent * width) / 3).toFixed(2)}, ${(next.x - width / 3).toFixed(2)} ${(next.y - (endTangent * width) / 3).toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }
  return path;
}

export function toSmoothPath(points: SvgCurvePoint[]): string {
  return toMonotoneCubicPath(points);
}

export function toSmoothAreaPath(points: SvgCurvePoint[], baselineY: number): string {
  const data = validPoints(points);
  if (data.length === 0) return "";
  const first = data[0];
  const last = data[data.length - 1];
  const curve = toMonotoneCubicPath(data);

  return `${curve} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}
