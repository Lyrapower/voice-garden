import './style.css';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import GUI from 'lil-gui';
import { AudioCapture } from './AudioCapture';
import { Controller } from './Controller';
import { createLatencyOverlay } from './Latency';
import { MemoryHall, type ParticleKeyframe } from './MemoryHall';
import { interpolateKeyframes } from './keyframes';
import {
  applyInstancedLiveUniforms,
  createParticleInstancedField,
  uniform,
} from './ParticleField';
import { SocketClient } from './SocketClient';
import { useGardenStore } from './store';

const BG = 0x0a0a0f;
// The camera orbits outside the cloud (radius up to ~60 x dispersion) so the field reads as one glowing body with dark
// space around it; from inside it, 100k additive quads sum to a white screen.
const CAMERA_ORBIT = 120;
const FIELD_RADIUS = 55; // what must stay in frame horizontally on a portrait screen
/** Camera distance for the current aspect: 120 on landscape, further back on a phone held upright. */
function orbitFor(aspect: number): number {
  const halfV = THREE.MathUtils.degToRad(52 / 2);
  return Math.max(CAMERA_ORBIT, FIELD_RADIUS / (Math.tan(halfV) * aspect));
}

/** Where the camera wants to be at time `now` (ms): circling slowly, looking down on the turning disk. */
function orbitTarget(now: number, aspect: number, mx: number, my: number, out: THREE.Vector3): THREE.Vector3 {
  const orbit = now * 0.00011;
  const r = orbitFor(aspect) + Math.sin(now * 0.00035) * 1.8;
  // about 40 degrees above the disk, bobbing a little
  const lift = 0.62 + Math.sin(orbit * 0.7) * 0.06;
  out.set(Math.cos(orbit), lift, Math.sin(orbit)).normalize().multiplyScalar(r);
  return out.add(tmpOffset.set(mx * 18, my * 12, 0));
}
const tmpOffset = new THREE.Vector3();
// aim a little below the centre: the near rim of the tilted disk reaches lower on screen than the far rim
const LOOK_AT = new THREE.Vector3(0, -8, 0);

const chromaShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    amount: { value: 0.003 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      vec2 dir = length(c) > 0.0001 ? normalize(c) : vec2(0.0);
      vec2 off = dir * amount * length(c);
      vec4 base = texture2D(tDiffuse, vUv);
      float r = texture2D(tDiffuse, vUv + off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - off).b;
      gl_FragColor = vec4(r, g, b, base.a);
    }
  `,
};

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#c');
  if (!canvas) throw new Error('Missing canvas');
  const latencyEl = document.querySelector<HTMLElement>('#latency-overlay');
  if (!latencyEl) throw new Error('Missing latency overlay');
  const guiMount = document.querySelector<HTMLElement>('#gui-mount');
  if (!guiMount) throw new Error('Missing gui mount');

  const latency = createLatencyOverlay(latencyEl);
  const memoryRoot = document.querySelector<HTMLElement>('#memory-hall');
  if (!memoryRoot) throw new Error('Missing memory hall');
  const memoryHall = new MemoryHall(memoryRoot);
  await memoryHall.init();

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);

  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 400);
  orbitTarget(performance.now(), camera.aspect, 0, 0, camera.position); // start on the orbit, not level with the disk
  camera.lookAt(LOOK_AT);

  const count = useGardenStore.getState().settings.particleCount;
  const field = createParticleInstancedField(count);
  scene.add(field.mesh);

  const composer = new EffectComposer(renderer);
  composer.setSize(window.innerWidth, window.innerHeight);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  // short light trails: each frame keeps a fading copy of the last ones, so the flow reads as streaks
  const trails = new AfterimagePass(0.8);
  composer.addPass(trails);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.0,
    0.32,
    0.35, // threshold: only the bright arms and core bloom, not every particle
  );
  composer.addPass(bloomPass);

  const chromaPass = new ShaderPass(chromaShader);
  composer.addPass(chromaPass);
  composer.addPass(new OutputPass());

  const controller = new Controller();
  const socket = new SocketClient();
  socket.connect((s) => controller.setAiSample(s));

  const audio = new AudioCapture(latency);
  memoryHall.attachAudioCapture(audio);

  let recordT0 = 0;
  let playback: {
    url: string;
    el: HTMLAudioElement;
    keyframes: ParticleKeyframe[];
  } | null = null;

  const sampleKeyframe = (): ParticleKeyframe => ({
    t: (performance.now() - recordT0) / 1000,
    uniforms: {
      u_density: uniform(field.material, 'u_density').value as number,
      u_colorShift: uniform(field.material, 'u_colorShift').value as number,
      u_coherence: uniform(field.material, 'u_coherence').value as number,
      u_audioRMS: uniform(field.material, 'u_audioRMS').value as number,
    },
    camera: {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      tx: 0,
      ty: 0,
      tz: 0,
    },
  });

  window.addEventListener(
    'garden-playback',
    (ev: Event) => {
      const e = ev as CustomEvent<{
        keyframes: ParticleKeyframe[];
        audio: Blob;
      }>;
      if (playback) {
        playback.el.pause();
        URL.revokeObjectURL(playback.url);
      }
      const url = URL.createObjectURL(e.detail.audio);
      const el = new Audio();
      el.src = url;
      void el.play().catch(() => {
        /* autoplay policy: user gesture may be required */
      });
      playback = { url, el, keyframes: e.detail.keyframes };
    },
    false,
  );

  window.addEventListener('garden-playback-stop', () => {
    if (playback) {
      playback.el.pause();
      URL.revokeObjectURL(playback.url);
      playback = null;
    }
  });

  const mouse = new THREE.Vector2(0, 0);
  const mouseTarget = new THREE.Vector2(0, 0);
  window.addEventListener(
    'pointermove',
    (ev) => {
      const cx = window.innerWidth * 0.5;
      const cy = window.innerHeight * 0.5;
      const dx = ev.clientX - cx;
      const dy = ev.clientY - cy;
      const dist = Math.hypot(dx, dy);
      const r = 100;
      const w = Math.max(0, 1 - dist / r);
      mouseTarget.set(dx * w * 0.00012, -dy * w * 0.00012);
    },
    { passive: true },
  );

  useGardenStore.subscribe((st, prev) => {
    if (prev && st.settings.particleCount !== prev.settings.particleCount) {
      field.setCount(st.settings.particleCount);
    }
  });

  const guiParams = { ...useGardenStore.getState().settings };
  const gui = new GUI({ container: guiMount, title: 'Garden' });
  gui.close(); // the field comes first; the panel opens from its title bar
  const folder = gui.addFolder('Field');
  folder
    .add(guiParams, 'dispersion', 0.5, 3.0, 0.01)
    .onChange((v: number) => useGardenStore.getState().setSettings({ dispersion: v }));
  folder
    .add(guiParams, 'particleSize', 0.5, 3.0, 0.01)
    .onChange((v: number) => useGardenStore.getState().setSettings({ particleSize: v }));
  folder
    .add(guiParams, 'flowSpeed', 0.1, 2.0, 0.01)
    .onChange((v: number) => useGardenStore.getState().setSettings({ flowSpeed: v }));
  folder
    .add(guiParams, 'audioReactivity', 0, 1, 0.01)
    .onChange((v: number) => useGardenStore.getState().setSettings({ audioReactivity: v }));
  folder
    .add(guiParams, 'bloomIntensity', 0, 3.0, 0.01)
    .onChange((v: number) => useGardenStore.getState().setSettings({ bloomIntensity: v }));
  folder
    .add(guiParams, 'colorShiftSpeed', 0, 2.0, 0.01)
    .onChange((v: number) => useGardenStore.getState().setSettings({ colorShiftSpeed: v }));
  folder
    .add(guiParams, 'particleCount', 50_000, 200_000, 1000)
    .onChange((v: number) => useGardenStore.getState().setSettings({ particleCount: Math.floor(v) }));

  const btnMic = document.querySelector<HTMLButtonElement>('#btn-mic');
  const btnRecord = document.querySelector<HTMLButtonElement>('#btn-record');
  const btnStop = document.querySelector<HTMLButtonElement>('#btn-stop');
  const recInd = document.querySelector<HTMLElement>('#rec-indicator');

  // ▶ Play demo track: a CC0 synth loop shipped with the page, analysed exactly like the microphone
  const btnDemo = document.querySelector<HTMLButtonElement>('#btn-demo');
  let demo: HTMLAudioElement | null = null;
  const stopDemo = () => {
    if (!demo) return;
    demo.pause();
    audio.stop();
    demo = null;
    btnDemo!.textContent = '▶ Play demo track';
  };
  btnDemo?.addEventListener('click', async () => {
    if (demo) return stopDemo();
    if (useGardenStore.getState().micEnabled) btnMic?.click(); // one source at a time
    const el = new Audio(`${import.meta.env.BASE_URL}demo-track.mp3`); // MP3 plays in every browser, AAC does not
    el.loop = true;
    try {
      await el.play();
    } catch (e) {
      // NotAllowedError: the browser wants a fresh tap. Anything else: the file could not be loaded or decoded.
      btnDemo.textContent = (e as DOMException)?.name === 'NotAllowedError' ? '▶ Tap again to play' : 'Demo track unavailable';
      return;
    }
    demo = el;
    audio.startAnalyzing((f) => controller.setAudioFeatures(f), el);
    btnDemo.textContent = '❚❚ Pause demo track';
  });

  btnMic?.addEventListener('click', async () => {
    const st = useGardenStore.getState();
    if (!st.micEnabled) stopDemo();
    if (st.micEnabled) {
      audio.stop();
      useGardenStore.getState().setMicEnabled(false);
      btnMic!.textContent = 'Mic on';
    } else {
      try {
        await audio.requestMic();
      } catch {
        // Permission denied or no input device: keep the field running on the built-in generator.
        btnMic!.textContent = 'Mic blocked';
        btnMic!.title = 'Allow microphone access for this site, then press again.';
        return;
      }
      btnMic!.title = '';
      audio.startAnalyzing((f) => controller.setAudioFeatures(f));
      useGardenStore.getState().setMicEnabled(true);
      btnMic!.textContent = 'Mic off';
    }
  });

  folder.add({ 'Record session': () => btnRecord?.click() }, 'Record session');
  btnRecord?.addEventListener('click', () => {
    recordT0 = performance.now();
    memoryHall.startRecording();
    btnRecord.hidden = true;
    btnStop!.hidden = false;
    recInd!.hidden = false;
  });

  btnStop?.addEventListener('click', async () => {
    const vf = controller.getVoiceFreq();
    const ai = socket.getLatest().aiFreq;
    await memoryHall.stopRecording(sampleKeyframe, vf, ai);
    btnStop!.hidden = true;
    recInd!.hidden = true;
  });

  let last = performance.now();
  const tmpCam = new THREE.Vector3();
  const camWorld = new THREE.Vector3(); // hoisted: avoid per-frame allocation
  let rafPending = false;

  function animate(): void {
    if (document.hidden) {
      rafPending = false;
      return; // resume on visibilitychange
    }
    rafPending = true;
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    mouse.lerp(mouseTarget, 1 - Math.exp(-dt * 6));

    const s = useGardenStore.getState().settings;
    bloomPass.strength = s.bloomIntensity;
    uniform(chromaPass, 'amount').value = 0.001 + 0.004 * Math.min(1, s.audioReactivity);

    let live = controller.update(dt, s.colorShiftSpeed, s.audioReactivity);

    if (playback && playback.keyframes.length) {
      const t = playback.el.currentTime;
      const k = interpolateKeyframes(playback.keyframes, t);
      if (k) {
        live = {
          ...live,
          u_density: k.uniforms.u_density,
          u_colorShift: k.uniforms.u_colorShift,
          u_coherence: k.uniforms.u_coherence,
          u_audioRMS: k.uniforms.u_audioRMS,
        };
        camera.position.set(k.camera.x, k.camera.y, k.camera.z);
        camera.lookAt(k.camera.tx, k.camera.ty, k.camera.tz);
      }
    } else {
      orbitTarget(now, camera.aspect, mouse.x, mouse.y, tmpCam);
      camera.position.lerp(tmpCam, 1 - Math.exp(-dt * 1.8));
      camera.lookAt(LOOK_AT);
    }

    camera.getWorldPosition(camWorld);

    applyInstancedLiveUniforms(
      field.material,
      live,
      { flowSpeed: s.flowSpeed, particleSize: s.particleSize, dispersion: s.dispersion },
      camWorld,
    );

    const tRec = (performance.now() - recordT0) / 1000;
    memoryHall.tickRecording(tRec, sampleKeyframe);

    composer.render();
    latency.markVisualFrame();
    latency.tickOverlay();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !rafPending) {
      last = performance.now(); // reset dt so we don't get a giant step
      animate();
    }
  });

  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloomPass.setSize(w, h);
  });

  animate();
}

void main();
