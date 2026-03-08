// BSP Visibility system
// Uses PVS (Potentially Visible Set) and frustum culling
// to determine which parts of the map are visible

import * as THREE from 'three';
import { BspData, BspNode, BspLeaf, BspPlane, VisData, findLeaf, clusterVisible } from './BspParser';

export class BspVisibility {
    private bsp: BspData;
    private frustum = new THREE.Frustum();
    private projScreenMatrix = new THREE.Matrix4();
    private lastCluster = -2; // -2 = never computed
    private visibleLeaves: Set<number> = new Set();
    private leafSurfaceVisible: Set<number> = new Set();

    constructor(bsp: BspData) {
        this.bsp = bsp;
    }

    // Update visibility based on camera position
    // Returns the set of visible surface indices
    update(camera: THREE.Camera): { cluster: number; visibleSurfaces: Set<number>; leafCount: number } {
        // Get camera position in MOHAA coordinates
        // Three.js: X=right, Y=up, Z=-forward (after -90 X rotation)
        // MOHAA: X=right, Y=forward, Z=up
        const mx = camera.position.x;
        const my = -camera.position.z;
        const mz = camera.position.y;

        const leafIdx = findLeaf(
            [mx, my, mz],
            this.bsp.nodes,
            this.bsp.leaves,
            this.bsp.planes
        );

        const leaf = leafIdx >= 0 && leafIdx < this.bsp.leaves.length
            ? this.bsp.leaves[leafIdx]
            : null;
        const cluster = leaf?.cluster ?? -1;

        // Only recompute PVS if cluster changed
        if (cluster !== this.lastCluster) {
            this.lastCluster = cluster;
            this.visibleLeaves.clear();
            this.leafSurfaceVisible.clear();

            if (!this.bsp.visData || cluster < 0) {
                // No PVS or outside world - mark everything visible
                for (let i = 0; i < this.bsp.leaves.length; i++) {
                    this.visibleLeaves.add(i);
                }
            } else {
                // Mark leaves whose clusters are visible from current cluster
                for (let i = 0; i < this.bsp.leaves.length; i++) {
                    const otherLeaf = this.bsp.leaves[i];
                    if (otherLeaf.cluster < 0) continue;
                    if (clusterVisible(this.bsp.visData, cluster, otherLeaf.cluster)) {
                        this.visibleLeaves.add(i);
                    }
                }
            }

            // Build set of visible surface indices from visible leaves
            for (const li of this.visibleLeaves) {
                const l = this.bsp.leaves[li];
                for (let si = 0; si < l.numLeafSurfaces; si++) {
                    const surfIdx = this.bsp.leafSurfaces[l.firstLeafSurface + si];
                    if (surfIdx !== undefined) {
                        this.leafSurfaceVisible.add(surfIdx);
                    }
                }
            }
        }

        return {
            cluster,
            visibleSurfaces: this.leafSurfaceVisible,
            leafCount: this.visibleLeaves.size,
        };
    }

    // Check if a bounding box (in MOHAA coordinates) is potentially visible
    isBoxVisible(mins: [number, number, number], maxs: [number, number, number]): boolean {
        // Simple check: see if any leaf overlapping this box is visible
        for (const li of this.visibleLeaves) {
            const leaf = this.bsp.leaves[li];
            // AABB overlap test
            if (mins[0] <= leaf.maxs[0] && maxs[0] >= leaf.mins[0] &&
                mins[1] <= leaf.maxs[1] && maxs[1] >= leaf.mins[1] &&
                mins[2] <= leaf.maxs[2] && maxs[2] >= leaf.mins[2]) {
                return true;
            }
        }
        return false;
    }

    getVisibleLeafCount(): number {
        return this.visibleLeaves.size;
    }

    getTotalLeafCount(): number {
        return this.bsp.leaves.length;
    }
}
