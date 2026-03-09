// Q3/MOHAA shader to Three.js material conversion
// Based on openmohaa tr_shader.c and tr_shade.c

import * as THREE from 'three';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { ParsedShader, ShaderStage, ShaderParser } from './ShaderParser';
import { VirtualFileSystem } from './VirtualFileSystem';

const tgaLoader = new TGALoader();
const texLoader = new THREE.TextureLoader();

// In WebGL2, UNPACK_FLIP_Y_WEBGL is silently ignored for typed-array uploads
// (texSubImage2D with ArrayBufferView).  The TGALoader returns data in
// top-to-bottom order (web convention) with flipY=true, but since the GPU
// flag is ignored for typed arrays the data stays top-to-bottom in VRAM.
// With flipY=false, row-0 goes to the texture bottom (V=0), so V=0 maps to
// the image TOP.  This matches Q3/MOHAA convention: the openmohaa TGA loader
// reads rows in reverse order producing top-to-bottom memory, and
// glTexImage2D maps row-0 to texture-bottom, giving V=0 = image-top.
// Therefore we do NOT flip the scanlines — the raw TGALoader output already
// has the correct layout for Q3 UVs.

// Texture cache
const textureCache = new Map<string, THREE.Texture | null>();
const pendingLoads = new Map<string, Promise<THREE.Texture | null>>();

let whiteTexture: THREE.DataTexture;
function getWhiteTexture(): THREE.DataTexture {
    if (!whiteTexture) {
        const data = new Uint8Array([255, 255, 255, 255]);
        whiteTexture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
        whiteTexture.name = 'white';
        whiteTexture.matrix = new THREE.Matrix3();
        whiteTexture.needsUpdate = true;
    }
    return whiteTexture;
}

// Missing texture placeholder (magenta/black checkerboard)
let missingTexture: THREE.DataTexture;
function getMissingTexture(): THREE.DataTexture {
    if (!missingTexture) {
        const size = 8;
        const data = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const idx = (y * size + x) * 4;
                const check = ((x >> 2) ^ (y >> 2)) & 1;
                data[idx] = check ? 255 : 0;
                data[idx + 1] = 0;
                data[idx + 2] = check ? 255 : 0;
                data[idx + 3] = 255;
            }
        }
        missingTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
        missingTexture.name = 'missing';
        missingTexture.matrix = new THREE.Matrix3();
        missingTexture.wrapS = THREE.RepeatWrapping;
        missingTexture.wrapT = THREE.RepeatWrapping;
        missingTexture.magFilter = THREE.NearestFilter;
        missingTexture.minFilter = THREE.NearestFilter;
        missingTexture.needsUpdate = true;
    }
    return missingTexture;
}

export async function loadTexture(vfs: VirtualFileSystem, path: string): Promise<THREE.Texture | null> {
    if (!path || path === '$whiteimage' || path === '*white') {
        return getWhiteTexture();
    }
    if (path === '$lightmap') {
        return null;
    }

    const lowerPath = path.toLowerCase();
    if (textureCache.has(lowerPath)) {
        return textureCache.get(lowerPath)!;
    }
    if (pendingLoads.has(lowerPath)) {
        return pendingLoads.get(lowerPath)!;
    }

    const promise = (async () => {
        const res = await vfs.findTexture(path);
        if (!res) {
            textureCache.set(lowerPath, null);
            return null;
        }

        let texture: THREE.Texture | null = null;
        if (res.extension === '.tga') {
            const parsed = tgaLoader.parse(res.buffer) as any;
            // Three.js r183+ TGALoader.parse() returns a plain object
            // { data: Uint8Array, width, height } instead of a DataTexture.
            if (parsed.data && parsed.width && parsed.height) {
                texture = new THREE.DataTexture(
                    parsed.data,
                    parsed.width,
                    parsed.height,
                    THREE.RGBAFormat,
                    THREE.UnsignedByteType
                );
                texture.flipY = false;
                texture.generateMipmaps = true;
                texture.minFilter = THREE.LinearMipmapLinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.needsUpdate = true;
            } else if (parsed instanceof THREE.Texture) {
                // Older Three.js returned a Texture directly
                texture = parsed;
                const img = (texture as THREE.DataTexture).image as { data: Uint8Array; width: number; height: number };
                if (img?.data) {
                    texture.flipY = false;
                }
            }
        } else {
            const blob = new Blob([res.buffer]);
            const url = URL.createObjectURL(blob);
            texture = await texLoader.loadAsync(url);
            // Match Q3 convention: V=0 = image top.  With flipY=false the
            // first image row (top) goes to texture-bottom (V=0).
            texture.flipY = false;
            URL.revokeObjectURL(url);
        }

        if (texture) {
            texture.name = path;
            if (!texture.matrix) texture.matrix = new THREE.Matrix3();
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            // Don't set SRGBColorSpace - Q3/MOHAA does all math in gamma space
            texture.channel = 0;
        }
        textureCache.set(lowerPath, texture);
        return texture;
    })();

    pendingLoads.set(lowerPath, promise);
    return promise;
}

// Map Q3 blend constants to Three.js
function mapBlendFactor(factor: string): THREE.BlendingDstFactor {
    switch (factor.toLowerCase()) {
        case 'gl_zero': return THREE.ZeroFactor;
        case 'gl_one': return THREE.OneFactor;
        case 'gl_src_color': return THREE.SrcColorFactor;
        case 'gl_one_minus_src_color': return THREE.OneMinusSrcColorFactor;
        case 'gl_dst_color': return THREE.DstColorFactor;
        case 'gl_one_minus_dst_color': return THREE.OneMinusDstColorFactor;
        case 'gl_src_alpha': return THREE.SrcAlphaFactor;
        case 'gl_one_minus_src_alpha': return THREE.OneMinusSrcAlphaFactor;
        case 'gl_dst_alpha': return THREE.DstAlphaFactor;
        case 'gl_one_minus_dst_alpha': return THREE.OneMinusDstAlphaFactor;
        default: return THREE.OneFactor;
    }
}

export interface Q3Material {
    material: THREE.Material;
    animated: boolean;
    update?: (time: number) => void;
    renderOrder?: number;
}

// Q3 sort values mapped to Three.js render order
function getSortOrder(shader: ParsedShader | undefined): number {
    if (!shader) return 0;
    if (shader.sort !== undefined) {
        const sortMap: Record<string, number> = {
            portal: -1, sky: 0, opaque: 0, decal: 1, seethrough: 2,
            banner: 3, underwater: 4, additive: 5, nearest: 6,
        };
        if (typeof shader.sort === 'string' && shader.sort in sortMap) {
            return sortMap[shader.sort];
        }
        if (typeof shader.sort === 'number') return shader.sort;
        const parsed = parseInt(shader.sort as string, 10);
        if (!isNaN(parsed)) return parsed;
    }
    return 0;
}

// Determine if a shader is transparent
// Check all non-lightmap stages for blend modes that require transparency
function isTransparent(shader: ParsedShader): boolean {
    for (const stage of shader.stages) {
        // Skip lightmap-only stages
        if (stage.map && stage.map.toLowerCase() === '$lightmap' && !stage.map2) continue;
        if (stage.map2 && stage.map2.toLowerCase() === '$lightmap' && !stage.map) continue;
        if (stage.blendFunc) {
            if (typeof stage.blendFunc === 'string') {
                if (stage.blendFunc === 'blend' || stage.blendFunc === 'add') return true;
            } else {
                const src = stage.blendFunc.src;
                const dst = stage.blendFunc.dst;
                if (src === 'gl_src_alpha' || dst === 'gl_one_minus_src_alpha' ||
                    dst === 'gl_one' || src === 'gl_one_minus_src_alpha') return true;
            }
        }
    }
    if (shader.surfaceparms.includes('trans') || shader.surfaceparms.includes('glass')) return true;
    return false;
}

type AlphaMode = 'opaque' | 'cutout' | 'blend' | 'auto';

function hasBlendTransparency(stage: ShaderStage | null): boolean {
    if (!stage?.blendFunc) return false;
    if (typeof stage.blendFunc === 'string') {
        return stage.blendFunc === 'blend' || stage.blendFunc === 'add';
    }
    const src = stage.blendFunc.src;
    const dst = stage.blendFunc.dst;
    return src === 'gl_src_alpha' || src === 'gl_one_minus_src_alpha' ||
        dst === 'gl_src_alpha' || dst === 'gl_one_minus_src_alpha' ||
        dst === 'gl_one';
}

function chooseInitialAlphaMode(shader: ParsedShader, stage: ShaderStage | null): AlphaMode {
    if (stage?.alphaFunc) return 'cutout';
    if (hasBlendTransparency(stage)) return 'blend';
    if (shader.surfaceparms.includes('glass')) return 'blend';
    if (shader.surfaceparms.includes('trans')) return 'auto';
    return 'opaque';
}

function inferAlphaModeFromTexture(tex: THREE.Texture): AlphaMode {
    if (!(tex instanceof THREE.DataTexture) || !tex.image?.data) {
        // For non-data textures we can't inspect pixels here; prefer blend safety.
        return 'blend';
    }

    const data = tex.image.data as Uint8Array;
    if (data.length < 4 || (data.length & 3) !== 0) return 'blend';

    let transparentPixels = 0;
    let softPixels = 0;
    let hasAnyAlpha = false;
    const totalPixels = data.length >> 2;

    for (let i = 3; i < data.length; i += 4) {
        const a = data[i];
        if (a < 250) {
            hasAnyAlpha = true;
            if (a <= 8) transparentPixels++;
            else if (a < 247) softPixels++;
        }
    }

    if (!hasAnyAlpha) return 'opaque';

    // Binary-ish alpha masks (fences, foliage) should use cutout.
    if (softPixels / totalPixels < 0.02 && transparentPixels > 0) {
        return 'cutout';
    }

    return 'blend';
}

function applyAlphaModeToMaterial(mat: THREE.MeshBasicMaterial, mode: AlphaMode) {
    if (mode === 'cutout') {
        if (mat.alphaTest < 0.5) mat.alphaTest = 0.5;
        mat.transparent = false;
        mat.depthWrite = true;
        return;
    }

    if (mode === 'blend') {
        mat.transparent = true;
        if (mat.alphaTest > 0 && mat.alphaTest < 0.01) mat.alphaTest = 0.01;
        mat.depthWrite = false;
        return;
    }

    // Opaque
    mat.transparent = false;
    mat.alphaTest = 0;
    mat.depthWrite = true;
}

function isNodraw(shader: ParsedShader): boolean {
    return shader.surfaceparms.includes('nodraw') && !shader.surfaceparms.includes('playerclip');
}

function getCullSide(shader: ParsedShader): THREE.Side {
    const cull = shader.cull?.toLowerCase();
    if (cull === 'none' || cull === 'disable' || cull === 'twosided') return THREE.DoubleSide;
    if (cull === 'front') return THREE.BackSide;
    if (cull === 'back') return THREE.FrontSide;
    // Default: Q3 culls back faces. Use DoubleSide for viewer convenience
    // (allows seeing geometry from inside rooms without winding concerns).
    return THREE.DoubleSide;
}

// Find the primary diffuse stage - the first non-lightmap stage that has actual
// surface texture. Prefers stages with explicit map over environment/reflection
// stages (tcGen environment) since env stages are overlays, not primary surface.
// With nextbundle support: if stage.map is the diffuse and stage.map2 is $lightmap,
// the stage IS the diffuse stage.
function findDiffuseStage(shader: ParsedShader): ShaderStage | null {
    let envFallback: ShaderStage | null = null;
    for (const stage of shader.stages) {
        // nextbundle: map is diffuse, map2 is lightmap - always definitive diffuse
        if (stage.map && stage.map2 && stage.map2.toLowerCase() === '$lightmap') {
            return stage;
        }
        if (stage.animMap) {
            return stage;
        }
        if (stage.map && stage.map.toLowerCase() !== '$lightmap') {
            // Skip environment/reflection stages as diffuse (they have no base texture).
            // MOHAA vehicles use tcGen environmentmodel for reflections overlaid
            // with the actual body texture in a later stage.
            const tcg = stage.tcGen?.toLowerCase() || '';
            const isEnvStage = tcg === 'environment' || tcg === 'environmentmodel';
            if (isEnvStage) {
                // Keep as fallback only if nothing else found
                if (!envFallback) envFallback = stage;
                continue;
            }
            return stage;
        }
    }
    return envFallback;
}

// Find an environment overlay stage (env stage that was NOT selected as diffuse).
// Vehicle shaders use tcGen environment/environmentmodel for reflection overlays
// rendered beneath the body texture, blended via the body's alpha channel.
function findEnvOverlayStage(shader: ParsedShader, diffuseStage: ShaderStage | null): ShaderStage | null {
    for (const stage of shader.stages) {
        if (stage === diffuseStage) continue;
        const tcg = stage.tcGen?.toLowerCase() || '';
        if ((tcg === 'environment' || tcg === 'environmentmodel') && stage.map) {
            return stage;
        }
    }
    return null;
}

// Check if the shader uses a lightmap (either as a separate stage or via nextbundle)
function hasLightmapStage(shader: ParsedShader): boolean {
    return shader.stages.some(s =>
        (s.map && s.map.toLowerCase() === '$lightmap') ||
        (s.map2 && s.map2.toLowerCase() === '$lightmap')
    );
}

// Determine rgbGen mode for a stage
function getRgbGenMode(stage: ShaderStage | null): string {
    if (!stage || !stage.rgbGen) return 'identity';
    if (typeof stage.rgbGen === 'string') return stage.rgbGen;
    return stage.rgbGen.type;
}

// Should vertex colors be used for this material?
function shouldUseVertexColors(shader: ParsedShader | undefined, hasLightmap: boolean): boolean {
    if (!shader) {
        // No shader definition - use vertex colors only if no lightmap
        return !hasLightmap;
    }

    // Check all stages for rgbGen vertex
    for (const stage of shader.stages) {
        const rgbGen = getRgbGenMode(stage);
        if (rgbGen === 'vertex' || rgbGen === 'exactvertex' ||
            rgbGen === 'oneminusvertex') {
            return true;
        }
    }

    // No lightmap means vertex colors provide lighting
    if (!hasLightmap && !hasLightmapStage(shader)) {
        return true;
    }

    return false;
}

export interface CreateMaterialOptions {
    vfs: VirtualFileSystem;
    shaderName: string;
    parsedShader: ParsedShader | undefined;
    lightmapTexture: THREE.Texture | null;
    vertexColors?: boolean;
    forceRepeatWrap?: boolean;
}

// All Q3 wave functions approximated with sin() for GLSL injection simplicity.
// The visual difference is negligible for vertex deformation.
function getWaveGlsl(_func: string): string {
    return 'sin';
}

// Track cull mode usage for debugging
const cullStats: Record<string, number> = {};
let cullStatsLogged = false;

export function logCullStats() {
    if (!cullStatsLogged && Object.keys(cullStats).length > 0) {
        console.log('Shader cull modes:', cullStats);
        cullStatsLogged = true;
    }
}

export function createQ3Material(opts: CreateMaterialOptions): Q3Material {
    const { vfs, shaderName, parsedShader, lightmapTexture, vertexColors, forceRepeatWrap } = opts;

    // No shader definition found - create a simple textured material
    if (!parsedShader) {
        return createSimpleMaterial(vfs, shaderName, lightmapTexture, vertexColors);
    }

    // Track cull usage
    const cullKey = parsedShader.cull || '(default)';
    cullStats[cullKey] = (cullStats[cullKey] || 0) + 1;

    // Skip nodraw shaders
    if (isNodraw(parsedShader)) {
        const mat = new THREE.MeshBasicMaterial({ visible: false });
        return { material: mat, animated: false };
    }

    // Sky shader
    if (parsedShader.surfaceparms.includes('sky') || parsedShader.skyParms) {
        return createSkyMaterial(vfs, parsedShader);
    }

    const transparent = isTransparent(parsedShader);
    const side = getCullSide(parsedShader);
    const diffuseStage = findDiffuseStage(parsedShader);
    const noLightmap = parsedShader.surfaceparms.includes('nolightmap');
    // In Q3/MOHAA, the renderer always multiplies the lightmap onto surfaces that have one,
    // regardless of whether the shader explicitly references $lightmap in its stages.
    const useLightmap = !noLightmap && !!lightmapTexture;
    const useVertexColors = shouldUseVertexColors(parsedShader, !!useLightmap);

    // Handle animated textures
    if (diffuseStage?.animMap) {
        return createAnimatedMaterial(vfs, parsedShader, diffuseStage, lightmapTexture, transparent, side, useVertexColors);
    }

    // Determine blend mode from diffuse stage
    let blending: THREE.Blending = THREE.NormalBlending;
    let blendSrc: THREE.BlendingDstFactor = THREE.SrcAlphaFactor;
    let blendDst: THREE.BlendingDstFactor = THREE.OneMinusSrcAlphaFactor;
    let alphaTest = 0;
    let depthWrite = !transparent;
    const alphaMode = chooseInitialAlphaMode(parsedShader, diffuseStage);

    if (diffuseStage) {
        if (diffuseStage.alphaFunc) {
            const func = diffuseStage.alphaFunc.func;
            if (func === 'gt0') alphaTest = 0.01;
            else if (func === 'ge128') alphaTest = 0.5;
            else if (func === 'ge192') alphaTest = 0.75;
            else alphaTest = 0.5;
            depthWrite = true;
        }

        if (diffuseStage.blendFunc) {
            if (typeof diffuseStage.blendFunc === 'string') {
                if (diffuseStage.blendFunc === 'add') {
                    blending = THREE.AdditiveBlending;
                    depthWrite = false;
                } else if (diffuseStage.blendFunc === 'filter') {
                    blending = THREE.MultiplyBlending;
                    depthWrite = false;
                } else if (diffuseStage.blendFunc === 'blend') {
                    blending = THREE.NormalBlending;
                }
            } else {
                const src = diffuseStage.blendFunc.src;
                const dst = diffuseStage.blendFunc.dst;

                if (src === 'gl_one' && dst === 'gl_one') {
                    blending = THREE.AdditiveBlending;
                    depthWrite = false;
                } else if (src === 'gl_dst_color' && dst === 'gl_zero') {
                    // Modulate - this is the lightmap multiply blend
                    // We handle this via Three.js lightMap, so use normal blending
                    blending = THREE.NormalBlending;
                } else if (src === 'gl_zero' && dst === 'gl_src_color') {
                    // Inverse modulate
                    blending = THREE.MultiplyBlending;
                    depthWrite = false;
                } else {
                    blending = THREE.CustomBlending;
                    blendSrc = mapBlendFactor(src);
                    blendDst = mapBlendFactor(dst);
                }
            }
        }
    }

    const matOpts: any = {
        color: 0xffffff,
        side,
        transparent: alphaMode === 'blend' || blending === THREE.CustomBlending,
        alphaTest: alphaTest > 0 ? alphaTest : 0,
        depthWrite,
        blending: blending,
        polygonOffset: parsedShader.polygonOffset || false,
        polygonOffsetFactor: parsedShader.polygonOffset ? -1 : 0,
        polygonOffsetUnits: parsedShader.polygonOffset ? -1 : 0,
        vertexColors: useVertexColors,
    };

    if (blending === THREE.CustomBlending) {
        matOpts.blendSrc = blendSrc;
        matOpts.blendDst = blendDst;
    }

    const mat = new THREE.MeshBasicMaterial(matOpts);

    // For cutout shaders we want hard alpha reject, not blended transparency.
    if (alphaMode === 'cutout') {
        applyAlphaModeToMaterial(mat, 'cutout');
    }

    if (useLightmap && lightmapTexture) {
        mat.lightMap = lightmapTexture;
        mat.lightMapIntensity = 1.0; // Overbright already baked into lightmap data
    }

    // Apply rgbGen constant color
    if (diffuseStage?.rgbGen && typeof diffuseStage.rgbGen !== 'string' && diffuseStage.rgbGen.type === 'constant') {
        const args = diffuseStage.rgbGen.args;
        mat.color.setRGB(args[0], args[1], args[2]);
    }

    // Apply alphaGen constant
    if (diffuseStage?.alphaGen && typeof diffuseStage.alphaGen !== 'string' && diffuseStage.alphaGen.type === 'constant') {
        mat.opacity = diffuseStage.alphaGen.args[0];
        mat.transparent = true;
    }

    // Apply deformVertexes via onBeforeCompile (vertex shader injection)
    const timeUniform = { value: 0.0 };
    const hasDeform = parsedShader.deformVertexes && parsedShader.deformVertexes.length > 0;
    const hasTcGenEnv = diffuseStage?.tcGen === 'environment' || diffuseStage?.tcGen === 'environmentmodel';

    // Find environment overlay: an env/environmentmodel stage separate from the diffuse.
    // Vehicle shaders use stage 0 as reflection (env) and stage 1 as body texture (diffuse).
    // In Q3, stage 0 renders first (env reflection), then stage 1 renders on top (body)
    // with its blendFunc compositing via the GPU framebuffer blend.
    const envOverlayStage = findEnvOverlayStage(parsedShader, diffuseStage);
    const envMapUniform: { value: THREE.Texture } | null = envOverlayStage ? { value: getWhiteTexture() } : null;
    // Flag to skip blending until the env texture actually loads (avoids white placeholder artifacts)
    const envReadyUniform: { value: number } | null = envOverlayStage ? { value: 0.0 } : null;
    if (envOverlayStage?.map) {
        loadTexture(vfs, envOverlayStage.map).then(tex => {
            if (tex && envMapUniform && envReadyUniform) {
                envMapUniform.value = tex;
                envReadyUniform.value = 1.0;
                mat.needsUpdate = true;
            }
        });
    }
    // Compute env stage alpha from alphaGen (e.g. alphaGen constant 0.05 for car windows)
    let envAlpha = 1.0;
    if (envOverlayStage?.alphaGen && typeof envOverlayStage.alphaGen !== 'string' &&
        envOverlayStage.alphaGen.type === 'constant') {
        envAlpha = envOverlayStage.alphaGen.args[0];
    }
    // Only force opaque if the env stage has NO blendFunc (opaque first pass in Q3).
    // If the env stage has blendFunc (e.g. car windows), both stages are transparent.
    if (envOverlayStage && !envOverlayStage.blendFunc) {
        mat.blending = THREE.NormalBlending;
        mat.transparent = false;
        mat.depthWrite = true;
    }

    // Load diffuse texture
    // For tcGen environment or deformVertexes, set a placeholder texture first so
    // USE_MAP is active when the shader compiles (needed for vMapUv to exist)
    if (diffuseStage?.map) {
        const mapPath = diffuseStage.map;
        if (mapPath.toLowerCase() !== '$lightmap' && mapPath.toLowerCase() !== '$whiteimage') {
            // Keep USE_MAP uniform path stable while the real texture loads.
            mat.map = getWhiteTexture();
            loadTexture(vfs, mapPath).then(tex => {
                if (tex) {
                    // Clone the texture before applying static tcMod transforms so we
                    // don't mutate the shared cached texture used by other materials.
                    const hasStaticTcMod = diffuseStage.tcMod?.some(
                        m => m.type === 'scale' || m.type === 'transform'
                    );
                    const finalTex = hasStaticTcMod ? tex.clone() : tex;
                    applyStaticTcMod(finalTex, diffuseStage);
                    if (diffuseStage.clamp && !forceRepeatWrap) {
                        finalTex.wrapS = THREE.ClampToEdgeWrapping;
                        finalTex.wrapT = THREE.ClampToEdgeWrapping;
                    }
                    mat.map = finalTex;
                    if (alphaMode === 'auto') {
                        applyAlphaModeToMaterial(mat, inferAlphaModeFromTexture(finalTex));
                    }
                    mat.needsUpdate = true;
                }
            });
        } else if (mapPath.toLowerCase() === '$whiteimage') {
            mat.map = getWhiteTexture();
        }
    } else if (!diffuseStage) {
        // No diffuse stage - keep a stable placeholder while loading fallback texture.
        mat.map = getWhiteTexture();
        loadTexture(vfs, shaderName).then(tex => {
            if (tex) {
                mat.map = tex;
                if (alphaMode === 'auto') {
                    applyAlphaModeToMaterial(mat, inferAlphaModeFromTexture(tex));
                }
                mat.needsUpdate = true;
            }
        });
    }

    if (hasDeform || hasTcGenEnv || envOverlayStage) {
        mat.onBeforeCompile = (shader) => {
            shader.uniforms.uTime = timeUniform;
            let vertexPreamble = 'uniform float uTime;\n';
            let fragmentPreamble = '';
            if (envOverlayStage && envMapUniform) {
                shader.uniforms.uEnvMap = envMapUniform;
                shader.uniforms.uEnvReady = envReadyUniform!;
                vertexPreamble += 'varying vec2 vEnvUv;\n';
                fragmentPreamble += 'uniform sampler2D uEnvMap;\nuniform float uEnvReady;\nvarying vec2 vEnvUv;\n';
            }
            shader.vertexShader = vertexPreamble + shader.vertexShader;
            if (fragmentPreamble) {
                shader.fragmentShader = fragmentPreamble + shader.fragmentShader;
            }

            // Inject deformVertexes into vertex shader
            // Note: MeshBasicMaterial doesn't have objectNormal by default,
            // so we read the 'normal' attribute directly
            if (hasDeform) {
                let deformCode = '';
                for (const deform of parsedShader.deformVertexes!) {
                    if (deform.type === 'wave' || deform.type === 'flap') {
                        const spread = deform.spread || 0;
                        const base = deform.base || 0;
                        const amp = deform.amplitude || 0;
                        const phase = deform.phase || 0;
                        const freq = deform.frequency || 0;
                        const waveGlsl = getWaveGlsl(deform.waveFunc || 'sin');
                        deformCode += `{
                            float off = (position.x + position.y + position.z) * ${spread.toFixed(6)};
                            float t = ${base.toFixed(6)} + ${amp.toFixed(6)} * ${waveGlsl}((off + ${phase.toFixed(6)} + uTime * ${freq.toFixed(6)}) * 6.283185);
                            transformed += normal * t;
                        }\n`;
                    } else if (deform.type === 'bulge') {
                        const w = deform.bulgeWidth || 1;
                        const h = deform.bulgeHeight || 0;
                        const s = deform.bulgeSpeed || 1;
                        deformCode += `{
                            float bulgeT = uv.x * ${w.toFixed(6)} + uTime * ${s.toFixed(6)};
                            float bulgeOff = sin(bulgeT) * ${h.toFixed(6)};
                            transformed += normal * bulgeOff;
                        }\n`;
                    } else if (deform.type === 'move') {
                        const mv = deform.moveVector || [0, 0, 0];
                        const base = deform.base || 0;
                        const amp = deform.amplitude || 0;
                        const phase = deform.phase || 0;
                        const freq = deform.frequency || 0;
                        const waveGlsl = getWaveGlsl(deform.waveFunc || 'sin');
                        deformCode += `{
                            float moveScale = ${base.toFixed(6)} + ${amp.toFixed(6)} * ${waveGlsl}((${phase.toFixed(6)} + uTime * ${freq.toFixed(6)}) * 6.283185);
                            transformed += vec3(${mv[0].toFixed(6)}, ${mv[1].toFixed(6)}, ${mv[2].toFixed(6)}) * moveScale;
                        }\n`;
                    }
                }

                if (deformCode) {
                    shader.vertexShader = shader.vertexShader.replace(
                        '#include <begin_vertex>',
                        '#include <begin_vertex>\n' + deformCode
                    );
                }
            }

            // Inject tcGen environment: compute UVs from view-reflected normals
            // We use modelViewMatrix (always available) and normalize in view space
            if (hasTcGenEnv) {
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <uv_vertex>',
                    `#include <uv_vertex>
                    {
                        vec3 viewNormal = normalize(mat3(modelViewMatrix) * normal);
                        vMapUv = vec2(0.5 + viewNormal.x * 0.5, 0.5 + viewNormal.y * 0.5);
                    }`
                );
            }

            // Inject env overlay: compute separate env UVs and blend in fragment shader.
            // environmentmodel uses viewer direction when the normal faces the camera,
            // reflection otherwise. Standard environment always reflects.
            if (envOverlayStage) {
                const isEnvModel = envOverlayStage.tcGen?.toLowerCase() === 'environmentmodel';
                const envUvCode = isEnvModel
                    ? `{
                        vec3 eViewDir = normalize(-mvPosition.xyz);
                        vec3 eNorm = normalize(normalMatrix * normal);
                        float eD = dot(eNorm, eViewDir);
                        vec3 eRefl = eD > 0.0 ? eViewDir : eNorm * (-2.0 * eD) + eViewDir;
                        vEnvUv = vec2(0.5 + eRefl.x * 0.5, 0.5 - eRefl.y * 0.5);
                    }`
                    : `{
                        vec3 eViewDir = normalize(mvPosition.xyz);
                        vec3 eNorm = normalize(normalMatrix * normal);
                        vec3 eRefl = reflect(eViewDir, eNorm);
                        vEnvUv = vec2(0.5 + eRefl.x * 0.5, 0.5 - eRefl.y * 0.5);
                    }`;
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <project_vertex>',
                    '#include <project_vertex>\n' + envUvCode
                );

                // Fragment: blend env overlay with body texture following Q3 multi-pass order.
                // In Q3, stage 0 (env) renders first, then stage 1 (body) renders on top.
                // The body stage's blendFunc(srcFactor, dstFactor) composites:
                //   output = body * srcFactor + framebuffer(env) * dstFactor
                // We also apply the env stage's alphaGen (e.g. constant 0.05 for windows).
                // A uEnvReady flag prevents blending with the white placeholder texture.
                const bf = diffuseStage?.blendFunc;
                const isInverseAlpha = bf && typeof bf !== 'string' &&
                    bf.src === 'gl_one_minus_src_alpha' && bf.dst === 'gl_src_alpha';
                const envAlphaLiteral = envAlpha.toFixed(6);
                // Determine if env stage was opaque (no blendFunc → opaque first pass)
                const envIsOpaque = !envOverlayStage.blendFunc;
                let blendGlsl: string;
                if (isInverseAlpha) {
                    // blendFunc(ONE_MINUS_SRC_ALPHA, SRC_ALPHA):
                    //   output = body*(1-body.a) + env*body.a
                    blendGlsl = `{
                        if (uEnvReady > 0.5) {
                            vec4 envC = texture2D(uEnvMap, vEnvUv);
                            #ifdef USE_COLOR
                                envC.rgb *= vColor.rgb;
                            #endif
                            diffuseColor.rgb = diffuseColor.rgb * (1.0 - diffuseColor.a) + envC.rgb * ${envAlphaLiteral} * diffuseColor.a;
                        }
                        diffuseColor.a = 1.0;
                    }`;
                } else if (envIsOpaque) {
                    // blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA) with opaque env backdrop:
                    //   output = body*body.a + env*(1-body.a), opaque result
                    blendGlsl = `{
                        if (uEnvReady > 0.5) {
                            vec4 envC = texture2D(uEnvMap, vEnvUv);
                            #ifdef USE_COLOR
                                envC.rgb *= vColor.rgb;
                            #endif
                            diffuseColor.rgb = diffuseColor.rgb * diffuseColor.a + envC.rgb * ${envAlphaLiteral} * (1.0 - diffuseColor.a);
                        }
                        diffuseColor.a = 1.0;
                    }`;
                } else {
                    // Both stages transparent (e.g. car windows).
                    // Q3: stage 0 blends env*envAlpha onto background, stage 1 blends body on top.
                    //   result.rgb = body*body.a + env*envAlpha*(1-body.a)
                    //   result.a = body.a + envAlpha*(1-body.a)
                    blendGlsl = `{
                        if (uEnvReady > 0.5) {
                            vec4 envC = texture2D(uEnvMap, vEnvUv);
                            #ifdef USE_COLOR
                                envC.rgb *= vColor.rgb;
                            #endif
                            float eA = ${envAlphaLiteral};
                            float bodyA = diffuseColor.a;
                            diffuseColor.rgb = diffuseColor.rgb * bodyA + envC.rgb * eA * (1.0 - bodyA);
                            diffuseColor.a = bodyA + eA * (1.0 - bodyA);
                        }
                    }`;
                }
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <map_fragment>',
                    '#include <map_fragment>\n' + blendGlsl
                );
            }
        };
    }

    // Check for rgbGen wave (pulsing color effect)
    const hasRgbGenWave = diffuseStage?.rgbGen && typeof diffuseStage.rgbGen !== 'string' &&
        (diffuseStage.rgbGen.type === 'wave' || diffuseStage.rgbGen.type === 'colorwave');
    // Check for alphaGen wave
    const hasAlphaGenWave = diffuseStage?.alphaGen && typeof diffuseStage.alphaGen !== 'string' &&
        diffuseStage.alphaGen.type === 'wave';

    // Handle tcMod scroll/rotate/turb animation + rgbGen/alphaGen wave
    let updateFn: ((time: number) => void) | undefined;
    const needsTimeUpdate = hasDeform || hasTcGenEnv || hasRgbGenWave || hasAlphaGenWave;

    const tcMods = diffuseStage?.tcMod && diffuseStage.tcMod.length > 0 ? diffuseStage.tcMod : null;
    const hasAnimatedTcMod = tcMods ? tcMods.some(m => m.type === 'scroll' || m.type === 'rotate' || m.type === 'turb') : false;

    if (hasAnimatedTcMod || needsTimeUpdate) {
        updateFn = (time: number) => {
            timeUniform.value = time;

            // rgbGen wave: base + amp * sin(phase + time * freq)
            if (hasRgbGenWave && diffuseStage?.rgbGen && typeof diffuseStage.rgbGen !== 'string') {
                const args = diffuseStage.rgbGen.args;
                if (diffuseStage.rgbGen.type === 'wave') {
                    // args: [func, base, amp, phase, freq]
                    const base = args[1] as number;
                    const amp = args[2] as number;
                    const phase = args[3] as number;
                    const freq = args[4] as number;
                    const v = Math.max(0, Math.min(1, base + amp * Math.sin((phase + time * freq) * Math.PI * 2)));
                    mat.color.setRGB(v, v, v);
                } else if (diffuseStage.rgbGen.type === 'colorwave') {
                    // args: [r, g, b, func, base, amp, phase, freq]
                    const r = args[0] as number;
                    const g = args[1] as number;
                    const b = args[2] as number;
                    const base = args[4] as number;
                    const amp = args[5] as number;
                    const phase = args[6] as number;
                    const freq = args[7] as number;
                    const v = Math.max(0, Math.min(1, base + amp * Math.sin((phase + time * freq) * Math.PI * 2)));
                    mat.color.setRGB(r * v, g * v, b * v);
                }
            }

            // alphaGen wave
            if (hasAlphaGenWave && diffuseStage?.alphaGen && typeof diffuseStage.alphaGen !== 'string') {
                const args = diffuseStage.alphaGen.args;
                // args: [func, base, amp, phase, freq]
                const base = args[1] as number;
                const amp = args[2] as number;
                const phase = args[3] as number;
                const freq = args[4] as number;
                mat.opacity = Math.max(0, Math.min(1, base + amp * Math.sin((phase + time * freq) * Math.PI * 2)));
            }

            // tcMod animations
            if (tcMods && mat.map) {
                mat.map.offset.set(0, 0);
                mat.map.repeat.set(1, 1);
                mat.map.rotation = 0;

                for (const mod of tcMods) {
                    if (mod.type === 'scroll') {
                        mat.map.offset.x += mod.args[0] * time;
                        mat.map.offset.y += mod.args[1] * time;
                    } else if (mod.type === 'scale') {
                        mat.map.repeat.x *= mod.args[0];
                        mat.map.repeat.y *= mod.args[1];
                    } else if (mod.type === 'rotate') {
                        mat.map.rotation += (mod.args[0] * time * Math.PI) / 180;
                    } else if (mod.type === 'turb') {
                        const amp = mod.args[1] || 0.05;
                        const freq = mod.args[3] || 1;
                        mat.map.offset.x += Math.sin(time * freq * Math.PI * 2) * amp;
                        mat.map.offset.y += Math.cos(time * freq * Math.PI * 2) * amp;
                    }
                }
                mat.map.updateMatrix();
            }
        };
    }

    // Check for additional overlay stages (detail textures, glow, etc.)
    const additionalMaterials = createOverlayStages(vfs, parsedShader, diffuseStage, lightmapTexture, side, useVertexColors);

    const sortOrder = getSortOrder(parsedShader);

    return {
        material: mat,
        animated: !!updateFn || additionalMaterials.length > 0,
        update: updateFn,
        renderOrder: sortOrder,
    };
}

// Create overlay materials for multi-pass stages
// Returns materials that should be rendered on separate geometries overlapping the base
function createOverlayStages(
    vfs: VirtualFileSystem,
    shader: ParsedShader,
    diffuseStage: ShaderStage | null,
    lightmapTexture: THREE.Texture | null,
    side: THREE.Side,
    useVertexColors: boolean
): Q3Material[] {
    // For now, we don't create separate overlay meshes
    // This would require the BSP parser to create duplicate geometry
    // TODO: Implement multi-pass rendering for detail textures and glow
    return [];
}

function applyStaticTcMod(tex: THREE.Texture, stage: ShaderStage) {
    if (stage.tcMod) {
        for (const mod of stage.tcMod) {
            if (mod.type === 'scale') {
                tex.repeat.set(mod.args[0], mod.args[1]);
            }
        }
    }
}

function createSimpleMaterial(
    vfs: VirtualFileSystem,
    shaderName: string,
    lightmapTexture: THREE.Texture | null,
    vertexColors?: boolean
): Q3Material {
    // Use vertex colors when there's no lightmap (they contain baked lighting)
    const useVertexColors = !lightmapTexture && !!vertexColors;

    const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.FrontSide, // Q3 default culling
        vertexColors: useVertexColors,
    });

    // Keep map uniform path stable before async texture load completes.
    mat.map = getWhiteTexture();

    if (lightmapTexture) {
        mat.lightMap = lightmapTexture;
        mat.lightMapIntensity = 1.0; // Overbright already baked into lightmap data
    }

    // Try to load texture by shader name
    loadTexture(vfs, shaderName).then(tex => {
        if (tex) {
            mat.map = tex;
            mat.needsUpdate = true;
        }
    });

    return { material: mat, animated: false };
}

function createSkyMaterial(_vfs: VirtualFileSystem, _shader: ParsedShader): Q3Material {
    // Sky surfaces in BSP are portals to the skybox cubemap.
    // Make them invisible - the scene.background cubemap handles the sky.
    // We still render them with colorWrite=false so they write to depth buffer,
    // preventing objects behind sky from rendering.
    const mat = new THREE.MeshBasicMaterial({
        visible: true,
        colorWrite: false,
        depthWrite: true,
        side: THREE.FrontSide, // Q3 default culling
    });

    return { material: mat, animated: false };
}

function createAnimatedMaterial(
    vfs: VirtualFileSystem,
    shader: ParsedShader,
    stage: ShaderStage,
    lightmapTexture: THREE.Texture | null,
    transparent: boolean,
    side: THREE.Side,
    useVertexColors: boolean
): Q3Material {
    const animMap = stage.animMap!;
    const textures: (THREE.Texture | null)[] = [];
    let loaded = false;

    let alphaTest = 0;
    if (stage.alphaFunc) {
        const func = stage.alphaFunc.func;
        if (func === 'gt0') alphaTest = 0.01;
        else if (func === 'ge128') alphaTest = 0.5;
        else if (func === 'ge192') alphaTest = 0.75;
        else alphaTest = 0.5;
    }

    const alphaMode = chooseInitialAlphaMode(shader, stage);
    const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side,
        transparent: alphaMode === 'blend' || transparent,
        depthWrite: alphaTest > 0 ? true : !transparent,
        alphaTest,
        vertexColors: useVertexColors,
    });

    if (alphaMode === 'cutout') {
        applyAlphaModeToMaterial(mat, 'cutout');
    }

    if (lightmapTexture) {
        mat.lightMap = lightmapTexture;
        mat.lightMapIntensity = 1.0; // Overbright already baked into lightmap data
    }

    // Load all animation frames
    Promise.all(animMap.maps.map(m => loadTexture(vfs, m))).then(results => {
        for (const tex of results) {
            textures.push(tex);
        }
        if (textures.length > 0 && textures[0]) {
            mat.map = textures[0];
            if (alphaMode === 'auto') {
                applyAlphaModeToMaterial(mat, inferAlphaModeFromTexture(textures[0]));
            }
            mat.needsUpdate = true;
        }
        loaded = true;
    });

    const update = (time: number) => {
        if (!loaded || textures.length === 0) return;
        const freq = animMap.frequency || 1;
        const frame = Math.floor(time * freq) % textures.length;
        const tex = textures[frame];
        if (tex && mat.map !== tex) {
            mat.map = tex;
            mat.needsUpdate = true;
        }
    };

    return { material: mat, animated: true, update };
}

// Load skybox as a Three.js scene background cubemap
export async function loadSkybox(
    vfs: VirtualFileSystem,
    shaderParser: ShaderParser,
    shaderNames: string[]
): Promise<THREE.CubeTexture | null> {
    // Find a sky shader among the BSP shaders
    let skyShader: ParsedShader | undefined;
    for (const name of shaderNames) {
        const ps = shaderParser.getShader(name);
        if (ps && (ps.surfaceparms.includes('sky') || ps.skyParms)) {
            skyShader = ps;
            break;
        }
    }

    if (!skyShader?.skyParms || skyShader.skyParms.farbox === '-') {
        return null;
    }

    const farbox = skyShader.skyParms.farbox;
    // Three.js CubeTexture face order: [+X, -X, +Y, -Y, +Z, -Z]
    // Q3 Z-up → Three.js Y-up coordinate mapping (rotation x=-PI/2):
    //   Q3 +X → Three.js +X  (face 0 = _rt)
    //   Q3 -X → Three.js -X  (face 1 = _lf)
    //   Q3 +Z → Three.js +Y  (face 2 = _up, needs 90° CCW rotation)
    //   Q3 -Z → Three.js -Y  (face 3 = _dn, needs 90° CW rotation)
    //   Q3 +Y → Three.js +Z  (face 4 = _bk)
    //   Q3 -Y → Three.js -Z  (face 5 = _ft)
    // The _up/_dn face rotations compensate for the axis swap between
    // Q3's st_to_vec encoding and the WebGL cubemap +Y/-Y face convention.
    const suffixes = ['_rt', '_lf', '_up', '_dn', '_bk', '_ft'];

    const faces: THREE.Texture[] = [];
    for (const suffix of suffixes) {
        const tex = await loadTexture(vfs, `${farbox}${suffix}`);
        if (!tex) return null;
        faces.push(tex);
    }

    // Build cubemap from individual face textures
    const cubeTexture = new THREE.CubeTexture();
    const images: any[] = [];

    for (let fi = 0; fi < faces.length; fi++) {
        const face = faces[fi];
        if (!face.image) continue;

        let canvas: HTMLCanvasElement;
        if (face instanceof THREE.DataTexture) {
            canvas = document.createElement('canvas');
            canvas.width = face.image.width;
            canvas.height = face.image.height;
            const ctx = canvas.getContext('2d')!;
            const imgData = ctx.createImageData(canvas.width, canvas.height);
            const src = face.image.data as Uint8Array;
            if (src.length === canvas.width * canvas.height * 3) {
                for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
                    imgData.data[j] = src[i];
                    imgData.data[j + 1] = src[i + 1];
                    imgData.data[j + 2] = src[i + 2];
                    imgData.data[j + 3] = 255;
                }
            } else {
                imgData.data.set(src);
            }
            ctx.putImageData(imgData, 0, 0);
        } else {
            const img = face.image as HTMLImageElement;
            canvas = document.createElement('canvas');
            canvas.width = img.width || img.naturalWidth;
            canvas.height = img.height || img.naturalHeight;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
        }

        // Rotate _up (face 2) 90° CCW and _dn (face 3) 90° CW
        // to compensate for Q3 Z-up → Three.js Y-up axis swap
        if (fi === 2 || fi === 3) {
            const rotated = document.createElement('canvas');
            rotated.width = canvas.width;
            rotated.height = canvas.height;
            const rctx = rotated.getContext('2d')!;
            rctx.translate(canvas.width / 2, canvas.height / 2);
            rctx.rotate(fi === 2 ? -Math.PI / 2 : Math.PI / 2);
            rctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
            canvas = rotated;
        }

        images.push(canvas);
    }

    if (images.length === 6) {
        cubeTexture.images = images;
        cubeTexture.colorSpace = THREE.LinearSRGBColorSpace; // No conversion - gamma-space rendering
        cubeTexture.needsUpdate = true;
        return cubeTexture;
    }

    return null;
}
