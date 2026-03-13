import * as THREE from 'three';
import { VirtualFileSystem } from './VirtualFileSystem';
import { ShaderParser } from './ShaderParser';
import { parseBsp, BspData, findLeaf, clusterVisible } from './BspParser';
import { Q3Material, loadSkybox } from './Q3ShaderMaterial';
import { loadStaticModels } from './StaticModelLoader';

const inputContainer = document.getElementById('file-input-container');
const statusDiv = document.getElementById('status');

// Renderer setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x222222);

// Camera
const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 1, 50000);
camera.position.set(0, 100, 0);

// FPS-style fly controls
const moveState = { forward: false, backward: false, left: false, right: false, up: false, down: false };
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
let flySpeed = 800;
let mouseSensitivity = 0.002;
let pointerLocked = false;

renderer.domElement.addEventListener('click', () => {
    if (!pointerLocked) {
        renderer.domElement.requestPointerLock();
    }
});

document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === renderer.domElement;
});

document.addEventListener('mousemove', (e) => {
    if (!pointerLocked) return;
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= e.movementX * mouseSensitivity;
    euler.x -= e.movementY * mouseSensitivity;
    euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
    camera.quaternion.setFromEuler(euler);
});

// Display settings toggles
let showWireframe = false;
let showEntityMarkers = true;
let showSubmodels = true;
let showStaticModels = true;
let showDebugInfo = false;

// References for toggling
let entityMarkerGroup: THREE.Group | null = null;
let submodelGroup: THREE.Group | null = null;
let staticModelGroupRef: THREE.Group | null = null;
let currentBsp: BspData | null = null;

type ViewerDebugState = {
    mapName: string;
    staticVisible: boolean;
    staticInstances: number;
    staticBoundsCenter: [number, number, number] | null;
    camera: [number, number, number];
    cameraDistanceToStaticCenter: number | null;
};

type ViewerAutomationApi = {
    teleport: (x: number, y: number, z: number) => void;
    lookAt: (x: number, y: number, z: number) => void;
    teleportNearStaticCenter: (offsetY?: number, offsetZ?: number) => boolean;
    lookAtStaticCenter: () => boolean;
};

const viewerDebugState: ViewerDebugState = {
    mapName: '',
    staticVisible: showStaticModels,
    staticInstances: 0,
    staticBoundsCenter: null,
    camera: [camera.position.x, camera.position.y, camera.position.z],
    cameraDistanceToStaticCenter: null,
};

(window as any).__viewerDebug = viewerDebugState;
(window as any).__scene = scene;
(window as any).__staticModelGroup = () => staticModelGroupRef;

const viewerAutomationApi: ViewerAutomationApi = {
    teleport: (x: number, y: number, z: number) => {
        camera.position.set(x, y, z);
        updateViewerDebugState();
    },
    lookAt: (x: number, y: number, z: number) => {
        camera.lookAt(x, y, z);
        updateViewerDebugState();
    },
    teleportNearStaticCenter: (offsetY = 200, offsetZ = 600) => {
        if (!viewerDebugState.staticBoundsCenter) return false;
        camera.position.set(
            viewerDebugState.staticBoundsCenter[0],
            viewerDebugState.staticBoundsCenter[1] + offsetY,
            viewerDebugState.staticBoundsCenter[2] + offsetZ
        );
        updateViewerDebugState();
        return true;
    },
    lookAtStaticCenter: () => {
        if (!viewerDebugState.staticBoundsCenter) return false;
        camera.lookAt(
            viewerDebugState.staticBoundsCenter[0],
            viewerDebugState.staticBoundsCenter[1],
            viewerDebugState.staticBoundsCenter[2]
        );
        updateViewerDebugState();
        return true;
    },
};

(window as any).__viewerAutomation = viewerAutomationApi;

function updateViewerDebugState() {
    viewerDebugState.staticVisible = showStaticModels;
    viewerDebugState.camera = [camera.position.x, camera.position.y, camera.position.z];
    if (staticModelGroupRef) {
        viewerDebugState.staticInstances = staticModelGroupRef.children.length;
        const smBounds = new THREE.Box3().setFromObject(staticModelGroupRef);
        if (!smBounds.isEmpty()) {
            const center = smBounds.getCenter(new THREE.Vector3());
            viewerDebugState.staticBoundsCenter = [center.x, center.y, center.z];
            viewerDebugState.cameraDistanceToStaticCenter = camera.position.distanceTo(center);
        } else {
            viewerDebugState.staticBoundsCenter = null;
            viewerDebugState.cameraDistanceToStaticCenter = null;
        }
    } else {
        viewerDebugState.staticInstances = 0;
        viewerDebugState.staticBoundsCenter = null;
        viewerDebugState.cameraDistanceToStaticCenter = null;
    }
}

document.addEventListener('keydown', (e) => {
    switch (e.code) {
        case 'KeyW': moveState.forward = true; break;
        case 'KeyS': moveState.backward = true; break;
        case 'KeyA': moveState.left = true; break;
        case 'KeyD': moveState.right = true; break;
        case 'Space': moveState.up = true; break;
        case 'ShiftLeft': case 'ShiftRight': moveState.down = true; break;
        case 'Equal': case 'NumpadAdd': flySpeed *= 1.5; break;
        case 'Minus': case 'NumpadSubtract': flySpeed /= 1.5; break;
        case 'Escape':
            if (inputContainer && inputContainer.style.display === 'none') {
                inputContainer.style.display = '';
            }
            break;
        case 'F1':
            e.preventDefault();
            showDebugInfo = !showDebugInfo;
            debugDiv.style.display = showDebugInfo ? 'block' : 'none';
            break;
        case 'F2':
            e.preventDefault();
            showWireframe = !showWireframe;
            scene.traverse((obj) => {
                if (obj instanceof THREE.Mesh && obj.material instanceof THREE.Material) {
                    (obj.material as any).wireframe = showWireframe;
                }
            });
            break;
        case 'F3':
            e.preventDefault();
            showEntityMarkers = !showEntityMarkers;
            if (entityMarkerGroup) entityMarkerGroup.visible = showEntityMarkers;
            break;
        case 'F4':
            e.preventDefault();
            showSubmodels = !showSubmodels;
            if (submodelGroup) submodelGroup.visible = showSubmodels;
            break;
        case 'F5':
            e.preventDefault();
            showStaticModels = !showStaticModels;
            if (staticModelGroupRef) staticModelGroupRef.visible = showStaticModels;
            updateViewerDebugState();
            break;
    }
});

document.addEventListener('keyup', (e) => {
    switch (e.code) {
        case 'KeyW': moveState.forward = false; break;
        case 'KeyS': moveState.backward = false; break;
        case 'KeyA': moveState.left = false; break;
        case 'KeyD': moveState.right = false; break;
        case 'Space': moveState.up = false; break;
        case 'ShiftLeft': case 'ShiftRight': moveState.down = false; break;
    }
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Animation
const clock = new THREE.Clock();
let animatedMaterials: Q3Material[] = [];
let totalTime = 0;
let frameCount = 0;
let lastFpsTime = 0;
let currentFps = 0;

// HUD elements
const fpsDiv = document.createElement('div');
fpsDiv.style.cssText = 'position:absolute;top:10px;right:10px;color:#0f0;font-family:monospace;font-size:13px;z-index:10;text-shadow:1px 1px 2px rgba(0,0,0,0.8)';
document.body.appendChild(fpsDiv);

const debugDiv = document.createElement('div');
debugDiv.style.cssText = 'position:absolute;bottom:10px;left:10px;color:#0f0;font-family:monospace;font-size:11px;z-index:10;text-shadow:1px 1px 2px rgba(0,0,0,0.8);white-space:pre;display:none;background:rgba(0,0,0,0.5);padding:6px 10px;border-radius:4px';
document.body.appendChild(debugDiv);

const controlsDiv = document.createElement('div');
controlsDiv.style.cssText = 'position:absolute;bottom:10px;right:10px;color:#aaa;font-family:monospace;font-size:10px;z-index:10;text-shadow:1px 1px 2px rgba(0,0,0,0.8);text-align:right;white-space:pre';
controlsDiv.textContent = 'F1: Debug  F2: Wireframe  F3: Entities\nF4: Submodels  F5: StaticModels  +/-: Speed';
document.body.appendChild(controlsDiv);

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    totalTime += delta;
    frameCount++;

    // FPS counter
    if (totalTime - lastFpsTime >= 1.0) {
        currentFps = Math.round(frameCount / (totalTime - lastFpsTime));
        lastFpsTime = totalTime;
        frameCount = 0;
        fpsDiv.textContent = `${currentFps} FPS`;
    }

    // FPS movement
    const direction = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    camera.getWorldDirection(direction);
    right.crossVectors(direction, up).normalize();

    const speed = flySpeed * delta;
    if (moveState.forward) camera.position.addScaledVector(direction, speed);
    if (moveState.backward) camera.position.addScaledVector(direction, -speed);
    if (moveState.left) camera.position.addScaledVector(right, -speed);
    if (moveState.right) camera.position.addScaledVector(right, speed);
    if (moveState.up) camera.position.y += speed;
    if (moveState.down) camera.position.y -= speed;

    // Update animated materials
    for (const mat of animatedMaterials) {
        if (mat.update) mat.update(totalTime);
    }

    // Debug info
    if (showDebugInfo && currentBsp) {
        // Convert Three.js camera pos back to MOHAA coords
        // Three.js: X=right, Y=up, Z=-forward
        // MOHAA: X=right, Y=forward, Z=up
        // After group rotation -90 X: mohaaX = threeX, mohaaY = -threeZ, mohaaZ = threeY
        const mx = camera.position.x;
        const my = -camera.position.z;
        const mz = camera.position.y;

        const leafIdx = findLeaf(
            [mx, my, mz],
            currentBsp.nodes,
            currentBsp.leaves,
            currentBsp.planes
        );
        const leaf = leafIdx >= 0 && leafIdx < currentBsp.leaves.length ? currentBsp.leaves[leafIdx] : null;

        debugDiv.textContent = [
            `Pos: ${mx.toFixed(0)}, ${my.toFixed(0)}, ${mz.toFixed(0)}`,
            `Leaf: ${leafIdx} | Cluster: ${leaf?.cluster ?? -1} | Area: ${leaf?.area ?? -1}`,
            `Speed: ${flySpeed.toFixed(0)}`,
            `Submodels: ${currentBsp.submodels.length} | SphereLights: ${currentBsp.sphereLights.length}`,
            `Draw calls: ${renderer.info.render.calls} | Tris: ${renderer.info.render.triangles}`,
        ].join('\n');
    }

    renderer.render(scene, camera);
    updateViewerDebugState();
}
animate();

// VFS Setup
const vfs = new VirtualFileSystem();
const shaderParser = new ShaderParser();
(window as any).__shaderParser = shaderParser;
(window as any).__vfs = vfs;
const PK3_BASE_URL = (window as any).__CONFIG__?.PK3_BASE_URL || 'https://cdn.moh-central.net/main';
const PK3_FILES = [
    'Pak0.pk3', 'Pak1.pk3', 'Pak2.pk3', 'Pak3.pk3',
    'Pak4.pk3', 'Pak5.pk3', 'Pak6.pk3', 'Pak6EnUk.pk3', 'pak7.pk3'
];

async function initVFS() {
    if (statusDiv) statusDiv.textContent = 'Loading PK3 archives...';
    try {
        let loaded = 0;
        const total = PK3_FILES.length;
        await Promise.all(PK3_FILES.map(async (pk3) => {
            try {
                await vfs.loadPk3(`${PK3_BASE_URL}/${pk3}`);
            } catch (e) {
                console.warn(`Failed to load ${pk3}:`, e);
            }
            loaded++;
            if (statusDiv) statusDiv.textContent = `Loading PK3 archives... (${loaded}/${total})`;
        }));

        // Parse shaders
        if (statusDiv) statusDiv.textContent = 'Parsing shaders...';
        const shaderContents = await vfs.getAllShaders();
        for (const content of shaderContents) {
            shaderParser.parse(content);
        }
        console.log(`Parsed ${shaderParser.getAllShaders().size} shaders`);

        const maps = vfs.getMapList();
        if (inputContainer) {
            inputContainer.innerHTML = '<h3>MOHAA Map Viewer</h3>';

            const select = document.createElement('select');
            select.style.width = '100%';
            maps.sort().forEach(m => {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                select.appendChild(opt);
            });
            inputContainer.appendChild(select);

            const btn = document.createElement('button');
            btn.textContent = 'Load Map';
            btn.style.display = 'block';
            btn.style.marginTop = '10px';
            btn.onclick = async () => {
                const mapPath = select.value;
                inputContainer.style.display = 'none';
                await loadMap(mapPath);
            };
            inputContainer.appendChild(btn);

            // File upload
            const fileLabel = document.createElement('div');
            fileLabel.textContent = 'Or upload a .bsp file:';
            fileLabel.style.marginTop = '10px';
            inputContainer.appendChild(fileLabel);

            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.bsp';
            fileInput.onchange = async (e: any) => {
                const file = e.target.files[0];
                if (!file) return;
                inputContainer.style.display = 'none';
                if (statusDiv) statusDiv.textContent = `Loading ${file.name}...`;
                const buffer = await file.arrayBuffer();
                loadBspBuffer(buffer, file.name);
            };
            inputContainer.appendChild(fileInput);
        }

        // PK3 upload support
        const pk3Upload = document.getElementById('pk3-upload') as HTMLInputElement;
        const pk3Area = document.getElementById('pk3-upload-area');
        if (pk3Upload && pk3Area) {
            pk3Area.style.display = 'block';
            pk3Upload.onchange = async (e: any) => {
                const files = e.target.files;
                if (!files || files.length === 0) return;

                for (const file of files) {
                    if (statusDiv) statusDiv.textContent = `Loading ${file.name}...`;
                    const buffer = await file.arrayBuffer();
                    await vfs.loadPk3FromBuffer(buffer, file.name);
                }

                const newShaders = await vfs.getAllShaders();
                for (const content of newShaders) {
                    shaderParser.parse(content);
                }

                const newMaps = vfs.getMapList();
                const mapSelect = inputContainer?.querySelector('select');
                if (mapSelect) {
                    mapSelect.innerHTML = '';
                    newMaps.sort().forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m;
                        opt.textContent = m;
                        mapSelect.appendChild(opt);
                    });
                }

                if (statusDiv) statusDiv.textContent = `Ready - ${newMaps.length} maps found.`;
            };
        }

        if (statusDiv) statusDiv.textContent = `Ready - ${maps.length} maps found. Select a map to load.`;
    } catch (err) {
        console.error(err);
        if (statusDiv) statusDiv.textContent = `Error: ${err}`;
    }
}

async function loadMap(mapPath: string) {
    if (statusDiv) statusDiv.textContent = `Loading ${mapPath}...`;
    const buffer = await vfs.getFile(mapPath);
    if (buffer) {
        loadBspBuffer(buffer, mapPath);
    } else {
        if (statusDiv) statusDiv.textContent = `Error: Could not read ${mapPath}`;
    }
}

function loadBspBuffer(buffer: ArrayBuffer, mapName: string) {
    // Clear previous map
    while (scene.children.length > 0) {
        scene.remove(scene.children[0]);
    }
    animatedMaterials = [];
    entityMarkerGroup = null;
    submodelGroup = null;
    staticModelGroupRef = null;
    currentBsp = null;

    if (statusDiv) statusDiv.textContent = `Parsing ${mapName}...`;

    const bsp = parseBsp(buffer, vfs, shaderParser);
    viewerDebugState.mapName = mapName;
    currentBsp = bsp;
    scene.add(bsp.mesh);
    animatedMaterials = bsp.animatedMaterials;

    // Apply worldspawn settings
    const worldspawn = bsp.entities.find((e: any) => e.classname === 'worldspawn');
    if (worldspawn) {
        console.log('Worldspawn:', worldspawn);

        if (worldspawn.farplane) {
            const farDist = parseFloat(worldspawn.farplane);
            if (farDist > 0) {
                let fogColor = new THREE.Color(0.5, 0.5, 0.5);
                if (worldspawn.farplane_color) {
                    const c = worldspawn.farplane_color.split(' ').map(parseFloat);
                    fogColor = new THREE.Color(c[0] || 0.5, c[1] || 0.5, c[2] || 0.5);
                }
                scene.fog = new THREE.Fog(fogColor, 1, farDist);
                scene.background = fogColor;
            }
        } else if (worldspawn._color) {
            const c = worldspawn._color.split(' ').map(parseFloat);
            const bg = new THREE.Color(c[0] || 0, c[1] || 0, c[2] || 0);
            scene.background = bg;
        } else {
            scene.background = new THREE.Color(0x556677);
        }
    } else {
        scene.background = new THREE.Color(0x556677);
    }

    // Add ambient light
    const ambient = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambient);

    // Set spawn point
    const spawnInfo = bsp.entities.find((e: any) =>
        e.classname === 'info_player_start' ||
        e.classname === 'info_player_deathmatch' ||
        e.classname === 'info_player_intermission' ||
        e.classname === 'info_player_allied'
    );

    if (spawnInfo && spawnInfo.origin) {
        const coords = spawnInfo.origin.split(' ').map(parseFloat);
        if (coords.length >= 3) {
            camera.position.set(coords[0], coords[2] + 64, -coords[1]);
            console.log(`Spawn: ${spawnInfo.classname} at [${coords}] -> camera [${camera.position.x}, ${camera.position.y}, ${camera.position.z}]`);

            if (spawnInfo.angle) {
                const angle = parseFloat(spawnInfo.angle) * Math.PI / 180;
                euler.set(0, angle + Math.PI / 2, 0, 'YXZ');
                camera.quaternion.setFromEuler(euler);
            }
        }
    }

    if (statusDiv) statusDiv.textContent = `${mapName} - Click to capture mouse, WASD+Mouse to fly`;

    // Add brush model entities (func_static, func_door, etc.)
    addBrushModelEntities(bsp);

    // Add entity markers (lights, spawns, etc.)
    // addEntityMarkers(bsp);

    // Add sphere light markers
    // addSphereLightMarkers(bsp);

    // Load skybox asynchronously
    if (shaderParser) {
        loadSkybox(vfs, shaderParser, bsp.shaderNames).then(cubeTexture => {
            if (cubeTexture) {
                scene.background = cubeTexture;
                console.log('Skybox loaded');
            }
        }).catch(e => console.warn('Failed to load skybox:', e));
    }

    // Load static models asynchronously
    if (bsp.staticModels.length > 0) {
        const modelSet = new Set(bsp.staticModels.map(m => m.model));
        console.log(`Loading ${bsp.staticModels.length} static models (${modelSet.size} unique)...`);

        loadStaticModels(bsp.staticModels, vfs, shaderParser, (msg) => {
            if (statusDiv) statusDiv.textContent = msg;
        }).then(staticGroup => {
            staticGroup.rotation.x = -Math.PI / 2;
            staticModelGroupRef = staticGroup;
            staticGroup.visible = showStaticModels;
            scene.add(staticGroup);

            // Diagnostic: compare static model bounds with camera position after world-space conversion.
            const smBounds = new THREE.Box3().setFromObject(staticGroup);
            if (!smBounds.isEmpty()) {
                const smCenter = smBounds.getCenter(new THREE.Vector3());
                const smSize = smBounds.getSize(new THREE.Vector3());
                const boundsInfo = {
                    min: [smBounds.min.x, smBounds.min.y, smBounds.min.z],
                    max: [smBounds.max.x, smBounds.max.y, smBounds.max.z],
                    center: [smCenter.x, smCenter.y, smCenter.z],
                    size: [smSize.x, smSize.y, smSize.z],
                    camera: [camera.position.x, camera.position.y, camera.position.z],
                    cameraDistanceToCenter: camera.position.distanceTo(smCenter),
                };
                console.log('Static model world bounds:', boundsInfo);
                // Also print as JSON so devtools doesn't collapse numeric arrays.
                console.log('Static model world bounds JSON:', JSON.stringify(boundsInfo));
            }

            console.log(`Loaded ${staticGroup.children.length} static model instances`);
            updateViewerDebugState();
            if (statusDiv) statusDiv.textContent = `${mapName} - Click to capture mouse, WASD+Mouse to fly`;
        }).catch(e => {
            console.warn('Failed to load static models:', e);
        });
    }

    updateViewerDebugState();
}

function addBrushModelEntities(bsp: BspData) {
    submodelGroup = new THREE.Group();
    submodelGroup.rotation.x = -Math.PI / 2;
    submodelGroup.visible = showSubmodels;

    let placedCount = 0;

    for (const ent of bsp.entities) {
        // Entities that reference brush models have model = "*N"
        if (!ent.model || !ent.model.startsWith('*')) continue;

        const modelIndex = parseInt(ent.model.substring(1), 10);
        if (isNaN(modelIndex) || modelIndex < 1 || modelIndex >= bsp.submodelMeshes.length) continue;

        const meshTemplate = bsp.submodelMeshes[modelIndex];
        if (!meshTemplate || meshTemplate.children.length === 0) continue;

        const clone = meshTemplate.clone();

        // Apply entity origin translation for inline brush models.
        // In MOHAA BSP, bmodel vertices are model-local and entity origin places them in world.
        if (ent.origin) {
            const coords = ent.origin.split(' ').map(parseFloat);
            if (coords.length >= 3) {
                clone.position.set(coords[0], coords[1], coords[2]);
            }
        }

        // Apply entity angles if present
        if (ent.angles) {
            const angles = ent.angles.split(' ').map(parseFloat);
            if (angles.length >= 3) {
                // MOHAA entity "angles" is "pitch yaw roll".
                // Parent submodelGroup has rotation.x = -PI/2 (MOHAA Z-up local frame).
                // Yaw is around MOHAA Z (up axis) = euler.z. Order 'ZXY': yaw→pitch→roll.
                clone.rotation.set(
                    (angles[0] * Math.PI) / 180, // pitch → X
                    (angles[2] * Math.PI) / 180, // roll  → Y
                    (angles[1] * Math.PI) / 180, // yaw   → Z
                    'ZXY'
                );
            }
        } else if (ent.angle) {
            const angle = parseFloat(ent.angle);
            clone.rotation.z = (angle * Math.PI) / 180; // single yaw → around Z (up in MOHAA)
        }

        submodelGroup.add(clone);
        placedCount++;
    }

    // Also add submodels that aren't referenced by entities (inline models at origin)
    // These are brush models that are part of the world but separated for grouping
    const referencedModels = new Set<number>();
    for (const ent of bsp.entities) {
        if (ent.model && ent.model.startsWith('*')) {
            const idx = parseInt(ent.model.substring(1), 10);
            if (!isNaN(idx)) referencedModels.add(idx);
        }
    }

    for (let i = 1; i < bsp.submodelMeshes.length; i++) {
        if (referencedModels.has(i)) continue;
        const meshTemplate = bsp.submodelMeshes[i];
        if (!meshTemplate || meshTemplate.children.length === 0) continue;
        const clone = meshTemplate.clone();
        submodelGroup.add(clone);
        placedCount++;
    }

    scene.add(submodelGroup);
    console.log(`Placed ${placedCount} brush model entities`);
}

function addEntityMarkers(bsp: BspData) {
    entityMarkerGroup = new THREE.Group();
    entityMarkerGroup.rotation.x = -Math.PI / 2;
    entityMarkerGroup.visible = showEntityMarkers;

    // Color mapping for different entity types
    const colorMap: Record<string, number> = {
        'info_player_start': 0x00ff00,
        'info_player_deathmatch': 0x00ff00,
        'info_player_allied': 0x0044ff,
        'info_player_axis': 0xff0000,
        'info_player_intermission': 0xffff00,
        'light': 0xffff00,
        'target_speaker': 0xff8800,
        'trigger_multiple': 0xff00ff,
        'trigger_once': 0xff00ff,
        'misc_model': 0x00ffff,
        'weapon_*': 0xff4400,
        'ammo_*': 0x44ff00,
        'item_*': 0x44ffff,
    };

    function getEntityColor(classname: string): number {
        if (!classname) return 0x888888;
        if (colorMap[classname]) return colorMap[classname];
        for (const [pattern, color] of Object.entries(colorMap)) {
            if (pattern.endsWith('*') && classname.startsWith(pattern.slice(0, -1))) return color;
        }
        if (classname.startsWith('info_')) return 0x00ff00;
        if (classname.startsWith('trigger_')) return 0xff00ff;
        if (classname.startsWith('func_')) return 0x0088ff;
        return 0x888888;
    }

    const markerGeo = new THREE.SphereGeometry(8, 6, 4);

    for (const ent of bsp.entities) {
        if (!ent.origin) continue;
        if (ent.model && ent.model.startsWith('*')) continue; // brush models handled separately

        const classname = ent.classname || '';
        // Skip worldspawn and brush-model entities
        if (classname === 'worldspawn') continue;

        const coords = ent.origin.split(' ').map(parseFloat);
        if (coords.length < 3) continue;

        const color = getEntityColor(classname);
        const mat = new THREE.MeshBasicMaterial({
            color,
            wireframe: true,
            transparent: true,
            opacity: 0.6,
            depthTest: false,
        });

        const marker = new THREE.Mesh(markerGeo, mat);
        marker.position.set(coords[0], coords[1], coords[2]);
        marker.userData.classname = classname;
        marker.userData.entity = ent;
        entityMarkerGroup.add(marker);
    }

    scene.add(entityMarkerGroup);
    console.log(`Created ${entityMarkerGroup.children.length} entity markers`);
}

function addSphereLightMarkers(bsp: BspData) {
    if (bsp.sphereLights.length === 0) return;
    if (!entityMarkerGroup) return;

    const lightGeo = new THREE.SphereGeometry(6, 6, 4);

    for (const light of bsp.sphereLights) {
        const color = new THREE.Color(
            Math.min(light.color[0], 1),
            Math.min(light.color[1], 1),
            Math.min(light.color[2], 1)
        );

        const mat = new THREE.MeshBasicMaterial({
            color,
            wireframe: true,
            transparent: true,
            opacity: 0.4,
            depthTest: false,
        });

        const marker = new THREE.Mesh(lightGeo, mat);
        marker.position.set(light.origin[0], light.origin[1], light.origin[2]);
        marker.userData.classname = light.spotLight ? 'sphere_spotlight' : 'sphere_light';
        marker.userData.intensity = light.intensity;

        // Scale marker based on intensity
        const scale = Math.max(0.5, Math.min(4, light.intensity / 200));
        marker.scale.setScalar(scale);

        entityMarkerGroup.add(marker);
    }

    console.log(`Added ${bsp.sphereLights.length} sphere light markers`);
}

initVFS();
