/**
 * The walkers' real art: 12 HeartGold/SoulSilver overworld walk sheets.
 *
 * SWAP SEAM (character side): every sheet is a 4x4 grid of `frameWidth` x
 * `frameHeight` frames whose row order and per-direction column sequence come
 * from `assets/pokemon/manifest.json`. Nothing here knows a species name apart
 * from SHEET_URLS, which only exists because the bundler needs a literal import
 * per file. Adding a Pokemon is a new PNG, a manifest entry and a line there.
 *
 * The manifest documents that the `up` row of every sheet is a placeholder copy
 * of `down` (the source rip has no back-facing art). That is deliberately NOT
 * special-cased: the row is read like any other, so replacing it with real art
 * later needs no code change.
 *
 * Licence and fan-use disclaimer: assets/ASSETS.md.
 */
import { Rectangle, Texture } from 'pixi.js';
import { loadPixelTexture } from './imageTexture';
import manifest from '@assets/pokemon/manifest.json';
import bulbasaur from '@assets/pokemon/bulbasaur.png';
import charmander from '@assets/pokemon/charmander.png';
import squirtle from '@assets/pokemon/squirtle.png';
import pikachu from '@assets/pokemon/pikachu.png';
import jigglypuff from '@assets/pokemon/jigglypuff.png';
import psyduck from '@assets/pokemon/psyduck.png';
import gengar from '@assets/pokemon/gengar.png';
import eevee from '@assets/pokemon/eevee.png';
import snorlax from '@assets/pokemon/snorlax.png';
import chikorita from '@assets/pokemon/chikorita.png';
import cyndaquil from '@assets/pokemon/cyndaquil.png';
import totodile from '@assets/pokemon/totodile.png';

/** Species name → the URL the bundler emitted for its sheet. */
export const SHEET_URLS: Record<string, string> = {
  bulbasaur,
  charmander,
  squirtle,
  pikachu,
  jigglypuff,
  psyduck,
  gengar,
  eevee,
  snorlax,
  chikorita,
  cyndaquil,
  totodile
};

type Direction = 'down' | 'left' | 'right' | 'up';

interface PokemonEntry {
  name: string;
  dex: number;
  /** Column sequence to play per direction, in the delivered sheet's own
   *  columns. Side rows repeat their two unique poses as [0,1,0,1]. */
  directions: Record<Direction, { frames: number[] }>;
}

// One cast at the boundary: TS widens the manifest's repeated object literals
// into a union that cannot be indexed by direction name.
const SPEC = manifest as unknown as {
  frameWidth: number;
  frameHeight: number;
  gridColumns: number;
  rowOrder: Direction[];
  pokemon: PokemonEntry[];
};

export interface PokemonInfo {
  name: string;
  dex: number;
  /** Capitalised for the UI. */
  label: string;
  sheetUrl: string;
}

export const FRAME_WIDTH = SPEC.frameWidth;
export const FRAME_HEIGHT = SPEC.frameHeight;

/**
 * Pixels of empty space below the sprite inside its frame. Measured across the
 * sheets: content bottoms sit at y=29..31 in the 32px frame. WalkerSprite
 * anchors (0.5, 1), so without this the feet float above the tile they stand on.
 */
export const FOOT_INSET = 2;

export const POKEMON_ROSTER: readonly PokemonInfo[] = SPEC.pokemon.map((p) => ({
  name: p.name,
  dex: p.dex,
  label: p.name.charAt(0).toUpperCase() + p.name.slice(1),
  sheetUrl: SHEET_URLS[p.name]
}));

/** Sheets are tiny (a few kB each) and the scene needs one synchronously the
 *  moment a session appears, so they are loaded once, up front, together. */
export async function loadPokemonSheets(): Promise<Map<string, Texture[][]>> {
  const loaded = await Promise.all(
    SPEC.pokemon.map(async (entry) => {
      const url = SHEET_URLS[entry.name];
      if (!url) throw new Error(`manifest lists ${entry.name}, which has no import here`);
      const sheet = await loadPixelTexture(url);
      const rows = SPEC.rowOrder.map((direction, row) =>
        entry.directions[direction].frames.map((col) => {
          if (col < 0 || col >= SPEC.gridColumns) {
            throw new Error(`${entry.name}.${direction} frame ${col} is outside the sheet`);
          }
          return new Texture({
            source: sheet.source,
            frame: new Rectangle(col * FRAME_WIDTH, row * FRAME_HEIGHT, FRAME_WIDTH, FRAME_HEIGHT)
          });
        })
      );
      return [entry.name, rows] as const;
    })
  );
  return new Map(loaded);
}

/** A species no live session is using, or — if all 12 are taken — a random one. */
export function pickFreePokemon(taken: readonly string[]): string {
  const free = POKEMON_ROSTER.filter((p) => !taken.includes(p.name));
  const pool = free.length > 0 ? free : POKEMON_ROSTER;
  return pool[Math.floor(Math.random() * pool.length)].name;
}
