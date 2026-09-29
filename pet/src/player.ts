export interface AnimMeta { fps: number; loop: boolean; frames: Array<{ x: number; y: number }> }

export function frameIndex(anim: AnimMeta, startedAt: number, now: number): number {
  const step = Math.floor(Math.max(0, now - startedAt) / (1000 / anim.fps));
  return anim.loop ? step % anim.frames.length : Math.min(step, anim.frames.length - 1);
}
