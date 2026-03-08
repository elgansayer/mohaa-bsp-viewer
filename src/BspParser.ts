// MOHAA BSP Parser
// Based on openmohaa qfiles.h structs and tr_bsp.c loading code
// Handles: MST_PLANAR, MST_PATCH, MST_TRIANGLE_SOUP, MST_TERRAIN
// + Brush models (submodels), BSP tree, PVS visibility, light grid

import * as THREE from 'three';
import { VirtualFileSystem } from './VirtualFileSystem';
import { ShaderParser } from './ShaderParser';
import { createQ3Material, Q3Material, loadSkybox, logCullStats } from './Q3ShaderMaterial';
import { tessellatePatch, PatchVert } from './BezierPatch';
import { parseTerrainPatches, buildTerrainGeometry } from './TerrainLoader';

// BSP constants
const BSP_IDENT = 0x32313035; // "2015" LE
const HEADER_LUMPS = 28;

// Lump indices (MOHAA BSP v19+)
const LUMP_SHADERS = 0;
const LUMP_PLANES = 1;
const LUMP_LIGHTMAPS = 2;
const LUMP_SURFACES = 3;
const LUMP_DRAWVERTS = 4;
const LUMP_DRAWINDEXES = 5;
const LUMP_LEAFBRUSHES = 6;
const LUMP_LEAFSURFACES = 7;
const LUMP_LEAFS = 8;
const LUMP_NODES = 9;
const LUMP_SIDEEQUATIONS = 10;
const LUMP_BRUSHSIDES = 11;
const LUMP_BRUSHES = 12;
const LUMP_MODELS = 13;
const LUMP_ENTITIES = 14;
const LUMP_VISIBILITY = 15;
const LUMP_LIGHTGRIDPALETTE = 16;
const LUMP_LIGHTGRIDOFFSETS = 17;
const LUMP_LIGHTGRIDDATA = 18;
const LUMP_SPHERELIGHTS = 19;
const LUMP_TERRAIN = 22;
const LUMP_TERRAININDEXES = 23;
const LUMP_STATICMODELDATA = 24;
const LUMP_STATICMODELDEF = 25;
const LUMP_STATICMODELINDEXES = 26;

// Surface types
const MST_BAD = 0;
const MST_PLANAR = 1;
const MST_PATCH = 2;
const MST_TRIANGLE_SOUP = 3;
const MST_FLARE = 4;
const MST_TERRAIN = 5;

// Struct sizes
const SHADER_SIZE = 140;    // char[64] + int + int + int + char[64]
const DRAWVERT_SIZE = 44;   // vec3(12) + st[2](8) + lightmap[2](8) + normal[3](12) + color[4](4)
const DSURFACE_SIZE = 108;  // 7 ints(28) + lightmapNum(4) + lmXY(8) + lmWH(8) + lmOrigin(12) + lmVecs(36) + patchWH(8) + subdiv(4)
const LIGHTMAP_W = 128;
const LIGHTMAP_H = 128;
const LIGHTMAP_SIZE = LIGHTMAP_W * LIGHTMAP_H * 3;
const STATIC_MODEL_SIZE = 164;

// dmodel_t: float mins[3](12) + float maxs[3](12) + int firstSurface(4) + int numSurfaces(4) + int firstBrush(4) + int numBrushes(4) = 40
const DMODEL_SIZE = 40;

// dnode_t: int planeNum(4) + int children[2](8) + int mins[3](12) + int maxs[3](12) = 36
const DNODE_SIZE = 36;

// dleaf_t: int cluster(4) + int area(4) + int mins[3](12) + int maxs[3](12)
//        + int firstLeafSurface(4) + int numLeafSurfaces(4)
//        + int firstLeafBrush(4) + int numLeafBrushes(4)
//        + int firstTerraPatch(4) + int numTerraPatches(4)
//        + int firstStaticModel(4) + int numStaticModels(4) = 64
const DLEAF_SIZE = 64;

// dplane_t: float normal[3](12) + float dist(4) = 16
const DPLANE_SIZE = 16;

interface Lump {
    offset: number;
    length: number;
}

interface DrawVert {
    xyz: [number, number, number];
    st: [number, number];
    lightmap: [number, number];
    normal: [number, number, number];
    color: [number, number, number, number];
}

interface DSurface {
    shaderNum: number;
    fogNum: number;
    surfaceType: number;
    firstVert: number;
    numVerts: number;
    firstIndex: number;
    numIndexes: number;
    lightmapNum: number;
    lightmapX: number;
    lightmapY: number;
    lightmapWidth: number;
    lightmapHeight: number;
    patchWidth: number;
    patchHeight: number;
    subdivisions: number;
}

interface StaticModel {
    model: string;
    origin: [number, number, number];
    angles: [number, number, number];
    scale: number;
}

export interface DModel {
    mins: [number, number, number];
    maxs: [number, number, number];
    firstSurface: number;
    numSurfaces: number;
    firstBrush: number;
    numBrushes: number;
}

export interface BspNode {
    planeNum: number;
    children: [number, number]; // negative = -(leaf+1)
    mins: [number, number, number];
    maxs: [number, number, number];
}

export interface BspLeaf {
    cluster: number;
    area: number;
    mins: [number, number, number];
    maxs: [number, number, number];
    firstLeafSurface: number;
    numLeafSurfaces: number;
    firstLeafBrush: number;
    numLeafBrushes: number;
}

export interface BspPlane {
    normal: [number, number, number];
    dist: number;
}

export interface VisData {
    numClusters: number;
    clusterBytes: number;
    data: Uint8Array;
}

export interface LightGrid {
    mins: [number, number, number];
    size: [number, number, number];
    bounds: [number, number, number];
    palette: Uint8Array; // 256 * 3 = 768 bytes
    offsets: Uint16Array;
    data: Uint8Array;
}

export interface SphereLight {
    origin: [number, number, number];
    color: [number, number, number];
    intensity: number;
    leaf: number;
    needsTrace: boolean;
    spotLight: boolean;
    spotDir: [number, number, number];
    spotRadiusByDistance: number;
}

export interface BspData {
    mesh: THREE.Group;
    entities: any[];
    animatedMaterials: Q3Material[];
    staticModels: StaticModel[];
    shaderNames: string[];
    // New: brush models
    submodels: DModel[];
    submodelMeshes: THREE.Group[]; // Pre-built meshes for each submodel
    // New: BSP tree
    nodes: BspNode[];
    leaves: BspLeaf[];
    planes: BspPlane[];
    leafSurfaces: number[];
    visData: VisData | null;
    // New: light grid
    lightGrid: LightGrid | null;
    // New: sphere lights
    sphereLights: SphereLight[];
    // BSP version
    version: number;
}

function readString(view: DataView, offset: number, maxLen: number): string {
    const decoder = new TextDecoder('utf-8');
    let end = offset;
    while (end < offset + maxLen && view.getUint8(end) !== 0) end++;
    return decoder.decode(new Uint8Array(view.buffer, offset, end - offset));
}

function getLump(view: DataView, version: number, lumpIndex: number, baseOffset: number): Lump {
    let actualIndex = lumpIndex;
    if (version <= 18 && lumpIndex > 12) {
        actualIndex = lumpIndex + 1;
    }
    const ptr = baseOffset + actualIndex * 8;
    return {
        offset: view.getInt32(ptr, true),
        length: view.getInt32(ptr + 4, true),
    };
}

export function parseBsp(buffer: ArrayBuffer, vfs: VirtualFileSystem, shaderParser?: ShaderParser): BspData {
    const view = new DataView(buffer);
    const ident = view.getInt32(0, true);
    const version = view.getInt32(4, true);

    console.log(`[BSP v3] ident: 0x${ident.toString(16)}, version: ${version}`);

    if (version < 17 || version > 21) {
        console.warn(`Unsupported BSP version: ${version}`);
    }

    const lumpsBase = 12; // ident(4) + version(4) + checksum(4)

    // Read lumps
    const shaderLump = getLump(view, version, LUMP_SHADERS, lumpsBase);
    const lightmapLump = getLump(view, version, LUMP_LIGHTMAPS, lumpsBase);
    const surfaceLump = getLump(view, version, LUMP_SURFACES, lumpsBase);
    const vertLump = getLump(view, version, LUMP_DRAWVERTS, lumpsBase);
    const indexLump = getLump(view, version, LUMP_DRAWINDEXES, lumpsBase);
    const entityLump = getLump(view, version, LUMP_ENTITIES, lumpsBase);
    const terrainLump = getLump(view, version, LUMP_TERRAIN, lumpsBase);
    const staticModelDefLump = getLump(view, version, LUMP_STATICMODELDEF, lumpsBase);
    const modelLump = getLump(view, version, LUMP_MODELS, lumpsBase);
    const nodeLump = getLump(view, version, LUMP_NODES, lumpsBase);
    const leafLump = getLump(view, version, LUMP_LEAFS, lumpsBase);
    const leafSurfLump = getLump(view, version, LUMP_LEAFSURFACES, lumpsBase);
    const planeLump = getLump(view, version, LUMP_PLANES, lumpsBase);
    const visLump = getLump(view, version, LUMP_VISIBILITY, lumpsBase);
    const lgPaletteLump = getLump(view, version, LUMP_LIGHTGRIDPALETTE, lumpsBase);
    const lgOffsetsLump = getLump(view, version, LUMP_LIGHTGRIDOFFSETS, lumpsBase);
    const lgDataLump = getLump(view, version, LUMP_LIGHTGRIDDATA, lumpsBase);
    const sphereLightLump = getLump(view, version, LUMP_SPHERELIGHTS, lumpsBase);

    // Parse Entities
    const entities = parseEntities(view, entityLump);

    // Parse Shader names
    const shaderNames = parseShaders(view, shaderLump);

    // Parse Lightmaps
    const lightmaps = parseLightmaps(view, lightmapLump);

    // Parse Vertices
    const drawVerts = parseDrawVerts(view, vertLump);

    // Parse Indices
    const drawIndices = parseDrawIndices(view, indexLump);

    // Parse Surfaces
    const surfaces = parseSurfaces(view, surfaceLump);

    // Parse Static Models
    const staticModels = parseStaticModels(view, staticModelDefLump);

    // Parse Models (submodels)
    let submodels: DModel[] = [];
    let nodes: BspNode[] = [];
    let leaves: BspLeaf[] = [];
    let planes: BspPlane[] = [];
    let leafSurfaces: number[] = [];
    let visData: VisData | null = null;
    let lightGrid: LightGrid | null = null;
    let sphereLights: SphereLight[] = [];

    try { submodels = parseModels(view, modelLump); } catch (e) { console.warn('Failed to parse models:', e); }
    try { nodes = parseNodes(view, nodeLump); } catch (e) { console.warn('Failed to parse nodes:', e); }
    try { leaves = parseLeaves(view, leafLump); } catch (e) { console.warn('Failed to parse leaves:', e); }
    try { planes = parsePlanes(view, planeLump); } catch (e) { console.warn('Failed to parse planes:', e); }
    try { leafSurfaces = parseLeafSurfaces(view, leafSurfLump); } catch (e) { console.warn('Failed to parse leafSurfaces:', e); }
    try { visData = parseVisibility(view, visLump); } catch (e) { console.warn('Failed to parse visibility:', e); }
    try { lightGrid = parseLightGrid(view, version, submodels, lgPaletteLump, lgOffsetsLump, lgDataLump); } catch (e) { console.warn('Failed to parse lightGrid:', e); }
    try { sphereLights = parseSphereLights(view, sphereLightLump); } catch (e) { console.warn('Failed to parse sphereLights:', e); }

    // Build geometry for world model only (model 0)
    // Submodel surfaces are at model-local coordinates and must NOT be rendered as world geometry.
    // They are rendered separately via buildSubmodelMesh when entities place them.
    const worldFirstSurf = submodels.length > 0 ? submodels[0].firstSurface : 0;
    const worldNumSurfs = submodels.length > 0 ? submodels[0].numSurfaces : surfaces.length;

    console.log(`Shaders: ${shaderNames.length}, Lightmaps: ${lightmaps.length}, Verts: ${drawVerts.length}, Indices: ${drawIndices.length}, Surfaces: ${surfaces.length} (world: ${worldFirstSurf}..${worldFirstSurf + worldNumSurfs - 1} of ${surfaces.length})`);
    console.log(`Submodels: ${submodels.length}, Nodes: ${nodes.length}, Leaves: ${leaves.length}, Planes: ${planes.length}`);
    console.log(`Clusters: ${visData ? visData.numClusters : 0}, SphereLights: ${sphereLights.length}`);
    if (lightGrid) console.log(`LightGrid: bounds [${lightGrid.bounds}], size [${lightGrid.size}]`);

    const group = new THREE.Group();
    const animatedMaterials: Q3Material[] = [];

    // Material cache
    const materialCache = new Map<string, { material: THREE.Material; q3mat: Q3Material }>();
    function getMaterial(shaderName: string, lightmapNum: number): { material: THREE.Material; q3mat: Q3Material } {
        const key = `${shaderName.toLowerCase()}_lm${lightmapNum}`;
        let cached = materialCache.get(key);
        if (cached) return cached;

        const lmTex = (lightmapNum >= 0 && lightmapNum < lightmaps.length) ? lightmaps[lightmapNum] : null;
        const parsedShader = shaderParser?.getShader(shaderName);

        const q3mat = createQ3Material({
            vfs,
            shaderName,
            parsedShader,
            lightmapTexture: lmTex,
            vertexColors: true,
        });

        if (q3mat.animated) {
            animatedMaterials.push(q3mat);
        }

        cached = { material: q3mat.material, q3mat };
        materialCache.set(key, cached);
        return cached;
    }

    interface SurfaceGroup {
        positions: number[];
        uvs: number[];
        uvs2: number[];
        normals: number[];
        colors: number[];
        indices: number[];
        material: THREE.Material;
        q3mat: Q3Material;
    }

    // Surface groups for world geometry (inline, same as original working code)
    const surfaceGroups = new Map<string, SurfaceGroup>();

    function getGroup(shaderName: string, lightmapNum: number): SurfaceGroup {
        const key = `${shaderName.toLowerCase()}_lm${lightmapNum}`;
        let grp = surfaceGroups.get(key);
        if (grp) return grp;

        const { material, q3mat } = getMaterial(shaderName, lightmapNum);

        grp = {
            positions: [], uvs: [], uvs2: [], normals: [], colors: [], indices: [],
            material, q3mat,
        };
        surfaceGroups.set(key, grp);
        return grp;
    }

    // Surface type statistics
    const surfTypeCount: Record<number, number> = {};
    let nodrawSkipped = 0;
    let processedCount = 0;

    for (let si = worldFirstSurf; si < worldFirstSurf + worldNumSurfs; si++) {
        const surf = surfaces[si];
        if (!surf) continue;
        surfTypeCount[surf.surfaceType] = (surfTypeCount[surf.surfaceType] || 0) + 1;
        const shaderName = surf.shaderNum >= 0 && surf.shaderNum < shaderNames.length ? shaderNames[surf.shaderNum] : '';

        if (shaderParser) {
            const ps = shaderParser.getShader(shaderName);
            if (ps && ps.surfaceparms.includes('nodraw')) {
                nodrawSkipped++;
                continue;
            }
        }

        processedCount++;
        if (surf.surfaceType === MST_PLANAR || surf.surfaceType === MST_TRIANGLE_SOUP) {
            const grp = getGroup(shaderName, surf.lightmapNum);
            const baseVert = grp.positions.length / 3;

            for (let i = 0; i < surf.numVerts; i++) {
                const v = drawVerts[surf.firstVert + i];
                grp.positions.push(v.xyz[0], v.xyz[1], v.xyz[2]);
                grp.uvs.push(v.st[0], v.st[1]);
                grp.uvs2.push(v.lightmap[0], v.lightmap[1]);
                grp.normals.push(v.normal[0], v.normal[1], v.normal[2]);
                grp.colors.push(v.color[0] / 255, v.color[1] / 255, v.color[2] / 255);
            }

            for (let i = 0; i < surf.numIndexes; i += 3) {
                grp.indices.push(baseVert + drawIndices[surf.firstIndex + i]);
                if (i + 2 < surf.numIndexes) {
                    grp.indices.push(baseVert + drawIndices[surf.firstIndex + i + 2]);
                    grp.indices.push(baseVert + drawIndices[surf.firstIndex + i + 1]);
                } else if (i + 1 < surf.numIndexes) {
                    grp.indices.push(baseVert + drawIndices[surf.firstIndex + i + 1]);
                }
            }
        } else if (surf.surfaceType === MST_PATCH) {
            const controlPoints: PatchVert[] = [];
            for (let i = 0; i < surf.numVerts; i++) {
                const v = drawVerts[surf.firstVert + i];
                controlPoints.push({
                    xyz: v.xyz, st: v.st, lightmap: v.lightmap, normal: v.normal, color: v.color,
                });
            }

            const tessellated = tessellatePatch(controlPoints, surf.patchWidth, surf.patchHeight, surf.subdivisions);
            const grp = getGroup(shaderName, surf.lightmapNum);
            const baseVert = grp.positions.length / 3;

            for (const v of tessellated.verts) {
                grp.positions.push(v.xyz[0], v.xyz[1], v.xyz[2]);
                grp.uvs.push(v.st[0], v.st[1]);
                grp.uvs2.push(v.lightmap[0], v.lightmap[1]);
                grp.normals.push(v.normal[0], v.normal[1], v.normal[2]);
                grp.colors.push(v.color[0] / 255, v.color[1] / 255, v.color[2] / 255);
            }

            for (const idx of tessellated.indices) {
                grp.indices.push(baseVert + idx);
            }
        }
    }

    // Build meshes from surface groups
    for (const [key, grp] of surfaceGroups) {
        if (grp.indices.length === 0) continue;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(grp.positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(grp.uvs, 2));
        geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(grp.uvs2, 2));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(grp.normals, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(grp.colors, 3));
        geometry.setIndex(grp.indices);

        const mesh = new THREE.Mesh(geometry, grp.material);
        mesh.frustumCulled = false;
        if (grp.q3mat.renderOrder) {
            mesh.renderOrder = grp.q3mat.renderOrder;
        }
        group.add(mesh);
    }

    let dbgVerts = 0;
    let dbgIdx = 0;
    for (const [key, grp] of surfaceGroups) {
        dbgVerts += grp.positions.length / 3;
        dbgIdx += grp.indices.length;
    }
    const typeNames: Record<number, string> = { 0: 'BAD', 1: 'PLANAR', 2: 'PATCH', 3: 'TRI_SOUP', 4: 'FLARE', 5: 'TERRAIN' };
    const typeStr = Object.entries(surfTypeCount).map(([t, c]) => `${typeNames[Number(t)] || t}=${c}`).join(', ');
    console.log(`Surface types: ${typeStr} | nodraw skipped: ${nodrawSkipped} | processed: ${processedCount}`);
    console.log(`BspParser Output: ${surfaceGroups.size} groups, ${dbgVerts} vertices, ${dbgIdx} indices pushed to WebGL!`);
    logCullStats();

    // Build submodel meshes (for brush entities like func_static, func_door, etc.)
    // Uses a separate simple function to avoid any interference with world geometry
    const submodelMeshes: THREE.Group[] = [group]; // index 0 = world
    for (let mi = 1; mi < submodels.length; mi++) {
        const sm = submodels[mi];
        const smGroup = buildSubmodelMesh(sm.firstSurface, sm.numSurfaces, surfaces, drawVerts, drawIndices, shaderNames, lightmaps, shaderParser, vfs, getMaterial);
        submodelMeshes.push(smGroup);
    }
    console.log(`Built ${submodels.length - 1} submodel meshes`);

    // Handle terrain
    if (terrainLump.length > 0) {
        try {
            const terrainPatches = parseTerrainPatches(buffer, terrainLump.offset, terrainLump.length);
            if (terrainPatches.length > 0 && shaderParser) {
                const terrain = buildTerrainGeometry(terrainPatches, shaderNames, lightmaps, vfs, shaderParser);
                group.add(terrain.group);
                animatedMaterials.push(...terrain.materials.filter(m => m.animated));
            }
            console.log(`Terrain patches: ${terrainPatches.length}`);
        } catch (e) {
            console.warn('Failed to parse terrain:', e);
        }
    }

    // Apply coordinate system transform
    group.rotation.x = -Math.PI / 2;

    return {
        mesh: group, entities, animatedMaterials, staticModels, shaderNames,
        submodels, submodelMeshes,
        nodes, leaves, planes, leafSurfaces,
        visData, lightGrid, sphereLights,
        version,
    };
}

interface DrawVertLocal {
    xyz: [number, number, number];
    st: [number, number];
    lightmap: [number, number];
    normal: [number, number, number];
    color: [number, number, number, number];
}

interface DSurfaceLocal {
    shaderNum: number;
    fogNum: number;
    surfaceType: number;
    firstVert: number;
    numVerts: number;
    firstIndex: number;
    numIndexes: number;
    lightmapNum: number;
    patchWidth: number;
    patchHeight: number;
    subdivisions: number;
}

function buildSubmodelMesh(
    firstSurf: number, numSurfs: number,
    surfaces: DSurfaceLocal[], drawVerts: DrawVertLocal[], drawIndices: number[],
    shaderNames: string[], lightmaps: THREE.DataTexture[],
    shaderParser: ShaderParser | undefined, vfs: VirtualFileSystem,
    getMaterial: (shaderName: string, lightmapNum: number) => { material: THREE.Material; q3mat: Q3Material }
): THREE.Group {
    interface SmSurfGroup {
        positions: number[]; uvs: number[]; uvs2: number[]; normals: number[];
        colors: number[]; indices: number[];
        material: THREE.Material; q3mat: Q3Material;
    }
    const groups = new Map<string, SmSurfGroup>();

    for (let si = firstSurf; si < firstSurf + numSurfs; si++) {
        const surf = surfaces[si];
        if (!surf) continue;
        if (surf.surfaceType !== MST_PLANAR && surf.surfaceType !== MST_TRIANGLE_SOUP && surf.surfaceType !== MST_PATCH) continue;
        if (surf.firstVert < 0 || surf.firstVert + surf.numVerts > drawVerts.length) continue;
        if (surf.firstIndex < 0 || surf.firstIndex + surf.numIndexes > drawIndices.length) continue;

        const shaderName = surf.shaderNum >= 0 && surf.shaderNum < shaderNames.length ? shaderNames[surf.shaderNum] : '';
        const key = `${shaderName.toLowerCase()}_lm${surf.lightmapNum}`;

        let grp = groups.get(key);
        if (!grp) {
            const { material, q3mat } = getMaterial(shaderName, surf.lightmapNum);
            grp = { positions: [], uvs: [], uvs2: [], normals: [], colors: [], indices: [], material, q3mat };
            groups.set(key, grp);
        }

        if (surf.surfaceType === MST_PLANAR || surf.surfaceType === MST_TRIANGLE_SOUP) {
            const baseVert = grp.positions.length / 3;
            for (let i = 0; i < surf.numVerts; i++) {
                const v = drawVerts[surf.firstVert + i];
                grp.positions.push(v.xyz[0], v.xyz[1], v.xyz[2]);
                grp.uvs.push(v.st[0], v.st[1]);
                grp.uvs2.push(v.lightmap[0], v.lightmap[1]);
                grp.normals.push(v.normal[0], v.normal[1], v.normal[2]);
                grp.colors.push(v.color[0] / 255, v.color[1] / 255, v.color[2] / 255);
            }
            for (let i = 0; i < surf.numIndexes; i += 3) {
                grp.indices.push(baseVert + drawIndices[surf.firstIndex + i]);
                if (i + 2 < surf.numIndexes) {
                    grp.indices.push(baseVert + drawIndices[surf.firstIndex + i + 2]);
                    grp.indices.push(baseVert + drawIndices[surf.firstIndex + i + 1]);
                }
            }
        } else if (surf.surfaceType === MST_PATCH) {
            const controlPoints: PatchVert[] = [];
            for (let i = 0; i < surf.numVerts; i++) {
                const v = drawVerts[surf.firstVert + i];
                controlPoints.push({ xyz: v.xyz, st: v.st, lightmap: v.lightmap, normal: v.normal, color: v.color });
            }
            const tessellated = tessellatePatch(controlPoints, surf.patchWidth, surf.patchHeight, surf.subdivisions);
            const baseVert = grp.positions.length / 3;
            for (const v of tessellated.verts) {
                grp.positions.push(v.xyz[0], v.xyz[1], v.xyz[2]);
                grp.uvs.push(v.st[0], v.st[1]);
                grp.uvs2.push(v.lightmap[0], v.lightmap[1]);
                grp.normals.push(v.normal[0], v.normal[1], v.normal[2]);
                grp.colors.push(v.color[0] / 255, v.color[1] / 255, v.color[2] / 255);
            }
            for (const idx of tessellated.indices) grp.indices.push(baseVert + idx);
        }
    }

    const resultGroup = new THREE.Group();
    for (const [, grp] of groups) {
        if (grp.indices.length === 0) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(grp.positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(grp.uvs, 2));
        geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(grp.uvs2, 2));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(grp.normals, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(grp.colors, 3));
        geometry.setIndex(grp.indices);
        const mesh = new THREE.Mesh(geometry, grp.material);
        mesh.frustumCulled = false;
        resultGroup.add(mesh);
    }
    return resultGroup;
}

function parseEntities(view: DataView, lump: Lump): any[] {
    if (!lump || lump.length <= 0) return [];

    const decoder = new TextDecoder('utf-8');
    const entString = decoder.decode(new Uint8Array(view.buffer, lump.offset, lump.length));

    const entities: any[] = [];
    const entRegex = /\{([^}]*)\}/g;
    let match;
    while ((match = entRegex.exec(entString)) !== null) {
        const entData = match[1];
        const props: any = {};
        const propRegex = /"([^"]+)"\s+"([^"]*)"/g;
        let pMatch;
        while ((pMatch = propRegex.exec(entData)) !== null) {
            props[pMatch[1]] = pMatch[2];
        }
        entities.push(props);
    }
    return entities;
}

function parseShaders(view: DataView, lump: Lump): string[] {
    const numShaders = Math.floor(lump.length / SHADER_SIZE);
    const shaders: string[] = [];

    for (let i = 0; i < numShaders; i++) {
        const offset = lump.offset + i * SHADER_SIZE;
        let shaderName = readString(view, offset, 64);
        shaderName = shaderName.replace(/\\/g, '/');
        shaders.push(shaderName);
    }
    return shaders;
}

function parseLightmaps(view: DataView, lump: Lump): THREE.DataTexture[] {
    const numLightmaps = Math.floor(lump.length / LIGHTMAP_SIZE);
    const lightmaps: THREE.DataTexture[] = [];

    for (let i = 0; i < numLightmaps; i++) {
        const offset = lump.offset + i * LIGHTMAP_SIZE;
        const rgbData = new Uint8Array(view.buffer, offset, LIGHTMAP_SIZE);

        const rgbaData = new Uint8Array(LIGHTMAP_W * LIGHTMAP_H * 4);
        for (let j = 0; j < LIGHTMAP_W * LIGHTMAP_H; j++) {
            rgbaData[j * 4] = Math.min(rgbData[j * 3] * 2, 255);
            rgbaData[j * 4 + 1] = Math.min(rgbData[j * 3 + 1] * 2, 255);
            rgbaData[j * 4 + 2] = Math.min(rgbData[j * 3 + 2] * 2, 255);
            rgbaData[j * 4 + 3] = 255;
        }

        const tex = new THREE.DataTexture(rgbaData, LIGHTMAP_W, LIGHTMAP_H, THREE.RGBAFormat);
        tex.name = `lightmap_${i}`;
        tex.matrix = new THREE.Matrix3();
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        tex.channel = 1;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        lightmaps.push(tex);
    }
    return lightmaps;
}

function parseDrawVerts(view: DataView, lump: Lump): DrawVert[] {
    const numVerts = Math.floor(lump.length / DRAWVERT_SIZE);
    const verts: DrawVert[] = [];

    for (let i = 0; i < numVerts; i++) {
        const off = lump.offset + i * DRAWVERT_SIZE;
        verts.push({
            xyz: [
                view.getFloat32(off, true),
                view.getFloat32(off + 4, true),
                view.getFloat32(off + 8, true),
            ],
            st: [
                view.getFloat32(off + 12, true),
                view.getFloat32(off + 16, true),
            ],
            lightmap: [
                view.getFloat32(off + 20, true),
                view.getFloat32(off + 24, true),
            ],
            normal: [
                view.getFloat32(off + 28, true),
                view.getFloat32(off + 32, true),
                view.getFloat32(off + 36, true),
            ],
            color: [
                view.getUint8(off + 40),
                view.getUint8(off + 41),
                view.getUint8(off + 42),
                view.getUint8(off + 43),
            ],
        });
    }
    return verts;
}

function parseDrawIndices(view: DataView, lump: Lump): number[] {
    const numIdx = Math.floor(lump.length / 4);
    const indices: number[] = [];
    for (let i = 0; i < numIdx; i++) {
        indices.push(view.getInt32(lump.offset + i * 4, true));
    }
    return indices;
}

function parseSurfaces(view: DataView, lump: Lump): DSurface[] {
    const numSurfs = Math.floor(lump.length / DSURFACE_SIZE);
    const surfaces: DSurface[] = [];

    for (let i = 0; i < numSurfs; i++) {
        const off = lump.offset + i * DSURFACE_SIZE;
        surfaces.push({
            shaderNum: view.getInt32(off, true),
            fogNum: view.getInt32(off + 4, true),
            surfaceType: view.getInt32(off + 8, true),
            firstVert: view.getInt32(off + 12, true),
            numVerts: view.getInt32(off + 16, true),
            firstIndex: view.getInt32(off + 20, true),
            numIndexes: view.getInt32(off + 24, true),
            lightmapNum: view.getInt32(off + 28, true),
            lightmapX: view.getInt32(off + 32, true),
            lightmapY: view.getInt32(off + 36, true),
            lightmapWidth: view.getInt32(off + 40, true),
            lightmapHeight: view.getInt32(off + 44, true),
            patchWidth: view.getInt32(off + 96, true),
            patchHeight: view.getInt32(off + 100, true),
            subdivisions: view.getFloat32(off + 104, true),
        });
    }
    return surfaces;
}

function parseStaticModels(view: DataView, lump: Lump): StaticModel[] {
    if (!lump || lump.length <= 0) return [];

    const models: StaticModel[] = [];
    const numModels = Math.floor(lump.length / STATIC_MODEL_SIZE);

    for (let i = 0; i < numModels; i++) {
        const off = lump.offset + i * STATIC_MODEL_SIZE;
        const model = readString(view, off, 128);
        const origin: [number, number, number] = [
            view.getFloat32(off + 128, true),
            view.getFloat32(off + 132, true),
            view.getFloat32(off + 136, true),
        ];
        const angles: [number, number, number] = [
            view.getFloat32(off + 140, true),
            view.getFloat32(off + 144, true),
            view.getFloat32(off + 148, true),
        ];
        const scale = view.getFloat32(off + 152, true);

        models.push({ model, origin, angles, scale });
    }
    return models;
}

function parseModels(view: DataView, lump: Lump): DModel[] {
    if (!lump || lump.length <= 0) return [];

    const numModels = Math.floor(lump.length / DMODEL_SIZE);
    const models: DModel[] = [];

    for (let i = 0; i < numModels; i++) {
        const off = lump.offset + i * DMODEL_SIZE;
        models.push({
            mins: [
                view.getFloat32(off, true),
                view.getFloat32(off + 4, true),
                view.getFloat32(off + 8, true),
            ],
            maxs: [
                view.getFloat32(off + 12, true),
                view.getFloat32(off + 16, true),
                view.getFloat32(off + 20, true),
            ],
            firstSurface: view.getInt32(off + 24, true),
            numSurfaces: view.getInt32(off + 28, true),
            firstBrush: view.getInt32(off + 32, true),
            numBrushes: view.getInt32(off + 36, true),
        });
    }
    return models;
}

function parseNodes(view: DataView, lump: Lump): BspNode[] {
    if (!lump || lump.length <= 0) return [];

    const numNodes = Math.floor(lump.length / DNODE_SIZE);
    const nodes: BspNode[] = [];

    for (let i = 0; i < numNodes; i++) {
        const off = lump.offset + i * DNODE_SIZE;
        nodes.push({
            planeNum: view.getInt32(off, true),
            children: [view.getInt32(off + 4, true), view.getInt32(off + 8, true)],
            mins: [view.getInt32(off + 12, true), view.getInt32(off + 16, true), view.getInt32(off + 20, true)],
            maxs: [view.getInt32(off + 24, true), view.getInt32(off + 28, true), view.getInt32(off + 32, true)],
        });
    }
    return nodes;
}

function parseLeaves(view: DataView, lump: Lump): BspLeaf[] {
    if (!lump || lump.length <= 0) return [];

    const numLeaves = Math.floor(lump.length / DLEAF_SIZE);
    const leaves: BspLeaf[] = [];

    for (let i = 0; i < numLeaves; i++) {
        const off = lump.offset + i * DLEAF_SIZE;
        leaves.push({
            cluster: view.getInt32(off, true),
            area: view.getInt32(off + 4, true),
            mins: [view.getInt32(off + 8, true), view.getInt32(off + 12, true), view.getInt32(off + 16, true)],
            maxs: [view.getInt32(off + 20, true), view.getInt32(off + 24, true), view.getInt32(off + 28, true)],
            firstLeafSurface: view.getInt32(off + 32, true),
            numLeafSurfaces: view.getInt32(off + 36, true),
            firstLeafBrush: view.getInt32(off + 40, true),
            numLeafBrushes: view.getInt32(off + 44, true),
        });
    }
    return leaves;
}

function parsePlanes(view: DataView, lump: Lump): BspPlane[] {
    if (!lump || lump.length <= 0) return [];

    const numPlanes = Math.floor(lump.length / DPLANE_SIZE);
    const planes: BspPlane[] = [];

    for (let i = 0; i < numPlanes; i++) {
        const off = lump.offset + i * DPLANE_SIZE;
        planes.push({
            normal: [
                view.getFloat32(off, true),
                view.getFloat32(off + 4, true),
                view.getFloat32(off + 8, true),
            ],
            dist: view.getFloat32(off + 12, true),
        });
    }
    return planes;
}

function parseLeafSurfaces(view: DataView, lump: Lump): number[] {
    if (!lump || lump.length <= 0) return [];

    const num = Math.floor(lump.length / 4);
    const arr: number[] = [];
    for (let i = 0; i < num; i++) {
        arr.push(view.getInt32(lump.offset + i * 4, true));
    }
    return arr;
}

function parseVisibility(view: DataView, lump: Lump): VisData | null {
    if (!lump || lump.length <= 8) return null;

    const numClusters = view.getInt32(lump.offset, true);
    const clusterBytes = view.getInt32(lump.offset + 4, true);

    if (numClusters <= 0 || clusterBytes <= 0) return null;

    const dataLength = lump.length - 8;
    const data = new Uint8Array(view.buffer, lump.offset + 8, dataLength);

    return { numClusters, clusterBytes, data };
}

function parseLightGrid(
    view: DataView, version: number, submodels: DModel[],
    paletteLump: Lump, offsetsLump: Lump, dataLump: Lump
): LightGrid | null {
    if (!paletteLump || paletteLump.length <= 0) return null;
    if (!offsetsLump || offsetsLump.length <= 0) return null;
    if (!dataLump || dataLump.length <= 0) return null;

    // Grid size depends on BSP version
    let gridSize: [number, number, number];
    if (version >= 21) {
        gridSize = [80, 80, 80]; // Breakthrough
    } else if (version >= 20) {
        gridSize = [48, 48, 64]; // Spearhead
    } else {
        gridSize = [32, 32, 32]; // Allied Assault
    }

    // World bounds from submodel 0
    if (submodels.length === 0) return null;
    const world = submodels[0];

    const mins: [number, number, number] = [
        gridSize[0] * Math.ceil(world.mins[0] / gridSize[0]),
        gridSize[1] * Math.ceil(world.mins[1] / gridSize[1]),
        gridSize[2] * Math.ceil(world.mins[2] / gridSize[2]),
    ];

    const bounds: [number, number, number] = [
        Math.floor((world.maxs[0] - mins[0]) / gridSize[0]) + 1,
        Math.floor((world.maxs[1] - mins[1]) / gridSize[1]) + 1,
        Math.floor((world.maxs[2] - mins[2]) / gridSize[2]) + 1,
    ];

    // Read palette (768 bytes = 256 * 3)
    const palette = new Uint8Array(view.buffer, paletteLump.offset, Math.min(paletteLump.length, 768));

    // Read offsets
    const numOffsets = Math.floor(offsetsLump.length / 2);
    const offsets = new Uint16Array(numOffsets);
    for (let i = 0; i < numOffsets; i++) {
        offsets[i] = view.getUint16(offsetsLump.offset + i * 2, true);
    }

    // Read data
    const data = new Uint8Array(view.buffer, dataLump.offset, dataLump.length);

    return { mins, size: gridSize, bounds, palette, offsets, data };
}

function parseSphereLights(view: DataView, lump: Lump): SphereLight[] {
    if (!lump || lump.length <= 0) return [];

    // dspherel_t size: origin(12) + color(12) + intensity(4) + leaf(4)
    //   + needs_trace(4) + spot_light(4) + spot_dir(12) + spot_radiusbydist(4) = 56
    const SPHERE_LIGHT_SIZE = 56;
    const numLights = Math.floor(lump.length / SPHERE_LIGHT_SIZE);
    const lights: SphereLight[] = [];

    for (let i = 0; i < numLights; i++) {
        const off = lump.offset + i * SPHERE_LIGHT_SIZE;
        lights.push({
            origin: [
                view.getFloat32(off, true),
                view.getFloat32(off + 4, true),
                view.getFloat32(off + 8, true),
            ],
            color: [
                view.getFloat32(off + 12, true),
                view.getFloat32(off + 16, true),
                view.getFloat32(off + 20, true),
            ],
            intensity: view.getFloat32(off + 24, true),
            leaf: view.getInt32(off + 28, true),
            needsTrace: view.getInt32(off + 32, true) !== 0,
            spotLight: view.getInt32(off + 36, true) !== 0,
            spotDir: [
                view.getFloat32(off + 40, true),
                view.getFloat32(off + 44, true),
                view.getFloat32(off + 48, true),
            ],
            spotRadiusByDistance: view.getFloat32(off + 52, true),
        });
    }
    return lights;
}

// PVS helper: check if cluster A can see cluster B
export function clusterVisible(visData: VisData | null, from: number, to: number): boolean {
    if (!visData) return true; // No vis data = everything visible
    if (from < 0 || to < 0) return true;
    if (from >= visData.numClusters || to >= visData.numClusters) return true;

    const offset = from * visData.clusterBytes;
    const byteIndex = to >> 3;
    const bitIndex = to & 7;

    if (offset + byteIndex >= visData.data.length) return true;

    return (visData.data[offset + byteIndex] & (1 << bitIndex)) !== 0;
}

// BSP tree traversal: find which leaf a point is in
export function findLeaf(point: [number, number, number], nodes: BspNode[], leaves: BspLeaf[], planes: BspPlane[]): number {
    if (nodes.length === 0) return -1;

    let nodeIndex = 0;
    while (nodeIndex >= 0) {
        const node = nodes[nodeIndex];
        const plane = planes[node.planeNum];

        // Dot product of point with plane normal - plane distance
        const dist = plane.normal[0] * point[0] + plane.normal[1] * point[1] + plane.normal[2] * point[2] - plane.dist;

        if (dist >= 0) {
            nodeIndex = node.children[0];
        } else {
            nodeIndex = node.children[1];
        }
    }

    // Convert to leaf index: leaf = -(nodeIndex + 1)
    return -(nodeIndex + 1);
}

// Sample light grid at a position, returns RGB color (0-255)
export function sampleLightGrid(grid: LightGrid, point: [number, number, number]): [number, number, number] | null {
    if (!grid) return null;

    // Convert world position to grid coordinates
    const gx = Math.floor((point[0] - grid.mins[0]) / grid.size[0]);
    const gy = Math.floor((point[1] - grid.mins[1]) / grid.size[1]);
    const gz = Math.floor((point[2] - grid.mins[2]) / grid.size[2]);

    if (gx < 0 || gx >= grid.bounds[0] || gy < 0 || gy >= grid.bounds[1] || gz < 0 || gz >= grid.bounds[2]) {
        return null;
    }

    const gridIndex = gz * grid.bounds[0] * grid.bounds[1] + gy * grid.bounds[0] + gx;
    if (gridIndex >= grid.offsets.length) return null;

    let dataOffset = grid.offsets[gridIndex];
    if (dataOffset >= grid.data.length) return null;

    // Decode RLE: negative byte = skip count, positive byte = palette index
    const val = grid.data[dataOffset];
    if (val === undefined) return null;

    // Read palette color
    const paletteIdx = val * 3;
    if (paletteIdx + 2 >= grid.palette.length) return null;

    return [grid.palette[paletteIdx], grid.palette[paletteIdx + 1], grid.palette[paletteIdx + 2]];
}
