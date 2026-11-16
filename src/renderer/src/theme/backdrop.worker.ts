// Paints a gradient theme's backdrop off the main thread (backdropPainter.ts) and answers with a PNG.
import { paintBackdrop, type Paint } from './backdropPaint'

interface Request {
  paint: Paint
  width: number
  height: number
}

async function paintPng({ paint, width, height }: Request): Promise<Blob | null> {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) return null
  context.putImageData(new ImageData(paintBackdrop(paint, width, height), width, height), 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

// Any failure answers null, so the window keeps the tokens' gradient.
self.onmessage = ({ data }: MessageEvent<Request>) => {
  paintPng(data).then(
    (png) => self.postMessage(png),
    () => self.postMessage(null),
  )
}
