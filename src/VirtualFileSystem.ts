import JSZip from 'jszip';

export class VirtualFileSystem {
    private zips: JSZip[] = [];
    private fileMap: Map<string, { zip: JSZip, name: string }> = new Map();
    private looseFiles: Map<string, { buffer: ArrayBuffer, name: string }> = new Map();

    async loadPk3(url: string) {
        console.log(`Loading PK3: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load ${url}: ${response.statusText}`);
        }
        const blob = await response.blob();
        const zip = await JSZip.loadAsync(blob);
        this.zips.push(zip);

        zip.forEach((relativePath, file) => {
            if (!file.dir) {
                // Store lowercase path for case-insensitive lookup (MOHAA is often case-insensitive)
                this.fileMap.set(relativePath.toLowerCase(), { zip, name: relativePath });
            }
        });
        console.log(`Loaded PK3: ${url} (${Object.keys(zip.files).length} files)`);
    }

    async getFile(path: string): Promise<ArrayBuffer | null> {
        const lowerPath = path.replace(/\\/g, '/').toLowerCase();

        // Check loose files first (user uploads override pk3 contents)
        const loose = this.looseFiles.get(lowerPath);
        if (loose) return loose.buffer;

        const entry = this.fileMap.get(lowerPath);
        if (!entry) {
            return null;
        }

        const file = entry.zip.file(entry.name);
        if (!file) return null;

        return await file.async("arraybuffer");
    }

    // Helper to find files with various extensions or exact matches
    async findTexture(basePath: string): Promise<{ buffer: ArrayBuffer, extension: string } | null> {
        basePath = basePath.replace(/\\/g, '/');
        // Remove extension if present to try variations
        let noExt = basePath;
        const lastDot = basePath.lastIndexOf('.');
        if (lastDot > basePath.lastIndexOf('/')) {
            noExt = basePath.substring(0, lastDot);
        }

        const extensions = ['.tga', '.jpg', '.png'];
        for (const ext of extensions) {
            const buffer = await this.getFile(noExt + ext);
            if (buffer) {
                return { buffer, extension: ext };
            }
        }

        // Try exact original
        const exact = await this.getFile(basePath);
        if (exact) {
            return { buffer: exact, extension: basePath.substring(lastDot) };
        }

        return null;
    }

    getMapList(): string[] {
        const maps = new Set<string>();
        for (const [key, entry] of this.looseFiles.entries()) {
            if (key.startsWith('maps/') && key.endsWith('.bsp')) {
                maps.add(entry.name);
            }
        }
        for (const [key, entry] of this.fileMap.entries()) {
            if (key.startsWith('maps/') && key.endsWith('.bsp')) {
                maps.add(entry.name);
            }
        }
        return Array.from(maps);
    }

    async loadPk3FromBuffer(buffer: ArrayBuffer, name: string) {
        console.log(`Loading PK3 from buffer: ${name}`);
        const zip = await JSZip.loadAsync(buffer);
        this.zips.push(zip);

        zip.forEach((relativePath, file) => {
            if (!file.dir) {
                this.fileMap.set(relativePath.toLowerCase(), { zip, name: relativePath });
            }
        });
        console.log(`Loaded PK3: ${name} (${Object.keys(zip.files).length} files)`);
    }

    hasFile(path: string): boolean {
        const lower = path.toLowerCase();
        return this.looseFiles.has(lower) || this.fileMap.has(lower);
    }

    async getTextFile(path: string): Promise<string | null> {
        const lowerPath = path.toLowerCase();

        const loose = this.looseFiles.get(lowerPath);
        if (loose) return new TextDecoder().decode(loose.buffer);

        const entry = this.fileMap.get(lowerPath);
        if (!entry) return null;
        const file = entry.zip.file(entry.name);
        if (!file) return null;
        return await file.async("string");
    }

    async getAllShaders(): Promise<string[]> {
        const shaderContents: string[] = [];
        const seen = new Set<string>();

        // Loose files first (overrides)
        for (const [key, entry] of this.looseFiles.entries()) {
            if (key.startsWith('scripts/') && key.endsWith('.shader')) {
                shaderContents.push(new TextDecoder().decode(entry.buffer));
                seen.add(key);
            }
        }

        for (const [key, entry] of this.fileMap.entries()) {
            if (seen.has(key)) continue;
            if (key.startsWith('scripts/') && key.endsWith('.shader')) {
                const file = entry.zip.file(entry.name);
                if (file) {
                    const text = await file.async("string");
                    shaderContents.push(text);
                }
            }
        }
        return shaderContents;
    }

    addLooseFile(gamePath: string, buffer: ArrayBuffer) {
        this.looseFiles.set(gamePath.toLowerCase(), { buffer, name: gamePath });
    }

    async loadLooseFiles(files: FileList | File[], stripPrefix?: string) {
        let count = 0;
        for (const file of files) {
            // webkitRelativePath gives e.g. "main/maps/dm/mohdm1.bsp"
            let relativePath = (file as any).webkitRelativePath || file.name;
            relativePath = relativePath.replace(/\\/g, '/');

            // Strip the top-level directory (the uploaded folder name)
            if (stripPrefix) {
                if (relativePath.toLowerCase().startsWith(stripPrefix.toLowerCase())) {
                    relativePath = relativePath.substring(stripPrefix.length);
                }
            } else {
                // Auto-strip first path segment
                const slashIdx = relativePath.indexOf('/');
                if (slashIdx >= 0) {
                    relativePath = relativePath.substring(slashIdx + 1);
                }
            }

            if (!relativePath || file.size === 0) continue;

            const buffer = await file.arrayBuffer();
            this.looseFiles.set(relativePath.toLowerCase(), { buffer, name: relativePath });
            count++;
        }
        console.log(`Loaded ${count} loose files into VFS`);
        return count;
    }
}
