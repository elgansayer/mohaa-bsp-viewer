import JSZip from 'jszip';

export class VirtualFileSystem {
    private zips: JSZip[] = [];
    private fileMap: Map<string, { zip: JSZip, name: string }> = new Map();

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
        const maps: string[] = [];
        for (const key of this.fileMap.keys()) {
            if (key.startsWith('maps/') && key.endsWith('.bsp')) {
                maps.push(this.fileMap.get(key)!.name);
            }
        }
        return maps;
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
        return this.fileMap.has(path.toLowerCase());
    }

    async getTextFile(path: string): Promise<string | null> {
        const lowerPath = path.toLowerCase();
        const entry = this.fileMap.get(lowerPath);
        if (!entry) return null;
        const file = entry.zip.file(entry.name);
        if (!file) return null;
        return await file.async("string");
    }

    async getAllShaders(): Promise<string[]> {
        const shaderContents: string[] = [];
        for (const [key, entry] of this.fileMap.entries()) {
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
}
