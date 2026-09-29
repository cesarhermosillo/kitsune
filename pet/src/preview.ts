import meta from "../public/sprites.json";

const SCALE = 4;
const img = new Image();
img.src = "/sprites.png";
img.onload = () => {
  const grid = document.getElementById("grid")!;
  for (const [name, anim] of Object.entries(meta.animations)) {
    const box = document.createElement("div");
    box.style.display = "inline-block";
    box.innerHTML = `<div>${name} · ${anim.fps} fps · ${anim.frames.length} cuadros</div>`;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = meta.frameSize * SCALE;
    box.appendChild(canvas);
    grid.appendChild(box);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    let i = 0;
    setInterval(() => {
      const f = anim.frames[i % anim.frames.length];
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, f.x, f.y, meta.frameSize, meta.frameSize, 0, 0, canvas.width, canvas.height);
      i = anim.loop ? i + 1 : Math.min(i + 1, anim.frames.length - 1);
    }, 1000 / anim.fps);
  }
};
