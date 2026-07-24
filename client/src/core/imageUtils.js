// 图片压缩：Canvas 缩放 + JPEG 质量探测
export const compressImage = (file, maxKB = 800, maxPx = 1920, minKB = 0) => new Promise(resolve => {
  const img = new Image();
  img.onload = () => {
    let w = img.width, h = img.height;
    if (w > maxPx) { h = h * maxPx / w; w = maxPx; }
    if (h > maxPx) { w = w * maxPx / h; h = maxPx; }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    let lastBlob = null;
    const tryQuality = (q) => {
      canvas.toBlob(blob => {
        if (blob.size <= maxKB * 1024) {
          if (minKB > 0 && blob.size < minKB * 1024 && lastBlob) resolve(lastBlob);
          else resolve(blob);
        } else if (q <= 0.3) { resolve(blob); }
        else { lastBlob = blob; tryQuality(q - 0.05); }
      }, 'image/jpeg', q);
    };
    tryQuality(minKB > 0 ? 1.0 : 0.8);
  };
  img.src = URL.createObjectURL(file);
});
