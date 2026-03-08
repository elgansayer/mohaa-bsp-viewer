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
// Match openmohaa static bake path: use the first weight entry for static xyz.
export function skdToStaticMeshes(model: SkdModel): StaticMesh[] {
    const meshes: StaticMesh[] = [];

    for (const surface of model.surfaces) {
        const positions = new Float32Array(surface.numVerts * 3);
        const normals = new Float32Array(surface.numVerts * 3);
        const uvs = new Float32Array(surface.numVerts * 2);

        for (let i = 0; i < surface.numVerts; i++) {
            const vert = surface.vertices[i];

            const first = vert.weights[0];
            if (first) {
                const bone = model.bones[first.boneIndex];
                const bx = bone ? bone.worldOffset[0] : 0;
                const by = bone ? bone.worldOffset[1] : 0;
                const bz = bone ? bone.worldOffset[2] : 0;

                positions[i * 3] = (first.offset[0] + bx) * first.boneWeight;
                positions[i * 3 + 1] = (first.offset[1] + by) * first.boneWeight;
                positions[i * 3 + 2] = (first.offset[2] + bz) * first.boneWeight;
            } else {
                positions[i * 3] = 0;
                positions[i * 3 + 1] = 0;
                positions[i * 3 + 2] = 0;
            }

            normals[i * 3] = vert.normal[0];
            normals[i * 3 + 1] = vert.normal[1];
            normals[i * 3 + 2] = vert.normal[2];

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
