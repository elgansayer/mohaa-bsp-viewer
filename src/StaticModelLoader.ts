// MOHAA Static Model Loader
// Loads TIKI + SKD models referenced by BSP static model definitions
// Based on openmohaa tr_staticmodels.cpp R_InitStaticModels

import * as THREE from 'three';
import { VirtualFileSystem } from './VirtualFileSystem';
import { ShaderParser } from './ShaderParser';
import { parseTiki, TikiDef } from './TikiParser';
import { loadSkd, skdToStaticMeshes, getSkdStaticBakeStats, SkdModel, StaticMesh, loadSkc, BoneTransform } from './SkdLoader';
import { createQ3Material, loadTexture } from './Q3ShaderMaterial';

interface StaticModelDef {
    model: string;
    origin: [number, number, number];
    angles: [number, number, number];
    scale: number;
}

// Cache loaded TIKIs and SKDs
const tikiCache = new Map<string, TikiDef | null>();
const skdCache = new Map<string, SkdModel | null>();
const skcCache = new Map<string, ArrayBuffer | null>();


function getStaticDebugMaterialEnabled(): boolean {
    const g = globalThis as { __viewerDebugForceStaticSolid?: boolean };
    return g.__viewerDebugForceStaticSolid === true;
}

export async function loadStaticModels(
    models: StaticModelDef[],
    vfs: VirtualFileSystem,
    shaderParser: ShaderParser,
    statusCallback?: (msg: string) => void
): Promise<THREE.Group> {
    const group = new THREE.Group();
    // Keep this group in MOHAA space; caller applies the single world-space
    // Z-up -> Y-up conversion when attaching to the scene.

    let totalInstances = 0;
    let invalidInstances = 0;
    let minScale = Number.POSITIVE_INFINITY;
    let maxScale = Number.NEGATIVE_INFINITY;
    const minOrigin = new THREE.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const maxOrigin = new THREE.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);

    // Group by model name for efficiency
    const modelGroups = new Map<string, StaticModelDef[]>();
    for (const model of models) {
        const key = model.model.toLowerCase();
        if (!modelGroups.has(key)) modelGroups.set(key, []);
        modelGroups.get(key)!.push(model);
    }

    let loaded = 0;
    const total = modelGroups.size;

    for (const [modelName, instances] of modelGroups) {
        loaded++;
        if (statusCallback && loaded % 10 === 0) {
            statusCallback(`Loading static models: ${loaded}/${total}`);
        }

        try {
            console.log(`Trying to load model template: ${modelName}`);
            const meshTemplate = await loadModelTemplate(modelName, vfs, shaderParser);
            if (!meshTemplate) {
                console.warn(`Failed to load template for: ${modelName}`);
                continue;
            }

            for (const inst of instances) {
                const clone = meshTemplate.clone();
                totalInstances++;
                minScale = Math.min(minScale, inst.scale);
                maxScale = Math.max(maxScale, inst.scale);
                minOrigin.min(new THREE.Vector3(inst.origin[0], inst.origin[1], inst.origin[2]));
                maxOrigin.max(new THREE.Vector3(inst.origin[0], inst.origin[1], inst.origin[2]));

                // Apply transform in MOHAA space; caller performs the single
                // MOHAA->Three world conversion on the parent group.
                // openmohaa uses AngleVectorsLeft(angles, axis[0], axis[1], axis[2]).
                clone.position.set(inst.origin[0], inst.origin[1], inst.origin[2]);
                const pitch = (inst.angles[0] * Math.PI) / 180;
                const yaw = (inst.angles[1] * Math.PI) / 180;
                const roll = (inst.angles[2] * Math.PI) / 180;

                const sp = Math.sin(pitch), cp = Math.cos(pitch);
                const sy = Math.sin(yaw), cy = Math.cos(yaw);
                const sr = Math.sin(roll), cr = Math.cos(roll);

                const forward = new THREE.Vector3(cp * cy, cp * sy, -sp);
                const left = new THREE.Vector3(
                    sr * sp * cy + cr * -sy,
                    sr * sp * sy + cr * cy,
                    sr * cp
                );
                const up = new THREE.Vector3(
                    cr * sp * cy + -sr * -sy,
                    cr * sp * sy + -sr * cy,
                    cr * cp
                );

                const basis = new THREE.Matrix4().makeBasis(forward, left, up);
                clone.quaternion.setFromRotationMatrix(basis);

                clone.scale.setScalar(inst.scale);

                group.add(clone);
            }
        } catch (e) {
            console.error(`Error loading model ${modelName}:`, e);
        }
    }

    if (totalInstances > 0) {
        const summary = {
            instances: totalInstances,
            invalidInstances,
            minScale,
            maxScale,
            originMin: [minOrigin.x, minOrigin.y, minOrigin.z],
            originMax: [maxOrigin.x, maxOrigin.y, maxOrigin.z],
        };
        console.log('Static model summary:', summary);
        console.log('Static model summary JSON:', JSON.stringify(summary));
    }

    return group;
}

async function loadModelTemplate(
    modelPath: string,
    vfs: VirtualFileSystem,
    shaderParser: ShaderParser
): Promise<THREE.Group | null> {
    // Normalize path
    let tikiPath = modelPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    tikiPath = tikiPath.replace(/^\/+/, '');
    if (!tikiPath.startsWith('models/')) {
        tikiPath = 'models/' + tikiPath;
    }
    tikiPath = tikiPath.replace(/\/{2,}/g, '/');
    if (!/\.tik$/i.test(tikiPath)) {
        tikiPath += '.tik';
    }

    // Load TIKI
    let tiki: TikiDef | null;
    const tikiKey = tikiPath.toLowerCase();
    if (tikiCache.has(tikiKey)) {
        tiki = tikiCache.get(tikiKey)!;
    } else {
        tiki = await parseTiki(vfs, tikiPath);
        if (!tiki) {
            tiki = await parseTiki(vfs, tikiPath.replace(/\.tik$/i, '.tiki'));
        }
        tikiCache.set(tikiKey, tiki);
    }

    if (!tiki) {
        console.warn(`parseTiki returned null for ${tikiPath}`);
        return null;
    }
    if (tiki.skelModels.length === 0) {
        console.warn(`Tiki ${tikiPath} has no skelModels`);
        return null;
    }

    const group = new THREE.Group();

    // Build a name→shader map from TIKI surfaces for correct name-based lookup.
    // OpenMOHAA matches TIKI surface declarations to SKD surfaces BY NAME, not position.
    // Also support "all" surface name which applies to every SKD surface.
    const tikiSurfaceMap = new Map<string, string>();
    let allSurfaceShader = '';
    for (const surf of tiki.surfaces) {
        if (surf.shaders.length > 0) {
            if (surf.name.toLowerCase() === 'all') {
                allSurfaceShader = surf.shaders[0];
            } else {
                tikiSurfaceMap.set(surf.name.toLowerCase(), surf.shaders[0]);
            }
        }
    }

    for (const skelPath of tiki.skelModels) {
        // Load SKD
        const skdKey = skelPath.toLowerCase();
        let skdModel: SkdModel | null;

        if (skdCache.has(skdKey)) {
            skdModel = skdCache.get(skdKey)!;
        } else {
            const skdData = await vfs.getFile(skelPath);
            if (!skdData) {
                skdCache.set(skdKey, null);
                continue;
            }
            skdModel = loadSkd(skdData);
            skdCache.set(skdKey, skdModel);
        }

        if (!skdModel) continue;

        // Load SKC animation for rest-pose bone transforms
        let boneTransforms: Map<number, BoneTransform> | null = null;
        if (tiki.firstSkcPath) {
            const skcKey = tiki.firstSkcPath.toLowerCase();
            let skcBuffer: ArrayBuffer | null | undefined;
            if (skcCache.has(skcKey)) {
                skcBuffer = skcCache.get(skcKey);
            } else {
                skcBuffer = await vfs.getFile(tiki.firstSkcPath) ?? null;
                skcCache.set(skcKey, skcBuffer);
            }
            if (skcBuffer) {
                boneTransforms = loadSkc(skcBuffer, skdModel);
            }
        }

        const bakeStats = getSkdStaticBakeStats(skdModel);
        if (bakeStats.multiWeightVerts > 0 || bakeStats.zeroWeightVerts > 0) {
            console.log('SKD static bake stats:', {
                skd: skelPath,
                totalVerts: bakeStats.totalVerts,
                multiWeightVerts: bakeStats.multiWeightVerts,
                zeroWeightVerts: bakeStats.zeroWeightVerts,
            });
        }

        const staticMeshes = skdToStaticMeshes(skdModel, boneTransforms);

        for (const staticMesh of staticMeshes) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(staticMesh.positions, 3));
            geometry.setAttribute('normal', new THREE.BufferAttribute(staticMesh.normals, 3));
            geometry.setAttribute('uv', new THREE.BufferAttribute(staticMesh.uvs, 2));
            geometry.setIndex(new THREE.BufferAttribute(staticMesh.indices, 1));

            // Add dummy vertex colors (white) for material compatibility
            const numVerts = staticMesh.positions.length / 3;
            const colors = new Float32Array(numVerts * 3);
            colors.fill(1.0);
            geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
            geometry.setAttribute('uv1', new THREE.BufferAttribute(staticMesh.uvs.slice(), 2));

            // Match OpenMOHAA TIKI_LoadTikiModel: shaders are matched by NAME.
            // 1. Try exact name match from TIKI surface declarations
            // 2. Try "all" surface wildcard
            // 3. Fallback: use surface name as shader (OpenMOHAA 2.0 behavior)
            const surfKey = staticMesh.surfaceName.toLowerCase();
            let shaderName = tikiSurfaceMap.get(surfKey) ?? '';
            if (!shaderName && allSurfaceShader) {
                shaderName = allSurfaceShader;
            }
            if (!shaderName && staticMesh.surfaceName) {
                shaderName = staticMesh.surfaceName;
            }

            // Use Q3 material system for proper rendering
            let material: THREE.Material;
            if (getStaticDebugMaterialEnabled()) {
                material = new THREE.MeshBasicMaterial({
                    color: 0x00ff66,
                    wireframe: true,
                    depthTest: false,
                    depthWrite: false,
                    transparent: true,
                    opacity: 0.95,
                    side: THREE.DoubleSide,
                });
            } else if (shaderName) {
                const parsedShader = shaderParser.getShader(shaderName);
                const q3mat = createQ3Material({
                    vfs,
                    shaderName,
                    parsedShader,
                    lightmapTexture: null, // Static models don't use lightmaps
                    vertexColors: false,
                });
                material = q3mat.material;
            } else {
                material = new THREE.MeshBasicMaterial({
                    color: 0xffffff,
                    side: THREE.DoubleSide,
                });
            }

            // Temporary deep-dive fallback: keep static meshes visible even if
            // there is still a winding/handedness mismatch in part of the pipeline.
            if ((material as THREE.Material).side !== THREE.DoubleSide) {
                (material as THREE.Material).side = THREE.DoubleSide;
                (material as THREE.Material).needsUpdate = true;
            }

            const mesh = new THREE.Mesh(geometry, material);

            // Match OpenMOHAA R_RotateForStaticModel:
            //   tiki_scale = tiki->load_scale * SM->scale  (applied via mesh.scale + parent group scale)
            //   Model matrix translation = SM->origin only (no load_origin offset)
            // load_origin is used for culling only, NOT vertex positioning.
            mesh.scale.setScalar(tiki.scale);

            group.add(mesh);
        }
    }

    return group.children.length > 0 ? group : null;
}
