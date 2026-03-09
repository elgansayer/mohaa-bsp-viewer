// Quake 3 / MOHAA Shader Parser

export interface ShaderStage {
    map?: string;
    clamp?: boolean;
    // nextbundle support: bundle[0] = primary, bundle[1] = secondary
    map2?: string;           // second bundle texture (from nextbundle)
    clamp2?: boolean;
    multitextureEnv?: 'modulate' | 'add'; // how bundles are combined
    animMap?: { frequency: number, maps: string[] };
    blendFunc?: { src: string, dst: string } | string;
    rgbGen?: string | { type: string, args: any[] };
    alphaGen?: string | { type: string, args: any[] };
    tcGen?: string; // 'base', 'lightmap', 'environment', 'vector'
    tcGen2?: string; // tcGen for bundle 2
    tcMod?: { type: string, args: number[] }[];
    tcMod2?: { type: string, args: number[] }[]; // tcMod for bundle 2
    depthFunc?: string;
    depthWrite?: boolean;
    alphaFunc?: { func: string, ref: number };
}

export interface DeformVertexes {
    type: string; // 'wave', 'normal', 'bulge', 'move', 'autosprite', 'autosprite2', 'flap'
    spread?: number;
    waveFunc?: string;
    base?: number;
    amplitude?: number;
    phase?: number;
    frequency?: number;
    moveVector?: [number, number, number];
    bulgeWidth?: number;
    bulgeHeight?: number;
    bulgeSpeed?: number;
}

export interface ParsedShader {
    name: string;
    surfaceparms: string[];
    cull?: string;
    nomipmaps?: boolean;
    nopicmip?: boolean;
    polygonOffset?: boolean;
    sort?: string | number;
    skyParms?: { farbox: string, cloudheight: number, nearbox: string };
    stages: ShaderStage[];
    deformVertexes?: DeformVertexes[];
}

export class ShaderParser {
    private shaders: Map<string, ParsedShader> = new Map();
    // Reverse index: texture path (from stage map directive) -> shader name
    // Used to resolve BSP shader references like "textures/central_europe/carpet_fancy1"
    // that map to shader definitions with short names like "carpet_fancy1"
    private textureToShader: Map<string, string> = new Map();

    public parse(shaderText: string) {
        // Remove block comments /* ... */ and line comments // ...
        let cleaned = shaderText.replace(/\/\*[\s\S]*?\*\//g, '');
        cleaned = cleaned.replace(/\/\/.*$/gm, '');

        // Tokenize
        const tokens = cleaned.match(/"[^"]+"|[\{\}]|[^\s\{\}]+/g) || [];

        let i = 0;
        while (i < tokens.length) {
            const token = tokens[i];
            if (token === '{' || token === '}') {
                i++;
                continue;
            }

            // Shader Name
            const shaderName = token.toLowerCase();
            i++;

            if (tokens[i] !== '{') {
                while (i < tokens.length && tokens[i] !== '{') i++;
            }
            if (i >= tokens.length) break;
            i++; // Skip '{'

            const shader: ParsedShader = {
                name: shaderName,
                surfaceparms: [],
                stages: []
            };

            // Parse Shader Body
            let braceDepth = 1;

            while (i < tokens.length && braceDepth > 0) {
                const cmd = tokens[i].toLowerCase();

                if (cmd === '{') {
                    // Start of a stage
                    braceDepth++;
                    i++;
                    const stage = this.parseStage(tokens, i);
                    i = stage.nextIndex;
                    shader.stages.push(stage.stage);
                    braceDepth--;
                } else if (cmd === '}') {
                    braceDepth--;
                    i++;
                } else if (cmd === 'surfaceparm') {
                    i++;
                    if (i < tokens.length) shader.surfaceparms.push(tokens[i].toLowerCase());
                    i++;
                } else if (cmd === 'cull') {
                    i++;
                    if (i < tokens.length) shader.cull = tokens[i].toLowerCase();
                    i++;
                } else if (cmd === 'nomipmaps') {
                    shader.nomipmaps = true;
                    i++;
                } else if (cmd === 'nopicmip') {
                    shader.nopicmip = true;
                    i++;
                } else if (cmd === 'polygonoffset') {
                    shader.polygonOffset = true;
                    i++;
                } else if (cmd === 'sort') {
                    i++;
                    if (i < tokens.length) shader.sort = tokens[i].toLowerCase();
                    i++;
                } else if (cmd === 'skyparms') {
                    i++;
                    shader.skyParms = {
                        farbox: tokens[i++] || '-',
                        cloudheight: parseFloat(tokens[i++] || '0'),
                        nearbox: tokens[i++] || '-'
                    };
                } else if (cmd === 'deformvertexes') {
                    i++;
                    const deform = this.parseDeformVertexes(tokens, i);
                    i = deform.nextIndex;
                    if (!shader.deformVertexes) shader.deformVertexes = [];
                    shader.deformVertexes.push(deform.deform);
                } else {
                    // Skip unknown global commands and their arguments
                    i++;
                    while (i < tokens.length && tokens[i] !== '{' && tokens[i] !== '}' &&
                        !isGlobalCommand(tokens[i].toLowerCase())) {
                        i++;
                    }
                }
            }

            this.shaders.set(shaderName, shader);

            // Build reverse index: map texture paths to shader name
            // This allows BSP references like "textures/foo/bar" to find
            // shader definitions named "bar" whose stage uses "textures/foo/bar.tga"
            for (const stage of shader.stages) {
                if (stage.map && stage.map !== '$lightmap' && stage.map !== '$whiteimage' && stage.map !== '*white') {
                    // Strip extension to get the texture path
                    const texPath = stage.map.replace(/\.\w+$/, '').toLowerCase();
                    if (texPath !== shaderName && !this.textureToShader.has(texPath)) {
                        this.textureToShader.set(texPath, shaderName);
                    }
                }
            }
        }
    }

    private parseStage(tokens: string[], startIndex: number): { stage: ShaderStage, nextIndex: number } {
        const stage: ShaderStage = {};
        let i = startIndex;
        let bundle = 0; // 0 = first bundle, 1 = second bundle (after nextbundle)

        while (i < tokens.length) {
            const cmd = tokens[i].toLowerCase();

            if (cmd === '}') {
                i++;
                break;
            }
            if (cmd === '{') {
                // shouldn't happen in valid shaders
                i++;
                continue;
            }

            i++; // consume command token

            if (cmd === 'map' || cmd === 'clampmap') {
                const mapVal = tokens[i].replace(/"/g, '');
                i++;
                if (bundle === 0) {
                    stage.map = mapVal;
                    stage.clamp = (cmd === 'clampmap');
                } else {
                    stage.map2 = mapVal;
                    stage.clamp2 = (cmd === 'clampmap');
                }
            } else if (cmd === 'animmap') {
                const freq = parseFloat(tokens[i++]);
                const maps: string[] = [];
                while (i < tokens.length && tokens[i] !== '}' &&
                    !isStageCommand(tokens[i].toLowerCase())) {
                    maps.push(tokens[i].replace(/"/g, ''));
                    i++;
                }
                stage.animMap = { frequency: freq, maps };
            } else if (cmd === 'nextbundle') {
                // Check for optional 'add' parameter
                if (i < tokens.length && tokens[i].toLowerCase() === 'add') {
                    stage.multitextureEnv = 'add';
                    i++;
                } else {
                    stage.multitextureEnv = 'modulate';
                }
                bundle = 1;
            } else if (cmd === 'blendfunc') {
                const arg1 = tokens[i].toLowerCase();
                i++;
                if (arg1 === 'add' || arg1 === 'filter' || arg1 === 'blend') {
                    stage.blendFunc = arg1;
                } else {
                    const arg2 = tokens[i].toLowerCase();
                    i++;
                    stage.blendFunc = { src: arg1, dst: arg2 };
                }
            } else if (cmd === 'rgbgen') {
                const type = tokens[i].toLowerCase();
                i++;
                if (type === 'wave') {
                    const func = tokens[i++];
                    stage.rgbGen = {
                        type: 'wave',
                        args: [func, parseFloat(tokens[i++]), parseFloat(tokens[i++]),
                            parseFloat(tokens[i++]), parseFloat(tokens[i++])]
                    };
                } else if (type === 'const' || type === 'constant') {
                    stage.rgbGen = {
                        type: 'constant',
                        args: [parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++])]
                    };
                } else if (type === 'colorwave') {
                    stage.rgbGen = {
                        type: 'colorwave',
                        args: [parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++]),
                            tokens[i++], parseFloat(tokens[i++]), parseFloat(tokens[i++]),
                            parseFloat(tokens[i++]), parseFloat(tokens[i++])]
                    };
                } else {
                    stage.rgbGen = type;
                }
            } else if (cmd === 'alphagen') {
                const type = tokens[i].toLowerCase();
                i++;
                if (type === 'wave') {
                    const func = tokens[i++];
                    stage.alphaGen = {
                        type: 'wave',
                        args: [func, parseFloat(tokens[i++]), parseFloat(tokens[i++]),
                            parseFloat(tokens[i++]), parseFloat(tokens[i++])]
                    };
                } else if (type === 'const' || type === 'constant') {
                    stage.alphaGen = { type: 'constant', args: [parseFloat(tokens[i++])] };
                } else {
                    stage.alphaGen = type;
                }
            } else if (cmd === 'tcmod') {
                const type = tokens[i].toLowerCase();
                i++;
                const tcModArr = bundle === 0 ? (stage.tcMod || (stage.tcMod = [])) : (stage.tcMod2 || (stage.tcMod2 = []));

                if (type === 'scroll' || type === 'scale') {
                    tcModArr.push({ type, args: [parseFloat(tokens[i++]), parseFloat(tokens[i++])] });
                } else if (type === 'rotate') {
                    tcModArr.push({ type, args: [parseFloat(tokens[i++])] });
                } else if (type === 'turb') {
                    tcModArr.push({ type, args: [parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++])] });
                } else if (type === 'stretch') {
                    const func = tokens[i++];
                    tcModArr.push({ type, args: [0, parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++])] });
                } else if (type === 'transform') {
                    tcModArr.push({ type, args: [parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++])] });
                } else {
                    // Skip unknown tcMod args (consume numeric tokens)
                    while (i < tokens.length && tokens[i] && /^[-.\d]/.test(tokens[i])) i++;
                }
            } else if (cmd === 'tcgen') {
                const type = tokens[i].toLowerCase();
                i++;
                if (bundle === 0) {
                    stage.tcGen = type;
                } else {
                    stage.tcGen2 = type;
                }
                // Skip vector args if present
                if (type === 'vector') {
                    // vector ( x y z ) ( x y z )
                    while (i < tokens.length && tokens[i] !== '}' && !isStageCommand(tokens[i].toLowerCase())) i++;
                }
            } else if (cmd === 'depthwrite') {
                stage.depthWrite = true;
            } else if (cmd === 'depthfunc') {
                stage.depthFunc = tokens[i].toLowerCase();
                i++;
            } else if (cmd === 'alphafunc') {
                stage.alphaFunc = { func: tokens[i].toLowerCase(), ref: 0 };
                i++;
            } else {
                // Skip unknown stage commands - consume until next known command or '}'
                while (i < tokens.length && tokens[i] !== '}' &&
                    !isStageCommand(tokens[i].toLowerCase())) {
                    i++;
                }
            }
        }

        return { stage, nextIndex: i };
    }

    private parseDeformVertexes(tokens: string[], startIndex: number): { deform: DeformVertexes, nextIndex: number } {
        let i = startIndex;
        const type = tokens[i].toLowerCase();
        i++;

        const deform: DeformVertexes = { type };

        if (type === 'wave' || type === 'flap') {
            deform.spread = parseFloat(tokens[i++]);
            deform.waveFunc = tokens[i++];
            deform.base = parseFloat(tokens[i++]);
            deform.amplitude = parseFloat(tokens[i++]);
            deform.phase = parseFloat(tokens[i++]);
            deform.frequency = parseFloat(tokens[i++]);
        } else if (type === 'normal') {
            deform.frequency = parseFloat(tokens[i++]);
            deform.amplitude = parseFloat(tokens[i++]);
        } else if (type === 'bulge') {
            deform.bulgeWidth = parseFloat(tokens[i++]);
            deform.bulgeHeight = parseFloat(tokens[i++]);
            deform.bulgeSpeed = parseFloat(tokens[i++]);
        } else if (type === 'move') {
            deform.moveVector = [parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++])];
            deform.waveFunc = tokens[i++];
            deform.base = parseFloat(tokens[i++]);
            deform.amplitude = parseFloat(tokens[i++]);
            deform.phase = parseFloat(tokens[i++]);
            deform.frequency = parseFloat(tokens[i++]);
        }
        // autosprite, autosprite2 have no additional args

        return { deform, nextIndex: i };
    }

    public getShader(name: string): ParsedShader | undefined {
        const lower = name.toLowerCase();
        const direct = this.shaders.get(lower);
        if (direct) return direct;

        // Fallback: BSP may reference the texture path (e.g. "textures/central_europe/carpet_fancy1")
        // while the shader is defined with a short name (e.g. "carpet_fancy1")
        const mapped = this.textureToShader.get(lower);
        if (mapped) return this.shaders.get(mapped);

        return undefined;
    }

    public getAllShaders(): Map<string, ParsedShader> {
        return this.shaders;
    }
}

const GLOBAL_COMMANDS = new Set([
    'surfaceparm', 'cull', 'nomipmaps', 'nopicmip', 'polygonoffset',
    'sort', 'skyparms', 'deformvertexes', 'tesssize', 'fogparms',
    'nocompress', 'qer_editorimage', 'qer_nocarve', 'qer_trans',
    'q3map_surfacelight', 'q3map_sun', 'q3map_lightimage',
    'q3map_globaltexture', 'q3map_backshader', 'q3map_lightmapfilterradius',
    'q3map_flare', 'light', 'nodlight', 'portal',
    'spritegen', 'spritescale', 'spriteorigin',
]);

function isGlobalCommand(token: string): boolean {
    return token === '{' || token === '}' || GLOBAL_COMMANDS.has(token);
}

const STAGE_COMMANDS = new Set([
    'map', 'clampmap', 'animmap', 'blendfunc', 'rgbgen', 'alphagen',
    'tcmod', 'tcgen', 'depthwrite', 'depthfunc', 'alphafunc',
    'detail', 'nextbundle',
]);

function isStageCommand(token: string): boolean {
    return token === '}' || STAGE_COMMANDS.has(token);
}
