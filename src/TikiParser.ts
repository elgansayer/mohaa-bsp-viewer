// MOHAA TIKI file parser
// Parses .tik text files to extract model references, shaders, and properties
// Based on openmohaa tiki_parse.cpp TIKI_ParseSetup

import { VirtualFileSystem } from './VirtualFileSystem';

export interface TikiSurface {
    name: string;
    shaders: string[];
    flags: number;
    damageMultiplier: number;
}

export interface TikiDef {
    path: string;
    skelModels: string[];     // .skd file paths
    surfaces: TikiSurface[];
    scale: number;
    lodScale: number;
    lodBias: number;
    origin: [number, number, number];
    lightOffset: [number, number, number];
    radius: number;
    isCharacter: boolean;
}

export async function parseTiki(vfs: VirtualFileSystem, tikiPath: string): Promise<TikiDef | null> {
    const data = await vfs.getFile(tikiPath);
    if (!data) return null;

    const text = new TextDecoder('utf-8').decode(new Uint8Array(data));
    return parseTikiText(text, tikiPath, vfs);
}

function normalizeAssetPath(p: string): string {
    let out = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').trim();
    out = out.replace(/^\.\//, '');
    out = out.replace(/^\/+/, '');
    return out;
}

function ensureTrailingSlash(p: string): string {
    return p.endsWith('/') ? p : `${p}/`;
}

function resolveDirPath(basePath: string, rawPath: string): string {
    const path = normalizeAssetPath(rawPath);
    if (!path) {
        return basePath;
    }

    if (path.startsWith('models/')) {
        return ensureTrailingSlash(path);
    }

    return ensureTrailingSlash(normalizeAssetPath(basePath + path));
}

function resolveAssetPath(baseDir: string, currentDir: string, rawPath: string): string {
    const path = normalizeAssetPath(rawPath);
    if (!path) {
        return '';
    }

    if (path.startsWith('models/')) {
        return path;
    }

    return normalizeAssetPath(ensureTrailingSlash(currentDir || baseDir) + path);
}

async function parseTikiText(text: string, tikiPath: string, vfs: VirtualFileSystem): Promise<TikiDef> {
    // Determine base path from tiki file path
    const lastSlash = tikiPath.lastIndexOf('/');
    const basePath = lastSlash >= 0 ? normalizeAssetPath(tikiPath.substring(0, lastSlash + 1)) : '';

    const def: TikiDef = {
        path: tikiPath,
        skelModels: [],
        surfaces: [],
        scale: 1.0,
        lodScale: 1.0,
        lodBias: 0,
        origin: [0, 0, 0],
        lightOffset: [0, 0, 0],
        radius: 0,
        isCharacter: false,
    };

    // Tokenize - handle // comments and quoted strings
    const tokens = tokenize(text);
    let i = 0;
    let currentPath = ensureTrailingSlash(basePath);
    let currentSurface: TikiSurface | null = null;
    let braceDepth = 0;
    let inSetup = false;
    let inAnimations = false;
    let surfaceBraceStart = -1; // braceDepth when current surface block was opened

    while (i < tokens.length) {
        const token = tokens[i].toLowerCase();

        if (token === '{') {
            braceDepth++;
            i++;
            continue;
        }
        if (token === '}') {
            braceDepth--;
            if (inSetup && braceDepth <= 1) inSetup = false;
            if (inAnimations && braceDepth <= 1) inAnimations = false;
            // Exit current surface block when brace depth returns to where it was declared
            if (currentSurface !== null && braceDepth <= surfaceBraceStart) {
                currentSurface = null;
            }
            i++;
            continue;
        }

        if (token === 'setup' || token === '$define') {
            inSetup = true;
            i++;
            continue;
        }

        if (token === 'animations' || token === 'init' || token === 'client' || token === 'server') {
            inAnimations = true;
            i++;
            continue;
        }

        if (token === 'path') {
            i++;
            if (i < tokens.length) {
                currentPath = resolveDirPath(ensureTrailingSlash(basePath), tokens[i]);
                i++;
            }
            continue;
        }

        if (token === 'skelmodel') {
            i++;
            if (i < tokens.length) {
                const modelPath = resolveAssetPath(ensureTrailingSlash(basePath), currentPath, tokens[i]);
                def.skelModels.push(modelPath);
                i++;
            }
            continue;
        }

        if (token === 'scale') {
            i++;
            if (i < tokens.length) {
                def.scale = parseFloat(tokens[i]);
                i++;
            }
            continue;
        }

        if (token === 'lod_scale') {
            i++;
            if (i < tokens.length) {
                def.lodScale = parseFloat(tokens[i]) / 5.0;
                i++;
            }
            continue;
        }

        if (token === 'lod_bias') {
            i++;
            if (i < tokens.length) {
                def.lodBias = parseFloat(tokens[i]);
                i++;
            }
            continue;
        }

        if (token === 'origin') {
            i++;
            if (i + 2 < tokens.length) {
                def.origin = [parseFloat(tokens[i]), parseFloat(tokens[i + 1]), parseFloat(tokens[i + 2])];
                i += 3;
            }
            continue;
        }

        if (token === 'lightoffset') {
            i++;
            if (i + 2 < tokens.length) {
                def.lightOffset = [parseFloat(tokens[i]), parseFloat(tokens[i + 1]), parseFloat(tokens[i + 2])];
                i += 3;
            }
            continue;
        }

        if (token === 'radius') {
            i++;
            if (i < tokens.length) {
                def.radius = parseFloat(tokens[i]);
                i++;
            }
            continue;
        }

        if (token === 'ischaracter') {
            def.isCharacter = true;
            i++;
            continue;
        }

        // Handle 'shader' keyword inside surface blocks (both inline and nested {})
        if (token === 'shader' && currentSurface !== null) {
            i++;
            if (i < tokens.length) {
                let shaderName = tokens[i];
                // OpenMOHAA rule: if name contains '.', it's a filename → prepend current path.
                // If no '.', it's a shader table reference → use as-is.
                if (shaderName.includes('.')) {
                    shaderName = normalizeAssetPath(currentPath + shaderName);
                }
                currentSurface.shaders.push(shaderName);
                i++;
            }
            continue;
        }

        if (token === 'surface') {
            i++;
            if (i < tokens.length) {
                const surfName = tokens[i];
                i++;
                currentSurface = { name: surfName, shaders: [], flags: 0, damageMultiplier: 1.0 };
                def.surfaces.push(currentSurface);
                surfaceBraceStart = braceDepth; // track depth so we know when surface block ends

                // Parse surface properties on the same line
                while (i < tokens.length && tokens[i] !== '{' && tokens[i] !== '}' && tokens[i].toLowerCase() !== 'surface' && tokens[i].toLowerCase() !== 'skelmodel') {
                    const prop = tokens[i].toLowerCase();
                    if (prop === 'shader') {
                        i++;
                        if (i < tokens.length) {
                            let shaderName = tokens[i];
                            // OpenMOHAA rule: if name contains '.', it's a filename → prepend current path.
                            // If no '.', it's a shader table reference → use as-is.
                            if (shaderName.includes('.')) {
                                shaderName = normalizeAssetPath(currentPath + shaderName);
                            }
                            currentSurface.shaders.push(shaderName);
                            i++;
                        }
                    } else if (prop === 'flags') {
                        i++;
                        if (i < tokens.length) {
                            // Parse flags like "nomipmaps"
                            i++;
                        }
                    } else if (prop === 'damage') {
                        i++;
                        if (i < tokens.length) {
                            currentSurface.damageMultiplier = parseFloat(tokens[i]);
                            i++;
                        }
                    } else {
                        i++;
                    }
                }
            }
            continue;
        }

        // Handle $include - recursively load included tiki files
        if (token === '$include' || token === 'include') {
            i++;
            if (i < tokens.length) {
                let includePath = tokens[i];
                i++;
                includePath = resolveAssetPath(ensureTrailingSlash(basePath), currentPath, includePath);
                // Load and merge included tiki
                const includeData = await vfs.getFile(includePath);
                if (includeData) {
                    const includeText = new TextDecoder('utf-8').decode(new Uint8Array(includeData));
                    const included = await parseTikiText(includeText, includePath, vfs);
                    // Merge: included skelModels, surfaces, etc.
                    def.skelModels.push(...included.skelModels);
                    def.surfaces.push(...included.surfaces);
                    if (included.scale !== 1.0) def.scale = included.scale;
                    if (included.origin[0] !== 0 || included.origin[1] !== 0 || included.origin[2] !== 0) {
                        def.origin = included.origin;
                    }
                }
            }
            continue;
        }

        i++;
    }

    return def;
}

function tokenize(text: string): string[] {
    const tokens: string[] = [];
    let i = 0;

    while (i < text.length) {
        // Skip whitespace
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i >= text.length) break;

        // Skip // comments
        if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }

        // Skip /* */ comments
        if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '*') {
            i += 2;
            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
            continue;
        }

        // Braces
        if (text[i] === '{' || text[i] === '}') {
            tokens.push(text[i]);
            i++;
            continue;
        }

        // Quoted string
        if (text[i] === '"') {
            i++;
            let s = '';
            while (i < text.length && text[i] !== '"') {
                s += text[i];
                i++;
            }
            i++; // skip closing quote
            tokens.push(s);
            continue;
        }

        // Regular token
        let s = '';
        while (i < text.length && !/[\s{}"]/.test(text[i])) {
            s += text[i];
            i++;
        }
        if (s) tokens.push(s);
    }

    return tokens;
}
