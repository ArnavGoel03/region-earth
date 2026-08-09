/* WebGL2 backend. Mirrors webgpu.js draw for draw; see backend.js for the
   contract both implement.

   Two choices here exist purely to keep the backends identical rather than
   merely similar. The dot field is drawn as instanced quads instead of
   gl_PointSize points, because WebGPU has no sized point primitive and a
   divergence there would mean two different-looking globes. And all uniforms
   live in one std140 block whose layout is declared once in params.js, so the
   same Float32Array feeds both APIs. */

import { SHADER, STYLE, U, f } from "./params.js";

const VERT_HEAD = `#version 300 es
precision highp float;
layout(std140) uniform Frame {
  mat4 viewProj;
  vec4 eye;
  vec4 params;
  vec4 ember;
  vec4 emberDeep;
  vec4 emberBright;
  vec4 signalColor;
  vec4 hairline;
  vec4 ocean;
  vec4 opacity;
  vec4 misc;
  vec4 viewport;
};
`;

const FRAG_HEAD = VERT_HEAD.replace("precision highp float;", "precision highp float;\nout vec4 fragColor;");

const SPHERE_VS = `${VERT_HEAD}
in vec3 aPos;
out vec3 vPos;
void main() {
  vPos = aPos;
  gl_Position = viewProj * vec4(aPos, 1.0);
}`;

const SPHERE_FS = `${FRAG_HEAD}
in vec3 vPos;
void main() {
  vec3 N = normalize(vPos);
  vec3 V = normalize(eye.xyz - vPos);
  float facing = max(dot(N, V), 0.0);
  /* Fresnel: grazing angles brighten. Without it a dark sphere reads as a flat
     disc, and the dot field loses the surface it is supposed to sit on. */
  float rim = pow(1.0 - facing, misc.y) * misc.z;
  vec3 col = ocean.rgb + ember.rgb * rim * ${f(SHADER.oceanRim)};
  /* A single fixed key light, well off axis, so the globe has a form shadow
     rather than reading as uniformly lit. */
  float key = max(dot(N, normalize(vec3(${SHADER.keyDir.map(f).join(', ')}))), 0.0);
  col += ember.rgb * pow(key, ${f(SHADER.keyPower)}) * ${f(SHADER.keyGain)};
  fragColor = vec4(col, 1.0);
}`;

const ATMO_VS = SPHERE_VS;
const ATMO_FS = `${FRAG_HEAD}
in vec3 vPos;
void main() {
  vec3 N = normalize(vPos);
  vec3 V = normalize(eye.xyz - vPos);
  float rim = pow(1.0 - max(dot(N, V), 0.0), ${f(SHADER.atmoPower)});
  fragColor = vec4(ember.rgb, rim * ${f(SHADER.atmoGain)});
}`;

/* Instanced quad: aCorner is the unit quad, aDot is one land sample. */
const DOT_VS = `${VERT_HEAD}
in vec2 aCorner;
in vec4 aDot;
out vec2 vCorner;
out float vFacing;
out float vHot;
void main() {
  vec3 P = aDot.xyz;
  vec3 N = normalize(P);
  vec3 V = normalize(eye.xyz - P);
  vFacing = dot(N, V);
  vHot = abs(aDot.w - params.z) < 0.5 ? 1.0 : 0.0;
  vCorner = aCorner;

  vec4 clip = viewProj * vec4(P, 1.0);
  /* Size in pixels, converted to clip space by hand so the quad stays circular
     whatever the aspect ratio, and grows as the camera closes in. */
  float px = params.y * misc.w * (1.0 + vHot * ${f(SHADER.hotScale)});
  vec2 offset = aCorner * px * clip.w / viewport.xy * 2.0;
  clip.xy += offset;
  gl_Position = clip;
}`;

const DOT_FS = `${FRAG_HEAD}
in vec2 vCorner;
in float vFacing;
in float vHot;
void main() {
  float r = length(vCorner) * 2.0;
  float disc = 1.0 - smoothstep(${f(SHADER.dotEdge)}, 1.0, r);
  if (disc <= ${f(SHADER.dotCut)}) discard;
  /* Fade before the true silhouette so the edge of the globe is a soft falloff
     rather than a stamped cut-out. */
  float limb = smoothstep(0.0, misc.x, vFacing);
  vec3 col = mix(emberDeep.rgb, ember.rgb, clamp(vFacing * ${f(SHADER.dotShade)}, 0.0, 1.0));
  col = mix(col, emberBright.rgb, vHot);
  float alpha = disc * limb * opacity.x * (0.5 + 0.5 * vFacing);
  fragColor = vec4(col, mix(alpha, min(1.0, alpha * ${f(SHADER.hotAlpha)}), vHot));
}`;

const LINE_VS = `${VERT_HEAD}
in vec3 aPos;
out vec3 vPos;
void main() {
  vPos = aPos;
  gl_Position = viewProj * vec4(aPos, 1.0);
}`;

const LINE_FS = `${FRAG_HEAD}
layout(std140) uniform Style {
  vec4 styleColor;
  vec4 styleOpts;
};
in vec3 vPos;
void main() {
  vec3 N = normalize(vPos);
  vec3 V = normalize(eye.xyz - vPos);
  float facing = dot(N, V);
  if (facing <= 0.0) discard;
  float limb = smoothstep(0.0, misc.x * ${f(SHADER.lineLimb)}, facing);
  fragColor = vec4(styleColor.rgb, styleColor.a * styleOpts.x * limb);
}`;

const ARC_VS = `${VERT_HEAD}
in vec3 aPos;
in float aT;
out vec3 vPos;
out float vT;
void main() {
  vPos = aPos;
  vT = aT;
  gl_Position = viewProj * vec4(aPos, 1.0);
}`;

const ARC_FS = `${FRAG_HEAD}
in vec3 vPos;
in float vT;
void main() {
  /* A pulse travelling from source to destination. The arc itself stays faint;
     the pulse is what carries the direction of travel. The phase arrives
     precomputed so the speed constant lives only in params.js. */
  float d = vT - params.x;
  d -= floor(d + 0.5);
  float pulse = exp(-abs(d) * ${f(SHADER.pulseFalloff)});
  vec3 col = mix(signalColor.rgb, vec3(1.0), pulse * ${f(SHADER.pulseWhite)});
  float alpha = opacity.w * (${f(SHADER.arcBase)} + pulse * ${f(SHADER.arcGain)});
  fragColor = vec4(col, alpha);
}`;

function compile(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`${label}: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function program(gl, vsSource, fsSource, label) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSource, `${label} vs`));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSource, `${label} fs`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${label}: ${gl.getProgramInfoLog(p)}`);
  }
  const frame = gl.getUniformBlockIndex(p, "Frame");
  if (frame !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, frame, 0);
  const style = gl.getUniformBlockIndex(p, "Style");
  if (style !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, style, 1);
  return p;
}

export function createWebGL2Renderer(canvas) {
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  if (!gl) return null;

  const programs = {
    sphere: program(gl, SPHERE_VS, SPHERE_FS, "sphere"),
    atmosphere: program(gl, ATMO_VS, ATMO_FS, "atmosphere"),
    dots: program(gl, DOT_VS, DOT_FS, "dots"),
    line: program(gl, LINE_VS, LINE_FS, "line"),
    arc: program(gl, ARC_VS, ARC_FS, "arc"),
  };

  const frameUbo = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, frameUbo);
  gl.bufferData(gl.UNIFORM_BUFFER, U.FLOATS * 4, gl.DYNAMIC_DRAW);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, frameUbo);

  const styleUbos = new Map();
  const styleData = new Float32Array(STYLE.FLOATS);
  const styleFor = (key) => {
    let buf = styleUbos.get(key);
    if (!buf) {
      buf = gl.createBuffer();
      gl.bindBuffer(gl.UNIFORM_BUFFER, buf);
      gl.bufferData(gl.UNIFORM_BUFFER, STYLE.FLOATS * 4, gl.DYNAMIC_DRAW);
      styleUbos.set(key, buf);
    }
    return buf;
  };

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    gl.STATIC_DRAW,
  );

  const buffers = new Map();
  const vaos = new Map();
  let sphereCount = 0;
  let dotCount = 0;
  let borderCount = 0;
  let graticuleCount = 0;
  let highlightCount = 0;
  let arcRanges = [];

  const upload = (key, data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) => {
    let buf = buffers.get(key);
    if (!buf) {
      buf = gl.createBuffer();
      buffers.set(key, buf);
    }
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, usage);
    return buf;
  };

  function makeVao(key, setup) {
    let vao = vaos.get(key);
    if (vao) gl.deleteVertexArray(vao);
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    setup();
    gl.bindVertexArray(null);
    vaos.set(key, vao);
    return vao;
  }

  function setGeometry({ sphere, dots, borders, graticule }) {
    const sphereBuf = upload("sphere", sphere.positions);
    const indexBuf = upload("sphereIndex", sphere.indices, gl.ELEMENT_ARRAY_BUFFER);
    sphereCount = sphere.count;
    makeVao("sphere", () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, sphereBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
    });

    setDots(dots);

    const borderBuf = upload("borders", borders.data);
    borderCount = borders.count;
    makeVao("borders", () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, borderBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    });

    const gratBuf = upload("graticule", graticule.data);
    graticuleCount = graticule.count;
    makeVao("graticule", () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, gratBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    });
  }

  function setDots(dots) {
    const dotBuf = upload("dots", dots.data, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    dotCount = dots.count;
    makeVao("dots", () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, dotBuf);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, 1);
    });
  }

  function setHighlight(outline) {
    highlightCount = outline.count;
    if (!outline.count) return;
    const buf = upload("highlight", outline.data, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    makeVao("highlight", () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    });
  }

  function setArcs(arcs) {
    arcRanges = arcs.ranges;
    if (!arcs.count) return;
    const buf = upload("arcs", arcs.data, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    makeVao("arcs", () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    });
  }

  function drawLines(vaoKey, count, color, opacity) {
    /* A hidden layer is skipped rather than drawn at zero alpha. Borders alone
       are eighty thousand segments, and paying for them to contribute nothing
       is the difference between a toggle and a slideshow on weaker hardware. */
    if (!count || opacity <= 0) return;
    styleData[STYLE.color] = color[0];
    styleData[STYLE.color + 1] = color[1];
    styleData[STYLE.color + 2] = color[2];
    styleData[STYLE.color + 3] = color[3] ?? 1;
    styleData[STYLE.opts] = opacity;
    const buf = styleFor(vaoKey);
    gl.bindBuffer(gl.UNIFORM_BUFFER, buf);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, styleData);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, buf);
    gl.bindVertexArray(vaos.get(vaoKey));
    gl.drawArrays(gl.LINES, 0, count);
  }

  function frame(uniforms, style) {
    gl.bindBuffer(gl.UNIFORM_BUFFER, frameUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, uniforms);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, frameUbo);

    gl.clearColor(style.background[0], style.background[1], style.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    /* Opaque shell first: it writes depth, and that depth is what hides the far
       hemisphere's dots and borders without any per-primitive sorting. */
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.useProgram(programs.sphere);
    gl.bindVertexArray(vaos.get("sphere"));
    gl.drawElements(gl.TRIANGLES, sphereCount, gl.UNSIGNED_INT, 0);

    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(programs.line);
    drawLines("graticule", graticuleCount, style.graticule, style.graticuleOpacity);
    drawLines("borders", borderCount, style.border, style.borderOpacity);

    gl.useProgram(programs.dots);
    gl.bindVertexArray(vaos.get("dots"));
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, dotCount);

    gl.useProgram(programs.line);
    drawLines("highlight", highlightCount, style.highlight, style.highlightOpacity);

    if (arcRanges.length) {
      gl.useProgram(programs.arc);
      gl.bindVertexArray(vaos.get("arcs"));
      for (const range of arcRanges) {
        gl.drawArrays(gl.LINE_STRIP, range.offset, range.count);
      }
    }

    /* Halo last, additively, with the front faces culled so what shows is the
       far inside of a slightly larger sphere: a rim of light around the limb. */
    gl.useProgram(programs.atmosphere);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.cullFace(gl.FRONT);
    gl.bindVertexArray(vaos.get("sphere"));
    gl.drawElements(gl.TRIANGLES, sphereCount, gl.UNSIGNED_INT, 0);
    gl.cullFace(gl.BACK);

    gl.bindVertexArray(null);
  }

  function resize(width, height) {
    gl.viewport(0, 0, width, height);
  }

  function dispose() {
    for (const buf of buffers.values()) gl.deleteBuffer(buf);
    for (const vao of vaos.values()) gl.deleteVertexArray(vao);
    for (const buf of styleUbos.values()) gl.deleteBuffer(buf);
    gl.deleteBuffer(frameUbo);
    gl.deleteBuffer(quad);
    for (const p of Object.values(programs)) gl.deleteProgram(p);
  }

  return {
    api: "webgl2",
    setGeometry,
    setDots,
    setHighlight,
    setArcs,
    frame,
    resize,
    dispose,
    get counts() {
      return { dots: dotCount, borders: borderCount, graticule: graticuleCount };
    },
  };
}
