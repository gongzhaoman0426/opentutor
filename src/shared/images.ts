import type { NormalizedBox } from './schema';

export function isNormalizedBox(box: NormalizedBox | null | undefined): box is NormalizedBox {
  return Boolean(box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001);
}

/** Coordinates refer to the original image, before contain letterboxing or cropping. */
export function imageGeometry(width: number, height: number, sourceWidth: number, sourceHeight: number, region?: NormalizedBox | null, highlight?: NormalizedBox | null) {
  const crop = isNormalizedBox(region) ? region : { x: 0, y: 0, width: 1, height: 1 };
  const ratio = Math.min(width / (sourceWidth * crop.width), height / (sourceHeight * crop.height));
  const imageWidth = sourceWidth * ratio;
  const imageHeight = sourceHeight * ratio;
  const cropWidth = imageWidth * crop.width;
  const cropHeight = imageHeight * crop.height;
  const intersection = isNormalizedBox(highlight) ? {
    x: Math.max(highlight.x, crop.x), y: Math.max(highlight.y, crop.y),
    right: Math.min(highlight.x + highlight.width, crop.x + crop.width),
    bottom: Math.min(highlight.y + highlight.height, crop.y + crop.height),
  } : null;
  return {
    left: (width - cropWidth) / 2, top: (height - cropHeight) / 2, width: cropWidth, height: cropHeight,
    image: { width: imageWidth, height: imageHeight, left: -crop.x * imageWidth, top: -crop.y * imageHeight },
    highlight: intersection && intersection.right > intersection.x && intersection.bottom > intersection.y ? {
      left: (intersection.x - crop.x) * imageWidth, top: (intersection.y - crop.y) * imageHeight,
      width: (intersection.right - intersection.x) * imageWidth, height: (intersection.bottom - intersection.y) * imageHeight,
    } : null,
  };
}
