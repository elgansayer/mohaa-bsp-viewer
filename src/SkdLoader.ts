// MOHAA SKD (Skeletal Model) file loader
// Parses .skd binary files to extract mesh geometry
// Based on openmohaa tiki_skel.cpp and tiki_shared.h

const SKD_IDENT = 0x444D4B53; // "SKMD" in LE
const SKD_VERSION_5 = 5;
const SKD_VERSION_6 = 6;

export interface SkdVertex {
    normal: [number, number, number];
    texCoords: [number, number];
    numWeights: number;
    numMorphs: number;
    weights: SkdWeight[];
}

export interface SkdWeight {
    boneIndex: number;
    boneWeight: number;
    offset: [number, number, number];
}

export interface SkdTriangle {
    indices: [number, number, number];
}

export interface SkdSurface {
    name: string;
    numTriangles: number;
    numVerts: number;
    triangles: SkdTriangle[];
    vertices: SkdVertex[];
}

export interface SkdBone {
    parent: number;
    parentName: string;
    boxIndex: number;
    flags: number;
    boneType: number;
    offset: [number, number, number];
    worldOffset: [number, number, number];
    name: string;
}

export interface SkdModel {
    name: string;
    version: number;
    scale: number;
    numBones: number;
    bones: SkdBone[];
    surfaces: SkdSurface[];
}

// For static models, compute the rest-pose vertex positions
// Since we don't have animation data, we use the bone offsets directly
// The first weight's offset IS the vertex position for single-weighted verts
export interface StaticMesh {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    surfaceName: string;
}

export interface StaticMeshBakeStats {
    totalVerts: number;
    multiWeightVerts: number;
    zeroWeightVerts: number;
}

// ---- SKC (Skeleton Animation) loader ----
// Parses .skc files to extract rest-pose bone transforms (frame 0)
// Based on openmohaa skeletor_animation_file_format.h

const SKC_IDENT = 0x4E414B53; // "SKAN" in LE
const SKC_VERSION_13 = 13;
const SKC_VERSION_14 = 14;

export interface BoneTransform {
    // 3x3 rotation matrix (row-major)
    matrix: [number, number, number, number, number, number, number, number, number];
    offset: [number, number, number];
}

/**
 * Load a .skc animation file and return per-bone transforms at frame 0.
 * Matches openmohaa's TIKI_GetSkelAnimFrame + R_InitStaticModels vertex baking.
 */
export function loadSkc(buffer: ArrayBuffer, skdModel: SkdModel): Map<number, BoneTransform> | null {
    const view = new DataView(buffer);
    if (buffer.byteLength < 96) return null;

    const ident = view.getUint32(0, true);
    if (ident !== SKC_IDENT) return null;

    const version = view.getInt32(4, true);
    if (version !== SKC_VERSION_13 && version !== SKC_VERSION_14) return null;

    const numChannels = view.getInt32(36, true);
    const ofsChannelNames = view.getInt32(40, true);
    const numFrames = view.getInt32(44, true);
    if (numFrames < 1 || numChannels < 1) return null;

    // Frame 0 channel data offset
    const iOfsChannels = view.getInt32(92, true);

    // Read channel names (32-byte null-padded strings)
    const channels: { name: string; values: [number, number, number, number] }[] = [];
    for (let c = 0; c < numChannels; c++) {
        const nameOff = ofsChannelNames + c * 32;
        let end = nameOff;
        while (end < nameOff + 32 && end < buffer.byteLength && view.getUint8(end) !== 0) end++;
        const name = new TextDecoder().decode(new Uint8Array(buffer, nameOff, end - nameOff));

        const dataOff = iOfsChannels + c * 16;
        const values: [number, number, number, number] = [
            view.getFloat32(dataOff, true),
            view.getFloat32(dataOff + 4, true),
            view.getFloat32(dataOff + 8, true),
            view.getFloat32(dataOff + 12, true),
        ];
        channels.push({ name, values });
    }

    // Build name → channel data maps  (case-insensitive)
    const rotMap = new Map<string, [number, number, number, number]>();
    const posMap = new Map<string, [number, number, number, number]>();
    for (const ch of channels) {
        const lower = ch.name.toLowerCase();
        if (lower.endsWith(' rot')) {
            rotMap.set(lower.slice(0, -4), ch.values);
        } else if (lower.endsWith(' pos')) {
            posMap.set(lower.slice(0, -4), ch.values);
        }
    }

    // Resolve bone transforms in hierarchy order (parent before child).
    // Engine: bone.GetTransform chains parent transforms.
    // worldbone (implicit root) → identity.
    // boneType 0 (Rotation): quat from anim, pos from SKD baseData
    // boneType 1 (PosRot/Root): quat from anim, pos from anim
    const boneTransforms = new Map<number, BoneTransform>();

    // Implicit worldbone identity
    const identityTransform: BoneTransform = {
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        offset: [0, 0, 0],
    };

    // Process bones in hierarchy order (topological sort, parents first)
    const processed = new Set<number>();
    const resolve = (idx: number): BoneTransform => {
        if (boneTransforms.has(idx)) return boneTransforms.get(idx)!;

        const bone = skdModel.bones[idx];

        // Get parent transform
        let parentT = identityTransform;
        if (bone.parent >= 0 && bone.parent < skdModel.bones.length) {
            if (!processed.has(bone.parent)) resolve(bone.parent);
            parentT = boneTransforms.get(bone.parent) ?? identityTransform;
        }

        // Get local rotation from animation (quaternion)
        const boneNameLower = bone.name.toLowerCase();
        const rotQuat = rotMap.get(boneNameLower);

        // Get local position: boneType 1 = from anim, boneType 0 = from SKD baseData
        let localPos: [number, number, number] = [0, 0, 0];
        if (bone.boneType === 1) {
            const posData = posMap.get(boneNameLower);
            if (posData) localPos = [posData[0], posData[1], posData[2]];
        } else if (bone.boneType === 0) {
            // Rotation bone: position from baseData (already extracted)
            localPos = [bone.offset[0], bone.offset[1], bone.offset[2]];
        }

        // Build local 3x3 matrix from quaternion
        let lm: [number, number, number, number, number, number, number, number, number];
        if (rotQuat) {
            const [x, y, z, w] = rotQuat;
            const x2 = x + x, y2 = y + y, z2 = z + z;
            const xx = x * x2, xy = x * y2, xz = x * z2;
            const yy = y * y2, yz = y * z2, zz = z * z2;
            const wx = w * x2, wy = w * y2, wz = w * z2;
            lm = [
                1 - (yy + zz), xy - wz, xz + wy,
                xy + wz, 1 - (xx + zz), yz - wx,
                xz - wy, yz + wx, 1 - (xx + yy),
            ];
        } else {
            lm = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // identity
        }

        // Compose: worldTransform = localTransform * parentTransform
        // Engine does: m_cachedValue.Multiply(incomingValue, m_parent->GetTransform())
        // SkelMat4::Multiply(A, B) = A * B (matrix multiply)
        // Result matrix = local_matrix * parent_matrix
        // Result offset = local_pos * parent_matrix + parent_offset
        const pm = parentT.matrix;
        const po = parentT.offset;

        const wm: [number, number, number, number, number, number, number, number, number] = [
            lm[0] * pm[0] + lm[1] * pm[3] + lm[2] * pm[6],
            lm[0] * pm[1] + lm[1] * pm[4] + lm[2] * pm[7],
            lm[0] * pm[2] + lm[1] * pm[5] + lm[2] * pm[8],

            lm[3] * pm[0] + lm[4] * pm[3] + lm[5] * pm[6],
            lm[3] * pm[1] + lm[4] * pm[4] + lm[5] * pm[7],
            lm[3] * pm[2] + lm[4] * pm[5] + lm[5] * pm[8],

            lm[6] * pm[0] + lm[7] * pm[3] + lm[8] * pm[6],
            lm[6] * pm[1] + lm[7] * pm[4] + lm[8] * pm[7],
            lm[6] * pm[2] + lm[7] * pm[5] + lm[8] * pm[8],
        ];

        const wo: [number, number, number] = [
            localPos[0] * pm[0] + localPos[1] * pm[3] + localPos[2] * pm[6] + po[0],
            localPos[0] * pm[1] + localPos[1] * pm[4] + localPos[2] * pm[7] + po[1],
            localPos[0] * pm[2] + localPos[1] * pm[5] + localPos[2] * pm[8] + po[2],
        ];

        const t: BoneTransform = { matrix: wm, offset: wo };
        boneTransforms.set(idx, t);
        processed.add(idx);
        return t;
    };

    for (let i = 0; i < skdModel.bones.length; i++) {
        resolve(i);
    }

    return boneTransforms;
}

function readString(view: DataView, offset: number, maxLen: number): string {
    let end = offset;
    while (end < offset + maxLen && view.getUint8(end) !== 0) end++;
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(new Uint8Array(view.buffer, view.byteOffset + offset, end - offset));
}

export function loadSkd(buffer: ArrayBuffer): SkdModel | null {
    const view = new DataView(buffer);

    if (buffer.byteLength < 16) return null;

    const ident = view.getUint32(0, true);
    if (ident !== SKD_IDENT) {
        console.warn(`SKD: invalid ident 0x${ident.toString(16)}, expected 0x${SKD_IDENT.toString(16)}`);
        return null;
    }

    const version = view.getInt32(4, true);
    if (version !== SKD_VERSION_5 && version !== SKD_VERSION_6) {
        console.warn(`SKD: unsupported version ${version}`);
        return null;
    }

    const name = readString(view, 8, 64);
    const numSurfaces = view.getInt32(72, true);
    const numBones = view.getInt32(76, true);
    const ofsBones = view.getInt32(80, true);
    const ofsSurfaces = view.getInt32(84, true);
    // ofsEnd at 88
    // lodIndex[10] at 92 (40 bytes)
    // numBoxes at 132
    // ofsBoxes at 136
    // numMorphTargets at 140
    // ofsMorphTargets at 144
    // scale at 148 (version 6+)

    let scale = 0.52; // default scale
    if (version >= SKD_VERSION_6) {
        scale = view.getFloat32(148, true) * 0.52;
    }

    // Parse bones from variable-size boneFileData records.
    // Layout in OpenMOHAA skeletor_model_file_format.h:
    // name[32], parent[32], boneType(int), ofsBaseData(int), ofsChannelNames(int), ofsBoneNames(int), ofsEnd(int)
    const bones: SkdBone[] = [];
    let boff = ofsBones;
    for (let i = 0; i < numBones; i++) {
        const name = readString(view, boff, 32);
        const parentName = readString(view, boff + 32, 32);
        const boneType = view.getInt32(boff + 64, true);
        const ofsBaseData = view.getInt32(boff + 68, true);
        const ofsEnd = view.getInt32(boff + 80, true);

        const offset: [number, number, number] = [0, 0, 0];
        const base = boff + ofsBaseData;

        // Match OpenMOHAA LoadBoneFromBuffer2 offset extraction.
        if (boneType === 0) {
            offset[0] = view.getFloat32(base, true);
            offset[1] = view.getFloat32(base + 4, true);
            offset[2] = view.getFloat32(base + 8, true);
        } else if (boneType === 2) {
            offset[0] = view.getFloat32(base + 16, true);
            offset[1] = view.getFloat32(base + 20, true);
            offset[2] = view.getFloat32(base + 24, true);
        } else if (boneType === 6) {
            offset[0] = view.getFloat32(base + 4, true);
            offset[1] = view.getFloat32(base + 8, true);
            offset[2] = view.getFloat32(base + 12, true);
        } else if (boneType === 5 || boneType === 10 || boneType === 11) {
            offset[0] = view.getFloat32(base + 12, true);
            offset[1] = view.getFloat32(base + 16, true);
            offset[2] = view.getFloat32(base + 20, true);
        }

        bones.push({
            parent: -1,
            parentName,
            boxIndex: 0,
            flags: 0,
            boneType,
            offset,
            worldOffset: [0, 0, 0],
            name,
        });

        if (ofsEnd <= 0) {
            break;
        }
        boff += ofsEnd;
    }

    const boneIndexByName = new Map<string, number>();
    for (let i = 0; i < bones.length; i++) {
        boneIndexByName.set(bones[i].name.toLowerCase(), i);
    }

    for (const bone of bones) {
        const parentKey = bone.parentName.toLowerCase();
        if (parentKey === 'worldbone' || parentKey.length === 0) {
            bone.parent = -1;
        } else {
            bone.parent = boneIndexByName.get(parentKey) ?? -1;
        }
    }

    const resolveWorldOffset = (index: number, stack = new Set<number>()): [number, number, number] => {
        const b = bones[index];
        if (b.worldOffset[0] !== 0 || b.worldOffset[1] !== 0 || b.worldOffset[2] !== 0) {
            return b.worldOffset;
        }

        if (b.parent < 0 || b.parent >= bones.length || stack.has(index)) {
            b.worldOffset = [b.offset[0], b.offset[1], b.offset[2]];
            return b.worldOffset;
        }

        stack.add(index);
        const p = resolveWorldOffset(b.parent, stack);
        b.worldOffset = [p[0] + b.offset[0], p[1] + b.offset[1], p[2] + b.offset[2]];
        stack.delete(index);
        return b.worldOffset;
    };

    for (let i = 0; i < bones.length; i++) {
        resolveWorldOffset(i);
    }

    // Parse surfaces
    const surfaces: SkdSurface[] = [];
    let surfOffset = ofsSurfaces;

    for (let s = 0; s < numSurfaces; s++) {
        // skelSurface_t:
        // int ident(4) + char name[64](64) + int numTriangles(4) + int numVerts(4)
        // + int staticSurfProcessed(4) + int ofsTriangles(4) + int ofsVerts(4)
        // + int ofsCollapse(4) + int ofsEnd(4) + int ofsCollapseIndex(4) = 96
        const surfIdent = view.getInt32(surfOffset, true);
        const surfName = readString(view, surfOffset + 4, 64);
        const numTriangles = view.getInt32(surfOffset + 68, true);
        const numVerts = view.getInt32(surfOffset + 72, true);
        const ofsTriangles = view.getInt32(surfOffset + 80, true);
        const ofsVerts = view.getInt32(surfOffset + 84, true);
        const ofsEnd = view.getInt32(surfOffset + 92, true);

        // Parse triangles
        const triangles: SkdTriangle[] = [];
        const triBase = surfOffset + ofsTriangles;
        for (let t = 0; t < numTriangles; t++) {
            triangles.push({
                indices: [
                    view.getInt32(triBase + t * 12, true),
                    view.getInt32(triBase + t * 12 + 4, true),
                    view.getInt32(triBase + t * 12 + 8, true),
                ],
            });
        }

        // Parse vertices.
        // OpenMOHAA caches SKD vertices as skeletorVertex_t for both v5 and v6:
        // normal(12) + texCoords(8) + numWeights(4) + numMorphs(4) = 28 bytes,
        // followed by numMorphs * 16-byte morph entries and numWeights * 20-byte
        // skelWeight_t entries.
        const vertices: SkdVertex[] = [];
        let voff = surfOffset + ofsVerts;

        for (let v = 0; v < numVerts; v++) {
            const nx = view.getFloat32(voff, true);
            const ny = view.getFloat32(voff + 4, true);
            const nz = view.getFloat32(voff + 8, true);
            const u = view.getFloat32(voff + 12, true);
            const vtc = view.getFloat32(voff + 16, true);
            const numWeights = view.getInt32(voff + 20, true);
            const numMorphs = view.getInt32(voff + 24, true);

            voff += 28; // sizeof(skeletorVertex_t)
            // Skip morphs (each morph: int morphIndex(4) + vec3_t offset(12) = 16)
            voff += numMorphs * 16;

            // Parse weights
            const weights: SkdWeight[] = [];
            for (let w = 0; w < numWeights; w++) {
                weights.push({
                    boneIndex: view.getInt32(voff, true),
                    boneWeight: view.getFloat32(voff + 4, true),
                    offset: [
                        view.getFloat32(voff + 8, true),
                        view.getFloat32(voff + 12, true),
                        view.getFloat32(voff + 16, true),
                    ],
                });
                voff += 20; // sizeof(skelWeight_t)
            }

            vertices.push({
                normal: [nx, ny, nz],
                texCoords: [u, vtc],
                numWeights,
                numMorphs,
                weights,
            });
        }

        surfaces.push({ name: surfName, numTriangles, numVerts, triangles, vertices });
        surfOffset += ofsEnd;
    }

    return { name, version, scale, numBones, bones, surfaces };
}

// Convert SKD model to static mesh data (for BSP static models)
// Match openmohaa static bake path:
//   pos = (weight.offset * bone.matrix + bone.offset) * boneWeight
// When boneTransforms is provided (from SKC), applies full bone rotation.
// Without it, falls back to additive offsets only.
export function skdToStaticMeshes(model: SkdModel, boneTransforms?: Map<number, BoneTransform> | null): StaticMesh[] {
    const meshes: StaticMesh[] = [];

    for (const surface of model.surfaces) {
        const positions = new Float32Array(surface.numVerts * 3);
        const normals = new Float32Array(surface.numVerts * 3);
        const uvs = new Float32Array(surface.numVerts * 2);

        for (let i = 0; i < surface.numVerts; i++) {
            const vert = surface.vertices[i];

            const first = vert.weights[0];
            if (first) {
                const bt = boneTransforms?.get(first.boneIndex);
                if (bt) {
                    // Engine path: pos = (weight.offset * bone.matrix + bone.offset) * boneWeight
                    const wx = first.offset[0], wy = first.offset[1], wz = first.offset[2];
                    const m = bt.matrix;
                    positions[i * 3]     = (wx * m[0] + wy * m[3] + wz * m[6] + bt.offset[0]) * first.boneWeight;
                    positions[i * 3 + 1] = (wx * m[1] + wy * m[4] + wz * m[7] + bt.offset[1]) * first.boneWeight;
                    positions[i * 3 + 2] = (wx * m[2] + wy * m[5] + wz * m[8] + bt.offset[2]) * first.boneWeight;
                } else {
                    // Fallback: additive offsets (no rotation)
                    const bone = model.bones[first.boneIndex];
                    const bx = bone ? bone.worldOffset[0] : 0;
                    const by = bone ? bone.worldOffset[1] : 0;
                    const bz = bone ? bone.worldOffset[2] : 0;

                    positions[i * 3] = (first.offset[0] + bx) * first.boneWeight;
                    positions[i * 3 + 1] = (first.offset[1] + by) * first.boneWeight;
                    positions[i * 3 + 2] = (first.offset[2] + bz) * first.boneWeight;
                }
            } else {
                positions[i * 3] = 0;
                positions[i * 3 + 1] = 0;
                positions[i * 3 + 2] = 0;
            }

            // Also rotate normals by bone matrix if available
            const nFirst = vert.weights[0];
            const nBt = nFirst ? boneTransforms?.get(nFirst.boneIndex) : undefined;
            if (nBt) {
                const nx = vert.normal[0], ny = vert.normal[1], nz = vert.normal[2];
                const m = nBt.matrix;
                normals[i * 3]     = nx * m[0] + ny * m[3] + nz * m[6];
                normals[i * 3 + 1] = nx * m[1] + ny * m[4] + nz * m[7];
                normals[i * 3 + 2] = nx * m[2] + ny * m[5] + nz * m[8];
            } else {
                normals[i * 3] = vert.normal[0];
                normals[i * 3 + 1] = vert.normal[1];
                normals[i * 3 + 2] = vert.normal[2];
            }

            uvs[i * 2] = vert.texCoords[0];
            uvs[i * 2 + 1] = vert.texCoords[1];
        }

        // Build index array
        const indices = new Uint32Array(surface.numTriangles * 3);
        for (let i = 0; i < surface.numTriangles; i++) {
            indices[i * 3] = surface.triangles[i].indices[0];
            indices[i * 3 + 1] = surface.triangles[i].indices[1];
            indices[i * 3 + 2] = surface.triangles[i].indices[2];
        }

        meshes.push({
            positions,
            normals,
            uvs,
            indices,
            surfaceName: surface.name,
        });
    }

    return meshes;
}

export function getSkdStaticBakeStats(model: SkdModel): StaticMeshBakeStats {
    let totalVerts = 0;
    let multiWeightVerts = 0;
    let zeroWeightVerts = 0;

    for (const surface of model.surfaces) {
        for (const vert of surface.vertices) {
            totalVerts++;
            if (vert.numWeights <= 0 || vert.weights.length === 0) {
                zeroWeightVerts++;
            } else if (vert.numWeights > 1) {
                multiWeightVerts++;
            }
        }
    }

    return { totalVerts, multiWeightVerts, zeroWeightVerts };
}
