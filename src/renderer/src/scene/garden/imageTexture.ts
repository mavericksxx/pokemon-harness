import { Texture } from 'pixi.js';

/**
 * Load a PNG as a nearest-filtered Pixi texture.
 *
 * Deliberately NOT `Assets.load`: Pixi's texture loader probes for ImageBitmap
 * support by constructing a Worker from a blob URL, which the renderer's CSP
 * (`script-src 'self'`) refuses — the load then fails outright and the garden
 * renders empty. An <img> element is covered by `img-src 'self'`, so this path
 * works without loosening the policy.
 */
export async function loadPixelTexture(url: string): Promise<Texture> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const texture = Texture.from(img);
  // Pixel art: nearest lives on the SOURCE, not the texture.
  texture.source.scaleMode = 'nearest';
  return texture;
}
