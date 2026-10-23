/** Procedural studio-lit gateway sculpture. Rendering is owned by the caller. */
const vertexSource = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;
const fragmentSource = `
precision highp float;
uniform vec2 resolution;
uniform vec2 pointer;
uniform float lightTheme;
mat2 rotate(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec3 local(vec3 p) {
  p.xy = rotate(-0.42) * p.xy;
  p.xz = rotate(0.57 + pointer.x * 0.18) * p.xz;
  p.yz = rotate(-0.35 + pointer.y * 0.15) * p.yz;
  return p;
}
float shape(vec3 point) {
  vec3 p = local(point);
  float angle = atan(p.y, p.x);
  float radius = 1.02 + 0.055 * cos(angle * 3.0);
  p.z += 0.10 * sin(angle * 3.0);
  vec2 tube = vec2(length(p.xy) - radius, p.z);
  tube = rotate(angle * 1.5) * tube;
  vec2 d = abs(tube) - vec2(0.17, 0.23);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - 0.115;
}
vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.0018, 0.0);
  return normalize(vec3(shape(p + e.xyy) - shape(p - e.xyy),
    shape(p + e.yxy) - shape(p - e.yxy), shape(p + e.yyx) - shape(p - e.yyx)));
}
float band(vec3 direction, vec3 axis, float width) {
  return exp(-pow((dot(direction, normalize(axis)) - 0.25) / width, 2.0));
}
vec3 studio(vec3 r) {
  vec3 base = mix(vec3(0.075, 0.083, 0.10), vec3(0.16, 0.18, 0.22), lightTheme);
  base += vec3(0.85, 0.91, 1.0) * band(r, vec3(-0.8, 1.0, 0.3), 0.20) * 1.4;
  base += vec3(1.0) * band(r, vec3(0.4, 0.1, 1.0), 0.055) * 1.5;
  base += vec3(0.47, 0.60, 0.80) * pow(max(dot(r, normalize(vec3(1.0, 0.3, 0.4))), 0.0), 14.0) * 1.1;
  return base;
}
void main() {
  vec2 uv = (2.0 * gl_FragCoord.xy - resolution) / min(resolution.x, resolution.y);
  vec3 origin = vec3(uv * 1.68, 4.0), ray = vec3(0.0, 0.0, -1.0);
  float travel = 0.0;
  bool hit = false;
  for (int i = 0; i < 72; i++) {
    float distance = shape(origin + ray * travel);
    if (distance < 0.0015) { hit = true; break; }
    if (travel > 6.0) break;
    travel += distance * 0.85;
  }
  if (!hit) { gl_FragColor = vec4(0.0); return; }
  vec3 p = origin + ray * travel, n = normalAt(p);
  float fresnel = pow(1.0 - max(dot(n, -ray), 0.0), 3.0);
  float occlusion = clamp(0.65 + 0.3 * length(p.xy), 0.65, 1.0);
  vec3 color = studio(reflect(ray, n)) * (0.72 + 0.28 * fresnel) * occlusion;
  color += vec3(0.055, 0.06, 0.07) * max(dot(n, normalize(vec3(-0.4, 1.0, 2.0))), 0.0);
  vec3 q = local(p);
  color *= 0.98 + 0.02 * sin(atan(q.y, q.x) * 620.0 + length(q.xy) * 180.0);
  color = pow(color / (color + vec3(0.65)), vec3(0.82));
  gl_FragColor = vec4(color, 1.0);
}
`;

export type GatewayScene = {
  hardware: boolean;
  draw: (x: number, y: number, light: boolean) => boolean;
  dispose: () => void;
};

export function createGatewayScene(canvas: HTMLCanvasElement): GatewayScene | null {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, powerPreference: "low-power" });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram(), buffer = gl.createBuffer();
  const dispose = () => {
    gl.deleteBuffer(buffer); gl.deleteProgram(program);
    shaders.forEach(shader => gl.deleteShader(shader));
  };
  if (!program || !buffer) { dispose(); return null; }
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
    const shader = gl.createShader(type);
    if (!shader) { dispose(); return null; }
    shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { dispose(); return null; }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { dispose(); return null; }
  gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const attribute = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
  const resolution = gl.getUniformLocation(program, "resolution");
  const pointer = gl.getUniformLocation(program, "pointer");
  const theme = gl.getUniformLocation(program, "lightTheme");
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
  let disposed = false;
  return {
    hardware: Boolean(debug) && !/swiftshader|llvmpipe|software/i.test(renderer),
    draw(x, y, light) {
      if (disposed || gl.isContextLost()) return false;
      const size = Math.min(840, Math.max(240, Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 1.25))));
      if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size; }
      gl.viewport(0, 0, size, size); gl.uniform2f(resolution, size, size);
      gl.uniform2f(pointer, x, y); gl.uniform1f(theme, light ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return true;
    },
    dispose() {
      disposed = true; dispose();
      // StrictMode immediately reuses a connected canvas during its effect
      // check. Release the context only once the element has actually left.
      queueMicrotask(() => { if (!canvas.isConnected) gl.getExtension("WEBGL_lose_context")?.loseContext(); });
    },
  };
}
