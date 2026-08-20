// The WebGL half of the painter (docs/studio.md §4.2).
//
// THIN BY DESIGN. Every method is a direct GL call with no decision in it — which cell
// changed, which glyph to rasterise and what the textures should contain are all settled
// in `glgrid.ts`, where they are ordinary code with ordinary tests. A decision reaching
// this file is a decision that has escaped its tests, because none of this can run in a
// headless suite: there is no GPU, no canvas and no `WebGLRenderingContext`.
//
// What protects it instead: the uniform names are checked against the shader source
// (`gl-shader.test.ts`), and `createGlDevice` returns null rather than throwing when
// WebGL is unavailable, so the caller falls back to `DomGrid` on a machine that cannot
// run this at all.
import type { GlyphDevice } from "./glgrid.js";
import {
  FRAGMENT_SOURCE, VERTEX_SOURCE, UNIFORMS, CRT_DEFAULT,
  type CrtSettings, type UniformName,
} from "./glshader.js";

const ATLAS_SLOTS = 32;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error("could not create a shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // The log, not a generic message. A shader that fails to compile is one typo in a
    // string the type checker never saw, and the driver already knows which line.
    throw new Error(`shader failed to compile: ${gl.getShaderInfoLog(shader) ?? "no log"}`);
  }
  return shader;
}

/**
 * Builds the WebGL painter, or returns null if this machine cannot run it.
 *
 * Null rather than an exception, because "no WebGL" is not an error — it is a fact about
 * the machine, and the answer to it is `DomGrid`, which works everywhere and is fast
 * enough for a normal diff (F3's own measurement said so).
 */
export function createGlDevice(
  canvas: HTMLCanvasElement,
  initialCellWidth: number,
  initialCellHeight: number,
  font: string,
  crt: CrtSettings = CRT_DEFAULT,
): GlyphDevice | null {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false });
  if (gl === null) {
    return null;
  }

  let program: WebGLProgram;
  try {
    program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
    }
  } catch {
    return null;
  }
  gl.useProgram(program);

  const uniform = new Map<UniformName, WebGLUniformLocation | null>();
  for (const name of UNIFORMS) {
    uniform.set(name, gl.getUniformLocation(program, name));
  }

  // One full-screen triangle, not two triangles. The seam down the diagonal of a quad is
  // a real source of a one-pixel line under a curvature that samples across it.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const makeTexture = (unit: number, filter: number): WebGLTexture => {
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  };
  // NEAREST for the data textures: they are not pictures, they are one texel per cell,
  // and interpolating between two cells produces a colour and a glyph slot that belong
  // to neither. LINEAR for the atlas, where smoothing is the point.
  const texFg = makeTexture(0, gl.NEAREST);
  const texBg = makeTexture(1, gl.NEAREST);
  const texAtlas = makeTexture(2, gl.LINEAR);

  gl.uniform1i(uniform.get("uFg")!, 0);
  gl.uniform1i(uniform.get("uBg")!, 1);
  gl.uniform1i(uniform.get("uAtlas")!, 2);
  gl.uniform2f(uniform.get("uAtlasSlots")!, ATLAS_SLOTS, ATLAS_SLOTS);
  // The initial look goes through the same five calls the reader's choice will, so
  // there is one place a renamed uniform can be wrong instead of two.
  const applyCrt = (next: CrtSettings): void => {
    gl.uniform1f(uniform.get("uCurve")!, next.curve);
    gl.uniform1f(uniform.get("uScanline")!, next.scanline);
    gl.uniform1f(uniform.get("uBloom")!, next.bloom);
    gl.uniform1f(uniform.get("uAberration")!, next.aberration);
    gl.uniform1f(uniform.get("uVignette")!, next.vignette);
  };
  applyCrt(crt);

  // The atlas is rasterised on a 2D canvas and re-uploaded when it changes. Kept as one
  // canvas for the life of the device: a glyph arriving mid-scene redraws one slot and
  // uploads once, rather than rebuilding anything.
  const atlasCanvas = document.createElement("canvas");
  const atlas2d = atlasCanvas.getContext("2d");
  let atlasDirty = false;
  let cellWidth = initialCellWidth;
  let cellHeight = initialCellHeight;

  return {
    setCrt(next) {
      applyCrt(next);
    },

    setCellSize(width, height) {
      cellWidth = width;
      cellHeight = height;
    },

    resize(cols, rows, atlasWidth, atlasHeight) {
      canvas.width = cols * cellWidth;
      canvas.height = rows * cellHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniform.get("uGrid")!, cols, rows);
      if (atlasCanvas.width !== atlasWidth || atlasCanvas.height !== atlasHeight) {
        atlasCanvas.width = atlasWidth;
        atlasCanvas.height = atlasHeight;
        atlasDirty = true;
      }
    },

    drawGlyph(char, slot, tile) {
      if (atlas2d === null) {
        return;
      }
      const slotW = atlasCanvas.width / ATLAS_SLOTS;
      const slotH = atlasCanvas.height / ATLAS_SLOTS;
      const x = (slot % ATLAS_SLOTS) * slotW;
      const y = Math.floor(slot / ATLAS_SLOTS) * slotH;
      atlas2d.clearRect(x, y, slotW, slotH);
      atlasDirty = true;
      if (tile !== null) {
        // A tile is an image; it arrives asynchronously, so the atlas is marked dirty
        // again from the load handler rather than uploaded half-decoded.
        const img = new Image();
        img.onload = () => {
          atlas2d.drawImage(img, x, y, slotW, slotH);
          atlasDirty = true;
        };
        img.src = tile;
        return;
      }
      atlas2d.fillStyle = "#fff";
      atlas2d.font = `${Math.floor(slotH * 0.8)}px ${font}`;
      atlas2d.textAlign = "center";
      atlas2d.textBaseline = "middle";
      atlas2d.fillText(char, x + slotW / 2, y + slotH / 2);
    },

    upload(fg, bg, cols, rows) {
      if (atlasDirty) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, texAtlas);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
        atlasDirty = false;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texFg);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, fg);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texBg);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, bg);
    },

    draw() {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
