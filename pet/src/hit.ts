export function isOpaqueAt(alpha: (sheetX: number, sheetY: number) => number, frame: { x: number; y: number }, frameSize: number, scale: number, px: number, py: number): boolean {
  const fx = Math.floor(px / scale);
  const fy = Math.floor(py / scale);
  if (fx < 0 || fy < 0 || fx >= frameSize || fy >= frameSize) return false;
  return alpha(frame.x + fx, frame.y + fy) > 0;
}
