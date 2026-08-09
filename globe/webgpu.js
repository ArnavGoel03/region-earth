/* WebGPU backend. Same passes, same uniform layout and same draw order as
   webgl2.js, so the two produce the same image rather than two similar ones.

   Differences that are forced by the API, not by choice:
     - line width is fixed at one pixel (WebGPU has no lineWidth), which is why
       the WebGL2 side does not use lineWidth either.
     - multisampling is explicit, so a 4x target is created to match the
       antialias:true default the WebGL2 context gets for free.
     - the per-draw line style rides a dynamic uniform offset instead of
       rebinding a different buffer each call. */

import { SHADER, STYLE, U, f } from "./params.js";

/* One aligned slot per line style: borders, graticule and the hover outline. */
const STYLE_STRIDE = 256;
const STYLE_SLOTS = ["graticule", "borders", "highlight"];
const SAMPLE_COUNT = 4;

const SHARED = /* wgsl */ `
struct Frame {
  viewProj : mat4x4<f32>,
  eye : vec4<f32>,
  params : vec4<f32>,
  ember : vec4<f32>,
  emberDeep : vec4<f32>,
  emberBright : vec4<f32>,
  signalColor : vec4<f32>,
  hairline : vec4<f32>,
  ocean : vec4<f32>,
  opacity : vec4<f32>,
  misc : vec4<f32>,
  viewport : vec4<f32>,
};
@group(0) @binding(0) var<uniform> frame : Frame;
`;

const SPHERE_WGSL = /* wgsl */ `${SHARED}
struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
};

@vertex fn vs(@location(0) pos : vec3<f32>) -> VSOut {
  var out : VSOut;
  out.clip = frame.viewProj * vec4<f32>(pos, 1.0);
  out.world = pos;
  return out;
}

@fragment fn fsSphere(in : VSOut) -> @location(0) vec4<f32> {
  let N = normalize(in.world);
  let V = normalize(frame.eye.xyz - in.world);
  let facing = max(dot(N, V), 0.0);
  let rim = pow(1.0 - facing, frame.misc.y) * frame.misc.z;
  var col = frame.ocean.rgb + frame.ember.rgb * rim * ${f(SHADER.oceanRim)};
  let key = max(dot(N, normalize(vec3<f32>(${SHADER.keyDir.map(f).join(', ')}))), 0.0);
  col += frame.ember.rgb * pow(key, ${f(SHADER.keyPower)}) * ${f(SHADER.keyGain)};
  return vec4<f32>(col, 1.0);
}

@fragment fn fsAtmosphere(in : VSOut) -> @location(0) vec4<f32> {
  let N = normalize(in.world);
  let V = normalize(frame.eye.xyz - in.world);
  let rim = pow(1.0 - max(dot(N, V), 0.0), ${f(SHADER.atmoPower)});
  return vec4<f32>(frame.ember.rgb, rim * ${f(SHADER.atmoGain)});
}
`;

const DOT_WGSL = /* wgsl */ `${SHARED}
struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) corner : vec2<f32>,
  @location(1) facing : f32,
  @location(2) hot : f32,
};

@vertex fn vs(
  @location(0) corner : vec2<f32>,
  @location(1) dot4 : vec4<f32>,
) -> VSOut {
  var out : VSOut;
  let P = dot4.xyz;
  let N = normalize(P);
  let V = normalize(frame.eye.xyz - P);
  out.facing = dot(N, V);
  out.hot = select(0.0, 1.0, abs(dot4.w - frame.params.z) < 0.5);
  out.corner = corner;

  var clip = frame.viewProj * vec4<f32>(P, 1.0);
  let px = frame.params.y * frame.misc.w * (1.0 + out.hot * ${f(SHADER.hotScale)});
  clip = vec4<f32>(
    clip.xy + corner * px * clip.w / frame.viewport.xy * 2.0,
    clip.z,
    clip.w,
  );
  out.clip = clip;
  return out;
}

@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let r = length(in.corner) * 2.0;
  let disc = 1.0 - smoothstep(${f(SHADER.dotEdge)}, 1.0, r);
  if (disc <= ${f(SHADER.dotCut)}) { discard; }
  let limb = smoothstep(0.0, frame.misc.x, in.facing);
  var col = mix(frame.emberDeep.rgb, frame.ember.rgb, clamp(in.facing * ${f(SHADER.dotShade)}, 0.0, 1.0));
  col = mix(col, frame.emberBright.rgb, in.hot);
  let alpha = disc * limb * frame.opacity.x * (0.5 + 0.5 * in.facing);
  return vec4<f32>(col, mix(alpha, min(1.0, alpha * ${f(SHADER.hotAlpha)}), in.hot));
}
`;

const LINE_WGSL = /* wgsl */ `${SHARED}
struct Style {
  color : vec4<f32>,
  opts : vec4<f32>,
};
@group(1) @binding(0) var<uniform> style : Style;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
};

@vertex fn vs(@location(0) pos : vec3<f32>) -> VSOut {
  var out : VSOut;
  out.clip = frame.viewProj * vec4<f32>(pos, 1.0);
  out.world = pos;
  return out;
}

@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let N = normalize(in.world);
  let V = normalize(frame.eye.xyz - in.world);
  let facing = dot(N, V);
  if (facing <= 0.0) { discard; }
  let limb = smoothstep(0.0, frame.misc.x * ${f(SHADER.lineLimb)}, facing);
  return vec4<f32>(style.color.rgb, style.color.a * style.opts.x * limb);
}
`;

const ARC_WGSL = /* wgsl */ `${SHARED}
struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) t : f32,
};

@vertex fn vs(@location(0) pos : vec3<f32>, @location(1) t : f32) -> VSOut {
  var out : VSOut;
  out.clip = frame.viewProj * vec4<f32>(pos, 1.0);
  out.t = t;
  return out;
}

@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  var d = in.t - frame.params.x;
  d -= floor(d + 0.5);
  let pulse = exp(-abs(d) * ${f(SHADER.pulseFalloff)});
  let col = mix(frame.signalColor.rgb, vec3<f32>(1.0), pulse * ${f(SHADER.pulseWhite)});
  return vec4<f32>(col, frame.opacity.w * (${f(SHADER.arcBase)} + pulse * ${f(SHADER.arcGain)}));
}
`;

const ALPHA_BLEND = {
  color: {
    srcFactor: "src-alpha",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

const ADDITIVE_BLEND = {
  color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
};

export async function createWebGPURenderer(canvas) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  if (!device) return null;

  const context = canvas.getContext("webgpu");
  if (!context) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const frameBuffer = device.createBuffer({
    size: U.FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const styleBuffer = device.createBuffer({
    size: STYLE_STRIDE * STYLE_SLOTS.length,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const frameLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });
  const styleLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: STYLE.FLOATS * 4 },
      },
    ],
  });

  const frameGroup = device.createBindGroup({
    layout: frameLayout,
    entries: [{ binding: 0, resource: { buffer: frameBuffer } }],
  });
  const styleGroup = device.createBindGroup({
    layout: styleLayout,
    entries: [
      {
        binding: 0,
        resource: { buffer: styleBuffer, size: STYLE.FLOATS * 4 },
      },
    ],
  });

  const modules = {
    sphere: device.createShaderModule({ code: SPHERE_WGSL, label: "sphere" }),
    dots: device.createShaderModule({ code: DOT_WGSL, label: "dots" }),
    line: device.createShaderModule({ code: LINE_WGSL, label: "line" }),
    arc: device.createShaderModule({ code: ARC_WGSL, label: "arc" }),
  };

  const depthState = (write) => ({
    format: "depth24plus",
    depthWriteEnabled: write,
    depthCompare: "less-equal",
  });

  const pipe = (opts) =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: opts.groups ?? [frameLayout],
      }),
      vertex: {
        module: opts.module,
        entryPoint: "vs",
        buffers: opts.buffers,
      },
      fragment: {
        module: opts.module,
        entryPoint: opts.fragment ?? "fs",
        targets: [{ format, blend: opts.blend }],
      },
      primitive: {
        topology: opts.topology,
        cullMode: opts.cullMode ?? "none",
        frontFace: "ccw",
      },
      depthStencil: depthState(opts.depthWrite ?? false),
      multisample: { count: SAMPLE_COUNT },
    });

  const vec3Layout = [
    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
  ];

  const pipelines = {
    sphere: pipe({
      module: modules.sphere,
      fragment: "fsSphere",
      buffers: vec3Layout,
      topology: "triangle-list",
      cullMode: "back",
      depthWrite: true,
    }),
    atmosphere: pipe({
      module: modules.sphere,
      fragment: "fsAtmosphere",
      buffers: vec3Layout,
      topology: "triangle-list",
      cullMode: "front",
      blend: ADDITIVE_BLEND,
    }),
    dots: pipe({
      module: modules.dots,
      buffers: [
        { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
        {
          arrayStride: 16,
          stepMode: "instance",
          attributes: [{ shaderLocation: 1, offset: 0, format: "float32x4" }],
        },
      ],
      topology: "triangle-strip",
      blend: ALPHA_BLEND,
    }),
    line: pipe({
      module: modules.line,
      groups: [frameLayout, styleLayout],
      buffers: vec3Layout,
      topology: "line-list",
      blend: ALPHA_BLEND,
    }),
    arc: pipe({
      module: modules.arc,
      buffers: [
        {
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32" },
          ],
        },
      ],
      topology: "line-strip",
      blend: ALPHA_BLEND,
    }),
  };

  const quad = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    quad,
    0,
    new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
  );

  const gpuBuffers = new Map();
  const styleScratch = new Float32Array(STYLE.FLOATS);
  let sphereCount = 0;
  let dotCount = 0;
  let borderCount = 0;
  let graticuleCount = 0;
  let highlightCount = 0;
  let arcRanges = [];
  let depthTexture = null;
  let msaaTexture = null;
  let size = [1, 1];

  function upload(key, data, usage) {
    const bytes = data.byteLength;
    let entry = gpuBuffers.get(key);
    if (!entry || entry.size < bytes) {
      entry?.buffer.destroy();
      entry = {
        buffer: device.createBuffer({ size: bytes, usage: usage | GPUBufferUsage.COPY_DST }),
        size: bytes,
      };
      gpuBuffers.set(key, entry);
    }
    device.queue.writeBuffer(entry.buffer, 0, data);
    return entry.buffer;
  }

  function setGeometry({ sphere, dots, borders, graticule }) {
    upload("sphere", sphere.positions, GPUBufferUsage.VERTEX);
    upload("sphereIndex", sphere.indices, GPUBufferUsage.INDEX);
    sphereCount = sphere.count;
    setDots(dots);
    upload("borders", borders.data, GPUBufferUsage.VERTEX);
    borderCount = borders.count;
    upload("graticule", graticule.data, GPUBufferUsage.VERTEX);
    graticuleCount = graticule.count;
  }

  function setDots(dots) {
    upload("dots", dots.data, GPUBufferUsage.VERTEX);
    dotCount = dots.count;
  }

  function setHighlight(outline) {
    highlightCount = outline.count;
    if (outline.count) upload("highlight", outline.data, GPUBufferUsage.VERTEX);
  }

  function setArcs(arcs) {
    arcRanges = arcs.ranges;
    if (arcs.count) upload("arcs", arcs.data, GPUBufferUsage.VERTEX);
  }

  function writeStyle(slot, color, opacity) {
    styleScratch.fill(0);
    styleScratch[STYLE.color] = color[0];
    styleScratch[STYLE.color + 1] = color[1];
    styleScratch[STYLE.color + 2] = color[2];
    styleScratch[STYLE.color + 3] = color[3] ?? 1;
    styleScratch[STYLE.opts] = opacity;
    device.queue.writeBuffer(styleBuffer, slot * STYLE_STRIDE, styleScratch);
  }

  function frame(uniforms, style) {
    if (!depthTexture) return;
    device.queue.writeBuffer(frameBuffer, 0, uniforms);
    writeStyle(0, style.graticule, style.graticuleOpacity);
    writeStyle(1, style.border, style.borderOpacity);
    writeStyle(2, style.highlight, style.highlightOpacity);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: msaaTexture.createView(),
          resolveTarget: context.getCurrentTexture().createView(),
          clearValue: {
            r: style.background[0],
            g: style.background[1],
            b: style.background[2],
            a: 1,
          },
          loadOp: "clear",
          storeOp: "discard",
        },
      ],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    });

    pass.setBindGroup(0, frameGroup);

    pass.setPipeline(pipelines.sphere);
    pass.setVertexBuffer(0, gpuBuffers.get("sphere").buffer);
    pass.setIndexBuffer(gpuBuffers.get("sphereIndex").buffer, "uint32");
    pass.drawIndexed(sphereCount);

    const drawLines = (key, count, slot, opacity) => {
      /* Matching webgl2.js: a hidden layer is skipped, not drawn transparent. */
      if (!count || opacity <= 0) return;
      pass.setPipeline(pipelines.line);
      pass.setBindGroup(1, styleGroup, [slot * STYLE_STRIDE]);
      pass.setVertexBuffer(0, gpuBuffers.get(key).buffer);
      pass.draw(count);
    };
    drawLines("graticule", graticuleCount, 0, style.graticuleOpacity);
    drawLines("borders", borderCount, 1, style.borderOpacity);

    pass.setPipeline(pipelines.dots);
    pass.setVertexBuffer(0, quad);
    pass.setVertexBuffer(1, gpuBuffers.get("dots").buffer);
    pass.draw(4, dotCount);

    drawLines("highlight", highlightCount, 2, style.highlightOpacity);

    if (arcRanges.length) {
      pass.setPipeline(pipelines.arc);
      pass.setVertexBuffer(0, gpuBuffers.get("arcs").buffer);
      for (const range of arcRanges) pass.draw(range.count, 1, range.offset);
    }

    pass.setPipeline(pipelines.atmosphere);
    pass.setVertexBuffer(0, gpuBuffers.get("sphere").buffer);
    pass.setIndexBuffer(gpuBuffers.get("sphereIndex").buffer, "uint32");
    pass.drawIndexed(sphereCount);

    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function resize(width, height) {
    size = [Math.max(1, width), Math.max(1, height)];
    depthTexture?.destroy();
    msaaTexture?.destroy();
    depthTexture = device.createTexture({
      size,
      format: "depth24plus",
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    msaaTexture = device.createTexture({
      size,
      format,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  function dispose() {
    depthTexture?.destroy();
    msaaTexture?.destroy();
    for (const entry of gpuBuffers.values()) entry.buffer.destroy();
    quad.destroy();
    frameBuffer.destroy();
    styleBuffer.destroy();
    device.destroy?.();
  }

  return {
    api: "webgpu",
    /* A lost device stops producing frames silently, so the page needs to hear
       about it and say something rather than showing a frozen globe. */
    onLost(handler) {
      device.lost.then((info) => {
        if (info.reason !== "destroyed") handler(info.message || "device lost");
      });
    },
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
