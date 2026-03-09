// MOHAA Terrain patch loader
// Based on openmohaa qfiles.h dterPatch_t and tr_terrain.c

import * as THREE from 'three';
import { VirtualFileSystem } from './VirtualFileSystem';
import { createQ3Material, Q3Material } from './Q3ShaderMaterial';
import { ShaderParser } from './ShaderParser';

// dterPatch_t layout (see qfiles.h):
// byte flags;           // 1
// byte scale;           // 1
// byte lmCoords[2];     // 2
// float texCoords[8];   // 32
// char x;               // 1
// char y;               // 1
// short baseZ;          // 2
// unsigned short shader;// 2
// short lightmap;       // 2
// short dummy[4];       // 8
// short vertFlags[2][63]; // 252
// byte heightmap[9][9]; // 81
// Total: 1+1+2+32+1+1+2+2+2+8+252+81 = 385 bytes

const TERPATCH_SIZE = 388; // 385 bytes data + 3 bytes padding for 4-byte alignment

export interface TerrainPatch {
    flags: number;
    scale: number;
    lmCoords: [number, number];
    texCoords: number[]; // 8 floats
    x: number;
    y: number;
    baseZ: number;
    shaderIndex: number;
    lightmapIndex: number;
    heightmap: number[][]; // 9x9
}

export function parseTerrainPatches(buffer: ArrayBuffer, offset: number, length: number): TerrainPatch[] {
    const view = new DataView(buffer);
    const numPatches = Math.floor(length / TERPATCH_SIZE);
    const patches: TerrainPatch[] = [];

    for (let i = 0; i < numPatches; i++) {
        let p = offset + i * TERPATCH_SIZE;

        const flags = view.getUint8(p); p += 1;
        const scale = view.getUint8(p); p += 1;
        const lmCoords: [number, number] = [view.getUint8(p), view.getUint8(p + 1)]; p += 2;

        const texCoords: number[] = [];
        for (let j = 0; j < 8; j++) {
            texCoords.push(view.getFloat32(p, true)); p += 4;
        }

        const x = view.getInt8(p); p += 1;
        const y = view.getInt8(p); p += 1;
        const baseZ = view.getInt16(p, true); p += 2;
        const shaderIndex = view.getUint16(p, true); p += 2;
        const lightmapIndex = view.getInt16(p, true); p += 2;

        p += 8; // skip dummy[4]
        p += 252; // skip vertFlags[2][63]

        const heightmap: number[][] = [];
        for (let row = 0; row < 9; row++) {
            const hrow: number[] = [];
            for (let col = 0; col < 9; col++) {
                hrow.push(view.getUint8(p)); p += 1;
            }
            heightmap.push(hrow);
        }

        patches.push({ flags, scale, lmCoords, texCoords, x, y, baseZ, shaderIndex, lightmapIndex, heightmap });
    }

    return patches;
}

export function buildTerrainGeometry(
    patches: TerrainPatch[],
    shaderNames: string[],
    lightmaps: THREE.DataTexture[],
    vfs: VirtualFileSystem,
    shaderParser: ShaderParser
): { group: THREE.Group; materials: Q3Material[] } {
    const group = new THREE.Group();
    const allMaterials: Q3Material[] = [];

    // Batch patches by shader+lightmap key for fewer draw calls
    interface TerrainBatch {
        positions: number[];
        uvs: number[];
        uvs2: number[];
        normals: number[];
        indices: number[];
        shaderName: string;
        lightmapIndex: number;
    }

    const batches = new Map<string, TerrainBatch>();

    for (const patch of patches) {
        const shaderName = patch.shaderIndex < shaderNames.length ? shaderNames[patch.shaderIndex] : '';
        const key = `${shaderName.toLowerCase()}_lm${patch.lightmapIndex}`;

        let batch = batches.get(key);
        if (!batch) {
            batch = {
                positions: [],
                uvs: [],
                uvs2: [],
                normals: [],
                indices: [],
                shaderName,
                lightmapIndex: patch.lightmapIndex,
            };
            batches.set(key, batch);
        }

        const baseVert = batch.positions.length / 3;
        // Terrain cells are always 64 world-unit steps (patch = 8 cells = 512 units).
        // patch.x * 64 and patch.y * 64 are the world-space patch origin
        // (see R_UnpackTerraPatch: x0 = pPacked->x << 6, y0 = pPacked->y << 6).
        const cellSize = 64;

        // texCoords stores 4 UV pairs for the patch corners (cTerraPatch_t texCoord[2][2]):
        //   [0,1] = (u,v) at corner (col=0, row=0)  = patch x0,y0
        //   [2,3] = (u,v) at corner (col=0, row=8)  = patch x0,y0+512
        //   [4,5] = (u,v) at corner (col=8, row=0)  = patch x0+512,y0
        //   [6,7] = (u,v) at corner (col=8, row=8)  = patch x0+512,y0+512
        const u00 = patch.texCoords[0], v00 = patch.texCoords[1];
        const u01 = patch.texCoords[2], v01 = patch.texCoords[3];
        const u10 = patch.texCoords[4], v10 = patch.texCoords[5];
        const u11 = patch.texCoords[6], v11 = patch.texCoords[7];

        // Lightmap UV base and size (R_UnpackTerraPatch: s=(s_byte+0.5)/128, lmapSize=lmapScale*8/128)
        const lmS0 = (patch.lmCoords[0] + 0.5) / 128.0;
        const lmT0 = (patch.lmCoords[1] + 0.5) / 128.0;
        const lmSize = patch.scale * 8 / 128.0;

        // Generate vertices for 9x9 heightmap
        for (let row = 0; row < 9; row++) {
            for (let col = 0; col < 9; col++) {
                const wx = patch.x * 64 + col * 64;
                const wy = patch.y * 64 + row * 64;
                const wz = patch.baseZ + patch.heightmap[row][col] * 2;

                batch.positions.push(wx, wy, wz);

                // Bilinear interpolation of diffuse UV from the 4 patch corner UVs
                const fx = col / 8;
                const fy = row / 8;
                const texU = u00 * (1 - fx) * (1 - fy) + u10 * fx * (1 - fy) + u01 * (1 - fx) * fy + u11 * fx * fy;
                const texV = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
                batch.uvs.push(texU, texV);
                batch.uvs2.push(lmS0 + fx * lmSize, lmT0 + fy * lmSize);

                // Placeholder normal, computed below
                batch.normals.push(0, 0, 1);
            }
        }

        // Compute normals from heightmap (height scale=2, horizontal step=cellSize=64)
        for (let row = 0; row < 9; row++) {
            for (let col = 0; col < 9; col++) {
                const idx = baseVert + row * 9 + col;
                const h = patch.heightmap[row][col];

                const left = col > 0 ? patch.heightmap[row][col - 1] : h;
                const right = col < 8 ? patch.heightmap[row][col + 1] : h;
                const up = row > 0 ? patch.heightmap[row - 1][col] : h;
                const down = row < 8 ? patch.heightmap[row + 1][col] : h;

                const dx = (right - left) * 2;
                const dy = (down - up) * 2;
                const len = Math.sqrt(dx * dx + dy * dy + cellSize * cellSize);

                batch.normals[idx * 3] = -dx / len;
                batch.normals[idx * 3 + 1] = -dy / len;
                batch.normals[idx * 3 + 2] = cellSize / len;
            }
        }

        // Generate indices for 8x8 grid of quads
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const i0 = baseVert + row * 9 + col;
                const i1 = baseVert + row * 9 + col + 1;
                const i2 = baseVert + (row + 1) * 9 + col;
                const i3 = baseVert + (row + 1) * 9 + col + 1;

                batch.indices.push(i0, i2, i1);
                batch.indices.push(i1, i2, i3);
            }
        }
    }

    // Build one mesh per batch
    for (const [, batch] of batches) {
        if (batch.indices.length === 0) continue;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uvs, 2));
        geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(batch.uvs2, 2));
        // Add dummy vertex colors for terrain (white, since terrain uses lightmaps)
        const colors = new Float32Array((batch.positions.length / 3) * 3);
        colors.fill(1.0);
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(batch.normals, 3));
        geometry.setIndex(batch.indices);

        const lmTex = (batch.lightmapIndex >= 0 && batch.lightmapIndex < lightmaps.length) ? lightmaps[batch.lightmapIndex] : null;

        const q3mat = createQ3Material({
            vfs,
            shaderName: batch.shaderName,
            parsedShader: shaderParser.getShader(batch.shaderName),
            lightmapTexture: lmTex,
            forceRepeatWrap: true, // Terrain UVs are tiling coordinates; ignore shader clampmap
        });
        allMaterials.push(q3mat);

        const mesh = new THREE.Mesh(geometry, q3mat.material);
        mesh.frustumCulled = false; // Terrain meshes span the whole map
        group.add(mesh);
    }

    // Debug: log first few terrain patches UV data
    for (let i = 0; i < Math.min(3, patches.length); i++) {
        const p = patches[i];
        const sn = p.shaderIndex < shaderNames.length ? shaderNames[p.shaderIndex] : '?';
        console.log(`[TerrainUV] patch ${i}: shader="${sn}" lm=${p.lightmapIndex} flags=0x${p.flags.toString(16)} scale=${p.scale} x=${p.x} y=${p.y} baseZ=${p.baseZ}`);
        console.log(`  texCoords: [${p.texCoords.map(v => v.toFixed(4)).join(', ')}]`);
        console.log(`  lmCoords: [${p.lmCoords.join(', ')}]`);
        console.log(`  heightmap corners: [0,0]=${p.heightmap[0][0]} [0,8]=${p.heightmap[0][8]} [8,0]=${p.heightmap[8][0]} [8,8]=${p.heightmap[8][8]}`);
    }

    console.log(`Terrain: ${patches.length} patches batched into ${batches.size} draw calls`);
    return { group, materials: allMaterials };
}
