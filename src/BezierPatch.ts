// Bezier patch tessellation for Q3/MOHAA BSP MST_PATCH surfaces
// Based on openmohaa tr_curve.c R_SubdividePatchToGrid

export interface PatchVert {
    xyz: [number, number, number];
    st: [number, number];
    lightmap: [number, number];
    normal: [number, number, number];
    color: [number, number, number, number]; // RGBA 0-255
}

export interface TessellatedPatch {
    verts: PatchVert[];
    indices: number[];
    width: number;
    height: number;
}

const MAX_GRID_SIZE = 129;

function lerpVert(a: PatchVert, b: PatchVert): PatchVert {
    return {
        xyz: [
            0.5 * (a.xyz[0] + b.xyz[0]),
            0.5 * (a.xyz[1] + b.xyz[1]),
            0.5 * (a.xyz[2] + b.xyz[2]),
        ],
        st: [
            0.5 * (a.st[0] + b.st[0]),
            0.5 * (a.st[1] + b.st[1]),
        ],
        lightmap: [
            0.5 * (a.lightmap[0] + b.lightmap[0]),
            0.5 * (a.lightmap[1] + b.lightmap[1]),
        ],
        normal: [
            0.5 * (a.normal[0] + b.normal[0]),
            0.5 * (a.normal[1] + b.normal[1]),
            0.5 * (a.normal[2] + b.normal[2]),
        ],
        color: [
            (a.color[0] + b.color[0]) >> 1,
            (a.color[1] + b.color[1]) >> 1,
            (a.color[2] + b.color[2]) >> 1,
            (a.color[3] + b.color[3]) >> 1,
        ],
    };
}

function copyVert(v: PatchVert): PatchVert {
    return {
        xyz: [v.xyz[0], v.xyz[1], v.xyz[2]],
        st: [v.st[0], v.st[1]],
        lightmap: [v.lightmap[0], v.lightmap[1]],
        normal: [v.normal[0], v.normal[1], v.normal[2]],
        color: [v.color[0], v.color[1], v.color[2], v.color[3]],
    };
}

// Simple fixed-level tessellation of a 3x3 bezier patch into a grid
function evaluateBiquadratic(
    controls: PatchVert[], // 9 control points (3x3)
    tessLevel: number
): { verts: PatchVert[]; width: number; height: number } {
    const L = tessLevel + 1;
    const verts: PatchVert[] = new Array(L * L);

    for (let i = 0; i <= tessLevel; i++) {
        const a = i / tessLevel;
        const b0 = (1 - a) * (1 - a);
        const b1 = 2 * (1 - a) * a;
        const b2 = a * a;

        // Evaluate 3 column control points at parameter a
        const temp: PatchVert[] = [];
        for (let col = 0; col < 3; col++) {
            const p0 = controls[col];
            const p1 = controls[3 + col];
            const p2 = controls[6 + col];
            temp.push({
                xyz: [
                    b0 * p0.xyz[0] + b1 * p1.xyz[0] + b2 * p2.xyz[0],
                    b0 * p0.xyz[1] + b1 * p1.xyz[1] + b2 * p2.xyz[1],
                    b0 * p0.xyz[2] + b1 * p1.xyz[2] + b2 * p2.xyz[2],
                ],
                st: [
                    b0 * p0.st[0] + b1 * p1.st[0] + b2 * p2.st[0],
                    b0 * p0.st[1] + b1 * p1.st[1] + b2 * p2.st[1],
                ],
                lightmap: [
                    b0 * p0.lightmap[0] + b1 * p1.lightmap[0] + b2 * p2.lightmap[0],
                    b0 * p0.lightmap[1] + b1 * p1.lightmap[1] + b2 * p2.lightmap[1],
                ],
                normal: [
                    b0 * p0.normal[0] + b1 * p1.normal[0] + b2 * p2.normal[0],
                    b0 * p0.normal[1] + b1 * p1.normal[1] + b2 * p2.normal[1],
                    b0 * p0.normal[2] + b1 * p1.normal[2] + b2 * p2.normal[2],
                ],
                color: [
                    Math.round(b0 * p0.color[0] + b1 * p1.color[0] + b2 * p2.color[0]),
                    Math.round(b0 * p0.color[1] + b1 * p1.color[1] + b2 * p2.color[1]),
                    Math.round(b0 * p0.color[2] + b1 * p1.color[2] + b2 * p2.color[2]),
                    Math.round(b0 * p0.color[3] + b1 * p1.color[3] + b2 * p2.color[3]),
                ],
            });
        }

        for (let j = 0; j <= tessLevel; j++) {
            const c = j / tessLevel;
            const c0 = (1 - c) * (1 - c);
            const c1 = 2 * (1 - c) * c;
            const c2 = c * c;

            verts[i * L + j] = {
                xyz: [
                    c0 * temp[0].xyz[0] + c1 * temp[1].xyz[0] + c2 * temp[2].xyz[0],
                    c0 * temp[0].xyz[1] + c1 * temp[1].xyz[1] + c2 * temp[2].xyz[1],
                    c0 * temp[0].xyz[2] + c1 * temp[1].xyz[2] + c2 * temp[2].xyz[2],
                ],
                st: [
                    c0 * temp[0].st[0] + c1 * temp[1].st[0] + c2 * temp[2].st[0],
                    c0 * temp[0].st[1] + c1 * temp[1].st[1] + c2 * temp[2].st[1],
                ],
                lightmap: [
                    c0 * temp[0].lightmap[0] + c1 * temp[1].lightmap[0] + c2 * temp[2].lightmap[0],
                    c0 * temp[0].lightmap[1] + c1 * temp[1].lightmap[1] + c2 * temp[2].lightmap[1],
                ],
                normal: [
                    c0 * temp[0].normal[0] + c1 * temp[1].normal[0] + c2 * temp[2].normal[0],
                    c0 * temp[0].normal[1] + c1 * temp[1].normal[1] + c2 * temp[2].normal[1],
                    c0 * temp[0].normal[2] + c1 * temp[1].normal[2] + c2 * temp[2].normal[2],
                ],
                color: [
                    Math.round(c0 * temp[0].color[0] + c1 * temp[1].color[0] + c2 * temp[2].color[0]),
                    Math.round(c0 * temp[0].color[1] + c1 * temp[1].color[1] + c2 * temp[2].color[1]),
                    Math.round(c0 * temp[0].color[2] + c1 * temp[1].color[2] + c2 * temp[2].color[2]),
                    Math.round(c0 * temp[0].color[3] + c1 * temp[1].color[3] + c2 * temp[2].color[3]),
                ],
            };

            // Normalize the normal
            const n = verts[i * L + j].normal;
            const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
            if (len > 0) {
                n[0] /= len;
                n[1] /= len;
                n[2] /= len;
            }
        }
    }

    return { verts, width: L, height: L };
}

export function tessellatePatch(
    controlPoints: PatchVert[],
    patchWidth: number,
    patchHeight: number,
    subdivisions?: number
): TessellatedPatch {
    // A patch is made of (patchWidth-1)/2 x (patchHeight-1)/2 biquadratic sub-patches
    const numPatchesX = (patchWidth - 1) / 2;
    const numPatchesY = (patchHeight - 1) / 2;

    // Determine tessellation level based on subdivisions parameter
    const tessLevel = subdivisions ? Math.max(2, Math.min(16, Math.round(16 / Math.max(1, subdivisions / 4)))) : 8;

    const allVerts: PatchVert[] = [];
    const allIndices: number[] = [];

    const L = tessLevel + 1;
    const totalWidth = numPatchesX * tessLevel + 1;
    const totalHeight = numPatchesY * tessLevel + 1;

    // Create a grid of all tessellated vertices
    const grid: (PatchVert | null)[] = new Array(totalWidth * totalHeight).fill(null);

    for (let py = 0; py < numPatchesY; py++) {
        for (let px = 0; px < numPatchesX; px++) {
            // Extract 3x3 control points for this sub-patch
            const controls: PatchVert[] = [];
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) {
                    const idx = (py * 2 + r) * patchWidth + (px * 2 + c);
                    controls.push(controlPoints[idx]);
                }
            }

            const tess = evaluateBiquadratic(controls, tessLevel);

            // Place into grid
            for (let r = 0; r < L; r++) {
                for (let c = 0; c < L; c++) {
                    const gx = px * tessLevel + c;
                    const gy = py * tessLevel + r;
                    grid[gy * totalWidth + gx] = tess.verts[r * L + c];
                }
            }
        }
    }

    // Flatten grid to vertex array
    for (let i = 0; i < grid.length; i++) {
        allVerts.push(grid[i]!);
    }

    // Generate triangle indices
    for (let y = 0; y < totalHeight - 1; y++) {
        for (let x = 0; x < totalWidth - 1; x++) {
            const i0 = y * totalWidth + x;
            const i1 = y * totalWidth + x + 1;
            const i2 = (y + 1) * totalWidth + x;
            const i3 = (y + 1) * totalWidth + x + 1;

            allIndices.push(i0, i2, i1);
            allIndices.push(i1, i2, i3);
        }
    }

    return {
        verts: allVerts,
        indices: allIndices,
        width: totalWidth,
        height: totalHeight,
    };
}
